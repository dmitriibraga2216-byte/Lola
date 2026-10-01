import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { withTenant } from '../utils/withTenant'
import type { ReviewDelegationJournalQuery, ReviewerWorkReportQuery } from '../../shared/schemas/review'
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

/**
 * «Робота перевіряючих» (`docs/v2/37` §9.2): строка — проверяющий за период. Колонки §9.2:
 * Перевіряючий · Філії · Перевірено · Прийнято · Відхилено · На доопрацювання · Частка прийнятих ·
 * Медіана реакції · Медіана перевірки · Делеговано мною · Делеговано мені · Частка делегованого ·
 * Прострочено · Ескальовано · Перевірок власного контенту.
 *
 * **Считается при запросе из тех же источников и по тем же правилам, что ночной
 * `review.stats_rollup`** (`reviewSla.ts`), а не суммой строк `reviewer_stats_daily` (`44`
 * Р-MT.1.1): у суточной строки нет разреза по точке работы, типу задания и типу субъекта — а это
 * фильтры §9.2 и граница области смотрящего; медиану за период из суточных медиан не сложить; и
 * «догрузка текущих суток» §9.2 при расчёте по источникам не нужна — сегодняшние решения уже в
 * журнале. Источники: решения — `audit_log` (`workshop.grade`, `attempt.grade`), закрытые работы
 * (просрочено, медианы) — `review_queue_items`, передачи — `review_delegations`, эскалации —
 * `review_sla_events`, свой контент — `review.author_conflict`. Каждый факт привязан к строке
 * очереди (решение — по `source_id`), и фильтры работают по ней.
 *
 * **Кто и что видит** — как журнал §9.4: область роли смотрящего по точке работы, фильтр «точка»
 * только сужает, работа кандидата — при `candidate.view` (#143). Строки — только сотрудники
 * (`kind = 'employee'`, правило 17): кандидат не проверяет.
 */
export interface ReviewerWorkRow {
  reviewerId: string
  reviewerName: string
  locations: string[]
  reviewed: number
  accepted: number
  rejected: number
  rework: number
  /** `accepted / reviewed`, доля 0…1; решений нет — `null`. */
  acceptedShare: number | null
  medianReactSec: number | null
  medianReviewSec: number | null
  delegatedOut: number
  delegatedIn: number
  /** `delegated_out / (reviewed + delegated_out)` (§9.2), доля 0…1; знаменатель 0 — `null`. */
  delegatedShare: number | null
  breached: number
  escalated: number
  ownContent: number
}

/** Период по умолчанию — 30 суток по сегодня включительно (`44` Р-MT.1.2). */
export const REVIEWER_REPORT_DEFAULT_DAYS = 30

export function reviewerReportPeriod(f: Pick<ReviewerWorkReportQuery, 'from' | 'to'>, today: Date = new Date()): { from: string, to: string } {
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const to = f.to ?? (f.from && f.from > iso(today) ? f.from : iso(today))
  const from = f.from ?? iso(new Date(Date.parse(`${to}T00:00:00Z`) - (REVIEWER_REPORT_DEFAULT_DAYS - 1) * 86_400_000))
  return { from, to }
}

export const share = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 1000 : null)

export async function reviewerWorkReport(
  ctx: { tenantId: string, actorId: string, scope: string[] | null, candidates: boolean },
  f: ReviewerWorkReportQuery,
): Promise<{ rows: ReviewerWorkRow[], from: string, to: string }> {
  const period = reviewerReportPeriod(f)
  if (ctx.scope && !ctx.scope.length) return { rows: [], ...period }
  if (f.subjectKind === 'candidate' && !ctx.candidates) return { rows: [], ...period }
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const qc: SQL[] = [sql`q.tenant_id = ${ctx.tenantId}::uuid`]
    if (ctx.scope) qc.push(sql`q.location_id in ${ctx.scope}`)
    if (!ctx.candidates) qc.push(sql`q.subject_kind = 'employee'`)
    if (f.locationId) qc.push(sql`q.location_id = ${f.locationId}::uuid`)
    if (f.taskType) qc.push(sql`q.task_type = ${f.taskType}`)
    if (f.subjectKind) qc.push(sql`q.subject_kind = ${f.subjectKind}`)
    const items = sql.join(qc, sql` and `)
    const inPeriod = (col: SQL) => sql`${col} >= ${period.from}::date and ${col} < (${period.to}::date + 1)`
    const rows = await tx.execute(sql`
      with items as (select q.* from review_queue_items q where ${items}),
      decisions as (
        select a.actor_id as reviewer_id,
               case when a.action = 'workshop.grade' then a.after->>'decision'
                    when (a.after->>'isCorrect')::boolean then 'accepted' else 'rejected' end as decision
          from audit_log a
         where a.tenant_id = ${ctx.tenantId}::uuid
           and a.action in ('workshop.grade', 'attempt.grade') and a.actor_id is not null
           and ${inPeriod(sql`a.created_at`)}
           and exists (select 1 from items q where q.source_id = a.entity_id)
      ),
      closed as (
        select q.* from items q
         where q.status = 'done' and q.assigned_reviewer_id is not null and ${inPeriod(sql`q.completed_at`)}
      ),
      moves as (
        select d.from_user_id, d.to_user_id from review_delegations d join items q on q.id = d.queue_item_id
         where ${inPeriod(sql`d.created_at`)}
      ),
      escalations as (
        select e.reviewer_id from review_sla_events e join items q on q.id = e.queue_item_id
         where e.event = 'escalated' and e.reviewer_id is not null and ${inPeriod(sql`e.created_at`)}
      ),
      own as (
        select a.actor_id as reviewer_id from audit_log a
         where a.tenant_id = ${ctx.tenantId}::uuid and a.action = 'review.author_conflict' and a.actor_id is not null
           and ${inPeriod(sql`a.created_at`)}
           and exists (select 1 from items q where q.source_id = a.entity_id)
      ),
      people as (
        select reviewer_id as id from decisions
        union select assigned_reviewer_id from closed
        union select from_user_id from moves
        union select to_user_id from moves
        union select reviewer_id from escalations
        union select reviewer_id from own
      )
      select u.id::text as reviewer_id, u.full_name as reviewer_name,
        coalesce((select array_agg(distinct l.name order by l.name) from user_placements pl join locations l on l.id = pl.location_id
                   where pl.user_id = u.id and (pl.ended_at is null or pl.ended_at >= current_date)), '{}') as locations,
        (select count(*) from decisions x where x.reviewer_id = u.id)::int as reviewed,
        (select count(*) from decisions x where x.reviewer_id = u.id and x.decision = 'accepted')::int as accepted,
        (select count(*) from decisions x where x.reviewer_id = u.id and x.decision = 'rejected')::int as rejected,
        (select count(*) from decisions x where x.reviewer_id = u.id and x.decision = 'rework')::int as rework,
        (select percentile_cont(0.5) within group (order by extract(epoch from (c.claimed_at - c.submitted_at)))
           from closed c where c.assigned_reviewer_id = u.id and c.claimed_at is not null)::int as median_react_sec,
        (select percentile_cont(0.5) within group (order by extract(epoch from (c.completed_at - c.claimed_at)))
           from closed c where c.assigned_reviewer_id = u.id and c.claimed_at is not null)::int as median_review_sec,
        (select count(*) from moves m where m.from_user_id = u.id)::int as delegated_out,
        (select count(*) from moves m where m.to_user_id = u.id)::int as delegated_in,
        (select count(*) from closed c where c.assigned_reviewer_id = u.id and c.sla_breached_at is not null)::int as breached,
        (select count(*) from escalations e where e.reviewer_id = u.id)::int as escalated,
        (select count(*) from own o where o.reviewer_id = u.id)::int as own_content
        from people p
        join users u on u.id = p.id and u.kind = 'employee'
       order by u.full_name, u.id
    `) as unknown as { reviewer_id: string, reviewer_name: string, locations: string[], reviewed: number, accepted: number, rejected: number, rework: number, median_react_sec: number | null, median_review_sec: number | null, delegated_out: number, delegated_in: number, breached: number, escalated: number, own_content: number }[]
    return {
      ...period,
      rows: rows.map(r => ({
        reviewerId: r.reviewer_id,
        reviewerName: r.reviewer_name,
        locations: r.locations ?? [],
        reviewed: r.reviewed,
        accepted: r.accepted,
        rejected: r.rejected,
        rework: r.rework,
        acceptedShare: share(r.accepted, r.reviewed),
        medianReactSec: r.median_react_sec,
        medianReviewSec: r.median_review_sec,
        delegatedOut: r.delegated_out,
        delegatedIn: r.delegated_in,
        delegatedShare: share(r.delegated_out, r.reviewed + r.delegated_out),
        breached: r.breached,
        escalated: r.escalated,
        ownContent: r.own_content,
      })),
    }
  })
}

/** Выгрузка «Робота перевіряючих» теми же строками, что на экране, в порядке колонок §9.2. */
export function reviewerWorkExportRows(rows: ReviewerWorkRow[]): Record<string, unknown>[] {
  return rows.map(r => ({
    reviewer: r.reviewerName,
    locations: r.locations.join(', '),
    reviewed: r.reviewed,
    accepted: r.accepted,
    rejected: r.rejected,
    rework: r.rework,
    accepted_share: r.acceptedShare,
    median_react_sec: r.medianReactSec,
    median_review_sec: r.medianReviewSec,
    delegated_out: r.delegatedOut,
    delegated_in: r.delegatedIn,
    delegated_share: r.delegatedShare,
    breached: r.breached,
    escalated: r.escalated,
    own_content: r.ownContent,
  }))
}
