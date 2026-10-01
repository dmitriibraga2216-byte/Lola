import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { withTenant } from '../utils/withTenant'
import type { ReviewDelegationJournalQuery } from '../../shared/schemas/review'
import type { ReviewDelegationReason, ReviewDelegationState, ReviewTaskType } from '../../shared/enums'

/**
 * Журнал «Делегування» (`docs/v2/37` §9.4): строка — одно звено передачи проверки.
 * Колонки §9.4: Дата · Від кого · Кому · Глибина · Завдання · Причина · Пояснення · Стан · Дата
 * завершення. Это отчёт по уже записанным звеньям (`review_delegations` пишет только
 * `reviewDelegation.ts`), сам он ничего не меняет.
 *
 * **Кто и что видит.** Скоуп `review.workload.view` (руководитель, администратор) — область его
 * роли по точке работы (`scope`: `null` — весь тенант). Фильтр «точка» только сужает. Работа
 * кандидата видна только смотрящему с `candidate.view` (решение владельца 25.09, #143): имени
 * проверяемого в журнале нет, но название задания и точка вакансии — уже сведения о кандидате.
 * Имена участников цепочки — соединением по первичному ключу (ФИО к звену, а не список людей).
 */

export interface DelegationJournalRow {
  id: string
  createdAt: Date
  fromName: string | null
  toName: string | null
  depth: number
  taskType: ReviewTaskType
  taskTitle: string | null
  locationName: string | null
  reasonCode: ReviewDelegationReason
  reasonText: string | null
  state: ReviewDelegationState
  resolvedAt: Date | null
}

/** Потолок строк журнала: больше — сузить период или фильтры. */
export const DELEGATION_JOURNAL_MAX = 2000

export async function delegationJournal(
  ctx: { tenantId: string, actorId: string, scope: string[] | null, candidates: boolean },
  f: ReviewDelegationJournalQuery,
): Promise<{ rows: DelegationJournalRow[], truncated: boolean }> {
  if (ctx.scope && !ctx.scope.length) return { rows: [], truncated: false }
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const conds: SQL[] = [sql`d.tenant_id = ${ctx.tenantId}::uuid`]
    if (ctx.scope) conds.push(sql`q.location_id in ${ctx.scope}`)
    if (!ctx.candidates) conds.push(sql`q.subject_kind = 'employee'`)
    if (f.locationId) conds.push(sql`q.location_id = ${f.locationId}::uuid`)
    if (f.from) conds.push(sql`d.created_at >= ${f.from}::date`)
    if (f.to) conds.push(sql`d.created_at < (${f.to}::date + 1)`)
    if (f.fromUserId) conds.push(sql`d.from_user_id = ${f.fromUserId}::uuid`)
    if (f.toUserId) conds.push(sql`d.to_user_id = ${f.toUserId}::uuid`)
    if (f.reasonCode) conds.push(sql`d.reason_code = ${f.reasonCode}`)
    if (f.state) conds.push(sql`d.state = ${f.state}`)
    const rows = await tx.execute(sql`
      select d.id, d.created_at, fu.full_name as from_name, tu.full_name as to_name, d.depth,
        q.task_type, q.task_title, l.name as location_name, d.reason_code, d.reason_text, d.state, d.resolved_at
      from review_delegations d
      join review_queue_items q on q.id = d.queue_item_id
      left join users fu on fu.id = d.from_user_id
      left join users tu on tu.id = d.to_user_id
      left join locations l on l.id = q.location_id
      where ${sql.join(conds, sql` and `)}
      order by d.created_at desc, d.id desc
      limit ${DELEGATION_JOURNAL_MAX + 1}
    `) as unknown as { id: string, created_at: string | Date, from_name: string | null, to_name: string | null, depth: number, task_type: string, task_title: string | null, location_name: string | null, reason_code: string, reason_text: string | null, state: string, resolved_at: string | Date | null }[]
    const truncated = rows.length > DELEGATION_JOURNAL_MAX
    return {
      truncated,
      rows: rows.slice(0, DELEGATION_JOURNAL_MAX).map(r => ({
        id: r.id,
        createdAt: new Date(r.created_at),
        fromName: r.from_name,
        toName: r.to_name,
        depth: r.depth,
        taskType: r.task_type as ReviewTaskType,
        taskTitle: r.task_title,
        locationName: r.location_name,
        reasonCode: r.reason_code as ReviewDelegationReason,
        reasonText: r.reason_text,
        state: r.state as ReviewDelegationState,
        resolvedAt: r.resolved_at ? new Date(r.resolved_at) : null,
      })),
    }
  })
}

/** Выгрузка журнала теми же строками, что на экране (`37` §9.4, docs/22 §3). */
export function delegationJournalExportRows(rows: DelegationJournalRow[]): Record<string, unknown>[] {
  return rows.map(r => ({
    date: r.createdAt,
    from: r.fromName,
    to: r.toName,
    depth: r.depth,
    task_type: r.taskType,
    task: r.taskTitle,
    location: r.locationName,
    reason: r.reasonCode,
    reason_text: r.reasonText,
    state: r.state,
    resolved_at: r.resolvedAt,
  }))
}
