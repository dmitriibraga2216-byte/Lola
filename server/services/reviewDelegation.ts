import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm'
import { reviewDelegations, reviewQueueItems, reviewSlaEvents, workshopSubmissions } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { currentRequestContext } from '../utils/requestContext'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import { absentUserIds, gradeReviewers, isActiveEmployee, managerChainOf, namesOf, reviewerLoads, tenantAdmins } from './reviewPeople'
import { notifyAssigned, notifyOverloaded } from './reviewRouting'
import { BULK_DELEGATE_LIMIT, MAX_DELEGATION_DEPTH, claimIsLive, delegationDueCheck, restingStatus } from './reviewRules'
import type { ReviewActor } from './reviewActor'
import type { ReviewBulkDelegateInput, ReviewDelegateInput } from '../../shared/schemas/review'
import type { ReviewDelegationState } from '../../shared/enums'

/**
 * Делегирование проверки (`docs/v2/37` §7.1–7.6, §10).
 *
 * **Модель — передача ответственности, а не второй проверяющий** (§7.1). Делегат становится
 * единственным ответственным: `assigned_reviewer_id` переходит к нему, работа уходит из «Мої»
 * делегировавшего и появляется в «Мої» и «Делеговані мені» делегата; делегировавший видит её
 * на «Делеговані мною». Решение делегата окончательное (§7.4): возврата на утверждение нет.
 *
 * **Цепочка A→B→C** — по строке на звено, глубина 1 и 2; пока работа у C, оба звена
 * `active` (Р-19.3), `review_queue_items.delegation_id` смотрит на самое глубокое. Истечение
 * срока или отзыв звена закрывает его и всё, что ниже, и возвращает работу тому, кто это
 * звено создал, с глубиной на единицу меньше.
 *
 * **Чего делегирование не делает никогда:**
 *   - не двигает `sla_due_at` — иначе оно было бы бесплатным продлением срока (§7.5);
 *   - не расширяет доступ к персональным данным кандидата (сквозная проверка 20, `42` §5):
 *     делегат видит работу в объёме карточки проверки, карточка кандидата ему не открывается
 *     (`candidates.ts`, `scopeCond`).
 */

type Item = typeof reviewQueueItems.$inferSelect
type Delegation = typeof reviewDelegations.$inferSelect

export type DelegateError =
  | 'not_found' | 'forbidden' | 'depth_exceeded' | 'already_in_review'
  | 'due_too_soon' | 'due_too_late' | 'target_forbidden' | 'target_declines' | 'cycle'

export type RevokeError = 'not_found' | 'forbidden' | 'closed' | 'in_progress' | 'reason_required'
export type ReassignError = 'not_found' | 'forbidden' | 'target_forbidden' | 'target_declines'

/** Элемент под блокировкой строки: два делегирования одной работы не должны пройти параллельно. */
async function lockItem(tx: TenantTx, itemId: string): Promise<Item | null> {
  const [item] = await tx.select().from(reviewQueueItems).where(eq(reviewQueueItems.id, itemId)).for('update')
  return item ?? null
}

/** Активные звенья цепочки элемента — от первого к самому глубокому. */
export async function activeChain(tx: TenantTx, itemId: string): Promise<Delegation[]> {
  return tx.select().from(reviewDelegations)
    .where(and(eq(reviewDelegations.queueItemId, itemId), eq(reviewDelegations.state, 'active')))
    .orderBy(asc(reviewDelegations.depth))
}

/**
 * Сдача практикума не должна остаться «в перевірці», если её захват в очереди сняли
 * делегированием, отзывом или переназначением у неё из-под рук: `claim()` — единственный
 * писатель, который переводит статус в `in_review`, и снятый захват обязан вернуть его
 * обратно (зеркала `reviewer_id` / `claimed_at` больше нет — PR-20, В-2).
 */
async function resetWorkshopStatusIfClaimed(tx: TenantTx, item: Item): Promise<void> {
  if (item.taskType !== 'workshop' || !item.claimedBy) return
  await tx.update(workshopSubmissions).set({ status: 'submitted', updatedAt: new Date() })
    .where(and(eq(workshopSubmissions.id, item.sourceId), eq(workshopSubmissions.status, 'in_review')))
}

async function slaEvent(tx: TenantTx, tenantId: string, item: Item, event: 'reassigned' | 'delegation_expired', reviewerId: string | null, targetId: string | null, details: Record<string, unknown>): Promise<void> {
  await tx.insert(reviewSlaEvents).values({
    tenantId,
    queueItemId: item.id,
    reviewerId,
    event,
    dueAt: item.slaDueAt,
    targetId,
    details,
    requestContext: currentRequestContext(),
  })
}

/**
 * Кто передаёт работу. Назначенный передаёт свою; работу из общего пула — тот, кто вправе
 * проверить её сам (без назначения «своей» она у каждого проверяющего); чужую — только
 * руководитель со скоупом `review.delegate.any` в области точки (§2), и тогда звено
 * записывается от имени текущего ответственного, а кто нажал кнопку — видно в `audit_log`.
 */
async function delegatorOf(tx: TenantTx, actor: ReviewActor, item: Item): Promise<string | null> {
  if (item.assignedReviewerId === actor.actorId) return actor.actorId
  if (item.assignedReviewerId === null) {
    const own = await gradeReviewers(tx, { locationId: item.locationId, onlyIds: [actor.actorId] })
    return own.length || actor.can('review.delegate.any', item.locationId) ? actor.actorId : null
  }
  return actor.can('review.delegate.any', item.locationId) ? item.assignedReviewerId : null
}

/** Все, кто уже в цепочке этой работы: делегировать любому из них — цикл (§7.3). */
function chainPeople(item: Item, chain: Delegation[], from: string): Set<string> {
  const out = new Set<string>([from])
  if (item.originReviewerId) out.add(item.originReviewerId)
  if (item.assignedReviewerId) out.add(item.assignedReviewerId)
  for (const d of chain) {
    out.add(d.fromUserId)
    out.add(d.toUserId)
  }
  return out
}

/**
 * Может ли этот человек принять именно эту работу (`37` §7.2): (а) право `review.grade`,
 * (б) область покрывает точку работы, (в) для кандидата — то же право на назначенную
 * проверку (`28` §2: наставник оценивает работу кандидата по своим проверкам, контакты ему
 * не нужны и не открываются), (г) не сам проверяемый — `target_forbidden`; (д) не принимает
 * делегирование, отсутствует или не берёт этот вид работ — `target_declines`. Отсутствие
 * проверяется в момент выполнения, а не в момент открытия формы (§12).
 */
async function targetCheck(tx: TenantTx, item: Item, targetId: string): Promise<'ok' | 'target_forbidden' | 'target_declines'> {
  if (targetId === item.userId) return 'target_forbidden'
  const graded = await gradeReviewers(tx, { locationId: item.locationId, onlyIds: [targetId] })
  if (!graded.length) return 'target_forbidden'
  const absent = await absentUserIds(tx, { userIds: [targetId] })
  const load = (await reviewerLoads(tx, [targetId])).get(targetId)
  if (absent.has(targetId) || load?.acceptsDelegation === false) return 'target_declines'
  if (load?.taskTypes.length && !load.taskTypes.includes(item.taskType)) return 'target_declines'
  return 'ok'
}

type DelegateResult = { ok: true, delegationId: string, item: Item } | { ok: false, code: DelegateError }

/** Делегирование внутри уже открытой транзакции — общий код одиночной и массовой передачи. */
async function delegateInTx(tx: TenantTx, actor: ReviewActor, itemId: string, input: ReviewDelegateInput, now: Date): Promise<DelegateResult> {
  const item = await lockItem(tx, itemId)
  // Своя работа не видна проверяющему никогда (§7.7) — и её существование не подтверждается.
  if (!item || item.status === 'done' || item.userId === actor.actorId) return { ok: false, code: 'not_found' }
  const from = await delegatorOf(tx, actor, item)
  if (!from) return { ok: false, code: 'forbidden' }

  const depth = item.delegationDepth + 1
  if (depth > MAX_DELEGATION_DEPTH) return { ok: false, code: 'depth_exceeded' }
  if (item.claimedBy && item.claimedBy !== actor.actorId && claimIsLive(item.claimedAt, now)) return { ok: false, code: 'already_in_review' }

  const chain = await activeChain(tx, item.id)
  const parent = chain[chain.length - 1] ?? null
  const limits = [item.slaDueAt, parent?.dueAt].filter((d): d is Date => !!d)
  const limit = limits.length ? new Date(Math.min(...limits.map(d => d.getTime()))) : null
  const due = new Date(input.dueAt)
  const dueCheck = delegationDueCheck(now, due, limit)
  if (dueCheck !== 'ok') return { ok: false, code: dueCheck === 'too_soon' ? 'due_too_soon' : 'due_too_late' }

  if (chainPeople(item, chain, from).has(input.toUserId)) return { ok: false, code: 'cycle' }
  const target = await targetCheck(tx, item, input.toUserId)
  if (target !== 'ok') return { ok: false, code: target }

  const [d] = await tx.insert(reviewDelegations).values({
    tenantId: actor.tenantId,
    queueItemId: item.id,
    fromUserId: from,
    toUserId: input.toUserId,
    depth,
    reasonCode: input.reasonCode,
    reasonText: input.reasonText || null,
    dueAt: due,
    requestContext: currentRequestContext(),
  }).returning()

  await resetWorkshopStatusIfClaimed(tx, item)
  const [updated] = await tx.update(reviewQueueItems).set({
    assignedReviewerId: input.toUserId,
    assignedAt: now,
    delegationId: d!.id,
    // Первый в цепочке не меняется при A→B→C (§7.3).
    originReviewerId: item.originReviewerId && chain.length ? item.originReviewerId : from,
    delegationDepth: depth,
    status: restingStatus({ delegationId: d!.id, escalatedAt: item.escalatedAt }),
    claimedBy: null,
    claimedAt: null,
    // Срок проверки не трогается — ни здесь, ни где-либо ещё при передаче (§7.5).
    updatedAt: now,
  }).where(eq(reviewQueueItems.id, item.id)).returning()

  await slaEvent(tx, actor.tenantId, item, 'reassigned', from, input.toUserId, { delegationId: d!.id, depth, reasonCode: input.reasonCode })
  await recordAudit(tx, {
    tenantId: actor.tenantId,
    actorId: actor.actorId,
    action: 'review.delegate',
    entity: 'review_queue_item',
    entityId: item.id,
    before: { assignedReviewerId: item.assignedReviewerId, delegationDepth: item.delegationDepth },
    after: { delegationId: d!.id, from, to: input.toUserId, depth, reasonCode: input.reasonCode, dueAt: due.toISOString() },
  })
  if (input.notify) {
    const names = await namesOf(tx, [from])
    await enqueueNotification(tx, {
      tenantId: actor.tenantId,
      userId: input.toUserId,
      code: 'review_delegated',
      payload: { name: names.get(from) ?? '', task: item.taskTitle ?? '', due: due.toISOString(), itemId: item.id },
      dedupKey: `review_delegated:${d!.id}`,
      refType: 'review_queue_item',
      refId: item.id,
    })
  }
  await notifyOverloaded(tx, actor.tenantId, input.toUserId)
  return { ok: true, delegationId: d!.id, item: updated! }
}

/** `POST /review/items/:id/delegate` (`37` §10). */
export async function delegateItem(actor: ReviewActor, itemId: string, input: ReviewDelegateInput, now: Date = new Date()): Promise<DelegateResult> {
  return withTenant(actor.tenantId, actor.actorId, tx => delegateInTx(tx, actor, itemId, input, now))
}

/**
 * «Делегувати обрані» (`37` §5.1, §10): до 25 работ одному делегату с одной причиной. Каждая
 * работа — в своей точке сохранения: отказ по одной не откатывает остальные, а попадает в
 * `failed` со своим кодом. Лимит делегата здесь не запрет (§12: 25 работ человеку с лимитом
 * 20 проходят, руководитель получает `review_overloaded`).
 */
export async function bulkDelegate(actor: ReviewActor, input: ReviewBulkDelegateInput, now: Date = new Date()): Promise<{ ok: false, code: 'bulk_limit' } | { ok: true, delegated: string[], failed: { id: string, code: DelegateError }[] }> {
  const ids = [...new Set(input.itemIds)]
  if (ids.length > BULK_DELEGATE_LIMIT) return { ok: false, code: 'bulk_limit' }
  return withTenant(actor.tenantId, actor.actorId, async (tx) => {
    const delegated: string[] = []
    const failed: { id: string, code: DelegateError }[] = []
    for (const id of ids) {
      const r = await tx.transaction(sp => delegateInTx(sp, actor, id, { ...input, notify: input.notify }, now))
        .catch(() => ({ ok: false as const, code: 'not_found' as DelegateError }))
      if (r.ok) delegated.push(id)
      else failed.push({ id, code: r.code })
    }
    return { ok: true as const, delegated, failed }
  })
}

/**
 * Закрыть звено и всё, что ниже, и вернуть работу тому, кто это звено создал (`37` §7.5,
 * §7.6). Глубина — на единицу меньше; если выше есть звено — оно снова текущее. Захват
 * снимается: работа возвращается не тому, у кого открыта карточка.
 */
async function unwindTo(tx: TenantTx, item: Item, link: Delegation, state: ReviewDelegationState, now: Date, revokedBy: string | null, reason: string | null): Promise<Item> {
  await tx.update(reviewDelegations).set({ state, resolvedAt: now, revokedBy, revokeReason: reason, updatedAt: now })
    .where(and(eq(reviewDelegations.queueItemId, item.id), eq(reviewDelegations.state, 'active'), gte(reviewDelegations.depth, link.depth)))
  const [parent] = await tx.select().from(reviewDelegations)
    .where(and(eq(reviewDelegations.queueItemId, item.id), eq(reviewDelegations.state, 'active'), eq(reviewDelegations.depth, link.depth - 1)))
  await resetWorkshopStatusIfClaimed(tx, item)
  const [updated] = await tx.update(reviewQueueItems).set({
    assignedReviewerId: link.fromUserId,
    assignedAt: now,
    delegationId: parent?.id ?? null,
    delegationDepth: link.depth - 1,
    originReviewerId: parent ? item.originReviewerId : null,
    status: restingStatus({ delegationId: parent?.id ?? null, escalatedAt: item.escalatedAt }),
    claimedBy: null,
    claimedAt: null,
    updatedAt: now,
  }).where(eq(reviewQueueItems.id, item.id)).returning()
  return updated!
}

/**
 * `POST /review/delegations/:id/revoke` (`37` §7.6). Автор отзывает, пока работа ждёт
 * (`waiting` / `delegated`); как только делегат открыл карточку — `409
 * review.delegation_in_progress`. Руководитель со скоупом `review.delegate.any` в области
 * точки отзывает и тогда, но только с причиной. Любой отзыв — в `audit_log`.
 */
export async function revokeDelegation(actor: ReviewActor, delegationId: string, input: { reason?: string }, now: Date = new Date()): Promise<{ ok: true, item: Item } | { ok: false, code: RevokeError }> {
  return withTenant(actor.tenantId, actor.actorId, async (tx) => {
    const [link] = await tx.select().from(reviewDelegations).where(eq(reviewDelegations.id, delegationId))
    if (!link) return { ok: false as const, code: 'not_found' as const }
    const item = await lockItem(tx, link.queueItemId)
    if (!item) return { ok: false as const, code: 'not_found' as const }
    const isAuthor = link.fromUserId === actor.actorId
    const isManager = actor.can('review.delegate.any', item.locationId)
    if (!isAuthor && !isManager) return { ok: false as const, code: 'forbidden' as const }
    if (link.state !== 'active' || item.status === 'done') return { ok: false as const, code: 'closed' as const }

    const inProgress = !!item.claimedBy && item.claimedBy !== actor.actorId && claimIsLive(item.claimedAt, now)
    if (inProgress && !isManager) return { ok: false as const, code: 'in_progress' as const }
    const byManager = inProgress || !isAuthor
    const reason = input.reason?.trim() || null
    if (byManager && !reason) return { ok: false as const, code: 'reason_required' as const }

    const state: ReviewDelegationState = byManager ? 'revoked_by_manager' : 'revoked_by_author'
    const updated = await unwindTo(tx, item, link, state, now, actor.actorId, reason)
    await slaEvent(tx, actor.tenantId, item, 'reassigned', link.toUserId, link.fromUserId, { delegationId: link.id, revoked: state })
    await recordAudit(tx, {
      tenantId: actor.tenantId,
      actorId: actor.actorId,
      action: 'review.delegation_revoke',
      entity: 'review_delegation',
      entityId: link.id,
      before: { state: link.state, assignedReviewerId: item.assignedReviewerId, inReview: inProgress },
      after: { state, returnedTo: link.fromUserId, reason },
    })
    const names = await namesOf(tx, [actor.actorId])
    await enqueueNotification(tx, {
      tenantId: actor.tenantId,
      userId: link.toUserId,
      code: 'review_delegation_revoked',
      payload: { name: names.get(actor.actorId) ?? '', task: item.taskTitle ?? '', itemId: item.id },
      dedupKey: `review_delegation_revoked:${link.id}`,
      refType: 'review_queue_item',
      refId: item.id,
    })
    return { ok: true as const, item: updated }
  })
}

/**
 * `POST /review/items/:id/reassign` (`37` §5.1, §10) — руководитель передаёт работу напрямую,
 * без цепочки: активные звенья закрываются `revoked_by_manager` с его причиной, работа
 * назначается вручную (`assigned_by_rule_id = null`). Срок проверки не двигается.
 */
export async function reassignItem(actor: ReviewActor, itemId: string, input: { toUserId: string, reason: string }, now: Date = new Date()): Promise<{ ok: true, item: Item } | { ok: false, code: ReassignError }> {
  return withTenant(actor.tenantId, actor.actorId, async (tx) => {
    const item = await lockItem(tx, itemId)
    if (!item || item.status === 'done' || item.userId === actor.actorId) return { ok: false as const, code: 'not_found' as const }
    if (!actor.can('review.delegate.any', item.locationId)) return { ok: false as const, code: 'forbidden' as const }
    const target = await targetCheck(tx, item, input.toUserId)
    if (target === 'target_forbidden') return { ok: false as const, code: target }
    // Отсутствующему передавать нельзя и вручную; «не принимаю делегирование» — про делегирование,
    // а не про решение руководителя.
    if ((await absentUserIds(tx, { userIds: [input.toUserId] })).has(input.toUserId)) return { ok: false as const, code: 'target_declines' as const }

    await tx.update(reviewDelegations).set({ state: 'revoked_by_manager', resolvedAt: now, revokedBy: actor.actorId, revokeReason: input.reason, updatedAt: now })
      .where(and(eq(reviewDelegations.queueItemId, item.id), eq(reviewDelegations.state, 'active')))
    await resetWorkshopStatusIfClaimed(tx, item)
    const [updated] = await tx.update(reviewQueueItems).set({
      assignedReviewerId: input.toUserId,
      assignedAt: now,
      assignedByRuleId: null,
      delegationId: null,
      delegationDepth: 0,
      originReviewerId: null,
      status: restingStatus({ delegationId: null, escalatedAt: item.escalatedAt }),
      claimedBy: null,
      claimedAt: null,
      updatedAt: now,
    }).where(eq(reviewQueueItems.id, item.id)).returning()

    await slaEvent(tx, actor.tenantId, item, 'reassigned', item.assignedReviewerId, input.toUserId, { manual: true })
    await recordAudit(tx, {
      tenantId: actor.tenantId,
      actorId: actor.actorId,
      action: 'review.reassign',
      entity: 'review_queue_item',
      entityId: item.id,
      before: { assignedReviewerId: item.assignedReviewerId, delegationId: item.delegationId },
      after: { assignedReviewerId: input.toUserId, reason: input.reason },
    })
    await notifyAssigned(tx, actor.tenantId, item, input.toUserId)
    await notifyOverloaded(tx, actor.tenantId, input.toUserId)
    return { ok: true as const, item: updated! }
  })
}

export interface DelegateTarget {
  id: string
  fullName: string
  open: number
  max: number
  overloaded: boolean
}

/**
 * Кому можно передать эту работу (`37` §6.1 «список отфильтрован заранее: недоступные не
 * показываются вовсе»). Те же проверки, что и при самой передаче, — чтобы форма не предлагала
 * человека, на котором сервер потом ответит отказом. Подсказка «У {ім'я} зараз {N} робіт у
 * черзі, ліміт {M}» — из `open` / `max`.
 */
export async function delegateTargets(actor: ReviewActor, itemId: string): Promise<DelegateTarget[] | null> {
  return withTenant(actor.tenantId, actor.actorId, async (tx) => {
    const [item] = await tx.select().from(reviewQueueItems).where(eq(reviewQueueItems.id, itemId))
    if (!item || item.status === 'done' || item.userId === actor.actorId) return null
    const from = await delegatorOf(tx, actor, item)
    if (!from) return null
    const chain = await activeChain(tx, item.id)
    const people = chainPeople(item, chain, from)
    const graded = (await gradeReviewers(tx, { locationId: item.locationId })).filter(id => id !== item.userId && !people.has(id))
    const absent = await absentUserIds(tx, { userIds: graded })
    const loads = await reviewerLoads(tx, graded)
    const names = await namesOf(tx, graded)
    return graded
      .filter((id) => {
        const l = loads.get(id)
        if (absent.has(id) || l?.acceptsDelegation === false) return false
        return !l?.taskTypes.length || l.taskTypes.includes(item.taskType)
      })
      .map((id) => {
        const l = loads.get(id)!
        return { id, fullName: names.get(id) ?? '', open: l.open, max: l.max, overloaded: l.open >= l.max }
      })
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'uk'))
  })
}

// ── Закрытие работы и истечение сроков ───────────────────────────────────────────────────

/**
 * Работа закрыта — что с её делегированием (`37` §7.4). Решение принято: все активные звенья
 * `resolved`, каждому делегировавшему — `review_delegation_resolved` с результатом; если он
 * уже уволен, уведомление уходит руководителю области вместо него (§12). Работа закрыта без
 * решения (аннулирована попытка, истекла доработка) — звенья `cancelled`.
 */
export async function closeDelegations(tx: TenantTx, tenantId: string, items: Pick<Item, 'id' | 'userId' | 'taskTitle'>[], opts: { deciderId: string | null, decision: string | null, at: Date }): Promise<void> {
  if (!items.length) return
  const links = await tx.select().from(reviewDelegations).where(and(
    inArray(reviewDelegations.queueItemId, items.map(i => i.id)),
    eq(reviewDelegations.state, 'active'),
  ))
  if (!links.length) return
  const state: ReviewDelegationState = opts.deciderId ? 'resolved' : 'cancelled'
  await tx.update(reviewDelegations).set({ state, resolvedAt: opts.at, updatedAt: opts.at })
    .where(inArray(reviewDelegations.id, links.map(l => l.id)))
  if (!opts.deciderId) return

  const names = await namesOf(tx, [opts.deciderId])
  for (const item of items) {
    const from = [...new Set(links.filter(l => l.queueItemId === item.id).map(l => l.fromUserId))]
    for (const person of from) {
      if (person === opts.deciderId) continue
      let target: string | undefined = person
      if (!(await isActiveEmployee(tx, person))) {
        target = (await managerChainOf(tx, tenantId, item.userId))[0] ?? (await tenantAdmins(tx))[0]
      }
      if (!target || target === opts.deciderId) continue
      await enqueueNotification(tx, {
        tenantId,
        userId: target,
        code: 'review_delegation_resolved',
        payload: { name: names.get(opts.deciderId) ?? '', task: item.taskTitle ?? '', decision: opts.decision ?? '', itemId: item.id },
        dedupKey: `review_delegation_resolved:${item.id}:${person}:${opts.at.getTime()}`,
        refType: 'review_queue_item',
        refId: item.id,
      })
    }
  }
}

/**
 * `review.delegation_expire` — каждые 15 минут (`37` §7.5, §11). В срок делегирования работа
 * **автоматически** возвращается делегировавшему: `revoked_sla`, глубина на единицу меньше,
 * обоим `review_delegation_expired`, в журнал SLA — `delegation_expired`. Исходный `sla_due_at`
 * не сдвигается.
 *
 * Одно послабление — открытая прямо сейчас карточка (захват моложе 30 минут) не вырывается
 * из рук: возврат случится на следующем прогоне, когда захват протухнет. Тот же принцип, что
 * у переброса очереди отсутствующего (`37` §7.18: «работы в in_review не трогаются 30 минут»).
 */
export async function expireDelegations(tenantId: string, now: Date = new Date()): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const due = await tx.select({ id: reviewDelegations.id }).from(reviewDelegations)
      .innerJoin(reviewQueueItems, eq(reviewQueueItems.id, reviewDelegations.queueItemId))
      .where(and(
        eq(reviewDelegations.state, 'active'),
        sql`${reviewDelegations.dueAt} <= ${now.toISOString()}::timestamptz`,
        sql`${reviewQueueItems.status} <> 'done'`,
      ))
      .orderBy(sql`${reviewDelegations.depth} desc`)
    let n = 0
    for (const { id } of due) {
      const [link] = await tx.select().from(reviewDelegations).where(eq(reviewDelegations.id, id))
      if (!link || link.state !== 'active') continue
      const item = await lockItem(tx, link.queueItemId)
      if (!item || item.status === 'done') continue
      if (item.claimedBy && claimIsLive(item.claimedAt, now)) continue
      await unwindTo(tx, item, link, 'revoked_sla', now, null, null)
      await slaEvent(tx, tenantId, item, 'delegation_expired', link.toUserId, link.fromUserId, { delegationId: link.id, delegationDueAt: link.dueAt.toISOString() })
      const names = await namesOf(tx, [link.fromUserId])
      for (const userId of [link.fromUserId, link.toUserId]) {
        await enqueueNotification(tx, {
          tenantId,
          userId,
          code: 'review_delegation_expired',
          payload: userId === link.fromUserId
            ? { task: item.taskTitle ?? '', toYou: true, itemId: item.id }
            : { task: item.taskTitle ?? '', toOther: names.get(link.fromUserId) ?? '', itemId: item.id },
          dedupKey: `review_delegation_expired:${link.id}:${userId}`,
          refType: 'review_queue_item',
          refId: item.id,
        })
      }
      n++
    }
    return n
  })
}
