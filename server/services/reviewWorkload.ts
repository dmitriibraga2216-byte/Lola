import { and, eq, inArray, sql } from 'drizzle-orm'
import { reviewDelegations, reviewQueueItems, reviewSlaEvents, reviewerAbsences, reviewerCapacity } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { currentRequestContext } from '../utils/requestContext'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import { activeChain } from './reviewDelegation'
import { absentUserIds, gradeReviewers, isActiveEmployee, namesOf, reviewerLoads } from './reviewPeople'
import { eligibleAmong, notifyOverloaded, routeQueueItem } from './reviewRouting'
import { MAX_DELEGATION_DEPTH, claimIsLive, restingStatus } from './reviewRules'
import type { ReviewActor } from './reviewActor'
import type { ReviewAbsenceInput, ReviewCapacityInput } from '../../shared/schemas/review'
import { REVIEWER_ABSENCE_KINDS } from '../../shared/enums'
import type { ReviewerAbsenceKind } from '../../shared/enums'

/**
 * Нагрузка проверяющих: отсутствия и переброс очереди, ёмкость, экран нагрузки
 * (`docs/v2/37` §3.4, §5.3, §6.2, §7.18).
 *
 * **Отсутствие исключает человека** из распределения и из списка делегатов на весь период
 * (`reviewPeople.absentUserIds`). При `move_open_items` в день начала его открытые работы
 * переезжают: к замещающему, а без него — заново по правилам распределения. Карточки, открытые
 * прямо сейчас (`in_review`, захват моложе 30 минут), не трогаются — они освободятся сами, и их
 * заберёт следующий прогон `review.absence_apply`. Увольнение (`dismissal`) перебрасывает
 * принудительно, а переданные уволенному делегирования возвращаются делегировавшим.
 */

type Item = typeof reviewQueueItems.$inferSelect

/**
 * Причина словами для «Вам передано {N} робіт із черги {ім'я} ({причина})» (`37` §8). Подписи
 * идут по порядку справочника `REVIEWER_ABSENCE_KINDS`, а не литералами кодов: код `training`
 * совпадает с кодом этапа, и литерал здесь красил бы сквозную проверку 1.
 */
const ABSENCE_REASON_UK = ['відпустка', 'лікарняний', 'навчання', 'звільнення', 'інша причина'] as const
function absenceReasonUk(kind: ReviewerAbsenceKind): string {
  return ABSENCE_REASON_UK[REVIEWER_ABSENCE_KINDS.indexOf(kind)] ?? ''
}

export type AbsenceError = 'range_invalid' | 'self_substitute' | 'forbidden' | 'not_found' | 'substitute_invalid'

/**
 * Можно ли отмечать отсутствие этого человека (`37` §2): своё — любому проверяющему со
 * скоупом `review.absence.manage`; чужое — только тому, кто видит нагрузку других
 * (`review.workload.view`), и в своей области.
 */
async function mayManageAbsence(tx: TenantTx, actor: ReviewActor, userId: string): Promise<boolean> {
  if (userId === actor.actorId) return true
  if (!actor.can('review.workload.view')) return false
  if (actor.tenantWide('review.workload.view')) return true
  const [pl] = await tx.execute(sql`
    select location_id::text as id from user_placements
     where user_id = ${userId}::uuid and is_primary and ended_at is null limit 1`) as unknown as { id: string }[]
  return !!pl && actor.can('review.workload.view', pl.id) && actor.can('review.absence.manage', pl.id)
}

/** `POST /review/absences` (`37` §6.2, §10): запись и немедленный переброс, если отсутствие уже началось. */
export async function createAbsence(actor: ReviewActor, input: ReviewAbsenceInput): Promise<{ ok: true, absenceId: string, movedCount: number } | { ok: false, code: AbsenceError }> {
  // Увольнение бессрочно; у остального конец не раньше начала (`ra_range_chk`, `ra_dismissal_chk`).
  if (input.endsOn && input.endsOn < input.startsOn) return { ok: false, code: 'range_invalid' }
  if (input.kind === 'dismissal' && input.endsOn) return { ok: false, code: 'range_invalid' }
  if (input.substituteId && input.substituteId === input.userId) return { ok: false, code: 'self_substitute' }
  const created = await withTenant(actor.tenantId, actor.actorId, async (tx) => {
    if (!(await isActiveEmployee(tx, input.userId))) return { ok: false as const, code: 'not_found' as const }
    if (!(await mayManageAbsence(tx, actor, input.userId))) return { ok: false as const, code: 'forbidden' as const }
    if (input.substituteId && !(await isActiveEmployee(tx, input.substituteId))) return { ok: false as const, code: 'substitute_invalid' as const }
    const [row] = await tx.insert(reviewerAbsences).values({
      tenantId: actor.tenantId,
      userId: input.userId,
      kind: input.kind,
      startsOn: input.startsOn,
      endsOn: input.endsOn ?? null,
      substituteId: input.substituteId ?? null,
      moveOpenItems: input.moveOpenItems,
      createdBy: actor.actorId,
    }).returning({ id: reviewerAbsences.id })
    await recordAudit(tx, { tenantId: actor.tenantId, actorId: actor.actorId, action: 'review.absence.create', entity: 'reviewer_absence', entityId: row!.id, after: input })
    return { ok: true as const, absenceId: row!.id }
  })
  if (!created.ok) return created
  // «ежедневно 06:00 и при создании записи» (`37` §11): началось сегодня или раньше — переброс сразу.
  const movedCount = await applyAbsences(actor.tenantId, { absenceId: created.absenceId, actorId: actor.actorId })
  return { ok: true, absenceId: created.absenceId, movedCount }
}

/** `DELETE /review/absences/:id` — отмена отсутствия. Уже переехавшие работы назад не едут. */
export async function deleteAbsence(actor: ReviewActor, id: string): Promise<{ ok: true } | { ok: false, code: AbsenceError }> {
  return withTenant(actor.tenantId, actor.actorId, async (tx) => {
    const [row] = await tx.select().from(reviewerAbsences).where(eq(reviewerAbsences.id, id))
    if (!row) return { ok: false as const, code: 'not_found' as const }
    if (!(await mayManageAbsence(tx, actor, row.userId))) return { ok: false as const, code: 'forbidden' as const }
    await tx.delete(reviewerAbsences).where(eq(reviewerAbsences.id, id))
    await recordAudit(tx, { tenantId: actor.tenantId, actorId: actor.actorId, action: 'review.absence.delete', entity: 'reviewer_absence', entityId: id, before: row })
    return { ok: true as const }
  })
}

/**
 * Работу делегировали отсутствующему — передать её дальше его замещающему звеном `absence`
 * (`37` §7.18: «все его waiting и delegated работы переходят на substitute_id»). Звено нельзя
 * добавить, если цепочка уже предельной глубины или замещающий в ней уже есть, — тогда работа
 * возвращается тому, кто её делегировал (`revoked_sla`: делегат не может уложиться в срок).
 */
async function forwardDelegated(tx: TenantTx, tenantId: string, item: Item, substituteId: string | null, now: Date): Promise<string | null> {
  const chain = await activeChain(tx, item.id)
  const link = chain[chain.length - 1]
  if (!link) return null
  const inChain = new Set([item.originReviewerId, ...chain.flatMap(d => [d.fromUserId, d.toUserId])])
  const eligible = substituteId && !inChain.has(substituteId) && item.delegationDepth < MAX_DELEGATION_DEPTH
    ? (await eligibleAmong(tx, item, [substituteId])).length > 0
    : false
  if (eligible && substituteId) {
    const [d] = await tx.insert(reviewDelegations).values({
      tenantId,
      queueItemId: item.id,
      fromUserId: link.toUserId,
      toUserId: substituteId,
      depth: link.depth + 1,
      reasonCode: 'absence',
      dueAt: link.dueAt,
      requestContext: currentRequestContext(),
    }).returning({ id: reviewDelegations.id })
    await tx.update(reviewQueueItems).set({
      assignedReviewerId: substituteId,
      assignedAt: now,
      delegationId: d!.id,
      delegationDepth: link.depth + 1,
      status: restingStatus({ delegationId: d!.id, escalatedAt: item.escalatedAt }),
      claimedBy: null,
      claimedAt: null,
      updatedAt: now,
    }).where(eq(reviewQueueItems.id, item.id))
    return substituteId
  }
  // Вернуть делегировавшему: звено закрыто по сроку делегата, выше — снова текущее.
  await tx.update(reviewDelegations).set({ state: 'revoked_sla', resolvedAt: now, updatedAt: now })
    .where(and(eq(reviewDelegations.queueItemId, item.id), eq(reviewDelegations.state, 'active'), sql`${reviewDelegations.depth} >= ${link.depth}`))
  const parent = chain.find(d => d.depth === link.depth - 1) ?? null
  await tx.update(reviewQueueItems).set({
    assignedReviewerId: link.fromUserId,
    assignedAt: now,
    delegationId: parent?.id ?? null,
    delegationDepth: link.depth - 1,
    originReviewerId: parent ? item.originReviewerId : null,
    status: restingStatus({ delegationId: parent?.id ?? null, escalatedAt: item.escalatedAt }),
    claimedBy: null,
    claimedAt: null,
    updatedAt: now,
  }).where(eq(reviewQueueItems.id, item.id))
  await enqueueNotification(tx, {
    tenantId,
    userId: link.fromUserId,
    code: 'review_delegation_expired',
    payload: { task: item.taskTitle ?? '', toYou: true, itemId: item.id },
    dedupKey: `review_delegation_expired:${link.id}:${link.fromUserId}`,
  })
  return link.fromUserId
}

/**
 * `review.absence_apply` (`37` §11): ежедневно в 06:00 и сразу при создании записи. Для
 * каждого отсутствия, действующего сегодня и требующего переброса (или увольнения), открытые
 * работы человека уходят замещающему, а без него — по правилам распределения. Повторный
 * прогон безопасен: перебрасывается только то, что сейчас числится за отсутствующим.
 */
export async function applyAbsences(tenantId: string, opts: { absenceId?: string, actorId?: string | null, day?: string, now?: Date } = {}): Promise<number> {
  return withTenant(tenantId, opts.actorId ?? null, async (tx) => {
    const now = opts.now ?? new Date()
    const day = opts.day ? sql`${opts.day}::date` : sql`current_date`
    const absences = await tx.select().from(reviewerAbsences).where(and(
      sql`${reviewerAbsences.startsOn} <= ${day}`,
      sql`(${reviewerAbsences.endsOn} is null or ${reviewerAbsences.endsOn} >= ${day})`,
      sql`(${reviewerAbsences.moveOpenItems} or ${reviewerAbsences.kind} = 'dismissal')`,
      ...(opts.absenceId ? [eq(reviewerAbsences.id, opts.absenceId)] : []),
    ))
    let moved = 0
    for (const a of absences) moved += await moveQueueOf(tx, tenantId, a.userId, a.substituteId, a.kind as ReviewerAbsenceKind, now)
    return moved
  })
}

/** Переброс открытой очереди одного человека. Возвращает, сколько работ переехало. */
async function moveQueueOf(tx: TenantTx, tenantId: string, userId: string, substituteId: string | null, kind: ReviewerAbsenceKind, now: Date): Promise<number> {
  const items = await tx.select().from(reviewQueueItems).where(and(
    eq(reviewQueueItems.assignedReviewerId, userId),
    inArray(reviewQueueItems.status, ['waiting', 'delegated', 'escalated', 'in_review']),
  ))
  // Замещающий сам может быть в отпуске — тогда его как будто нет.
  const substitute = substituteId && !(await absentUserIds(tx, { userIds: [substituteId] })).has(substituteId) && await isActiveEmployee(tx, substituteId)
    ? substituteId
    : null
  const receivers = new Map<string, number>()
  for (const item of items) {
    // Открытая карточка не вырывается из рук: 30 минут, и она освободится сама (`37` §7.18).
    if (item.claimedBy && claimIsLive(item.claimedAt, now)) continue
    let to: string | null = null
    if (item.delegationId) {
      to = await forwardDelegated(tx, tenantId, item, kind === 'dismissal' ? null : substitute, now)
    }
    else if (substitute && (await eligibleAmong(tx, item, [substitute])).length) {
      await tx.update(reviewQueueItems).set({
        assignedReviewerId: substitute,
        assignedAt: now,
        assignedByRuleId: null,
        status: restingStatus(item),
        claimedBy: null,
        claimedAt: null,
        updatedAt: now,
      }).where(eq(reviewQueueItems.id, item.id))
      to = substitute
    }
    else {
      // Без замещающего — заново по правилам; правил нет или некому — в общий пул.
      await tx.update(reviewQueueItems).set({ assignedReviewerId: null, assignedAt: null, assignedByRuleId: null, claimedBy: null, claimedAt: null, status: restingStatus(item), updatedAt: now })
        .where(eq(reviewQueueItems.id, item.id))
      const r = await routeQueueItem(tx, tenantId, item.id, { reason: 'absence', exclude: [userId], notify: false })
      to = r.assignedTo
    }
    await tx.insert(reviewSlaEvents).values({
      tenantId,
      queueItemId: item.id,
      reviewerId: userId,
      event: 'reassigned',
      dueAt: item.slaDueAt,
      targetId: to,
      details: { absence: kind },
      requestContext: currentRequestContext(),
    })
    if (to) receivers.set(to, (receivers.get(to) ?? 0) + 1)
  }

  // «Вам передано {N} робіт із черги {ім'я} ({причина})» — одно уведомление на получателя.
  if (receivers.size) {
    const names = await namesOf(tx, [userId])
    for (const [to, n] of receivers) {
      await enqueueNotification(tx, {
        tenantId,
        userId: to,
        code: 'review_queue_moved',
        payload: { n, name: names.get(userId) ?? '', reason: absenceReasonUk(kind) },
        dedupKey: `review_queue_moved:${userId}:${to}:${now.toISOString().slice(0, 13)}`,
      })
      await notifyOverloaded(tx, tenantId, to)
    }
  }
  return [...receivers.values()].reduce((s, n) => s + n, 0)
}

/** «Змінити ліміт» (`37` §5.3) и «приймаю делегування» (§7.2 (д)): своё — сам, чужое — руководитель. */
export async function updateCapacity(actor: ReviewActor, userId: string, input: ReviewCapacityInput): Promise<{ ok: true } | { ok: false, code: 'forbidden' | 'not_found' }> {
  return withTenant(actor.tenantId, actor.actorId, async (tx) => {
    if (!(await isActiveEmployee(tx, userId))) return { ok: false as const, code: 'not_found' as const }
    const self = userId === actor.actorId
    // Себе — только «приймаю делегування»; лимит и виды работ назначает руководитель.
    const onlyAccepts = input.maxOpenItems === undefined && input.dailyTarget === undefined && input.taskTypes === undefined
    if (!(self && onlyAccepts) && !(await mayManageAbsence(tx, actor, userId) && actor.can('review.workload.view'))) return { ok: false as const, code: 'forbidden' as const }
    const set = {
      ...(input.maxOpenItems !== undefined ? { maxOpenItems: input.maxOpenItems } : {}),
      ...(input.dailyTarget !== undefined ? { dailyTarget: input.dailyTarget } : {}),
      ...(input.acceptsDelegation !== undefined ? { acceptsDelegation: input.acceptsDelegation } : {}),
      ...(input.taskTypes !== undefined ? { taskTypes: input.taskTypes } : {}),
    }
    await tx.insert(reviewerCapacity).values({ tenantId: actor.tenantId, userId, ...set })
      .onConflictDoUpdate({ target: [reviewerCapacity.tenantId, reviewerCapacity.userId], set: { ...set, updatedAt: new Date() } })
    await recordAudit(tx, { tenantId: actor.tenantId, actorId: actor.actorId, action: 'review.capacity.update', entity: 'reviewer_capacity', entityId: userId, after: input })
    return { ok: true as const }
  })
}

export interface WorkloadRow {
  userId: string
  fullName: string
  open: number
  max: number
  overloaded: boolean
  reviewed7d: number
  medianReactHours: number | null
  overdue: number
  delegatedToMe: number
  delegatedByMe: number
  acceptsDelegation: boolean
  absence: { id: string, kind: string, endsOn: string | null } | null
}

/**
 * Экран нагрузки (`37` §5.3, §10 `GET /review/workload`): проверяющие области — открыто /
 * лимит, проверено за 7 дней, медиана реакции, просрочено, делегировано, присутствие.
 * Область — скоуп `review.workload.view`: вся сеть или точки роли.
 */
export async function listWorkload(actor: ReviewActor, filter: { locationId?: string }): Promise<WorkloadRow[]> {
  return withTenant(actor.tenantId, actor.actorId, async (tx) => {
    const areas = actor.tenantWide('review.workload.view') ? null : actor.locations('review.workload.view')
    let ids: string[]
    if (filter.locationId) {
      if (areas && !areas.includes(filter.locationId)) return []
      ids = await gradeReviewers(tx, { locationId: filter.locationId })
    }
    else if (areas) {
      ids = [...new Set((await Promise.all(areas.map(l => gradeReviewers(tx, { locationId: l, pointLevelOnly: true })))).flat())]
    }
    else {
      ids = await gradeReviewers(tx, { locationId: null })
    }
    if (!ids.length) return []
    const list = sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)
    const loads = await reviewerLoads(tx, ids)
    const names = await namesOf(tx, ids)
    const stats = await tx.execute(sql`
      select u.id::text as id,
        (select count(*)::int from review_queue_items q where q.assigned_reviewer_id = u.id and q.status = 'done'
           and q.completed_at >= now() - interval '7 days') as reviewed7d,
        (select percentile_cont(0.5) within group (order by extract(epoch from (q.claimed_at - q.submitted_at)) / 3600)
           from review_queue_items q where q.assigned_reviewer_id = u.id and q.status = 'done' and q.claimed_at is not null
            and q.completed_at >= now() - interval '7 days') as react,
        (select count(*)::int from review_queue_items q where q.assigned_reviewer_id = u.id and q.status <> 'done'
           and q.sla_due_at < now()) as overdue,
        (select count(*)::int from review_delegations d where d.to_user_id = u.id and d.state = 'active') as delegated_in,
        (select count(*)::int from review_delegations d where d.from_user_id = u.id and d.state = 'active') as delegated_out,
        (select json_build_object('id', a.id, 'kind', a.kind, 'endsOn', a.ends_on) from reviewer_absences a
          where a.user_id = u.id and a.starts_on <= current_date and (a.ends_on is null or a.ends_on >= current_date)
          order by a.starts_on desc limit 1) as absence
      from unnest(array[${list}]::uuid[]) as u(id)`) as unknown as { id: string, reviewed7d: number, react: number | null, overdue: number, delegated_in: number, delegated_out: number, absence: WorkloadRow['absence'] }[]
    return stats.map((s) => {
      const l = loads.get(s.id)!
      return {
        userId: s.id,
        fullName: names.get(s.id) ?? '',
        open: l.open,
        max: l.max,
        overloaded: l.open >= l.max,
        reviewed7d: s.reviewed7d,
        medianReactHours: s.react != null ? Math.round(Number(s.react) * 10) / 10 : null,
        overdue: s.overdue,
        delegatedToMe: s.delegated_in,
        delegatedByMe: s.delegated_out,
        acceptsDelegation: l.acceptsDelegation,
        absence: s.absence,
      }
    }).sort((a, b) => a.fullName.localeCompare(b.fullName, 'uk'))
  })
}
