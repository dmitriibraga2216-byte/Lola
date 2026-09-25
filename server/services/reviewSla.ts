import { and, eq, isNotNull, ne, sql } from 'drizzle-orm'
import { reviewQueueItems, reviewSlaEvents } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { enqueueNotification } from './notifications'
import { escalationTarget, namesOf } from './reviewPeople'
import type { EscalationSource } from './reviewPeople'
import { dueSlaSteps, notifyStep, overdueHours } from './reviewRules'
import type { SlaStep } from './reviewRules'

/**
 * Срок проверки и эскалация — задача `review.sla_scan`, ежечасно (`docs/v2/37` §7.19, §11;
 * расширяет одноимённую задачу `docs/14` §11 на всю очередь, а не только практикумы).
 *
 * Пороги от окна `sla_hours`, конец которого — `sla_due_at`:
 *   - **50 %** — `sla_warned_at`, проверяющему `review_sla_warning`;
 *   - **100 %** — `sla_breached_at`, строка коралловая, руководителю области `review_sla_breach`;
 *   - **150 %** — `status = 'escalated'`, `escalated_to_id` = руководитель области, работа
 *     появляется в его «Мої» **дополнительно** к текущему проверяющему (единственный случай,
 *     когда работу видят двое — эскалация не должна выглядеть как отъём).
 *
 * Руководитель, который сам и есть проверяющий, эскалацию на себя не получает — она уходит
 * вверх по дереву до ближайшего держателя руководящей точки (PR-31), а если выше в дереве
 * никого — администратору тенанта (`reviewPeople.escalationTarget`).
 *
 * Отметки времени — по факту события, а не доставки: предупреждение, выпавшее на ночь,
 * доставляется в 09:00 по тихим часам, но `sla_warned_at` фиксируется сейчас (§7.20).
 */
export async function reviewSlaScan(tenantId: string, now: Date = new Date()): Promise<{ warned: number, breached: number, escalated: number }> {
  return withTenant(tenantId, null, async (tx) => {
    const items = await tx.select().from(reviewQueueItems).where(and(
      ne(reviewQueueItems.status, 'done'),
      isNotNull(reviewQueueItems.slaDueAt),
      sql`(${reviewQueueItems.slaWarnedAt} is null or ${reviewQueueItems.slaBreachedAt} is null or ${reviewQueueItems.escalatedAt} is null)`,
      // Раньше половины окна делать нечего: `due − hours/2 ≤ now`.
      sql`${reviewQueueItems.slaDueAt} - make_interval(secs => ${reviewQueueItems.slaHours} * 1800) <= ${now.toISOString()}::timestamptz`,
    ))
    const out = { warned: 0, breached: 0, escalated: 0 }
    for (const item of items) {
      const steps = dueSlaSteps(item, now)
      if (!steps.length) continue
      const set: Partial<typeof reviewQueueItems.$inferInsert> = { updatedAt: now }
      let target: { id: string, source: EscalationSource } | null = null
      if (steps.includes('breach') || steps.includes('escalate')) target = await escalationTarget(tx, item)

      if (steps.includes('warn')) set.slaWarnedAt = now
      if (steps.includes('breach')) {
        set.slaBreachedAt = now
        // Просроченные выше в очереди (`docs/14` §3.3).
        set.priority = Math.max(item.priority, 10)
      }
      if (steps.includes('escalate')) {
        set.escalatedAt = now
        set.escalatedToId = target?.id ?? null
        // Открытую карточку статус не отнимает: эскалированной она станет, когда её отпустят.
        if (item.status !== 'in_review') set.status = 'escalated'
      }
      await tx.update(reviewQueueItems).set(set).where(eq(reviewQueueItems.id, item.id))

      for (const step of steps) {
        await tx.insert(reviewSlaEvents).values({
          tenantId,
          queueItemId: item.id,
          reviewerId: item.assignedReviewerId ?? item.claimedBy,
          event: step === 'warn' ? 'warned' : step === 'breach' ? 'breached' : 'escalated',
          dueAt: item.slaDueAt,
          overdueHours: step === 'warn' ? null : String(overdueHours(item.slaDueAt!, now)),
          targetId: step === 'warn' ? null : target?.id ?? null,
          details: target && step !== 'warn' ? { target: target.source } : {},
        })
        if (step === 'warn') out.warned++
        if (step === 'breach') out.breached++
        if (step === 'escalate') out.escalated++
      }
      await notifySla(tenantId, tx, item, notifyStep(steps), target, now)
    }
    return out
  })
}

/** Одно уведомление на элемент за прогон — самого высокого порога (`reviewRules.notifyStep`). */
async function notifySla(tenantId: string, tx: TenantTx, item: typeof reviewQueueItems.$inferSelect, step: SlaStep | null, target: { id: string } | null, now: Date): Promise<void> {
  if (!step) return
  const task = item.taskTitle ?? ''
  if (step === 'warn') {
    const reviewer = item.assignedReviewerId ?? item.claimedBy
    if (!reviewer) return
    const hours = Math.max(0, Math.round((item.slaDueAt!.getTime() - now.getTime()) / 3_600_000))
    await enqueueNotification(tx, { tenantId, userId: reviewer, code: 'review_sla_warning', payload: { hours, task, itemId: item.id }, dedupKey: `review_sla_warning:${item.id}:${item.slaDueAt!.getTime()}`, refType: 'review_queue_item', refId: item.id })
    return
  }
  if (!target) return
  if (step === 'breach') {
    const hours = Math.max(0, Math.round(overdueHours(item.slaDueAt!, now)))
    await enqueueNotification(tx, { tenantId, userId: target.id, code: 'review_sla_breach', payload: { hours, task, itemId: item.id }, dedupKey: `review_sla_breach:${item.id}:${item.slaDueAt!.getTime()}`, refType: 'review_queue_item', refId: item.id })
    return
  }
  const names = await namesOf(tx, [item.userId])
  await enqueueNotification(tx, { tenantId, userId: target.id, code: 'review_escalated', payload: { task, name: names.get(item.userId) ?? '', itemId: item.id }, dedupKey: `review_escalated:${item.id}:${item.slaDueAt!.getTime()}`, refType: 'review_queue_item', refId: item.id })
}

/**
 * `review.stats_rollup` — ежедневно в 03:00 (`37` §3.4, §9.2, §11): суточная строка
 * `reviewer_stats_daily` за прошедшие сутки.
 *
 * Решения берутся из журнала (`audit_log`: `workshop.grade`, `attempt.grade`), а не из
 * текущего состояния очереди: доработанная и пересданная до ночи работа уже снова открыта, и
 * по строке очереди её решение потерялось бы. Просрочено — по факту `sla_breached_at` на
 * момент решения (§7.19), медианы реакции (сдача → взятие) и проверки (взятие → решение) — по
 * работам, закрытым в эти сутки. Делегировано «мною» и «мне» — по журналу передач. Проверок
 * собственного контента — `review.author_conflict` (§7.8). Повторный прогон за тот же день
 * переписывает строку: источники задним числом не меняются.
 */
export async function reviewStatsRollup(tenantId: string, day?: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    // Без даты — вчерашние сутки по часам базы: задача идёт в 03:00, день уже закрыт.
    const dayExpr = day ? sql`${day}::date` : sql`current_date - 1`
    const rows = await tx.execute(sql`
      with d as (select ${dayExpr} as day),
      decisions as (
        select a.actor_id as reviewer_id,
               case when a.action = 'workshop.grade' then a.after->>'decision'
                    when (a.after->>'isCorrect')::boolean then 'accepted' else 'rejected' end as decision
          from audit_log a, d
         where a.action in ('workshop.grade', 'attempt.grade') and a.actor_id is not null
           and a.created_at >= d.day and a.created_at < d.day + 1
      ),
      closed as (
        select q.* from review_queue_items q, d
         where q.status = 'done' and q.assigned_reviewer_id is not null
           and q.completed_at >= d.day and q.completed_at < d.day + 1
      ),
      moves as (
        select r.* from review_delegations r, d where r.created_at >= d.day and r.created_at < d.day + 1
      ),
      people as (
        select reviewer_id from decisions
        union select from_user_id from moves
        union select to_user_id from moves
      )
      insert into reviewer_stats_daily (tenant_id, reviewer_id, day, reviewed_count, accepted_count, rejected_count,
        rework_count, delegated_out, delegated_in, breached_count, own_content_count, median_react_sec, median_review_sec)
      select ${tenantId}::uuid, p.reviewer_id, (select day from d),
        (select count(*) from decisions x where x.reviewer_id = p.reviewer_id)::int,
        (select count(*) from decisions x where x.reviewer_id = p.reviewer_id and x.decision = 'accepted')::int,
        (select count(*) from decisions x where x.reviewer_id = p.reviewer_id and x.decision = 'rejected')::int,
        (select count(*) from decisions x where x.reviewer_id = p.reviewer_id and x.decision = 'rework')::int,
        (select count(*) from moves m where m.from_user_id = p.reviewer_id)::int,
        (select count(*) from moves m where m.to_user_id = p.reviewer_id)::int,
        (select count(*) from closed c where c.assigned_reviewer_id = p.reviewer_id and c.sla_breached_at is not null)::int,
        (select count(*) from audit_log a, d where a.actor_id = p.reviewer_id and a.action = 'review.author_conflict'
            and a.created_at >= d.day and a.created_at < d.day + 1)::int,
        (select percentile_cont(0.5) within group (order by extract(epoch from (c.claimed_at - c.submitted_at)))
           from closed c where c.assigned_reviewer_id = p.reviewer_id and c.claimed_at is not null)::int,
        (select percentile_cont(0.5) within group (order by extract(epoch from (c.completed_at - c.claimed_at)))
           from closed c where c.assigned_reviewer_id = p.reviewer_id and c.claimed_at is not null)::int
        from people p
       where p.reviewer_id is not null
      on conflict (tenant_id, reviewer_id, day) do update set
        reviewed_count = excluded.reviewed_count, accepted_count = excluded.accepted_count,
        rejected_count = excluded.rejected_count, rework_count = excluded.rework_count,
        delegated_out = excluded.delegated_out, delegated_in = excluded.delegated_in,
        breached_count = excluded.breached_count, own_content_count = excluded.own_content_count,
        median_react_sec = excluded.median_react_sec, median_review_sec = excluded.median_review_sec,
        updated_at = now()
      returning reviewer_id`) as unknown as unknown[]
    return rows.length
  })
}
