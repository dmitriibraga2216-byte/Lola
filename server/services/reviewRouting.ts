import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { locations, reviewQueueItems, reviewRoutingRules, reviewSlaEvents } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { currentRequestContext } from '../utils/requestContext'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import { absentUserIds, gradeReviewers, isActiveEmployee, managerChainOf, namesOf, reviewerLoads, tenantAdmins } from './reviewPeople'
import { pickLeastLoaded, pickRoundRobin, restingStatus, ruleMatches, scopeIsEmpty } from './reviewRules'
import type { RuleScope } from './reviewRules'
import type { ReviewActor } from './reviewActor'
import type { ReviewRoutingRuleInput } from '../../shared/schemas/review'
import type { ReviewRoutingStrategy } from '../../shared/enums'

/**
 * Распределение работ по проверяющим (`docs/v2/37` §3.3, §7.16–7.17) и правила распределения.
 *
 * **Когда работает.** При постановке в очередь (`enqueueReview()` → `routeQueueItem()`, та же
 * транзакция), при ежедневном `review.rebalance` (работы старше суток без проверяющего) и при
 * перебросе очереди отсутствующего (`reviewWorkload.ts`). Правил нет — поведение базового ТЗ
 * (`docs/13` §7.1): работа остаётся в общем пуле, её видят и берут все проверяющие.
 *
 * **Что не делает никогда.** Не двигает срок проверки: `sla_due_at` ставится при постановке
 * (с учётом `sla_hours_override` правила) и дальше не пересчитывается ни переназначением, ни
 * делегированием — иначе любое движение работы продлевало бы срок бесплатно (`37` §7.5).
 */

type Item = typeof reviewQueueItems.$inferSelect
type Rule = typeof reviewRoutingRules.$inferSelect

export type RouteReason = 'enqueue' | 'rebalance' | 'absence'

export interface RouteResult {
  /** Кому назначено; `null` — работа в общем пуле (правил нет, `manual` или некому). */
  assignedTo: string | null
  ruleId: string | null
  overloaded: boolean
  /** Назначено запасным путём: `fallback_user_id`, руководитель или администратор. */
  fallback: 'rule' | 'manager' | 'admin' | null
}

const POOL: RouteResult = { assignedTo: null, ruleId: null, overloaded: false, fallback: null }

/** Узлы оргструктуры в области правила: подходит, если основное назначение человека лежит в поддереве. */
async function orgNodesMatch(tx: TenantTx, nodeIds: string[], userId: string): Promise<boolean> {
  const [present] = await tx.execute(sql`select to_regclass('public.org_node_assignments') is not null as ok`) as unknown as { ok: boolean }[]
  if (!present?.ok) return false
  const [row] = await tx.execute(sql`
    select exists (
      select 1 from org_node_assignments a
        join org_nodes n on n.id = a.node_id
        join org_nodes r on r.id in (${sql.join(nodeIds.map(id => sql`${id}::uuid`), sql`, `)})
       where a.user_id = ${userId}::uuid and a.ended_at is null and a.is_primary and n.path <@ r.path
    ) as ok`) as unknown as { ok: boolean }[]
  return !!row?.ok
}

/** Первое подошедшее активное правило по `priority` (меньше — раньше, `37` §3.3). */
export async function matchingRule(tx: TenantTx, item: Item): Promise<Rule | null> {
  const rules = await tx.select().from(reviewRoutingRules)
    .where(eq(reviewRoutingRules.isActive, true))
    .orderBy(asc(reviewRoutingRules.priority), asc(reviewRoutingRules.createdAt), asc(reviewRoutingRules.id))
  for (const rule of rules) {
    const scope = (rule.matchScope ?? {}) as RuleScope
    if (!ruleMatches({ matchScope: scope, matchSubjectKind: rule.matchSubjectKind, matchTaskTypes: rule.matchTaskTypes }, item)) continue
    if (scope.org_node_ids?.length && !(await orgNodesMatch(tx, scope.org_node_ids, item.userId))) continue
    return rule
  }
  return null
}

/** Авторы материала работы — кандидаты стратегии `course_author` (`37` §7.16). */
async function authorIdsOf(tx: TenantTx, item: Item): Promise<string[]> {
  if (item.taskType === 'workshop') {
    const [r] = await tx.execute(sql`
      select w.author_ids from workshop_submissions s join workshops w on w.id = s.workshop_id
       where s.id = ${item.sourceId}::uuid`) as unknown as { author_ids: string[] }[]
    return r?.author_ids ?? []
  }
  if (item.taskType === 'quiz_open_answer') {
    const [r] = await tx.execute(sql`
      select q.author_ids from attempt_answers aa
        join attempts a on a.id = aa.attempt_id
        join quizzes q on q.id = a.quiz_id
       where aa.id = ${item.sourceId}::uuid`) as unknown as { author_ids: string[] }[]
    return r?.author_ids ?? []
  }
  return []
}

/**
 * Круговой выбор с блокировкой (`37` §7.17): строки ёмкости кандидатов заводятся (новичок
 * входит в круг со счётчиком, равным текущему минимуму, — без «долга» за время до прихода),
 * блокируются `for update` в той же транзакции, выбранному счётчик увеличивается на один.
 */
async function roundRobinPick(tx: TenantTx, tenantId: string, ids: string[]): Promise<{ id: string, overloaded: boolean } | null> {
  if (!ids.length) return null
  const list = sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)
  await tx.execute(sql`
    insert into reviewer_capacity (tenant_id, user_id, rr_cursor)
    select ${tenantId}::uuid, x.id,
           (select coalesce(min(c.rr_cursor), 0) from reviewer_capacity c where c.user_id in (${list}))
      from unnest(array[${list}]::uuid[]) as x(id)
    on conflict (tenant_id, user_id) do nothing`)
  await tx.execute(sql`select user_id from reviewer_capacity where user_id in (${list}) order by user_id for update`)
  const loads = await reviewerLoads(tx, ids)
  const pick = pickRoundRobin(ids.map(id => loads.get(id)!).filter(Boolean))
  if (!pick) return null
  await tx.execute(sql`update reviewer_capacity set rr_cursor = rr_cursor + 1, updated_at = now() where user_id = ${pick.id}::uuid`)
  return pick
}

/**
 * Запасной адресат, когда после фильтров `37` §7.2 и §7.7 кандидатов ноль (`37` §7.16):
 * `fallback_user_id` правила, при его отсутствии — руководитель области, выше некуда —
 * администратор тенанта. Никогда не сам проверяемый и никогда не отсутствующий.
 */
async function fallbackReviewer(tx: TenantTx, item: Item, rule: Rule | null, exclude: Set<string>): Promise<{ id: string, source: 'rule' | 'manager' | 'admin' } | null> {
  const skip = new Set([item.userId, ...exclude])
  const absent = await absentUserIds(tx)
  const usable = async (id: string | null | undefined) => !!id && !skip.has(id) && !absent.has(id) && await isActiveEmployee(tx, id)
  if (rule?.fallbackUserId && await usable(rule.fallbackUserId)) return { id: rule.fallbackUserId, source: 'rule' }
  for (const id of await managerChainOf(tx, item.tenantId, item.userId)) {
    if (await usable(id)) return { id, source: 'manager' }
  }
  for (const id of await tenantAdmins(tx)) {
    if (await usable(id)) return { id, source: 'admin' }
  }
  return null
}

/** Кандидаты стратегии до фильтров (`37` §7.16). */
async function strategyCandidates(tx: TenantTx, item: Item, rule: Rule): Promise<string[]> {
  const strategy = rule.strategy as ReviewRoutingStrategy
  if (strategy === 'course_author') return authorIdsOf(tx, item)
  if (strategy === 'location_mentor') return gradeReviewers(tx, { locationId: item.locationId, pointLevelOnly: true })
  if (rule.reviewerIds.length) return rule.reviewerIds
  // Круг и «наименее загруженный» без списка — среди наставников точки человека.
  return strategy === 'specific_list' ? [] : gradeReviewers(tx, { locationId: item.locationId, pointLevelOnly: true })
}

/**
 * Кому из кандидатов стратегии работу можно отдать (`37` §7.2 (а)–(г), §7.7, §7.18): право
 * `review.grade` в области точки, не сам проверяемый, на месте, берёт этот вид работ.
 * Порядок кандидатов сохраняется — для `specific_list` он и есть приоритет.
 */
export async function eligibleAmong(tx: TenantTx, item: Pick<Item, 'userId' | 'locationId' | 'taskType'>, candidates: string[], exclude: Set<string> = new Set()): Promise<string[]> {
  const unique = [...new Set(candidates)].filter(id => id !== item.userId && !exclude.has(id))
  if (!unique.length) return []
  const graded = new Set(await gradeReviewers(tx, { locationId: item.locationId, onlyIds: unique }))
  const absent = await absentUserIds(tx, { userIds: unique })
  const loads = await reviewerLoads(tx, unique)
  return unique.filter((id) => {
    if (!graded.has(id) || absent.has(id)) return false
    const types = loads.get(id)?.taskTypes ?? []
    return !types.length || types.includes(item.taskType)
  })
}

/**
 * Назначить работу по правилам распределения. Вызывается внутри транзакции события
 * (постановка, ежедневная перебалансировка, переброс очереди отсутствующего).
 *
 * `exclude` — кого не назначать (переброс очереди: сам отсутствующий). Срок проверки
 * переносит только постановка — и только если правило задаёт свой `sla_hours_override`.
 */
export async function routeQueueItem(tx: TenantTx, tenantId: string, itemId: string, opts: { reason: RouteReason, exclude?: string[], notify?: boolean } = { reason: 'enqueue' }): Promise<RouteResult> {
  const [item] = await tx.select().from(reviewQueueItems).where(eq(reviewQueueItems.id, itemId))
  if (!item || item.status === 'done') return POOL
  const rule = await matchingRule(tx, item)
  if (!rule) return POOL

  const now = new Date()
  const exclude = new Set(opts.exclude ?? [])
  // `sla_hours_override` — снимок правила на момент постановки; позже срок не трогается.
  const sla = opts.reason === 'enqueue' && rule.slaHoursOverride
    ? { slaHours: rule.slaHoursOverride, slaDueAt: new Date(item.submittedAt.getTime() + rule.slaHoursOverride * 3_600_000) }
    : {}

  if (rule.strategy === 'manual') {
    await tx.update(reviewQueueItems).set({ assignedByRuleId: rule.id, ...sla, updatedAt: now }).where(eq(reviewQueueItems.id, item.id))
    return { ...POOL, ruleId: rule.id }
  }

  const candidates = await eligibleAmong(tx, item, await strategyCandidates(tx, item, rule), exclude)
  let pick: { id: string, overloaded: boolean } | null = null
  if (rule.strategy === 'specific_list') {
    if (candidates[0]) {
      const load = (await reviewerLoads(tx, [candidates[0]])).get(candidates[0])
      pick = { id: candidates[0], overloaded: !!load && load.open >= load.max }
    }
  }
  else if (rule.strategy === 'round_robin') {
    pick = await roundRobinPick(tx, tenantId, candidates)
  }
  else {
    const loads = await reviewerLoads(tx, candidates)
    pick = pickLeastLoaded(candidates.map(id => loads.get(id)!).filter(Boolean))
  }

  let fallback: RouteResult['fallback'] = null
  if (!pick) {
    const fb = await fallbackReviewer(tx, item, rule, exclude)
    if (!fb) {
      await tx.update(reviewQueueItems).set({ assignedByRuleId: rule.id, ...sla, updatedAt: now }).where(eq(reviewQueueItems.id, item.id))
      return { ...POOL, ruleId: rule.id }
    }
    fallback = fb.source
    const load = (await reviewerLoads(tx, [fb.id])).get(fb.id)
    pick = { id: fb.id, overloaded: !!load && load.open >= load.max }
  }

  await tx.update(reviewQueueItems).set({
    assignedReviewerId: pick.id,
    assignedAt: now,
    assignedByRuleId: rule.id,
    status: restingStatus(item),
    ...sla,
    updatedAt: now,
  }).where(eq(reviewQueueItems.id, item.id))

  await tx.insert(reviewSlaEvents).values({
    tenantId,
    queueItemId: item.id,
    reviewerId: pick.id,
    event: 'assigned',
    dueAt: 'slaDueAt' in sla ? sla.slaDueAt : item.slaDueAt,
    details: { ruleId: rule.id, strategy: rule.strategy, reason: opts.reason, overloaded: pick.overloaded, ...(fallback ? { fallback } : {}) },
    requestContext: currentRequestContext(),
  })

  if (opts.notify !== false) await notifyAssigned(tx, tenantId, item, pick.id)
  if (pick.overloaded) await notifyOverloaded(tx, tenantId, pick.id)
  return { assignedTo: pick.id, ruleId: rule.id, overloaded: pick.overloaded, fallback }
}

/** `review_assigned` (`37` §8): «Вам призначено перевірку «{task}» — {ім'я}, {філія}». */
export async function notifyAssigned(tx: TenantTx, tenantId: string, item: Pick<Item, 'id' | 'userId' | 'taskTitle' | 'locationId'>, reviewerId: string): Promise<void> {
  const names = await namesOf(tx, [item.userId])
  const [loc] = item.locationId ? await tx.select({ name: locations.name }).from(locations).where(eq(locations.id, item.locationId)) : []
  await enqueueNotification(tx, {
    tenantId,
    userId: reviewerId,
    code: 'review_assigned',
    payload: { task: item.taskTitle ?? '', name: names.get(item.userId) ?? '', location: loc?.name ?? '', itemId: item.id },
    dedupKey: `review_assigned:${item.id}:${reviewerId}:${new Date().toISOString().slice(0, 13)}`,
    refType: 'review_queue_item',
    refId: item.id,
  })
}

/**
 * `review_overloaded` (`37` §8, §12): у проверяющего открыто не меньше лимита. Уходит его
 * руководителю (иначе — администратору), не чаще раза в сутки на человека: лимит — сигнал
 * руководителю, а не запрет ручному действию и не повод для потока уведомлений.
 */
export async function notifyOverloaded(tx: TenantTx, tenantId: string, reviewerId: string): Promise<void> {
  const load = (await reviewerLoads(tx, [reviewerId])).get(reviewerId)
  if (!load || load.open < load.max) return
  const managers = await managerChainOf(tx, tenantId, reviewerId)
  const target = managers[0] ?? (await tenantAdmins(tx)).find(id => id !== reviewerId)
  if (!target || target === reviewerId) return
  const names = await namesOf(tx, [reviewerId])
  await enqueueNotification(tx, {
    tenantId,
    userId: target,
    code: 'review_overloaded',
    payload: { name: names.get(reviewerId) ?? '', n: load.open, m: load.max },
    dedupKey: `review_overloaded:${reviewerId}:${new Date().toISOString().slice(0, 10)}`,
  })
}

// ── Ежедневная перебалансировка (`37` §11 `review.rebalance`) ─────────────────────────────

/**
 * Работы старше суток без проверяющего — назначить правилами. Только те, по которым правило
 * ещё не высказывалось (`assigned_by_rule_id is null`): `manual` оставил работу в пуле
 * осознанно, и перебалансировка не должна его переспорить.
 */
export async function rebalanceTenant(tenantId: string, now: Date = new Date()): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const olderThan = new Date(now.getTime() - 24 * 3_600_000).toISOString()
    const items = await tx.select({ id: reviewQueueItems.id }).from(reviewQueueItems).where(and(
      eq(reviewQueueItems.status, 'waiting'),
      isNull(reviewQueueItems.assignedReviewerId),
      isNull(reviewQueueItems.assignedByRuleId),
      isNull(reviewQueueItems.delegationId),
      sql`${reviewQueueItems.submittedAt} < ${olderThan}::timestamptz`,
    ))
    let n = 0
    for (const it of items) {
      const r = await routeQueueItem(tx, tenantId, it.id, { reason: 'rebalance' })
      if (r.assignedTo) n++
    }
    return n
  })
}

// ── Правила распределения: CRUD (`37` §5.3 «Правила розподілу», §10) ───────────────────────

export type RoutingRuleError = 'not_found' | 'forbidden' | 'scope_empty' | 'org_tree_missing' | 'reviewers_invalid' | 'reviewers_required'

function toScope(input: ReviewRoutingRuleInput['matchScope']): RuleScope {
  const out: RuleScope = {}
  if (input?.locationIds?.length) out.location_ids = input.locationIds
  if (input?.orgNodeIds?.length) out.org_node_ids = input.orgNodeIds
  if (input?.positionIds?.length) out.position_ids = input.positionIds
  if (input?.courseIds?.length) out.course_ids = input.courseIds
  return out
}

/**
 * Проверки правила, общие для создания и правки. Руководитель точки правит правила только
 * своей области (`37` §2): правило «на весь тенант» (пустая область) — только со скоупом на
 * всю сеть, иначе `422 routing.scope_empty`; точки вне области — `403`.
 */
async function validateRule(tx: TenantTx, actor: ReviewActor, input: ReviewRoutingRuleInput): Promise<RoutingRuleError | null> {
  const scope = toScope(input.matchScope)
  if (!actor.tenantWide('review.routing.manage')) {
    if (scopeIsEmpty(scope) || !scope.location_ids?.length) return 'scope_empty'
    const mine = new Set(actor.locations('review.routing.manage'))
    if (scope.location_ids.some(id => !mine.has(id))) return 'forbidden'
  }
  if (scope.org_node_ids?.length) {
    const [present] = await tx.execute(sql`select to_regclass('public.org_nodes') is not null as ok`) as unknown as { ok: boolean }[]
    if (!present?.ok) return 'org_tree_missing'
  }
  if (input.strategy === 'specific_list' && !input.reviewerIds.length) return 'reviewers_required'
  const people = [...input.reviewerIds, ...(input.fallbackUserId ? [input.fallbackUserId] : [])]
  for (const id of people) {
    if (!(await isActiveEmployee(tx, id))) return 'reviewers_invalid'
  }
  return null
}

export interface RoutingRuleRow {
  id: string
  nameUk: string
  priority: number
  matchScope: RuleScope
  matchSubjectKind: string | null
  matchTaskTypes: string[]
  strategy: string
  reviewerIds: string[]
  reviewerNames: string[]
  fallbackUserId: string | null
  fallbackName: string | null
  slaHoursOverride: number | null
  isActive: boolean
}

export async function listRoutingRules(actor: ReviewActor): Promise<RoutingRuleRow[]> {
  return withTenant(actor.tenantId, actor.actorId, async (tx) => {
    const rules = await tx.select().from(reviewRoutingRules).orderBy(asc(reviewRoutingRules.priority), asc(reviewRoutingRules.createdAt))
    const names = await namesOf(tx, rules.flatMap(r => [...r.reviewerIds, r.fallbackUserId]))
    return rules.map(r => ({
      id: r.id,
      nameUk: r.nameUk,
      priority: r.priority,
      matchScope: (r.matchScope ?? {}) as RuleScope,
      matchSubjectKind: r.matchSubjectKind,
      matchTaskTypes: r.matchTaskTypes,
      strategy: r.strategy,
      reviewerIds: r.reviewerIds,
      reviewerNames: r.reviewerIds.map(id => names.get(id) ?? ''),
      fallbackUserId: r.fallbackUserId,
      fallbackName: r.fallbackUserId ? names.get(r.fallbackUserId) ?? null : null,
      slaHoursOverride: r.slaHoursOverride,
      isActive: r.isActive,
    }))
  })
}

export async function createRoutingRule(actor: ReviewActor, input: ReviewRoutingRuleInput): Promise<{ ok: true, id: string } | { ok: false, code: RoutingRuleError }> {
  return withTenant(actor.tenantId, actor.actorId, async (tx) => {
    const bad = await validateRule(tx, actor, input)
    if (bad) return { ok: false as const, code: bad }
    const [row] = await tx.insert(reviewRoutingRules).values({
      tenantId: actor.tenantId,
      nameUk: input.nameUk,
      priority: input.priority,
      matchScope: toScope(input.matchScope),
      matchSubjectKind: input.matchSubjectKind ?? null,
      matchTaskTypes: input.matchTaskTypes,
      strategy: input.strategy,
      reviewerIds: input.reviewerIds,
      fallbackUserId: input.fallbackUserId ?? null,
      slaHoursOverride: input.slaHoursOverride ?? null,
      isActive: input.isActive,
      createdBy: actor.actorId,
    }).returning({ id: reviewRoutingRules.id })
    await recordAudit(tx, { tenantId: actor.tenantId, actorId: actor.actorId, action: 'review.routing_rule.create', entity: 'review_routing_rule', entityId: row!.id, after: input })
    return { ok: true as const, id: row!.id }
  })
}

/** Правка правила. Чужое правило (вне области руководителя) — `403`; несуществующее — `404`. */
export async function updateRoutingRule(actor: ReviewActor, id: string, input: ReviewRoutingRuleInput): Promise<{ ok: true } | { ok: false, code: RoutingRuleError }> {
  return withTenant(actor.tenantId, actor.actorId, async (tx) => {
    const [before] = await tx.select().from(reviewRoutingRules).where(eq(reviewRoutingRules.id, id))
    if (!before) return { ok: false as const, code: 'not_found' as const }
    if (!ownsRule(actor, before)) return { ok: false as const, code: 'forbidden' as const }
    const bad = await validateRule(tx, actor, input)
    if (bad) return { ok: false as const, code: bad }
    await tx.update(reviewRoutingRules).set({
      nameUk: input.nameUk,
      priority: input.priority,
      matchScope: toScope(input.matchScope),
      matchSubjectKind: input.matchSubjectKind ?? null,
      matchTaskTypes: input.matchTaskTypes,
      strategy: input.strategy,
      reviewerIds: input.reviewerIds,
      fallbackUserId: input.fallbackUserId ?? null,
      slaHoursOverride: input.slaHoursOverride ?? null,
      isActive: input.isActive,
      updatedAt: new Date(),
    }).where(eq(reviewRoutingRules.id, id))
    await recordAudit(tx, { tenantId: actor.tenantId, actorId: actor.actorId, action: 'review.routing_rule.update', entity: 'review_routing_rule', entityId: id, before, after: input })
    return { ok: true as const }
  })
}

/**
 * Удаление правила. Работы, назначенные им, **остаются** у своих проверяющих: ключ
 * `rqi_assigned_by_rule_id_fk` — `set null`, не `cascade` (В-13). Удаление правила меняет
 * будущее распределение, а не уже розданную работу.
 */
export async function deleteRoutingRule(actor: ReviewActor, id: string): Promise<{ ok: true } | { ok: false, code: RoutingRuleError }> {
  return withTenant(actor.tenantId, actor.actorId, async (tx) => {
    const [before] = await tx.select().from(reviewRoutingRules).where(eq(reviewRoutingRules.id, id))
    if (!before) return { ok: false as const, code: 'not_found' as const }
    if (!ownsRule(actor, before)) return { ok: false as const, code: 'forbidden' as const }
    await tx.delete(reviewRoutingRules).where(eq(reviewRoutingRules.id, id))
    await recordAudit(tx, { tenantId: actor.tenantId, actorId: actor.actorId, action: 'review.routing_rule.delete', entity: 'review_routing_rule', entityId: id, before })
    return { ok: true as const }
  })
}

/** Правило в области руководителя: на всю сеть — только со скоупом на всю сеть. */
function ownsRule(actor: ReviewActor, rule: Rule): boolean {
  if (actor.tenantWide('review.routing.manage')) return true
  const scope = (rule.matchScope ?? {}) as RuleScope
  if (!scope.location_ids?.length) return false
  const mine = new Set(actor.locations('review.routing.manage'))
  return scope.location_ids.every(id => mine.has(id))
}
