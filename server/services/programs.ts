import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  attempts, automationRules, courses, enrollments, meetupRegistrations, programEdges, programEnrollments, programNodes, programs, quizzes, resourceProgress, resources, users, workshops, workshopSubmissions,
} from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import { countRequired } from './learning'
import { enqueueNotification } from './notifications'
import { eventForTransition, logPassEvent } from './passEvents'
import { managerIdOf, managerIdsOf } from './orgManager'

interface Ctx { tenantId: string, actorId: string }

/**
 * Программы и траектории (docs/17): одна модель, два режима. Для linear рёбра строятся из
 * порядка узлов; для graph — заданы явно с условиями. Путь человека пишется в nodes_state,
 * чтобы был воспроизводим (§7.4).
 */

export type NodeStatus = 'locked' | 'available' | 'in_progress' | 'done' | 'failed' | 'skipped' | 'unavailable'
export interface NodeState { status: NodeStatus, at?: string, score?: number | null, enrollmentId?: string | null, via?: string | null, dueAt?: string | null }
export type NodesState = Record<string, NodeState>
export type EdgeCondition = { type: 'always' } | { type: 'passed' } | { type: 'failed' } | { type: 'score_gte', value: number } | { type: 'position_is', ids: string[] }
export type UnlockRule = { type: 'all' } | { type: 'any' } | { type: 'score', min: number }

// ── CRUD (§3.1–3.3) ─────────────────────────────────────────────────────

export async function listPrograms(ctx: Ctx, opts: { all?: boolean } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.execute(sql`
      select p.*, r.name as rule_name,
             (select count(*)::int from program_nodes n where n.program_id = p.id and n.node_type = 'item') as items,
             (select count(*)::int from program_enrollments e where e.program_id = p.id and e.status in ('not_started','in_progress')) as active_people,
             (select count(*)::int from program_enrollments e where e.program_id = p.id and e.status = 'done' and e.cancelled_at is null) as completed_people,
             u.full_name as updated_by_name
      from programs p left join automation_rules r on r.id = p.automation_rule_id left join users u on u.id = p.updated_by
      where ${opts.all ? sql`true` : sql`p.status = 'published'`} order by p.updated_at desc
    `) as unknown as Promise<Record<string, unknown>[]>
  })
}

export async function createProgram(ctx: Ctx, input: { title: string, description?: string, mode?: 'linear' | 'graph', tags?: string[] }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [p] = await tx.insert(programs).values({ tenantId: ctx.tenantId, title: input.title, description: input.description ?? null, mode: input.mode ?? 'linear', tags: input.tags ?? [], authorIds: [ctx.actorId], updatedBy: ctx.actorId }).returning()
    // Start и Finish создаются автоматически (§5.1)
    await tx.insert(programNodes).values([
      { tenantId: ctx.tenantId, programId: p!.id, nodeType: 'start', sort: 0, position: { x: 40, y: 200 }, isRequired: false },
      { tenantId: ctx.tenantId, programId: p!.id, nodeType: 'finish', sort: 9999, position: { x: 800, y: 200 }, isRequired: false },
    ])
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'program.create', entity: 'program', entityId: p!.id, after: { title: p!.title } })
    return p!
  })
}

export async function updateProgram(ctx: Ctx, id: string, input: Partial<{ title: string, description: string | null, mode: 'linear' | 'graph', tags: string[], coverKey: string | null, code: string | null, iconKey: string | null, workload: string | null, assignmentMode: string[], automationRuleId: string | null, noAssignAfterFinish: boolean, countPriorResults: boolean, validityMonths: number | null, dueDays: number | null, status: 'draft' | 'archived' }>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(programs).where(eq(programs.id, id))
    if (!before) return null
    // Изменение опубликованной программы → новая версия; активные прохождения остаются на своей (§7.6)
    const bump = before.status === 'published' && (input.mode !== undefined || input.dueDays !== undefined)
    const [p] = await tx.update(programs).set({ ...input, ...(bump ? { version: before.version + 1 } : {}), updatedBy: ctx.actorId, updatedAt: new Date() }).where(eq(programs.id, id)).returning()
    return p!
  })
}

export async function getProgram(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [p] = await tx.select().from(programs).where(eq(programs.id, id))
    if (!p) return null
    const nodes = await tx.select().from(programNodes).where(eq(programNodes.programId, id)).orderBy(asc(programNodes.sort))
    const edges = await tx.select().from(programEdges).where(eq(programEdges.programId, id)).orderBy(asc(programEdges.sort))
    const titles = await itemTitles(tx, nodes)
    const [rule] = p.automationRuleId ? await tx.select({ id: automationRules.id, name: automationRules.name }).from(automationRules).where(eq(automationRules.id, p.automationRuleId)) : []
    return { ...p, nodes: nodes.map(n => ({ ...n, itemTitle: titles.get(`${n.itemType}:${n.itemId}`) ?? null })), edges, rule: rule ?? null }
  })
}

async function itemTitles(tx: TenantTx, nodes: { itemType: string | null, itemId: string | null }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const by = (t: string) => nodes.filter(n => n.itemType === t && n.itemId).map(n => n.itemId!)
  const c = by('course'); if (c.length) for (const r of await tx.select({ id: courses.id, title: courses.title }).from(courses).where(inArray(courses.id, c))) out.set(`course:${r.id}`, r.title)
  const q = by('quiz'); if (q.length) for (const r of await tx.select({ id: quizzes.id, title: quizzes.title }).from(quizzes).where(inArray(quizzes.id, q))) out.set(`quiz:${r.id}`, r.title)
  const w = by('workshop'); if (w.length) for (const r of await tx.select({ id: workshops.id, title: workshops.title }).from(workshops).where(inArray(workshops.id, w))) out.set(`workshop:${r.id}`, r.title)
  const m = [...by('meetup'), ...by('webinar')]; if (m.length) for (const r of await tx.execute(sql`select id, title, kind from meetups where id in (${sql.join(m.map(x => sql`${x}::uuid`), sql`, `)})`) as unknown as { id: string, title: string, kind: string }[]) { out.set(`meetup:${r.id}`, r.title); out.set(`webinar:${r.id}`, r.title) }
  // Ресурс — элемент программы по docs/17 §3.2; без названия публикация отвергала его как «?» (fix-resource-node)
  const rs = by('resource'); if (rs.length) for (const r of await tx.select({ id: resources.id, title: resources.title }).from(resources).where(inArray(resources.id, rs))) out.set(`resource:${r.id}`, r.title)
  return out
}

export async function upsertNode(ctx: Ctx, programId: string, input: { id?: string, itemType: string, itemId: string, titleOverride?: string | null, sort?: number, position?: { x: number, y: number }, isRequired?: boolean, dueDays?: number | null, unlockAfter?: string[], unlockRule?: UnlockRule }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const values = { itemType: input.itemType, itemId: input.itemId, titleOverride: input.titleOverride ?? null, ...(input.sort !== undefined ? { sort: input.sort } : {}), ...(input.position ? { position: input.position } : {}), isRequired: input.isRequired ?? true, dueDays: input.dueDays ?? null, unlockAfter: input.unlockAfter ?? [], unlockRule: input.unlockRule ?? { type: 'all' } }
    if (input.id) {
      const [n] = await tx.update(programNodes).set({ ...values, updatedAt: new Date() }).where(and(eq(programNodes.id, input.id), eq(programNodes.programId, programId))).returning()
      return n ?? null
    }
    const [max] = await tx.select({ m: sql<number>`coalesce(max(sort), 0)` }).from(programNodes).where(and(eq(programNodes.programId, programId), eq(programNodes.nodeType, 'item')))
    const [n] = await tx.insert(programNodes).values({ tenantId: ctx.tenantId, programId, nodeType: 'item', ...values, sort: input.sort ?? Number(max!.m) + 1, position: input.position ?? { x: 200 + (Number(max!.m) + 1) * 180, y: 200 } }).returning()
    return n!
  })
}

export async function deleteNode(ctx: Ctx, programId: string, nodeId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const r = await tx.delete(programNodes).where(and(eq(programNodes.id, nodeId), eq(programNodes.programId, programId), eq(programNodes.nodeType, 'item'))).returning({ id: programNodes.id })
    return r.length > 0
  })
}

export async function reorderNodes(ctx: Ctx, programId: string, ids: string[]) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    for (let i = 0; i < ids.length; i++) await tx.update(programNodes).set({ sort: i + 1 }).where(and(eq(programNodes.id, ids[i]!), eq(programNodes.programId, programId)))
    return true
  })
}

export async function upsertEdge(ctx: Ctx, programId: string, input: { id?: string, fromNodeId: string, toNodeId: string, condition?: EdgeCondition, sort?: number }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    if (input.fromNodeId === input.toNodeId) return null
    const [e] = await tx.insert(programEdges).values({ tenantId: ctx.tenantId, programId, fromNodeId: input.fromNodeId, toNodeId: input.toNodeId, condition: input.condition ?? { type: 'always' }, sort: input.sort ?? 0 })
      .onConflictDoUpdate({ target: [programEdges.fromNodeId, programEdges.toNodeId], set: { condition: input.condition ?? { type: 'always' }, sort: input.sort ?? 0, updatedAt: new Date() } }).returning()
    return e!
  })
}

export async function deleteEdge(ctx: Ctx, programId: string, edgeId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => (await tx.delete(programEdges).where(and(eq(programEdges.id, edgeId), eq(programEdges.programId, programId))).returning({ id: programEdges.id })).length > 0)
}

// ── Граф (§5.1 проверки, §7) ────────────────────────────────────────────

type Node = typeof programNodes.$inferSelect
type Edge = typeof programEdges.$inferSelect

/** Для linear рёбра выводятся из порядка: start → items по sort → finish. */
export function effectiveEdges(mode: string, nodes: Node[], edges: Edge[]): { fromNodeId: string, toNodeId: string, condition: EdgeCondition, sort: number }[] {
  if (mode === 'graph') return edges.map(e => ({ fromNodeId: e.fromNodeId, toNodeId: e.toNodeId, condition: e.condition as EdgeCondition, sort: e.sort }))
  const start = nodes.find(n => n.nodeType === 'start'), finish = nodes.find(n => n.nodeType === 'finish')
  const items = nodes.filter(n => n.nodeType === 'item').sort((a, b) => a.sort - b.sort)
  const chain = [start, ...items, finish].filter((n): n is Node => !!n)
  return chain.slice(0, -1).map((n, i) => ({ fromNodeId: n.id, toNodeId: chain[i + 1]!.id, condition: { type: 'always' as const }, sort: 0 }))
}

export interface PublishProblem { code: 'no_path' | 'orphan' | 'unpublished_item' | 'cycle' | 'empty' | 'ambiguous', nodeId?: string, message: string }

export async function validateProgram(tx: TenantTx, programId: string): Promise<PublishProblem[]> {
  const [p] = await tx.select().from(programs).where(eq(programs.id, programId))
  if (!p) return [{ code: 'empty', message: 'Програму не знайдено' }]
  const nodes = await tx.select().from(programNodes).where(eq(programNodes.programId, programId))
  const edges = effectiveEdges(p.mode, nodes, await tx.select().from(programEdges).where(eq(programEdges.programId, programId)))
  const problems: PublishProblem[] = []
  const items = nodes.filter(n => n.nodeType === 'item')
  if (!items.length) return [{ code: 'empty', message: 'Додайте хоча б один елемент' }]
  const start = nodes.find(n => n.nodeType === 'start')!, finish = nodes.find(n => n.nodeType === 'finish')!
  const out = new Map<string, typeof edges>()
  for (const e of edges) out.set(e.fromNodeId, [...(out.get(e.fromNodeId) ?? []), e])
  // Путь Start → Finish
  const seen = new Set<string>(); const stack = [start.id]
  while (stack.length) { const id = stack.pop()!; if (seen.has(id)) continue; seen.add(id); for (const e of out.get(id) ?? []) stack.push(e.toNodeId) }
  if (!seen.has(finish.id)) problems.push({ code: 'no_path', nodeId: finish.id, message: 'Немає шляху від Start до Finish' })
  // Узлы без входящих рёбер
  const incoming = new Set(edges.map(e => e.toNodeId))
  for (const n of items) if (!incoming.has(n.id)) problems.push({ code: 'orphan', nodeId: n.id, message: `Блок «${n.titleOverride ?? n.itemType}» без вхідних звʼязків` })
  // Все элементы опубликованы
  const titles = await itemTitles(tx, nodes)
  for (const n of items) {
    let ok = true
    if (n.itemType === 'course') ok = !!(await tx.select({ id: courses.id }).from(courses).where(and(eq(courses.id, n.itemId!), eq(courses.status, 'published'))))[0]
    else if (n.itemType === 'quiz') ok = !!(await tx.select({ id: quizzes.id }).from(quizzes).where(and(eq(quizzes.id, n.itemId!), eq(quizzes.status, 'published'))))[0]
    else if (n.itemType === 'workshop') ok = !!(await tx.select({ id: workshops.id }).from(workshops).where(and(eq(workshops.id, n.itemId!), isNull(workshops.deletedAt))))[0]
    else if (n.itemType === 'resource') ok = !!(await tx.select({ id: resources.id }).from(resources).where(and(eq(resources.id, n.itemId!), eq(resources.status, 'published'), isNull(resources.deletedAt))))[0]
    else if (!titles.has(`${n.itemType}:${n.itemId}`)) ok = false
    if (!ok) problems.push({ code: 'unpublished_item', nodeId: n.id, message: `Елемент «${titles.get(`${n.itemType}:${n.itemId}`) ?? n.titleOverride ?? '?'}» не опубліковано` })
  }
  // Циклы без условия выхода: цикл, все рёбра которого — always
  const alwaysOut = new Map<string, string[]>()
  for (const e of edges) if (e.condition.type === 'always') alwaysOut.set(e.fromNodeId, [...(alwaysOut.get(e.fromNodeId) ?? []), e.toNodeId])
  const color = new Map<string, number>()
  const dfs = (id: string): string | null => {
    color.set(id, 1)
    for (const to of alwaysOut.get(id) ?? []) {
      if (color.get(to) === 1) return to
      if (!color.has(to)) { const r = dfs(to); if (r) return r }
    }
    color.set(id, 2); return null
  }
  for (const n of nodes) if (!color.has(n.id)) { const c = dfs(n.id); if (c) { problems.push({ code: 'cycle', nodeId: c, message: 'Цикл без умови виходу' }); break } }
  // Пересекающиеся условия из одного узла — предупреждение (§12): два always из одного узла
  for (const [from, list] of out) if (list.filter(e => e.condition.type === 'always').length > 1 && from !== start.id) problems.push({ code: 'ambiguous', nodeId: from, message: 'Кілька безумовних переходів з одного блоку — береться перший за порядком' })
  return problems
}

export async function publishProgram(ctx: Ctx, id: string): Promise<{ ok: true } | { ok: false, problems: PublishProblem[] }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const problems = (await validateProgram(tx, id)).filter(p => p.code !== 'ambiguous')
    if (problems.length) return { ok: false as const, problems }
    const [p] = await tx.select({ assignmentMode: programs.assignmentMode, automationRuleId: programs.automationRuleId }).from(programs).where(eq(programs.id, id))
    if (p?.assignmentMode.includes('automation') && !p.automationRuleId) return { ok: false as const, problems: [{ code: 'empty', message: 'Оберіть правило автоматизації' }] }
    await tx.update(programs).set({ status: 'published', publishedAt: new Date(), updatedBy: ctx.actorId, updatedAt: new Date() }).where(eq(programs.id, id))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'program.publish', entity: 'program', entityId: id })
    return { ok: true as const }
  })
}

export async function duplicateProgram(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [p] = await tx.select().from(programs).where(eq(programs.id, id))
    if (!p) return null
    const [np] = await tx.insert(programs).values({ ...p, id: undefined, title: `${p.title} (копія)`, status: 'draft', publishedAt: null, version: 1, createdAt: undefined, updatedAt: undefined, updatedBy: ctx.actorId } as never).returning()
    const nodes = await tx.select().from(programNodes).where(eq(programNodes.programId, id))
    const idMap = new Map<string, string>()
    for (const n of nodes) { const [nn] = await tx.insert(programNodes).values({ ...n, id: undefined, programId: np!.id, createdAt: undefined, updatedAt: undefined } as never).returning({ id: programNodes.id }); idMap.set(n.id, nn!.id) }
    for (const n of nodes) if (n.unlockAfter.length) await tx.update(programNodes).set({ unlockAfter: n.unlockAfter.map(x => idMap.get(x) ?? x) }).where(eq(programNodes.id, idMap.get(n.id)!))
    for (const e of await tx.select().from(programEdges).where(eq(programEdges.programId, id))) await tx.insert(programEdges).values({ tenantId: ctx.tenantId, programId: np!.id, fromNodeId: idMap.get(e.fromNodeId)!, toNodeId: idMap.get(e.toNodeId)!, condition: e.condition, sort: e.sort })
    return np!
  })
}

// ── Зачисление и движение (§4, §7) ──────────────────────────────────────

/** Есть ли действующий результат по элементу — для «Зараховувати попередні результати» (§7.7). */
async function priorResult(tx: TenantTx, userId: string, itemType: string, itemId: string): Promise<{ done: boolean, score: number | null, enrollmentId: string | null }> {
  if (itemType === 'course') {
    const [e] = await tx.select({ id: enrollments.id, score: enrollments.score, validUntil: enrollments.validUntil }).from(enrollments)
      .where(and(eq(enrollments.userId, userId), eq(enrollments.subjectId, itemId), eq(enrollments.status, 'done'), isNull(enrollments.cancelledAt))).orderBy(desc(enrollments.completedAt)).limit(1)
    if (e && (!e.validUntil || e.validUntil.getTime() > Date.now())) return { done: true, score: e.score != null ? Number(e.score) : null, enrollmentId: e.id }
  }
  if (itemType === 'quiz') {
    const [a] = await tx.select({ score: attempts.score }).from(attempts).where(and(eq(attempts.userId, userId), eq(attempts.quizId, itemId), eq(attempts.status, 'passed'))).orderBy(desc(attempts.submittedAt)).limit(1)
    if (a) return { done: true, score: a.score != null ? Number(a.score) : null, enrollmentId: null }
  }
  if (itemType === 'workshop') {
    const [w] = await tx.select({ id: workshopSubmissions.id }).from(workshopSubmissions).where(and(eq(workshopSubmissions.userId, userId), eq(workshopSubmissions.workshopId, itemId), eq(workshopSubmissions.status, 'accepted'))).limit(1)
    if (w) return { done: true, score: null, enrollmentId: null }
  }
  if (itemType === 'meetup' || itemType === 'webinar') {
    const [m] = await tx.select({ id: meetupRegistrations.id }).from(meetupRegistrations).where(and(eq(meetupRegistrations.userId, userId), eq(meetupRegistrations.meetupId, itemId), eq(meetupRegistrations.status, 'attended'))).limit(1)
    if (m) return { done: true, score: null, enrollmentId: null }
  }
  if (itemType === 'resource') {
    // Ресурс, уже пройденный по правилу типа (Г-11.5) в любом контексте — узел, траектория, прямое назначение
    const [r] = await tx.select({ id: resourceProgress.id }).from(resourceProgress).where(and(eq(resourceProgress.userId, userId), eq(resourceProgress.resourceId, itemId), eq(resourceProgress.status, 'completed'))).limit(1)
    if (r) return { done: true, score: null, enrollmentId: null }
  }
  return { done: false, score: null, enrollmentId: null }
}

function unlockSatisfied(node: Node, state: NodesState): boolean {
  const rule = node.unlockRule as UnlockRule
  const deps = node.unlockAfter
  if (!deps.length) return true
  const st = deps.map(d => state[d])
  if (rule.type === 'any') return st.some(s => s?.status === 'done')
  if (rule.type === 'score') return st.every(s => s?.status === 'done' && (s.score ?? 0) >= rule.min)
  return st.every(s => s?.status === 'done')
}

/** Пересчёт состояния: открыть доступные узлы, текущий узел, прогресс, завершение (§7.1–7.4). Возвращает новые открытые узлы. */
async function recompute(tx: TenantTx, tenantId: string, enr: typeof programEnrollments.$inferSelect, prog: typeof programs.$inferSelect, nodes: Node[], edges: ReturnType<typeof effectiveEdges>): Promise<{ state: NodesState, unlocked: string[], completed: boolean }> {
  const state: NodesState = { ...(enr.nodesState as NodesState) }
  const start = nodes.find(n => n.nodeType === 'start')!, finish = nodes.find(n => n.nodeType === 'finish')!
  state[start.id] = { status: 'done', at: state[start.id]?.at ?? new Date().toISOString() }
  const unlocked: string[] = []
  const byId = new Map(nodes.map(n => [n.id, n]))
  // Целевые узлы, в которые ведёт удовлетворённое ребро из done-узла: первое подходящее ребро из узла (§12)
  const reachable = new Set<string>()
  for (const n of nodes) {
    const s = state[n.id]
    if (!s || (s.status !== 'done' && s.status !== 'failed')) continue
    const outs = edges.filter(e => e.fromNodeId === n.id).sort((a, b) => a.sort - b.sort)
    const pick = outs.find(e => edgeMatches(e.condition, s))
    if (pick) reachable.add(pick.toNodeId)
    if (s.via && !pick) reachable.add(s.via)
  }
  for (const id of reachable) {
    const n = byId.get(id)!
    const cur = state[id]
    if (cur && ['done', 'failed', 'in_progress', 'available'].includes(cur.status)) continue
    if (!unlockSatisfied(n, state)) continue
    if (n.nodeType === 'finish') { state[id] = { status: 'done', at: new Date().toISOString() }; continue }
    // Зачёт прежнего результата (§7.7)
    if (prog.countPriorResults && n.itemType && n.itemId) {
      const pr = await priorResult(tx, enr.userId, n.itemType, n.itemId)
      if (pr.done) { state[id] = { status: 'done', at: new Date().toISOString(), score: pr.score, enrollmentId: pr.enrollmentId, via: 'prior' }; continue }
    }
    state[id] = { status: 'available', at: new Date().toISOString(), dueAt: n.dueDays ? new Date(Date.now() + n.dueDays * 86_400_000).toISOString() : null }
    unlocked.push(id)
  }
  // Повторяем, пока зачёты открывают следующие узлы
  if (unlocked.length === 0 && [...reachable].some(id => state[id]?.via === 'prior' && byId.get(id)?.nodeType === 'item')) {
    const again = await recompute(tx, tenantId, { ...enr, nodesState: state }, prog, nodes, edges)
    return { state: again.state, unlocked: again.unlocked, completed: again.completed }
  }
  for (const id of reachable) if (state[id]?.via === 'prior' && !unlocked.length) { /* уже обработано рекурсией */ }
  const required = nodes.filter(n => n.nodeType === 'item' && n.isRequired && state[n.id]?.status !== 'unavailable')
  const done = required.filter(n => state[n.id]?.status === 'done').length
  const completed = state[finish.id]?.status === 'done' && done === required.length
  return { state, unlocked, completed }
}

function edgeMatches(c: EdgeCondition, s: NodeState): boolean {
  switch (c.type) {
    case 'always': return s.status === 'done' || s.status === 'failed'
    case 'passed': return s.status === 'done'
    case 'failed': return s.status === 'failed'
    case 'score_gte': return s.status === 'done' && (s.score ?? 0) >= c.value
    case 'position_is': return s.status === 'done' // позиция проверяется при зачислении (упрощение, см. docs/28)
    default: return false
  }
}

export type EnrollResult = { ok: true, enrollmentId: string, created: boolean } | { ok: false, code: 'not_found' | 'not_published' | 'finished_no_reassign' }

/** Зачисление на программу; идемпотентно по (program, user, version). */
export async function enrollProgram(tx: TenantTx, tenantId: string, programId: string, userId: string, opts: { source: string, ruleId?: string | null, assignmentId?: string | null, availableFrom?: Date | null, actorId?: string | null }): Promise<EnrollResult> {
  const [p] = await tx.select().from(programs).where(eq(programs.id, programId))
  if (!p) return { ok: false, code: 'not_found' }
  if (p.status !== 'published') return { ok: false, code: 'not_published' }
  const prior = await tx.select({ id: programEnrollments.id, status: programEnrollments.status, cancelledAt: programEnrollments.cancelledAt }).from(programEnrollments).where(and(eq(programEnrollments.programId, programId), eq(programEnrollments.userId, userId)))
  const active = prior.find(x => ['not_started', 'in_progress'].includes(x.status) && !x.cancelledAt)
  if (active) return { ok: true, enrollmentId: active.id, created: false }
  if (p.noAssignAfterFinish && prior.some(x => x.status === 'done')) return { ok: false, code: 'finished_no_reassign' }
  const [enr] = await tx.insert(programEnrollments).values({
    tenantId, programId, userId, programVersion: p.version, source: opts.source, ruleId: opts.ruleId ?? null, assignmentId: opts.assignmentId ?? null,
    availableFrom: opts.availableFrom ?? null, dueAt: p.dueDays ? new Date(Date.now() + p.dueDays * 86_400_000) : null, status: 'not_started',
  }).onConflictDoNothing().returning()
  if (!enr) { const [again] = await tx.select({ id: programEnrollments.id }).from(programEnrollments).where(and(eq(programEnrollments.programId, programId), eq(programEnrollments.userId, userId), eq(programEnrollments.programVersion, p.version))); return { ok: true, enrollmentId: again!.id, created: false } }
  // docs/33 D-045: протокол статусов программы — как enrollment_events у курса
  await logPassEvent(tx, tenantId, { subjectType: 'training_program', subjectId: programId, enrollmentId: enr.id, userId, event: 'created', payload: { from: null, to: 'not_started', source: opts.source }, actorId: opts.actorId ?? null })
  if (!opts.availableFrom || opts.availableFrom.getTime() <= Date.now()) await openEnrollment(tx, tenantId, enr.id)
  await recordAudit(tx, { tenantId, actorId: opts.actorId ?? null, action: 'program.enroll', entity: 'program_enrollment', entityId: enr.id, after: { programId, userId, source: opts.source } })
  await enqueueNotification(tx, { tenantId, userId, code: 'program_assigned', payload: { title: p.title, due: p.dueDays ? new Date(Date.now() + p.dueDays * 86_400_000).toISOString() : '' }, dedupKey: `prog_assigned:${enr.id}` })
  return { ok: true, enrollmentId: enr.id, created: true }
}

/** Открыть программу человеку: первый пересчёт (зачёты, первый доступный узел). */
async function openEnrollment(tx: TenantTx, tenantId: string, enrollmentId: string) {
  const [enr] = await tx.select().from(programEnrollments).where(eq(programEnrollments.id, enrollmentId))
  const [p] = await tx.select().from(programs).where(eq(programs.id, enr!.programId))
  const nodes = await tx.select().from(programNodes).where(eq(programNodes.programId, p!.id)).orderBy(asc(programNodes.sort))
  const edges = effectiveEdges(p!.mode, nodes, await tx.select().from(programEdges).where(eq(programEdges.programId, p!.id)))
  const r = await recompute(tx, tenantId, enr!, p!, nodes, edges)
  await persistState(tx, tenantId, enr!, p!, nodes, r)
}

async function persistState(tx: TenantTx, tenantId: string, enr: typeof programEnrollments.$inferSelect, p: typeof programs.$inferSelect, nodes: Node[], r: { state: NodesState, unlocked: string[], completed: boolean }) {
  const required = nodes.filter(n => n.nodeType === 'item' && n.isRequired)
  const done = required.filter(n => r.state[n.id]?.status === 'done').length
  const pct = required.length ? Math.floor(done / required.length * 100) : 0
  const current = nodes.filter(n => n.nodeType === 'item').sort((a, b) => a.sort - b.sort).find(n => ['available', 'in_progress'].includes(r.state[n.id]?.status ?? ''))
  const now = new Date()
  const status = r.completed ? 'done' : (enr.status === 'not_started' && Object.values(r.state).some(s => s.status !== 'locked' && s.via !== 'prior' && s.status !== 'available') && done > 0) ? 'in_progress' : enr.status === 'completed' ? 'completed' : enr.status
  await tx.update(programEnrollments).set({ nodesState: r.state, progressPct: String(pct), currentNodeId: current?.id ?? null, status, availableFrom: null, ...(r.completed && !enr.completedAt ? { completedAt: now } : {}), lastActivityAt: now, updatedAt: now }).where(eq(programEnrollments.id, enr.id))
  const ev = eventForTransition(enr.status, status)
  if (ev) await logPassEvent(tx, tenantId, { subjectType: 'training_program', subjectId: p.id, enrollmentId: enr.id, userId: enr.userId, event: ev, payload: { from: enr.status, to: status, result: r.completed ? 100 : pct } })
  for (const id of r.unlocked) {
    const n = nodes.find(x => x.id === id)!
    if (Object.keys(enr.nodesState as NodesState).length) await enqueueNotification(tx, { tenantId, userId: enr.userId, code: 'program_node_unlocked', payload: { title: p.title, step: n.titleOverride ?? '' }, dedupKey: `prog_unlock:${enr.id}:${id}` })
  }
  if (r.completed && enr.status !== 'done') {
    await enqueueNotification(tx, { tenantId, userId: enr.userId, code: 'program_completed', payload: { title: p.title }, dedupKey: `prog_done:${enr.id}` })
    await recordAudit(tx, { tenantId, actorId: null, action: 'program.complete', entity: 'program_enrollment', entityId: enr.id })
    // docs/33 D-020: програму завершено — єдиний хук (журнал + компетенції призначення)
    const { onTaskCompleted } = await import('./taskCompletion')
    await onTaskCompleted(tx, tenantId, enr.userId, { contentType: 'training_program', contentId: p.id, status: 'done', result: pct, assignmentId: enr.assignmentId, enrollmentId: enr.id, sourceKind: 'program_enrollment', sourceId: enr.id })
  }
}

/** Событие по элементу (курс завершён, тест сдан/провален, практикум принят, занятие посещено) → движение по всем активным программам. */
export async function onItemResult(tenantId: string, userId: string, itemType: string, itemId: string, result: { passed: boolean, score?: number | null, enrollmentId?: string | null }) {
  const completedPrograms: string[] = []
  await withTenant(tenantId, null, async (tx) => {
    const rows = await tx.execute(sql`
      select e.id as enrollment_id, n.id as node_id from program_enrollments e
      join program_nodes n on n.program_id = e.program_id and n.item_type = ${itemType} and n.item_id = ${itemId}::uuid
      where e.user_id = ${userId}::uuid and e.status in ('not_started','in_progress')
    `) as unknown as { enrollment_id: string, node_id: string }[]
    for (const r of rows) {
      const [enr] = await tx.select().from(programEnrollments).where(eq(programEnrollments.id, r.enrollment_id))
      const state = { ...(enr!.nodesState as NodesState) }
      const cur = state[r.node_id]
      if (!cur || !['available', 'in_progress', 'failed'].includes(cur.status)) continue
      state[r.node_id] = { ...cur, status: result.passed ? 'done' : 'failed', at: new Date().toISOString(), score: result.score ?? null, enrollmentId: result.enrollmentId ?? cur.enrollmentId ?? null }
      const [p] = await tx.select().from(programs).where(eq(programs.id, enr!.programId))
      const nodes = await tx.select().from(programNodes).where(eq(programNodes.programId, p!.id)).orderBy(asc(programNodes.sort))
      const edges = effectiveEdges(p!.mode, nodes, await tx.select().from(programEdges).where(eq(programEdges.programId, p!.id)))
      const rec = await recompute(tx, tenantId, { ...enr!, nodesState: state, status: 'in_progress' }, p!, nodes, edges)
      await persistState(tx, tenantId, { ...enr!, status: 'in_progress' }, p!, nodes, rec)
      if (rec.completed) completedPrograms.push(p!.id)
    }
  })
  // Программа сама бывает узлом траектории «Завдання» (training_program): её завершение — результат
  // для траектории тем же хуком, после фиксации (раньше писался только журнал, узел не засчитывался)
  for (const programId of completedPrograms) {
    await import('./trajectories').then(t => t.onTaskResult(tenantId, userId, 'training_program', programId, { passed: true }))
      .catch(err => console.error('trajectory program hook', err))
  }
}

/** Открыть узел: для курса — запись (если нет), возвращает куда идти. */
export async function openNode(ctx: Ctx, enrollmentId: string, nodeId: string): Promise<{ ok: true, to: string } | { ok: false, code: 'not_found' | 'locked' }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [enr] = await tx.select().from(programEnrollments).where(and(eq(programEnrollments.id, enrollmentId), eq(programEnrollments.userId, ctx.actorId)))
    const [n] = enr ? await tx.select().from(programNodes).where(eq(programNodes.id, nodeId)) : []
    if (!enr || !n || n.programId !== enr.programId) return { ok: false as const, code: 'not_found' as const }
    const state = { ...(enr.nodesState as NodesState) }
    const s = state[nodeId]
    if (!s || !['available', 'in_progress', 'failed', 'done'].includes(s.status)) return { ok: false as const, code: 'locked' as const }
    let to = '/learn'
    if (n.itemType === 'course') {
      let eid = s.enrollmentId
      if (!eid) {
        const [ex] = await tx.select({ id: enrollments.id }).from(enrollments).where(and(eq(enrollments.userId, ctx.actorId), eq(enrollments.subjectId, n.itemId!), inArray(enrollments.status, ['not_started', 'in_progress', 'done']), isNull(enrollments.cancelledAt)))
        if (ex) eid = ex.id
        else {
          const [course] = await tx.select({ publishedVersionId: courses.publishedVersionId }).from(courses).where(eq(courses.id, n.itemId!))
          if (course?.publishedVersionId) {
            const [ne] = await tx.insert(enrollments).values({ tenantId: ctx.tenantId, userId: ctx.actorId, subjectId: n.itemId!, versionId: course.publishedVersionId, source: 'assigned', requiredTotal: await countRequired(tx, course.publishedVersionId), dueAt: s.dueAt ? new Date(s.dueAt) : null }).returning({ id: enrollments.id })
            eid = ne!.id
          }
        }
      }
      to = eid ? `/learn/${eid}` : '/learn/catalog'
      state[nodeId] = { ...s, status: s.status === 'available' ? 'in_progress' : s.status, enrollmentId: eid ?? null }
    }
    else if (n.itemType === 'quiz') { to = `/learn/quiz/${n.itemId}`; state[nodeId] = { ...s, status: s.status === 'available' ? 'in_progress' : s.status } }
    else if (n.itemType === 'workshop') { to = `/learn/workshop/${n.itemId}`; state[nodeId] = { ...s, status: s.status === 'available' ? 'in_progress' : s.status } }
    else if (n.itemType === 'meetup' || n.itemType === 'webinar') to = `/learn/meetups/${n.itemId}`
    // Ресурс проходится по правилу типа (docs/11 Г-11.5), а не читается справкой базы знаний:
    // зачёт вернётся сюда хуком onItemResult (resourcePass.ts)
    else if (n.itemType === 'resource') to = `/learn/resources/${n.itemId}?program=${enrollmentId}`
    await tx.update(programEnrollments).set({ nodesState: state, status: enr.status === 'not_started' ? 'in_progress' : enr.status, startedAt: enr.startedAt ?? new Date(), lastActivityAt: new Date(), currentNodeId: nodeId, updatedAt: new Date() }).where(eq(programEnrollments.id, enrollmentId))
    if (enr.status === 'not_started') await logPassEvent(tx, ctx.tenantId, { subjectType: 'training_program', subjectId: enr.programId, enrollmentId, userId: enr.userId, event: 'started', payload: { from: 'not_started', to: 'in_progress', result: Number(enr.progressPct) }, actorId: ctx.actorId })
    return { ok: true as const, to }
  })
}

/** Лента шагов человека (§5.2): для графа — только его фактический путь + доступные. */
export async function programLadder(ctx: Ctx, enrollmentId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [enr] = await tx.select().from(programEnrollments).where(and(eq(programEnrollments.id, enrollmentId), eq(programEnrollments.userId, ctx.actorId)))
    if (!enr) return null
    const [p] = await tx.select().from(programs).where(eq(programs.id, enr.programId))
    const nodes = await tx.select().from(programNodes).where(eq(programNodes.programId, p!.id)).orderBy(asc(programNodes.sort))
    const titles = await itemTitles(tx, nodes)
    const state = enr.nodesState as NodesState
    const items = nodes.filter(n => n.nodeType === 'item')
    const shown = p!.mode === 'graph' ? items.filter(n => state[n.id] && state[n.id]!.status !== 'locked') : items
    const edges = effectiveEdges(p!.mode, nodes, await tx.select().from(programEdges).where(eq(programEdges.programId, p!.id)))
    const opensAfter = (n: Node) => { const e = edges.find(x => x.toNodeId === n.id); const from = e ? nodes.find(x => x.id === e.fromNodeId) : null; return from && from.nodeType === 'item' ? (from.titleOverride ?? titles.get(`${from.itemType}:${from.itemId}`) ?? '') : '' }
    // В графе к пройденному пути добавляем «следующие» узлы как locked с подписью
    const next = p!.mode === 'graph' ? items.filter(n => !state[n.id] && edges.some(e => e.toNodeId === n.id && shown.some(s => s.id === e.fromNodeId))) : []
    const list = [...shown, ...next].map(n => ({ id: n.id, title: n.titleOverride ?? titles.get(`${n.itemType}:${n.itemId}`) ?? '?', itemType: n.itemType, isRequired: n.isRequired, state: state[n.id] ?? { status: 'locked' as const }, opensAfter: opensAfter(n) }))
    const required = items.filter(n => n.isRequired)
    return { enrollment: { id: enr.id, status: enr.status, progressPct: Number(enr.progressPct), dueAt: enr.dueAt, completedAt: enr.completedAt, certificateId: enr.certificateId }, program: { id: p!.id, title: p!.title, description: p!.description, mode: p!.mode }, steps: list, done: required.filter(n => state[n.id]?.status === 'done').length, total: required.length }
  })
}

export async function myPrograms(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.execute(sql`
      select e.id, e.status, e.progress_pct, e.due_at, e.completed_at, e.current_node_id, p.id as program_id, p.title, p.mode, p.cover_key,
             (select count(*)::int from program_nodes n where n.program_id = p.id and n.node_type = 'item' and n.is_required) as total
      from program_enrollments e join programs p on p.id = e.program_id
      where e.user_id = ${ctx.actorId}::uuid and e.cancelled_at is null and e.status <> 'not_assigned' and (e.available_from is null or e.available_from <= now())
      order by case e.status when 'in_progress' then 0 when 'not_started' then 1 else 2 end, e.due_at nulls last
    `) as unknown as Promise<Record<string, unknown>[]>
  })
}

/** Каталог программ (§3.4): catalog_free — самозапись; catalog_request — заявка руководителю. */
export async function catalogPrograms(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.execute(sql`
      select p.id, p.title, p.description, p.mode, p.cover_key, p.tags, p.assignment_mode,
             (select count(*)::int from program_nodes n where n.program_id = p.id and n.node_type = 'item') as items,
             (select e.status from program_enrollments e where e.program_id = p.id and e.user_id = ${ctx.actorId}::uuid order by e.created_at desc limit 1) as my_status
      from programs p where p.status = 'published' and (p.assignment_mode && array['catalog_free','catalog_request']::text[]) order by p.title
    `) as unknown as Promise<Record<string, unknown>[]>
  })
}

export async function selfEnrollProgram(ctx: Ctx, programId: string): Promise<EnrollResult | { ok: false, code: 'not_in_catalog' | 'requested' }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [p] = await tx.select().from(programs).where(and(eq(programs.id, programId), eq(programs.status, 'published')))
    if (!p) return { ok: false as const, code: 'not_found' as const }
    if (p.assignmentMode.includes('catalog_free')) return enrollProgram(tx, ctx.tenantId, programId, ctx.actorId, { source: 'catalog', actorId: ctx.actorId })
    if (p.assignmentMode.includes('catalog_request')) {
      const [req] = await tx.insert(programEnrollments).values({ tenantId: ctx.tenantId, programId, userId: ctx.actorId, programVersion: p.version, source: 'catalog', status: 'not_assigned', requestedAt: new Date() }).onConflictDoNothing().returning({ id: programEnrollments.id })
      if (req) await logPassEvent(tx, ctx.tenantId, { subjectType: 'training_program', subjectId: programId, enrollmentId: req.id, userId: ctx.actorId, event: 'created', payload: { from: null, to: 'not_assigned', source: 'catalog' }, actorId: ctx.actorId })
      const mgr = await managerIdOf(tx, ctx.actorId) // П-16.4: адресат заявки — руководитель по дереву
      if (mgr) await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: mgr, code: 'program_request', payload: { title: p.title, programId }, dedupKey: `prog_req:${programId}:${ctx.actorId}` })
      return { ok: false as const, code: 'requested' as const }
    }
    return { ok: false as const, code: 'not_in_catalog' as const }
  })
}

/** Рішення по заявці (docs/10 §14.1): відмова — з причиною, яку бачить людина. */
export async function decideRequest(ctx: Ctx, enrollmentId: string, approve: boolean, reason?: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    // Заявка через каталог: status = not_assigned + requested_at; отказ — cancelled_at
    const [enr] = await tx.select().from(programEnrollments).where(and(eq(programEnrollments.id, enrollmentId), eq(programEnrollments.status, 'not_assigned'), sql`${programEnrollments.requestedAt} is not null`, isNull(programEnrollments.cancelledAt)))
    if (!enr) return null
    if (!approve) {
      await tx.update(programEnrollments).set({ cancelledAt: new Date(), cancelReason: reason ?? null, updatedAt: new Date() }).where(eq(programEnrollments.id, enrollmentId))
      await logPassEvent(tx, ctx.tenantId, { subjectType: 'training_program', subjectId: enr.programId, enrollmentId, userId: enr.userId, event: 'cancelled', payload: { from: 'not_assigned', reason: reason ?? 'request_rejected' }, actorId: ctx.actorId })
      await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'program_enrollment.request.reject', entity: 'program_enrollment', entityId: enrollmentId, after: { userId: enr.userId, reason } })
      await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: enr.userId, code: 'catalog_request_rejected', payload: { reason: reason ?? null }, dedupKey: `catalog_request_rejected:${enrollmentId}` })
      return { status: 'cancelled' }
    }
    await tx.update(programEnrollments).set({ status: 'not_started', updatedAt: new Date() }).where(eq(programEnrollments.id, enrollmentId))
    await logPassEvent(tx, ctx.tenantId, { subjectType: 'training_program', subjectId: enr.programId, enrollmentId, userId: enr.userId, event: 'created', payload: { from: 'not_assigned', to: 'not_started', source: 'catalog' }, actorId: ctx.actorId })
    await openEnrollment(tx, ctx.tenantId, enrollmentId)
    const [p] = await tx.select({ title: programs.title }).from(programs).where(eq(programs.id, enr.programId))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'program_enrollment.request.approve', entity: 'program_enrollment', entityId: enrollmentId, after: { userId: enr.userId } })
    await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: enr.userId, code: 'program_assigned', payload: { title: p?.title, due: '' }, dedupKey: `prog_assigned:${enr.id}` })
    return { status: 'not_started' }
  })
}

// ── Правила автоматизации (§3.4 automation, §7.8) ───────────────────────

export async function assignProgramsForRule(tx: TenantTx, tenantId: string, ruleId: string, userId: string, opts: { dryRun: boolean, delayDays: number }): Promise<{ type: 'assign_program', programId: string, title: string, wouldAssign?: boolean, enrollmentId?: string, skipped?: string }[]> {
  const list = await tx.select().from(programs).where(and(eq(programs.automationRuleId, ruleId), eq(programs.status, 'published'), sql`'automation' = any(${programs.assignmentMode})`))
  const out: { type: 'assign_program', programId: string, title: string, wouldAssign?: boolean, enrollmentId?: string, skipped?: string }[] = []
  for (const p of list) {
    if (opts.dryRun) { out.push({ type: 'assign_program', programId: p.id, title: p.title, wouldAssign: true }); continue }
    const r = await enrollProgram(tx, tenantId, p.id, userId, { source: 'automation', ruleId, availableFrom: opts.delayDays ? new Date(Date.now() + opts.delayDays * 86_400_000) : null })
    out.push(r.ok ? { type: 'assign_program', programId: p.id, title: p.title, enrollmentId: r.enrollmentId } : { type: 'assign_program', programId: p.id, title: p.title, skipped: r.code })
  }
  return out
}

export async function programsUsingRules(tx: TenantTx, ruleIds: string[]): Promise<Map<string, { id: string, title: string }[]>> {
  const map = new Map<string, { id: string, title: string }[]>()
  if (!ruleIds.length) return map
  const rows = await tx.select({ id: programs.id, title: programs.title, ruleId: programs.automationRuleId }).from(programs).where(and(inArray(programs.automationRuleId, ruleIds), sql`${programs.status} <> 'archived'`))
  for (const r of rows) if (r.ruleId) map.set(r.ruleId, [...(map.get(r.ruleId) ?? []), { id: r.id, title: r.title }])
  return map
}

// ── Отчёты и сканеры (§9, §11) ──────────────────────────────────────────

export async function programReport(ctx: Ctx, programId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [p] = await tx.select().from(programs).where(eq(programs.id, programId))
    if (!p) return null
    const nodes = (await tx.select().from(programNodes).where(and(eq(programNodes.programId, programId), eq(programNodes.nodeType, 'item'))).orderBy(asc(programNodes.sort)))
    const titles = await itemTitles(tx, nodes)
    const enrs = await tx.select({ id: programEnrollments.id, status: programEnrollments.status, nodesState: programEnrollments.nodesState, progressPct: programEnrollments.progressPct, currentNodeId: programEnrollments.currentNodeId, dueAt: programEnrollments.dueAt, fullName: users.fullName, userId: users.id })
      .from(programEnrollments).innerJoin(users, eq(users.id, programEnrollments.userId)).where(eq(programEnrollments.programId, programId))
    const funnel = nodes.map((n) => {
      const reached = enrs.filter(e => (e.nodesState as NodesState)[n.id] && (e.nodesState as NodesState)[n.id]!.status !== 'locked').length
      const done = enrs.filter(e => (e.nodesState as NodesState)[n.id]?.status === 'done')
      const scores = done.map(e => (e.nodesState as NodesState)[n.id]!.score).filter((x): x is number => x != null)
      return { nodeId: n.id, title: n.titleOverride ?? titles.get(`${n.itemType}:${n.itemId}`) ?? '?', reached, done: done.length, failed: enrs.filter(e => (e.nodesState as NodesState)[n.id]?.status === 'failed').length, avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null }
    })
    const people = enrs.map(e => ({ enrollmentId: e.id, userId: e.userId, fullName: e.fullName, status: e.status, progressPct: Number(e.progressPct), dueAt: e.dueAt, currentStep: e.currentNodeId ? (nodes.findIndex(n => n.id === e.currentNodeId) + 1) : null, currentTitle: e.currentNodeId ? funnel.find(f => f.nodeId === e.currentNodeId)?.title ?? null : null }))
    return { program: { id: p.id, title: p.title }, total: enrs.length, completed: enrs.filter(e => e.status === 'done').length, funnel, people }
  })
}

/** Ежедневно: застрявшие 14 дней → руководителю; дедлайн через 3 дня → человеку; отложенные (available_from) — открыть. */
export async function programScan(tenantId: string): Promise<{ opened: number, stuck: number, dueSoon: number }> {
  const out = { opened: 0, stuck: 0, dueSoon: 0 }
  await withTenant(tenantId, null, async (tx) => {
    const pending = await tx.select({ id: programEnrollments.id }).from(programEnrollments).where(and(eq(programEnrollments.status, 'not_started'), sql`${programEnrollments.availableFrom} is not null and ${programEnrollments.availableFrom} <= now()`))
    for (const e of pending) { await openEnrollment(tx, tenantId, e.id); out.opened++ }
    const day = new Date().toISOString().slice(0, 10)
    const stuck = await tx.execute(sql`
      select e.id, e.user_id, p.title from program_enrollments e join programs p on p.id = e.program_id
      where e.status = 'in_progress' and coalesce(e.last_activity_at, e.started_at, e.created_at) < now() - interval '14 days'
    `) as unknown as { id: string, user_id: string, title: string }[]
    // Руководители застрявших — одним резолвом (П-16.4); раньше условие «есть руководитель»
    // стояло прямо в `where` по `locations.manager_id` и молча теряло людей без точки.
    const stuckManagers = await managerIdsOf(tx, stuck.map(s => s.user_id))
    for (const s of stuck) {
      const mgr = stuckManagers.get(s.user_id)
      if (mgr && await enqueueNotification(tx, { tenantId, userId: mgr, code: 'program_stuck', payload: { title: s.title, userId: s.user_id }, dedupKey: `prog_stuck:${s.id}:${day.slice(0, 7)}` })) out.stuck++
    }
    const soon = await tx.execute(sql`select e.id, e.user_id, p.title, e.due_at from program_enrollments e join programs p on p.id = e.program_id where e.status in ('not_started','in_progress') and e.due_at between now() and now() + interval '3 days'`) as unknown as { id: string, user_id: string, title: string, due_at: string }[]
    for (const s of soon) if (await enqueueNotification(tx, { tenantId, userId: s.user_id, code: 'program_due_soon', payload: { title: s.title, due: s.due_at }, dedupKey: `prog_due:${s.id}:${day}` })) out.dueSoon++
    // Автозакрытие по сроку: failed через 14 дней просрочки (как у записей на курс, dueScan)
    const expired = await tx.update(programEnrollments).set({ status: 'failed', updatedAt: new Date() }).where(and(inArray(programEnrollments.status, ['not_started', 'in_progress']), isNull(programEnrollments.cancelledAt), sql`${programEnrollments.dueAt} < now() - interval '14 days'`))
      .returning({ id: programEnrollments.id, programId: programEnrollments.programId, userId: programEnrollments.userId, progressPct: programEnrollments.progressPct })
    for (const e of expired) await logPassEvent(tx, tenantId, { subjectType: 'training_program', subjectId: e.programId, enrollmentId: e.id, userId: e.userId, event: 'failed', payload: { to: 'failed', result: Number(e.progressPct), reason: 'expired' } })
  })
  return out
}

/**
 * Нагадування за день до старту програми (докс/33 D-049, клас сповіщень `programReminder`):
 * `available_from` — дата, з якої `programScan` відкриє призначення (Spec 17 «Призначення через
 * N днів»); за день до цього — нагадування людині, поки запис ще `not_started`.
 */
export async function programReminderScan(tenantId: string): Promise<number> {
  let count = 0
  await withTenant(tenantId, null, async (tx) => {
    const day = new Date().toISOString().slice(0, 10)
    const rows = await tx.execute(sql`
      select e.id, e.user_id, p.title, e.available_from from program_enrollments e join programs p on p.id = e.program_id
      where e.status = 'not_started' and e.available_from is not null and e.available_from::date = (current_date + 1)
    `) as unknown as { id: string, user_id: string, title: string, available_from: string }[]
    for (const r of rows) {
      if (await enqueueNotification(tx, { tenantId, userId: r.user_id, code: 'program_reminder', payload: { title: r.title, availableFrom: r.available_from }, dedupKey: `prog_reminder:${r.id}:${day}` })) count++
    }
  })
  return count
}
