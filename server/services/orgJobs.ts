import { sql } from 'drizzle-orm'
import { withTenant, type TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import { scopeHolders } from './contentIssueNotify'
import { orgTreeIsSourceOfTruth } from './orgManager'
import { notifyManagerChangesFor } from './orgStructure'
import { takeSnapshot } from './orgTreeWrite'
import { ORG_CHANGE_ACTIONS } from '../../shared/domain/orgLayout'

/**
 * Хвосты оргструктуры (`docs/v2/32-org-structure.md` §7 п. 7, §7.8, §8, §11; решения —
 * `docs/v2/44-decisions.md` §16 Р-OS.1…Р-OS.5):
 *
 * - `org.daily_snapshot` — снимок в 03:00 **по поясу тенанта**, если со времени последнего
 *   снимка дерево менялось;
 * - `org.snapshot_cleanup` — еженедельная чистка: старше 365 дней — любые, ежедневные — сверх
 *   тридцати последних;
 * - `org_structure_conflict` — письмо администраторам о новых конфликтах `critical`
 *   (`severity='error'` пакета — это `critical` общего перечня, `44` В-7);
 * - перевод флага `org_structure_is_source_of_truth` в `true` — с подтверждением
 *   администратора, когда в дереве не меньше пяти живых узлов (`32` §7.8).
 */

interface Ctx { tenantId: string, actorId: string | null }

/** Час снимка по поясу тенанта (`32` §7 п. 7). */
export const DAILY_SNAPSHOT_HOUR = 3
/** Сколько ежедневных снимков хранится (`32` §7 п. 7). */
export const DAILY_SNAPSHOTS_KEPT = 30
/** Сколько дней хранится любой снимок (`32` §11). */
export const SNAPSHOT_RETENTION_DAYS = 365
/** Порог узлов, с которого дерево можно объявить источником истины (`32` §7.8). */
export const SOURCE_OF_TRUTH_MIN_NODES = 5


// ── org.daily_snapshot ─────────────────────────────────────────────────────────────────

export type DailySnapshotResult =
  | { taken: true, snapshotId: string, nodeCount: number }
  | { taken: false, reason: 'not_due' | 'already_taken' | 'no_changes' | 'empty' }

/**
 * Один тенант задачи `org.daily_snapshot`. Задача идёт ежечасно по всем тенантам, а снимок
 * делается только у того, у кого по его поясу сейчас 03:xx (тот же приём, что у `usage.collect`,
 * `docs/24` §10) — «03:00 по таймзоне тенанта» без задачи на каждый тенант.
 *
 * «Если за сутки были изменения» читается как «со времени последнего снимка любого вида»
 * (Р-OS.1): снимок, сделанный перед импортом или руками, уже хранит то же дерево, и копия его
 * ничего не даёт; а пропущенная ночь (воркер лежал) не теряет изменений — они попадут
 * в следующий снимок.
 */
export async function dailySnapshot(tenantId: string, now: Date = new Date()): Promise<DailySnapshotResult> {
  return withTenant(tenantId, null, async (tx) => {
    const [t] = await tx.execute(sql`
      select extract(hour from (${now.toISOString()}::timestamptz at time zone timezone))::int as hour,
             (${now.toISOString()}::timestamptz at time zone timezone)::date::text as day,
             timezone
        from tenants where id = ${tenantId}::uuid`) as unknown as { hour: number, day: string, timezone: string }[]
    if (!t || t.hour !== DAILY_SNAPSHOT_HOUR) return { taken: false as const, reason: 'not_due' as const }

    const [today] = await tx.execute(sql`
      select 1 from org_structure_snapshots
       where kind = 'auto_daily' and (created_at at time zone ${t.timezone})::date = ${t.day}::date
       limit 1`) as unknown as unknown[]
    if (today) return { taken: false as const, reason: 'already_taken' as const }

    const [live] = await tx.execute(sql`select count(*)::int as n from org_nodes where state <> 'archived'`) as unknown as { n: number }[]
    if (!live?.n) return { taken: false as const, reason: 'empty' as const }

    const [changed] = await tx.execute(sql`
      select 1 from audit_log
       where action in (${sql.join(ORG_CHANGE_ACTIONS.map(a => sql`${a}`), sql`, `)})
         and created_at > coalesce((select max(created_at) from org_structure_snapshots), '-infinity'::timestamptz)
       limit 1`) as unknown as unknown[]
    if (!changed) return { taken: false as const, reason: 'no_changes' as const }

    // Подпись — дата по поясу тенанта: язык интерфейса ей не нужен, вид снимка экран переводит сам.
    const snap = await takeSnapshot(tx, { tenantId, actorId: null }, { label: t.day, kind: 'auto_daily' })
    return { taken: true as const, snapshotId: snap.id, nodeCount: snap.nodeCount }
  })
}

// ── org.snapshot_cleanup ───────────────────────────────────────────────────────────────

export interface SnapshotCleanupResult { expired: number, dailyOverflow: number }

/**
 * Один тенант задачи `org.snapshot_cleanup` (еженедельно, `32` §11). Удаляет:
 * - любой снимок старше 365 дней;
 * - ежедневные (`auto_daily`) сверх тридцати последних.
 * Ручные, предымпортные и «до массового перемещения» живут все 365 дней (`32` §7 п. 7).
 * Удаление — физическое: снимок не история людей, а копия дерева для отката, и её срок задан
 * документом; факт чистки со счётчиками — в `audit_log`.
 */
export async function snapshotCleanup(tenantId: string): Promise<SnapshotCleanupResult> {
  return withTenant(tenantId, null, async (tx) => {
    const expired = await tx.execute(sql`
      delete from org_structure_snapshots
       where created_at < now() - make_interval(days => ${SNAPSHOT_RETENTION_DAYS}::int)
      returning id`) as unknown as unknown[]
    const overflow = await tx.execute(sql`
      delete from org_structure_snapshots
       where id in (
         select id from org_structure_snapshots where kind = 'auto_daily'
          order by created_at desc, id desc offset ${DAILY_SNAPSHOTS_KEPT})
      returning id`) as unknown as unknown[]
    const result = { expired: expired.length, dailyOverflow: overflow.length }
    if (result.expired || result.dailyOverflow) {
      await recordAudit(tx, { tenantId, actorId: null, action: 'org_structure.snapshot_cleanup', entity: 'org_structure', after: result })
    }
    return result
  })
}

// ── org_structure_conflict ─────────────────────────────────────────────────────────────

/**
 * Письмо администраторам о новых конфликтах `critical` (`32` §8). Зовётся после ежедневного
 * валидатора (`org.validate_structure`), но считает не только его находки: импорт тоже пишет
 * `critical` (петля, узел под самим собой). «Новые» — открытые и появившиеся после прошлого
 * такого письма в тенанте (Р-OS.3): ни одна находка не теряется между прогонами и ни одна
 * не приходит дважды. Адресаты — носители `org.structure.import` (`32` §2: разбирать конфликты
 * структуры может только администратор), только действующие сотрудники (правило 17).
 */
export async function notifyStructureConflicts(tenantId: string): Promise<{ count: number, sent: number }> {
  return withTenant(tenantId, null, async (tx) => {
    const [row] = await tx.execute(sql`
      select count(*)::int as n from org_conflicts c
       where c.severity = 'critical' and c.resolved_at is null
         and c.created_at > coalesce(
           (select max(created_at) from notifications where code = 'org_structure_conflict'),
           '-infinity'::timestamptz)`) as unknown as { n: number }[]
    const count = row?.n ?? 0
    if (!count) return { count: 0, sent: 0 }
    const stamp = new Date().toISOString()
    let sent = 0
    for (const userId of await scopeHolders(tx, 'org.structure.import')) {
      if (await enqueueNotification(tx, { tenantId, userId, code: 'org_structure_conflict', payload: { count }, dedupKey: `org_conflict:${userId}:${stamp}` })) sent++
    }
    return { count, sent }
  })
}

// ── org_structure_is_source_of_truth ───────────────────────────────────────────────────

export interface SourceOfTruthStatus {
  enabled: boolean
  /** Живых (не архивных) узлов в дереве. */
  liveNodes: number
  /** Можно предложить перевод: флаг выключен, а узлов не меньше пяти. */
  eligible: boolean
  /** Открытые `manager_mismatch` — «цена переключения» (`32` §12 п. 6). */
  mismatches: number
}

export async function sourceOfTruthStatusTx(tx: TenantTx, tenantId: string): Promise<SourceOfTruthStatus> {
  const enabled = await orgTreeIsSourceOfTruth(tx, tenantId)
  const [r] = await tx.execute(sql`
    select (select count(*)::int from org_nodes where state <> 'archived') as live,
           (select count(*)::int from org_conflicts where kind = 'manager_mismatch' and resolved_at is null) as mismatches`) as unknown as { live: number, mismatches: number }[]
  const liveNodes = r?.live ?? 0
  return { enabled, liveNodes, eligible: !enabled && liveNodes >= SOURCE_OF_TRUTH_MIN_NODES, mismatches: r?.mismatches ?? 0 }
}

export async function sourceOfTruthStatus(ctx: Ctx): Promise<SourceOfTruthStatus> {
  return withTenant(ctx.tenantId, ctx.actorId, tx => sourceOfTruthStatusTx(tx, ctx.tenantId))
}

export type EnableSourceOfTruthResult =
  | { ok: true, alreadyEnabled: boolean, changed: number }
  | { ok: false, code: 'too_few_nodes', liveNodes: number }

/**
 * Перевод флага `org_structure_is_source_of_truth` в `true` (`32` §7.8): «первая публикация
 * дерева с ≥5 узлами переводит флаг с подтверждением администратора». Публикации как отдельного
 * шага у дерева нет — узлы видны в витрине сразу, — поэтому система **предлагает** перевод на
 * экране конструктора, как только живых узлов стало пять, а переводит его подтверждение
 * администратора (Р-OS.4). Обратного перевода нет — документ его не описывает.
 *
 * В той же транзакции: флаг, пересборка `org_manager_map` для всех, кого касается подчинение, и
 * `org_manager_changed` тем, у кого руководитель от этого сменился (критерий приёмки 5:
 * уведомления с этого момента идут человеку из дерева). Повторный вызов — без изменений.
 */
export async function enableSourceOfTruth(ctx: Ctx): Promise<EnableSourceOfTruthResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const status = await sourceOfTruthStatusTx(tx, ctx.tenantId)
    if (status.enabled) return { ok: true as const, alreadyEnabled: true, changed: 0 }
    if (status.liveNodes < SOURCE_OF_TRUTH_MIN_NODES) return { ok: false as const, code: 'too_few_nodes' as const, liveNodes: status.liveNodes }

    const before = await managerMapSnapshot(tx)
    await tx.execute(sql`
      update tenants set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{org_structure_is_source_of_truth}', 'true'::jsonb)
       where id = ${ctx.tenantId}::uuid`)
    // Круг — все, у кого подчинение уже посчитано, плюс все, кто стоит в дереве (правило 17:
    // только сотрудники — у кандидата руководителя нет).
    const people = await tx.execute(sql`
      select m.user_id as id from org_manager_map m join users u on u.id = m.user_id where u.kind = 'employee'
      union
      select a.user_id from org_node_assignments a join users u on u.id = a.user_id
       where a.ended_at is null and u.kind = 'employee' and u.status <> 'archived'`) as unknown as { id: string }[]
    await notifyManagerChangesFor(tx, ctx, people.map(p => p.id))
    const after = await managerMapSnapshot(tx)
    const changed = [...after].filter(([id, m]) => before.get(id) !== m).length
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'org_structure.source_of_truth', entity: 'org_structure', before: { enabled: false }, after: { enabled: true, liveNodes: status.liveNodes, mismatches: status.mismatches, changed } })
    return { ok: true as const, alreadyEnabled: false, changed }
  })
}

async function managerMapSnapshot(tx: TenantTx): Promise<Map<string, string | null>> {
  const rows = await tx.execute(sql`select user_id, manager_user_id from org_manager_map`) as unknown as { user_id: string, manager_user_id: string | null }[]
  return new Map(rows.map(r => [r.user_id, r.manager_user_id]))
}
