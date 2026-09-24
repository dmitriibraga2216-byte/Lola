import { sql } from 'drizzle-orm'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { DEFAULT_TRASH_DAYS, ensureRetentionPolicies } from '../db/tenantDefaults'
import { MEDIA_ORIGINS } from '../../shared/enums'
import type { MediaOrigin, StorageRetentionAction, StorageRetentionAnchor } from '../../shared/enums'
import type { RetentionDryRun, RetentionPoliciesSave } from '../../shared/schemas/storage'
import { recordAudit } from './audit'

/**
 * Политики хранения (docs/v2/34 §3.3, §5.2, §6.2, §7.3; план docs/v2/45 PR-36).
 *
 * Строка на происхождение, у нового тенанта всё выключено. Первое включение удаляющей
 * политики требует сухого прогона и подтверждения объёма (§7.3): «молча удалять
 * доказательства при запуске функции нельзя». Здесь же живёт срок корзины — `trash_days`
 * (docs/v2/44 §8: предварительно 30 дней, строкой, а не константой в коде).
 *
 * Исполнение политик по расписанию (`storage.retention_scan`, §11) в PR-36 не входит — план
 * называет только `storage.purge`. Экран, сохранение и сухой прогон работают уже сейчас:
 * включённая политика ждёт задачи, а не наоборот.
 */

export interface Ctx { tenantId: string, actorId: string }

export interface RetentionPolicyRow {
  origin: MediaOrigin
  enabled: boolean
  keepMonths: number | null
  anchor: StorageRetentionAnchor
  action: StorageRetentionAction
  keepEvidence: boolean
  warnDaysBefore: number
  maxBatchPerRun: number
  trashDays: number
  updatedAt: string
}

type Row = {
  origin: string, enabled: boolean, keep_months: number | null, anchor: string, action: string, keep_evidence: boolean
  warn_days_before: number, max_batch_per_run: number, trash_days: number, updated_at: Date | string
}

const toRow = (r: Row): RetentionPolicyRow => ({
  origin: r.origin as MediaOrigin,
  enabled: r.enabled,
  keepMonths: r.keep_months,
  anchor: r.anchor as StorageRetentionAnchor,
  action: r.action as StorageRetentionAction,
  keepEvidence: r.keep_evidence,
  warnDaysBefore: r.warn_days_before,
  maxBatchPerRun: r.max_batch_per_run,
  trashDays: r.trash_days,
  updatedAt: new Date(r.updated_at).toISOString(),
})

async function readPolicies(tx: TenantTx, tenantId: string): Promise<RetentionPolicyRow[]> {
  await ensureRetentionPolicies(tx, tenantId)
  const rows = await tx.execute(sql`
    select origin, enabled, keep_months, anchor, action, keep_evidence, warn_days_before, max_batch_per_run, trash_days, updated_at
      from storage_retention_policies
  `) as unknown as Row[]
  const order = new Map(MEDIA_ORIGINS.map((o, i) => [o, i]))
  return rows.map(toRow).sort((a, b) => (order.get(a.origin) ?? 99) - (order.get(b.origin) ?? 99))
}

/** `GET /storage/retention-policies` — список фиксирован (строка на каждое из `MEDIA_ORIGINS`), пустого состояния нет (§5.2). */
export async function listRetentionPolicies(ctx: Ctx): Promise<RetentionPolicyRow[]> {
  return withTenant(ctx.tenantId, ctx.actorId, tx => readPolicies(tx, ctx.tenantId))
}

/**
 * Срок корзины для файла этого происхождения (docs/v2/44 §8). Строки нет — досеваются
 * умолчания; строка есть — её значение, какое бы владелец продукта ни поставил.
 */
export async function trashDaysFor(tx: TenantTx, tenantId: string, origin: string): Promise<number> {
  const read = async () => (await tx.execute(sql`
    select trash_days from storage_retention_policies where origin = ${origin}
  `) as unknown as { trash_days: number }[])[0]?.trash_days
  const days = await read()
  if (days != null) return days
  await ensureRetentionPolicies(tx, tenantId)
  return (await read()) ?? DEFAULT_TRASH_DAYS
}

export interface DryRunResult { files: number, bytes: number, evidenceCount: number }

/**
 * Сухой прогон (§5.2 «Буде звільнено приблизно {size}», §7.3): сколько файлов этого
 * происхождения политика удалила бы сегодня. Точка отсчёта:
 *  - `created_at` — дата загрузки;
 *  - `last_accessed_at` — последнее обращение, а у файла, к которому не обращались, — загрузка;
 *  - `graded_at` — дата решения по сдаче, на которую ссылается файл (`workshop_submissions
 *    .reviewed_at`); у файла без решённой сдачи отсчитывать не от чего, и он не удаляется.
 * `notify_only` ничего не удаляет — прогон честно показывает ноль.
 */
export async function retentionDryRun(ctx: Ctx, input: RetentionDryRun): Promise<DryRunResult> {
  if (input.action === 'notify_only' || input.keepMonths == null) return { files: 0, bytes: 0, evidenceCount: 0 }
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const anchor = input.anchor === 'created_at'
      ? sql`m.created_at`
      : input.anchor === 'last_accessed_at'
        ? sql`coalesce(m.last_accessed_at, m.created_at)`
        : sql`(select max(s.reviewed_at) from workshop_submissions s
                where s.status in ('accepted', 'rejected')
                  and jsonb_path_exists(s.files, 'lax $[*] ? (@.mediaId == $id)', jsonb_build_object('id', m.id::text)))`
    const [r] = await tx.execute(sql`
      select count(*)::int as files, coalesce(sum(m.bytes), 0)::bigint as bytes,
             count(*) filter (where m.is_evidence)::int as evidence
        from media_assets m
       where m.origin = ${input.origin}
         and m.lifecycle in ('active', 'orphaned')
         and m.origin <> 'certificate'
         ${input.keepEvidence ? sql`and not m.is_evidence` : sql``}
         and ${anchor} < now() - make_interval(months => ${input.keepMonths}::int)
    `) as unknown as { files: number, bytes: string | number, evidence: number }[]
    return { files: r?.files ?? 0, bytes: Number(r?.bytes ?? 0), evidenceCount: r?.evidence ?? 0 }
  })
}

export type SavePoliciesResult
  = | { ok: true, policies: RetentionPolicyRow[] }
    | { ok: false, code: 'dry_run_required' | 'evidence_ack_required' | 'keep_months_required', origins: MediaOrigin[] }

/**
 * `PUT /storage/retention-policies` (§6.2, §10). Три правила формы, которые сервер обязан
 * повторить, а не доверить экрану:
 *  1. включённая удаляющая политика знает срок («Від 1 до 120 місяців»);
 *  2. `keepEvidence=false` — только с отметкой «Розумію, що буде видалено підтвердження оцінок»;
 *  3. **первое включение** удаляющей политики — только после сухого прогона (§7.3).
 * Запись `storage.policy.update` в `audit_log` — на каждую изменившуюся строку.
 */
export async function saveRetentionPolicies(ctx: Ctx, input: RetentionPoliciesSave): Promise<SavePoliciesResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const before = new Map((await readPolicies(tx, ctx.tenantId)).map(p => [p.origin, p]))
    const deleting = (p: { enabled: boolean, action: string }) => p.enabled && p.action !== 'notify_only'

    const noKeep = input.policies.filter(p => deleting(p) && p.keepMonths == null).map(p => p.origin)
    if (noKeep.length) return { ok: false as const, code: 'keep_months_required' as const, origins: noKeep }
    const noAck = input.policies.filter(p => deleting(p) && !p.keepEvidence && !p.acknowledgeEvidence).map(p => p.origin)
    if (noAck.length) return { ok: false as const, code: 'evidence_ack_required' as const, origins: noAck }
    const firstOn = input.policies.filter(p => deleting(p) && !deleting(before.get(p.origin) ?? { enabled: false, action: 'notify_only' })).map(p => p.origin)
    if (firstOn.length && !input.dryRunConfirmed) return { ok: false as const, code: 'dry_run_required' as const, origins: firstOn }

    for (const p of input.policies) {
      const prev = before.get(p.origin)
      const same = prev && prev.enabled === p.enabled && prev.keepMonths === p.keepMonths && prev.anchor === p.anchor
        && prev.action === p.action && prev.keepEvidence === p.keepEvidence && prev.warnDaysBefore === p.warnDaysBefore
        && prev.maxBatchPerRun === p.maxBatchPerRun && prev.trashDays === p.trashDays
      if (same) continue
      await tx.execute(sql`
        update storage_retention_policies
           set enabled = ${p.enabled}, keep_months = ${p.keepMonths}::int, anchor = ${p.anchor}, action = ${p.action},
               keep_evidence = ${p.keepEvidence}, warn_days_before = ${p.warnDaysBefore}, max_batch_per_run = ${p.maxBatchPerRun},
               trash_days = ${p.trashDays}, updated_by = ${ctx.actorId}::uuid, updated_at = now()
         where origin = ${p.origin}
      `)
      await recordAudit(tx, {
        tenantId: ctx.tenantId,
        actorId: ctx.actorId,
        action: 'storage.policy.update',
        entity: 'storage_retention_policies',
        before: prev ?? null,
        after: { ...p, acknowledgeEvidence: undefined, dryRunConfirmed: input.dryRunConfirmed ?? false },
      })
    }
    return { ok: true as const, policies: await readPolicies(tx, ctx.tenantId) }
  })
}
