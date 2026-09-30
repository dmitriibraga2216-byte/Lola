import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { withTenant } from '../utils/withTenant'
import { keysetAfter, keysetAt } from '../utils/keyset'
import { KEYSETS, encodeKeyset } from '../../shared/domain/keyset'
import { scopeSql } from './access'
import { frameJoins } from './reportFrame'
import { EMPLOYEES_ONLY } from './repo/people'
import { ORG_JOURNAL_ACTIONS } from '../../shared/domain/orgLayout'
import type { OrgJournalAction } from '../../shared/domain/orgLayout'
import type { OrgManagerSource } from '../../shared/enums'

/**
 * Отчёты оргструктуры `docs/v2/32-org-structure.md` §9 (решения `docs/v2/44` §14 Р-OS.6, Р-OS.7):
 * - «Підпорядкування людей» — кто чей руководитель и на каком правиле это держится;
 * - «Журнал змін структури» — действия структуры из `audit_log`.
 *
 * «Укомплектованість структури» живёт в конструкторе отчётов (`reportBuilder.ts`, сущность
 * `orgNodes`, PR-38), «Конфлікти структури» — экран протокола конфликтов (`/admin/org-conflicts`).
 */

interface Ctx { tenantId: string, actorId: string | null }

/** Потолок строк одного ответа: отчёт — не выгрузка всей истории, дальше — фильтры. */
export const ORG_REPORT_LIMIT = 2000

// ── «Підпорядкування людей» ────────────────────────────────────────────────────────────

export interface SubordinationFilter {
  /** Область видимости смотрящего по точкам; `null` — весь тенант. */
  scope: string[] | null
  locationId?: string
  /** Только те, у кого подчинение держится на резервных правилах (`source ≠ org_tree`). */
  onlyFallback?: boolean
  q?: string
}

export interface SubordinationRow {
  userId: string
  fullName: string
  position: string | null
  location: string | null
  node: string | null
  managerUserId: string | null
  manager: string | null
  /** `null` — карта для человека ещё не посчитана (новый человек до ночной пересборки). */
  source: OrgManagerSource | null
  /** Узлы совместительства — активные неосновные назначения. */
  secondary: string[]
  /** Начало подчинения: основное назначение в дереве, иначе — основное размещение. */
  since: string | null
}

/**
 * Строка — действующий сотрудник (правило 17: явный `kind`, кандидатов в подчинении нет).
 * Руководитель — из проекции `org_manager_map`: её и строят для отчётов (`32` §3.3), а прямой
 * вопрос «кто руководитель X» задаёт только `resolveManager()`, который эту проекцию и пишет.
 * Область видимости — точка основного размещения, как у всех отчётов каркаса.
 */
export async function subordinationReport(ctx: Ctx, f: SubordinationFilter): Promise<SubordinationRow[]> {
  const q = f.q?.trim()
  const rows = await withTenant(ctx.tenantId, ctx.actorId, tx => tx.execute(sql`
    select u.id as user_id, u.full_name, p.name as position, l.name as location,
           pn.title as node, m.manager_user_id, mu.full_name as manager, m.source,
           coalesce((select array_agg(sn.title order by sn.title)
                       from org_node_assignments sa join org_nodes sn on sn.id = sa.node_id
                      where sa.user_id = u.id and sa.ended_at is null and not sa.is_primary and sn.state <> 'archived'), '{}') as secondary,
           coalesce(pa.started_at, (select up.started_at from user_placements up
                                     where up.user_id = u.id and up.ended_at is null
                                     order by up.is_primary desc, up.started_at desc limit 1))::text as since
      from users u
      ${frameJoins()}
      left join org_manager_map m on m.user_id = u.id
      left join users mu on mu.id = m.manager_user_id
      left join lateral (
        select a.node_id, a.started_at from org_node_assignments a
         where a.user_id = u.id and a.ended_at is null and a.is_primary
         order by a.started_at desc limit 1
      ) pa on true
      left join org_nodes pn on pn.id = pa.node_id
     where u.status <> 'archived' ${EMPLOYEES_ONLY('u')}
       ${scopeSql(f.scope, sql`pl.location_id`)}
       ${f.locationId ? sql`and pl.location_id = ${f.locationId}::uuid` : sql``}
       ${f.onlyFallback ? sql`and coalesce(m.source, 'none') <> 'org_tree'` : sql``}
       ${q ? sql`and (u.full_name ilike ${`%${q}%`} or mu.full_name ilike ${`%${q}%`} or pn.title ilike ${`%${q}%`})` : sql``}
     order by u.full_name, u.id
     limit ${ORG_REPORT_LIMIT}`)) as unknown as {
    user_id: string, full_name: string, position: string | null, location: string | null, node: string | null,
    manager_user_id: string | null, manager: string | null, source: OrgManagerSource | null, secondary: string[], since: string | null
  }[]
  return rows.map(r => ({
    userId: r.user_id,
    fullName: r.full_name,
    position: r.position,
    location: r.location,
    node: r.node,
    managerUserId: r.manager_user_id,
    manager: r.manager,
    source: r.source,
    secondary: r.secondary ?? [],
    since: r.since ? r.since.slice(0, 10) : null,
  }))
}

// ── «Журнал змін структури» ────────────────────────────────────────────────────────────


export interface ChangesFilter {
  from?: string
  to?: string
  actorId?: string
  action?: OrgJournalAction
  /** Ветка: узел и всё его поддерево (по текущему положению узлов). */
  nodeId?: string
  /**
   * Ветки, которыми ограничен смотрящий (`manager` — своя ветка, `32` §2); `null` — весь тенант.
   * Строки без узла (импорт, откат, снимки) в ветку не входят: они про всё дерево.
   */
  branches: string[] | null
  /** Ключевой курсор журналов `created_at desc, id::text desc` (`KEYSETS.logs`, `docs/04` §4.1). */
  cursor?: string
  limit: number
}

export interface ChangeRow {
  id: string
  at: string
  actorId: string | null
  actor: string | null
  action: OrgJournalAction
  nodeId: string | null
  node: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  /** «Зачеплено нащадків» — у переноса ветки. */
  affected: number | null
}

export async function changesJournal(ctx: Ctx, f: ChangesFilter): Promise<{ rows: ChangeRow[], cursor: string | null }> {
  if (f.branches && !f.branches.length) return { rows: [], cursor: null }
  const branchSql: SQL = f.branches
    ? sql`and n.path <@ any(array[${sql.join(f.branches.map(b => sql`${b}::ltree`), sql`, `)}])`
    : sql``
  const after = keysetAfter(KEYSETS.logs, f.cursor, [sql`a.created_at`, sql`a.id::text`], 'desc')
  const rows = await withTenant(ctx.tenantId, ctx.actorId, tx => tx.execute(sql`
    select a.id::text as id, a.created_at, ${keysetAt(sql`a.created_at`)} as cursor_at, a.actor_id, au.full_name as actor, a.action,
           case when a.entity = 'org_node' then a.entity_id end as node_id, n.title as node,
           a.before, a.after
      from audit_log a
      left join users au on au.id = a.actor_id
      left join org_nodes n on a.entity = 'org_node' and n.id = a.entity_id
     where a.action in (${sql.join(ORG_JOURNAL_ACTIONS.map(x => sql`${x}`), sql`, `)})
       ${branchSql}
       ${f.nodeId ? sql`and n.path <@ (select path from org_nodes where id = ${f.nodeId}::uuid)` : sql``}
       ${f.action ? sql`and a.action = ${f.action}` : sql``}
       ${f.actorId ? sql`and a.actor_id = ${f.actorId}::uuid` : sql``}
       ${f.from ? sql`and a.created_at >= ${f.from}::date` : sql``}
       ${f.to ? sql`and a.created_at < ${f.to}::date + 1` : sql``}
       ${after ? sql`and ${after}` : sql``}
     order by a.created_at desc, a.id::text desc
     limit ${f.limit + 1}`)) as unknown as {
    id: string, created_at: Date | string, cursor_at: string, actor_id: string | null, actor: string | null, action: OrgJournalAction,
    node_id: string | null, node: string | null, before: Record<string, unknown> | null, after: Record<string, unknown> | null
  }[]
  const page = rows.slice(0, f.limit)
  return {
    rows: page.map(r => ({
      id: r.id,
      at: new Date(r.created_at).toISOString(),
      actorId: r.actor_id,
      actor: r.actor,
      action: r.action,
      nodeId: r.node_id,
      node: r.node,
      before: r.before,
      after: r.after,
      affected: typeof r.after?.affected === 'number' ? r.after.affected : null,
    })),
    cursor: rows.length > f.limit ? encodeKeyset(KEYSETS.logs, [String(page[page.length - 1]!.cursor_at), page[page.length - 1]!.id]) : null,
  }
}

/** Плоские строки для файла: «Було» / «Стало» — JSON изменённых полей. */
export function changesExportRows(rows: ChangeRow[]): Record<string, unknown>[] {
  return rows.map(r => ({
    at: r.at, actor: r.actor ?? '', action: r.action, node: r.node ?? '',
    before: r.before ? JSON.stringify(r.before) : '', after: r.after ? JSON.stringify(r.after) : '',
    affected: r.affected ?? '',
  }))
}

export function subordinationExportRows(rows: SubordinationRow[]): Record<string, unknown>[] {
  return rows.map(r => ({
    full_name: r.fullName, position: r.position ?? '', location: r.location ?? '', node: r.node ?? '',
    manager: r.manager ?? '', source: r.source ?? '', secondary: r.secondary.join(', '), since: r.since ?? '',
  }))
}
