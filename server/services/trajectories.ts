import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { z } from 'zod'
import {
  assignments, automationRules, enrollments, locations, trajectories, trajectoryEdges, trajectoryEnrollments,
  trajectoryNodeStates, trajectoryNodes, userPlacements, users,
} from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import { findContent } from './taskContent'
import { createAssignmentTx, expandAssignment } from './assignments'
import { assignmentCreateSchema } from '../../shared/schemas/assignments'
import type {
  BranchCondition, GraphProblem, TrajectoryGraphInput, trajectoryCreateSchema, trajectoryUpdateSchema,
} from '../../shared/schemas/trajectories'
import type { ContentType } from '../../shared/enums'

/**
 * Траектории (docs/17 §14.1–14.3, §15; docs/32 Б.8): маршрут из узлов, где условия
 * живут в узлах — `and`/`or` (логика), `delay`/`stop_delay` (время), `branch`
 * («Розгалуження за результатом», Г-17.1), `mentor` («Призначити наставника», Г-17.2).
 * Сервер считает состояние узлов и создаёт назначения; клиент только показывает.
 */

interface Ctx { tenantId: string, actorId: string }

type Trajectory = typeof trajectories.$inferSelect
type Node = typeof trajectoryNodes.$inferSelect
type Edge = typeof trajectoryEdges.$inferSelect
type Enrollment = typeof trajectoryEnrollments.$inferSelect
type NodeState = typeof trajectoryNodeStates.$inferSelect

// ── Граф ──────────────────────────────────────────────────────────────────────────────

export interface Graph {
  nodes: Node[]
  edges: Edge[]
  byId: Map<string, Node>
  out: Map<string, Edge[]>
  inc: Map<string, Edge[]>
}

export function buildGraph(nodes: Node[], edges: Edge[]): Graph {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const out = new Map<string, Edge[]>(), inc = new Map<string, Edge[]>()
  for (const e of [...edges].sort((a, b) => a.sort - b.sort)) {
    out.set(e.fromNodeId, [...(out.get(e.fromNodeId) ?? []), e])
    inc.set(e.toNodeId, [...(inc.get(e.toNodeId) ?? []), e])
  }
  return { nodes, edges, byId, out, inc }
}

async function loadGraph(tx: TenantTx, trajectoryId: string): Promise<Graph> {
  const nodes = await tx.select().from(trajectoryNodes).where(eq(trajectoryNodes.trajectoryId, trajectoryId)).orderBy(trajectoryNodes.createdAt)
  const edges = await tx.select().from(trajectoryEdges).where(eq(trajectoryEdges.trajectoryId, trajectoryId))
  return buildGraph(nodes, edges)
}

const label = (n: Node) => n.title || KIND_LABEL[n.kind] || n.kind
const KIND_LABEL: Record<string, string> = { start: 'Start', finish: 'Finish', task: 'Завдання', and: 'Блок «І»', or: 'Блок «АБО»', delay: 'Затримка', stop_delay: 'Закриття доступу', branch: 'Розгалуження', mentor: 'Наставник' }

/**
 * Проверки полотна (docs/17 §15 Г-17.1, docs/30): текст ошибки говорит, что исправить.
 * Чистая функция — гоняется и на сервере, и в тестах без БД; статус контента — параметром.
 */
export function validateGraph(g: Graph, contentOk: Map<string, boolean> = new Map()): GraphProblem[] {
  const problems: GraphProblem[] = []
  const starts = g.nodes.filter(n => n.kind === 'start'), finishes = g.nodes.filter(n => n.kind === 'finish')
  if (starts.length === 0) problems.push({ code: 'no_start', message: 'Додайте блок Start — з нього починається траєкторія' })
  if (starts.length > 1) problems.push({ code: 'many_start', nodeId: starts[1]!.id, message: 'Блок Start має бути один — видаліть зайвий' })
  if (finishes.length === 0) problems.push({ code: 'no_finish', message: 'Додайте блок Finish — без нього траєкторію не можна завершити' })
  if (!g.nodes.some(n => n.kind === 'task')) problems.push({ code: 'no_tasks', message: 'Додайте хоча б один блок «Завдання»' })

  for (const n of g.nodes) {
    const ins = g.inc.get(n.id) ?? [], outs = g.out.get(n.id) ?? []
    if (['and', 'or', 'delay', 'stop_delay', 'branch', 'mentor'].includes(n.kind) && !n.title?.trim()) problems.push({ code: 'missing_title', nodeId: n.id, message: `${KIND_LABEL[n.kind]}: вкажіть назву (підпис до блоку)` })
    if ((n.kind === 'delay' || n.kind === 'stop_delay') && !(n.days && n.days > 0)) problems.push({ code: 'missing_days', nodeId: n.id, message: `«${label(n)}»: вкажіть кількість днів` })
    if (n.kind === 'task') {
      if (!n.contentType || !n.contentId) problems.push({ code: 'missing_content', nodeId: n.id, message: `«${label(n)}»: оберіть контент для блоку` })
      else if (contentOk.has(n.id) && !contentOk.get(n.id)) problems.push({ code: 'content_unpublished', nodeId: n.id, message: `«${label(n)}»: контент не опубліковано або недоступний — опублікуйте його чи замініть` })
    }
    if (n.kind === 'and' && ins.length < 2) problems.push({ code: 'and_single_input', nodeId: n.id, message: `«${label(n)}»: блок «І» має сенс лише з двома і більше входами — додайте звʼязки або замініть блок` })
    if (n.kind === 'stop_delay' && outs.some(e => g.byId.get(e.toNodeId)?.kind === 'finish')) problems.push({ code: 'stop_delay_before_finish', nodeId: n.id, message: `«${label(n)}»: закриття доступу не може стояти перед Finish — поставте його перед завданням` })
    if (n.kind === 'branch') {
      if (!outs.some(e => (e.condition as BranchCondition | null)?.op === 'else')) problems.push({ code: 'branch_no_else', nodeId: n.id, message: `«${label(n)}»: додайте гілку «інакше» — куди йти, якщо жодна умова не спрацювала` })
      for (const e of outs) if (!e.condition) problems.push({ code: 'branch_condition_required', nodeId: n.id, edgeId: e.id, message: `«${label(n)}»: у кожної гілки має бути умова (пройдено, не пройдено, бал ≥ N або «інакше»)` })
      if (!ins.some(e => g.byId.get(e.fromNodeId)?.kind === 'task')) problems.push({ code: 'branch_no_task_before', nodeId: n.id, message: `«${label(n)}»: розгалуження має стояти одразу після блоку «Завдання» — воно розгалужує за його результатом` })
    }
    else {
      for (const e of outs) if (e.condition) problems.push({ code: 'condition_not_allowed', nodeId: n.id, edgeId: e.id, message: `«${label(n)}»: умови бувають лише на гілках блоку «Розгалуження» — приберіть умову зі звʼязку` })
    }
  }

  // Достижимость от Start и путь до Finish
  const start = starts[0]
  if (start) {
    const reach = new Set<string>([start.id]); const q = [start.id]
    while (q.length) { const id = q.shift()!; for (const e of g.out.get(id) ?? []) if (!reach.has(e.toNodeId)) { reach.add(e.toNodeId); q.push(e.toNodeId) } }
    for (const n of g.nodes) if (!reach.has(n.id)) problems.push({ code: 'unreachable', nodeId: n.id, message: `«${label(n)}»: до блоку немає шляху від Start — зʼєднайте його або видаліть` })
    // Из каждого достижимого узла должен быть путь к Finish
    const finishIds = new Set(finishes.map(f => f.id))
    const toFinish = new Set<string>(finishIds); const q2 = [...finishIds]
    while (q2.length) { const id = q2.shift()!; for (const e of g.inc.get(id) ?? []) if (!toFinish.has(e.fromNodeId)) { toFinish.add(e.fromNodeId); q2.push(e.fromNodeId) } }
    for (const n of g.nodes) if (reach.has(n.id) && !toFinish.has(n.id)) problems.push({ code: 'no_path_to_finish', nodeId: n.id, message: `«${label(n)}»: із блоку не дійти до Finish — додайте звʼязок далі` })
  }

  // Циклы — DFS с цветами
  const color = new Map<string, 0 | 1 | 2>()
  const dfs = (id: string): string | null => {
    color.set(id, 1)
    for (const e of g.out.get(id) ?? []) {
      const c = color.get(e.toNodeId) ?? 0
      if (c === 1) return e.toNodeId
      if (c === 0) { const r = dfs(e.toNodeId); if (r) return r }
    }
    color.set(id, 2)
    return null
  }
  for (const n of g.nodes) if ((color.get(n.id) ?? 0) === 0) { const c = dfs(n.id); if (c) { problems.push({ code: 'cycle', nodeId: c, message: `«${label(g.byId.get(c)!)}»: блоки утворюють цикл — людина ходитиме по колу. Розірвіть звʼязок` }); break } }

  return problems
}

async function contentStatuses(tx: TenantTx, nodes: Node[]): Promise<Map<string, boolean>> {
  const m = new Map<string, boolean>()
  for (const n of nodes) if (n.kind === 'task' && n.contentType && n.contentId) m.set(n.id, !!await findContent(tx, n.contentType as ContentType, n.contentId))
  return m
}

export async function validateTrajectory(tx: TenantTx, id: string): Promise<GraphProblem[] | null> {
  const [t] = await tx.select({ id: trajectories.id }).from(trajectories).where(eq(trajectories.id, id))
  if (!t) return null
  const g = await loadGraph(tx, id)
  return validateGraph(g, await contentStatuses(tx, g.nodes))
}

// ── CRUD ──────────────────────────────────────────────────────────────────────────────

export async function listTrajectories(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({
      id: trajectories.id, title: trajectories.title, status: trajectories.status, assignMode: trajectories.assignMode, tags: trajectories.tags,
      automationRuleId: trajectories.automationRuleId, ruleName: automationRules.name, updatedAt: trajectories.updatedAt, publishedAt: trajectories.publishedAt,
      blocks: sql<number>`(select count(*)::int from trajectory_nodes n where n.trajectory_id = ${trajectories.id})`,
      people: sql<number>`(select count(*)::int from trajectory_enrollments e where e.trajectory_id = ${trajectories.id} and e.cancelled_at is null)`,
      done: sql<number>`(select count(*)::int from trajectory_enrollments e where e.trajectory_id = ${trajectories.id} and e.status = 'done')`,
    }).from(trajectories).leftJoin(automationRules, eq(automationRules.id, trajectories.automationRuleId))
      .where(sql`${trajectories.status} <> 'archived'`).orderBy(desc(trajectories.updatedAt))
  })
}

export async function createTrajectory(ctx: Ctx, input: z.infer<typeof trajectoryCreateSchema>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [t] = await tx.insert(trajectories).values({ tenantId: ctx.tenantId, ...input, createdBy: ctx.actorId, updatedBy: ctx.actorId }).returning()
    // Start и Finish создаются автоматически (docs/17 §5.1)
    await tx.insert(trajectoryNodes).values([
      { tenantId: ctx.tenantId, trajectoryId: t!.id, kind: 'start', x: 16, y: 160 },
      { tenantId: ctx.tenantId, trajectoryId: t!.id, kind: 'finish', x: 640, y: 160 },
    ])
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'trajectory.create', entity: 'trajectory', entityId: t!.id, after: { title: input.title } })
    return t!
  })
}

async function nodeTitles(tx: TenantTx, nodes: Node[]): Promise<Map<string, string>> {
  const m = new Map<string, string>()
  for (const n of nodes) {
    if (n.kind === 'task' && n.contentType && n.contentId) m.set(n.id, (await findContent(tx, n.contentType as ContentType, n.contentId))?.title ?? '')
    if (n.kind === 'mentor' && n.mentorId) { const [u] = await tx.select({ n: users.fullName }).from(users).where(eq(users.id, n.mentorId)); m.set(n.id, u?.n ?? '') }
  }
  return m
}

export async function getTrajectory(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [t] = await tx.select().from(trajectories).where(eq(trajectories.id, id))
    if (!t) return null
    const g = await loadGraph(tx, id)
    const titles = await nodeTitles(tx, g.nodes)
    const [rule] = t.automationRuleId ? await tx.select({ id: automationRules.id, name: automationRules.name }).from(automationRules).where(eq(automationRules.id, t.automationRuleId)) : []
    const [stats] = await tx.select({
      people: sql<number>`count(*) filter (where cancelled_at is null)::int`, done: sql<number>`count(*) filter (where status = 'done')::int`,
      inProgress: sql<number>`count(*) filter (where status = 'in_progress' and cancelled_at is null)::int`, requested: sql<number>`count(*) filter (where status = 'not_assigned' and requested_at is not null and cancelled_at is null)::int`,
    }).from(trajectoryEnrollments).where(eq(trajectoryEnrollments.trajectoryId, id))
    const [author] = t.updatedBy ? await tx.select({ n: users.fullName }).from(users).where(eq(users.id, t.updatedBy)) : []
    return {
      ...t, rule: rule ?? null, updatedByName: author?.n ?? null, stats,
      nodes: g.nodes.map(n => ({ ...n, contentTitle: titles.get(n.id) ?? null })),
      edges: g.edges,
    }
  })
}

export async function updateTrajectory(ctx: Ctx, id: string, input: z.infer<typeof trajectoryUpdateSchema>): Promise<{ ok: true, trajectory: Trajectory } | { ok: false, code: 'not_found' | 'rule_not_found' | 'rule_required' }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(trajectories).where(eq(trajectories.id, id))
    if (!before) return { ok: false as const, code: 'not_found' as const }
    if (input.automationRuleId) {
      const [r] = await tx.select({ id: automationRules.id }).from(automationRules).where(eq(automationRules.id, input.automationRuleId))
      if (!r) return { ok: false as const, code: 'rule_not_found' as const }
    }
    const assignMode = input.assignMode ?? before.assignMode
    const ruleId = input.automationRuleId === undefined ? before.automationRuleId : input.automationRuleId
    if (assignMode === 'automation' && !ruleId) return { ok: false as const, code: 'rule_required' as const }
    const [t] = await tx.update(trajectories).set({ ...input, updatedAt: new Date(), updatedBy: ctx.actorId }).where(eq(trajectories.id, id)).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'trajectory.update', entity: 'trajectory', entityId: id, before: { assignMode: before.assignMode, status: before.status, automationRuleId: before.automationRuleId }, after: input })
    return { ok: true as const, trajectory: t! }
  })
}

export type GraphPutResult = { ok: true, nodes: Node[], edges: Edge[], problems: GraphProblem[], ids: Record<string, string> } | { ok: false, code: 'not_found' | 'published' | 'bad_edge', message?: string }

/**
 * PUT /trajectories/:id/graph — полотно целиком. У опубликованной траектории меняются только
 * координаты (состояния людей ссылаются на узлы); состав — через дубликат (docs/17 §7.6).
 */
export async function putGraph(ctx: Ctx, id: string, input: TrajectoryGraphInput): Promise<GraphPutResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [t] = await tx.select().from(trajectories).where(eq(trajectories.id, id))
    if (!t) return { ok: false as const, code: 'not_found' as const }
    const existing = await loadGraph(tx, id)
    if (t.status === 'published') {
      const incoming = new Set(input.nodes.map(n => n.id).filter(Boolean))
      const same = existing.nodes.every(n => incoming.has(n.id)) && input.nodes.every(n => n.id && existing.byId.has(n.id))
        && input.edges.length === existing.edges.length && input.edges.every(e => existing.edges.some(x => x.fromNodeId === e.fromNodeId && x.toNodeId === e.toNodeId))
      if (!same) return { ok: false as const, code: 'published' as const }
      for (const n of input.nodes) await tx.update(trajectoryNodes).set({ x: n.x, y: n.y, updatedAt: new Date() }).where(eq(trajectoryNodes.id, n.id!))
      const g = await loadGraph(tx, id)
      return { ok: true as const, nodes: g.nodes, edges: g.edges, problems: validateGraph(g, await contentStatuses(tx, g.nodes)), ids: {} }
    }

    // Узлы: обновить существующие, создать новые (tmpId → id), удалить пропавшие
    const idMap = new Map<string, string>()
    const keep = new Set<string>()
    for (const n of input.nodes) {
      const base = { kind: n.kind, x: n.x, y: n.y, title: 'title' in n ? (n.title ?? null) : null, days: 'days' in n ? n.days : null, contentType: n.kind === 'task' ? n.contentType : null, contentId: n.kind === 'task' ? n.contentId : null, mentorId: n.kind === 'mentor' ? (n.mentorId ?? null) : null, params: n.kind === 'task' ? n.params : {} }
      if (n.id && existing.byId.has(n.id)) {
        await tx.update(trajectoryNodes).set({ ...base, updatedAt: new Date() }).where(eq(trajectoryNodes.id, n.id))
        keep.add(n.id); idMap.set(n.id, n.id)
      }
      else {
        const [row] = await tx.insert(trajectoryNodes).values({ tenantId: ctx.tenantId, trajectoryId: id, ...base }).returning({ id: trajectoryNodes.id })
        keep.add(row!.id); if (n.tmpId) idMap.set(n.tmpId, row!.id); if (n.id) idMap.set(n.id, row!.id)
      }
    }
    const gone = existing.nodes.filter(n => !keep.has(n.id)).map(n => n.id)
    if (gone.length) await tx.delete(trajectoryNodes).where(inArray(trajectoryNodes.id, gone))

    await tx.delete(trajectoryEdges).where(eq(trajectoryEdges.trajectoryId, id))
    const rows = []
    for (const [i, e] of input.edges.entries()) {
      const from = idMap.get(e.fromNodeId), to = idMap.get(e.toNodeId)
      if (!from || !to) return { ok: false as const, code: 'bad_edge' as const, message: 'Звʼязок посилається на блок, якого немає на полотні' }
      if (from === to) return { ok: false as const, code: 'bad_edge' as const, message: 'Блок не може бути зʼєднаний сам із собою' }
      rows.push({ tenantId: ctx.tenantId, trajectoryId: id, fromNodeId: from, toNodeId: to, condition: e.condition ?? null, sort: e.sort ?? i })
    }
    if (rows.length) await tx.insert(trajectoryEdges).values(rows).onConflictDoNothing()
    await tx.update(trajectories).set({ updatedAt: new Date(), updatedBy: ctx.actorId }).where(eq(trajectories.id, id))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'trajectory.graph', entity: 'trajectory', entityId: id, after: { nodes: input.nodes.length, edges: rows.length, removed: gone.length } })
    const g = await loadGraph(tx, id)
    return { ok: true as const, nodes: g.nodes, edges: g.edges, problems: validateGraph(g, await contentStatuses(tx, g.nodes)), ids: Object.fromEntries(idMap) }
  })
}

export async function publishTrajectory(ctx: Ctx, id: string): Promise<{ ok: true } | { ok: false, code: 'not_found' | 'invalid' | 'rule_required', problems: GraphProblem[] }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [t] = await tx.select().from(trajectories).where(eq(trajectories.id, id))
    if (!t) return { ok: false as const, code: 'not_found' as const, problems: [] }
    if (t.assignMode === 'automation' && !t.automationRuleId) return { ok: false as const, code: 'rule_required' as const, problems: [] }
    const problems = (await validateTrajectory(tx, id))!
    if (problems.length) return { ok: false as const, code: 'invalid' as const, problems }
    await tx.update(trajectories).set({ status: 'published', publishedAt: new Date(), updatedAt: new Date(), updatedBy: ctx.actorId }).where(eq(trajectories.id, id))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'trajectory.publish', entity: 'trajectory', entityId: id, before: { status: t.status }, after: { status: 'published' } })
    return { ok: true as const }
  })
}

export async function duplicateTrajectory(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [t] = await tx.select().from(trajectories).where(eq(trajectories.id, id))
    if (!t) return null
    const g = await loadGraph(tx, id)
    const { id: _id, createdAt: _c, updatedAt: _u, publishedAt: _p, ...rest } = t
    const [copy] = await tx.insert(trajectories).values({ ...rest, title: `${t.title} (копія)`, status: 'draft', createdBy: ctx.actorId, updatedBy: ctx.actorId }).returning()
    const map = new Map<string, string>()
    for (const n of g.nodes) {
      const { id: nid, createdAt: _nc, updatedAt: _nu, ...nrest } = n
      const [row] = await tx.insert(trajectoryNodes).values({ ...nrest, trajectoryId: copy!.id }).returning({ id: trajectoryNodes.id })
      map.set(nid, row!.id)
    }
    if (g.edges.length) await tx.insert(trajectoryEdges).values(g.edges.map(e => ({ tenantId: ctx.tenantId, trajectoryId: copy!.id, fromNodeId: map.get(e.fromNodeId)!, toNodeId: map.get(e.toNodeId)!, condition: e.condition, sort: e.sort })))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'trajectory.duplicate', entity: 'trajectory', entityId: copy!.id, after: { from: id } })
    return copy!
  })
}

/** Где используется контент: траектории с блоком «Завдання» на него (для usages контента и архивирования). */
export async function contentUsages(ctx: Ctx, contentType: string, contentId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.selectDistinct({ id: trajectories.id, title: trajectories.title, status: trajectories.status }).from(trajectoryNodes)
      .innerJoin(trajectories, eq(trajectories.id, trajectoryNodes.trajectoryId))
      .where(and(eq(trajectoryNodes.contentType, contentType), eq(trajectoryNodes.contentId, contentId)))
  })
}

/** Где используется траектория: правило, назначения узлов, прохождения. */
export async function trajectoryUsages(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [t] = await tx.select().from(trajectories).where(eq(trajectories.id, id))
    if (!t) return null
    const [rule] = t.automationRuleId ? await tx.select({ id: automationRules.id, name: automationRules.name }).from(automationRules).where(eq(automationRules.id, t.automationRuleId)) : []
    const [enr] = await tx.select({
      total: sql<number>`count(*) filter (where cancelled_at is null)::int`, inProgress: sql<number>`count(*) filter (where status = 'in_progress' and cancelled_at is null)::int`,
      done: sql<number>`count(*) filter (where status = 'done')::int`, failed: sql<number>`count(*) filter (where status = 'failed')::int`,
    }).from(trajectoryEnrollments).where(eq(trajectoryEnrollments.trajectoryId, id))
    const [asg] = await tx.select({ n: sql<number>`count(*)::int` }).from(assignments).where(sql`${assignments.audience}->>'trajectoryId' = ${id}`)
    return { rule: rule ?? null, enrollments: enr, assignments: asg?.n ?? 0 }
  })
}

export async function trajectoriesUsingRules(tx: TenantTx, ruleIds: string[]): Promise<Map<string, { id: string, title: string }[]>> {
  const out = new Map<string, { id: string, title: string }[]>()
  if (!ruleIds.length) return out
  const rows = await tx.select({ id: trajectories.id, title: trajectories.title, ruleId: trajectories.automationRuleId }).from(trajectories)
    .where(and(inArray(trajectories.automationRuleId, ruleIds), sql`${trajectories.status} <> 'archived'`))
  for (const r of rows) out.set(r.ruleId!, [...(out.get(r.ruleId!) ?? []), { id: r.id, title: r.title }])
  return out
}

// ── Зачисление ────────────────────────────────────────────────────────────────────────

export type EnrollResult = { ok: true, enrollmentId: string, created: boolean, started: boolean } | { ok: false, code: 'not_found' | 'not_published' | 'finished_no_reassign' | 'already_active' }

/**
 * Зачисление человека (внутри транзакции вызывающего). `stopAssignAfterFinish` — завершивший
 * повторно не назначается (docs/17 §7.5). Старт (активация Start) — отдельно, после фиксации: startEnrollment.
 */
export async function enrollTx(tx: TenantTx, tenantId: string, trajectoryId: string, userId: string, opts: { source: 'manual' | 'catalog' | 'automation', ruleId?: string | null, availableFrom?: Date | null, requested?: boolean, actorId: string | null }): Promise<EnrollResult> {
  const [t] = await tx.select().from(trajectories).where(eq(trajectories.id, trajectoryId))
  if (!t) return { ok: false, code: 'not_found' }
  if (t.status !== 'published') return { ok: false, code: 'not_published' }
  const [prev] = await tx.select().from(trajectoryEnrollments).where(and(eq(trajectoryEnrollments.trajectoryId, trajectoryId), eq(trajectoryEnrollments.userId, userId)))
  if (prev) {
    if (prev.status === 'done' && t.stopAssignAfterFinish) return { ok: false, code: 'finished_no_reassign' }
    if (!prev.cancelledAt && prev.status !== 'done' && prev.status !== 'failed') return { ok: true, enrollmentId: prev.id, created: false, started: false }
    // Снятое или завершённое (при разрешённом повторе) — начинаем заново
    await tx.delete(trajectoryNodeStates).where(eq(trajectoryNodeStates.enrollmentId, prev.id))
    const [row] = await tx.update(trajectoryEnrollments).set({
      status: opts.requested ? 'not_assigned' : 'not_started', source: opts.source, ruleId: opts.ruleId ?? null, mentorId: null, requestedAt: opts.requested ? new Date() : null,
      availableFrom: opts.availableFrom ?? null, startedAt: null, completedAt: null, cancelledAt: null, cancelReason: null, progressPct: '0', updatedAt: new Date(),
    }).where(eq(trajectoryEnrollments.id, prev.id)).returning({ id: trajectoryEnrollments.id })
    await recordAudit(tx, { tenantId, actorId: opts.actorId, action: 'trajectory.enroll', entity: 'trajectory_enrollment', entityId: row!.id, after: { userId, trajectoryId, source: opts.source, repeat: true } })
    return { ok: true, enrollmentId: row!.id, created: true, started: false }
  }
  const [row] = await tx.insert(trajectoryEnrollments).values({
    tenantId, trajectoryId, userId, status: opts.requested ? 'not_assigned' : 'not_started', source: opts.source, ruleId: opts.ruleId ?? null,
    requestedAt: opts.requested ? new Date() : null, availableFrom: opts.availableFrom ?? null,
  }).returning({ id: trajectoryEnrollments.id })
  await recordAudit(tx, { tenantId, actorId: opts.actorId, action: 'trajectory.enroll', entity: 'trajectory_enrollment', entityId: row!.id, after: { userId, trajectoryId, source: opts.source, availableFrom: opts.availableFrom ?? null } })
  if (!opts.requested) await enqueueNotification(tx, { tenantId, userId, code: 'trajectory_assigned', payload: { title: t.title, availableFrom: opts.availableFrom?.toISOString() ?? null }, dedupKey: `trajectory_assigned:${row!.id}`, refType: 'trajectory_enrollment', refId: row!.id })
  return { ok: true, enrollmentId: row!.id, created: true, started: false }
}

/** POST /trajectories/:id/assign — ручное назначение списком (assign_mode = manual или любой другой — админ всегда может). */
export async function assignTrajectory(ctx: Ctx, id: string, userIds: string[]): Promise<{ ok: true, added: number, skipped: { userId: string, code: string }[] } | { ok: false, code: 'not_found' | 'not_published' }> {
  const toStart: string[] = []
  const r = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [t] = await tx.select({ id: trajectories.id, status: trajectories.status }).from(trajectories).where(eq(trajectories.id, id))
    if (!t) return { ok: false as const, code: 'not_found' as const }
    if (t.status !== 'published') return { ok: false as const, code: 'not_published' as const }
    const people = await tx.select({ id: users.id }).from(users).where(and(inArray(users.id, userIds), eq(users.status, 'active')))
    let added = 0; const skipped: { userId: string, code: string }[] = []
    for (const u of people) {
      const e = await enrollTx(tx, ctx.tenantId, id, u.id, { source: 'manual', actorId: ctx.actorId })
      if (!e.ok) { skipped.push({ userId: u.id, code: e.code }); continue }
      if (!e.created) { skipped.push({ userId: u.id, code: 'already_active' }); continue }
      added++; toStart.push(e.enrollmentId)
    }
    return { ok: true as const, added, skipped }
  })
  for (const eid of toStart) await startEnrollment(ctx.tenantId, eid, ctx.actorId)
  return r
}

/** Правило автоматизации → траектории с assign_mode=automation на это правило (вызывается из runRules внутри его транзакции). */
export async function assignTrajectoriesForRule(tx: TenantTx, tenantId: string, ruleId: string, userId: string, opts: { dryRun: boolean, delayDays: number }) {
  const list = await tx.select().from(trajectories).where(and(eq(trajectories.automationRuleId, ruleId), eq(trajectories.assignMode, 'automation'), eq(trajectories.status, 'published')))
  const out: { type: 'assign_trajectory', trajectoryId: string, title: string, wouldAssign?: boolean, enrollmentId?: string, started?: boolean, skipped?: string }[] = []
  for (const t of list) {
    if (opts.dryRun) { out.push({ type: 'assign_trajectory', trajectoryId: t.id, title: t.title, wouldAssign: true }); continue }
    const availableFrom = opts.delayDays > 0 ? new Date(Date.now() + opts.delayDays * 86_400_000) : null
    const r = await enrollTx(tx, tenantId, t.id, userId, { source: 'automation', ruleId, availableFrom, actorId: null })
    if (!r.ok) out.push({ type: 'assign_trajectory', trajectoryId: t.id, title: t.title, skipped: r.code })
    else out.push({ type: 'assign_trajectory', trajectoryId: t.id, title: t.title, enrollmentId: r.enrollmentId, started: r.created && !availableFrom })
  }
  return out
}

/** Каталог (docs/17 §3.4): траектории с режимом catalog_free / catalog_request. */
export async function catalogTrajectories(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({
      id: trajectories.id, title: trajectories.title, description: trajectories.description, coverKey: trajectories.coverKey, assignMode: trajectories.assignMode, tags: trajectories.tags,
      blocks: sql<number>`(select count(*)::int from trajectory_nodes n where n.trajectory_id = ${trajectories.id} and n.kind = 'task')`,
      enrollmentId: trajectoryEnrollments.id, enrollmentStatus: trajectoryEnrollments.status, requestedAt: trajectoryEnrollments.requestedAt,
    }).from(trajectories)
      .leftJoin(trajectoryEnrollments, and(eq(trajectoryEnrollments.trajectoryId, trajectories.id), eq(trajectoryEnrollments.userId, ctx.actorId), isNull(trajectoryEnrollments.cancelledAt)))
      .where(and(eq(trajectories.status, 'published'), inArray(trajectories.assignMode, ['catalog_free', 'catalog_request']))).orderBy(trajectories.title)
  })
}

/** Самозапись или заявка через каталог — по режиму траектории. */
export async function selfEnroll(ctx: Ctx, id: string): Promise<EnrollResult | { ok: false, code: 'not_in_catalog' } | { ok: true, requested: true, enrollmentId: string }> {
  const r = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [t] = await tx.select().from(trajectories).where(eq(trajectories.id, id))
    if (!t) return { ok: false as const, code: 'not_found' as const }
    if (t.assignMode !== 'catalog_free' && t.assignMode !== 'catalog_request') return { ok: false as const, code: 'not_in_catalog' as const }
    const requested = t.assignMode === 'catalog_request'
    const e = await enrollTx(tx, ctx.tenantId, id, ctx.actorId, { source: 'catalog', requested, actorId: ctx.actorId })
    if (e.ok && e.created && requested) {
      const managerId = await mentorFor(tx, ctx.actorId, null)
      if (managerId) await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: managerId, code: 'trajectory_request', payload: { title: t.title }, dedupKey: `trajectory_request:${e.enrollmentId}`, refType: 'trajectory_enrollment', refId: e.enrollmentId })
      return { ok: true as const, requested: true as const, enrollmentId: e.enrollmentId }
    }
    return e
  })
  if (r.ok && 'created' in r && r.created) await startEnrollment(ctx.tenantId, r.enrollmentId, ctx.actorId)
  return r
}

/** Решение по заявке (catalog_request) — тем, у кого есть assignment.create; відмова — з причиною (docs/10 §14.1). */
export async function decideRequest(ctx: Ctx, enrollmentId: string, approve: boolean, reason?: string): Promise<{ ok: true } | { ok: false, code: 'not_found' | 'not_requested' }> {
  const r = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [e] = await tx.select().from(trajectoryEnrollments).where(eq(trajectoryEnrollments.id, enrollmentId))
    if (!e) return { ok: false as const, code: 'not_found' as const }
    if (e.status !== 'not_assigned' || !e.requestedAt || e.cancelledAt) return { ok: false as const, code: 'not_requested' as const }
    if (approve) await tx.update(trajectoryEnrollments).set({ status: 'not_started', updatedAt: new Date() }).where(eq(trajectoryEnrollments.id, enrollmentId))
    else {
      await tx.update(trajectoryEnrollments).set({ cancelledAt: new Date(), cancelReason: reason ?? 'request_rejected', updatedAt: new Date() }).where(eq(trajectoryEnrollments.id, enrollmentId))
      await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: e.userId, code: 'catalog_request_rejected', payload: { reason: reason ?? null }, dedupKey: `catalog_request_rejected:${enrollmentId}` })
    }
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: approve ? 'trajectory.request.approve' : 'trajectory.request.reject', entity: 'trajectory_enrollment', entityId: enrollmentId, after: { userId: e.userId, reason } })
    return { ok: true as const }
  })
  if (r.ok && approve) await startEnrollment(ctx.tenantId, enrollmentId, ctx.actorId)
  return r
}

// ── Движок прохождения ────────────────────────────────────────────────────────────────

/** Побочные эффекты, которые нельзя делать внутри транзакции: раскрытие назначений, таймеры pg-boss. */
interface Effects { expand: string[], timers: { stateId: string, at: Date }[] }
const newEffects = (): Effects => ({ expand: [], timers: [] })

interface Run { tx: TenantTx, tenantId: string, actorId: string | null, enr: Enrollment, t: Trajectory, g: Graph, states: Map<string, NodeState>, fx: Effects, visited: Set<string> }

async function loadRun(tx: TenantTx, tenantId: string, enrollmentId: string, actorId: string | null, fx: Effects): Promise<Run | null> {
  const [enr] = await tx.select().from(trajectoryEnrollments).where(eq(trajectoryEnrollments.id, enrollmentId))
  if (!enr) return null
  const [t] = await tx.select().from(trajectories).where(eq(trajectories.id, enr.trajectoryId))
  if (!t) return null
  const g = await loadGraph(tx, t.id)
  const rows = await tx.select().from(trajectoryNodeStates).where(eq(trajectoryNodeStates.enrollmentId, enr.id))
  const states = new Map(rows.map(s => [s.nodeId, s]))
  // Недостающие состояния (первый запуск или узлы, добавленные позже) — locked
  const missing = g.nodes.filter(n => !states.has(n.id))
  if (missing.length) {
    const ins = await tx.insert(trajectoryNodeStates).values(missing.map(n => ({ tenantId, enrollmentId: enr.id, nodeId: n.id, status: 'locked' }))).returning()
    for (const s of ins) states.set(s.nodeId, s)
  }
  return { tx, tenantId, actorId, enr, t, g, states, fx, visited: new Set() }
}

async function setState(run: Run, nodeId: string, patch: Partial<NodeState>) {
  const [row] = await run.tx.update(trajectoryNodeStates).set({ ...patch, updatedAt: new Date() }).where(and(eq(trajectoryNodeStates.enrollmentId, run.enr.id), eq(trajectoryNodeStates.nodeId, nodeId))).returning()
  if (row) run.states.set(nodeId, row)
  return row!
}

async function mentorFor(tx: TenantTx, userId: string, explicit: string | null): Promise<string | null> {
  if (explicit) return explicit
  const [row] = await tx.select({ managerId: locations.managerId }).from(userPlacements)
    .innerJoin(locations, eq(locations.id, userPlacements.locationId))
    .where(and(eq(userPlacements.userId, userId), eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt)))
  return row?.managerId ?? null
}

/** Активировать узел: locked → available (или сразу done для start/finish/stop_delay/or/and-с-выполненными-входами). */
async function activate(run: Run, node: Node): Promise<void> {
  const st = run.states.get(node.id)!
  if (st.status !== 'locked') return
  if (run.visited.has(`a:${node.id}`)) return
  run.visited.add(`a:${node.id}`)
  const now = new Date()
  switch (node.kind) {
    case 'start':
      await setState(run, node.id, { status: 'done', activatedAt: now, finishedAt: now })
      return complete(run, node)
    case 'finish':
      await setState(run, node.id, { status: 'done', activatedAt: now, finishedAt: now })
      return
    case 'task': {
      await setState(run, node.id, { status: 'available', activatedAt: now })
      const assignmentId = await createNodeAssignment(run, node)
      await setState(run, node.id, { assignmentId })
      await enqueueNotification(run.tx, { tenantId: run.tenantId, userId: run.enr.userId, code: 'trajectory_next_unlocked', payload: { title: run.t.title, step: node.title ?? null }, dedupKey: `trajectory_next:${run.enr.id}:${node.id}`, refType: 'trajectory_enrollment', refId: run.enr.id })
      return
    }
    case 'and': {
      await setState(run, node.id, { status: 'available', activatedAt: now })
      return checkAnd(run, node)
    }
    case 'or':
      await setState(run, node.id, { status: 'done', activatedAt: now, finishedAt: now })
      return complete(run, node)
    case 'delay': {
      const at = new Date(now.getTime() + (node.days ?? 1) * 86_400_000)
      const s = await setState(run, node.id, { status: 'available', activatedAt: now, firesAt: at })
      run.fx.timers.push({ stateId: s.id, at })
      return
    }
    case 'stop_delay': {
      // Пропускает сразу; через N днів закрывает доступ к следующим блокам, если они не выполнены
      const at = new Date(now.getTime() + (node.days ?? 1) * 86_400_000)
      const s = await setState(run, node.id, { status: 'done', activatedAt: now, finishedAt: now, firesAt: at })
      run.fx.timers.push({ stateId: s.id, at })
      return complete(run, node)
    }
    case 'branch': {
      await setState(run, node.id, { status: 'available', activatedAt: now })
      return resolveBranch(run, node)
    }
    case 'mentor': {
      const mentorId = await mentorFor(run.tx, run.enr.userId, node.mentorId)
      await setState(run, node.id, { status: 'available', activatedAt: now })
      if (mentorId) {
        await run.tx.update(trajectoryEnrollments).set({ mentorId, updatedAt: now }).where(eq(trajectoryEnrollments.id, run.enr.id))
        run.enr = { ...run.enr, mentorId }
        await enqueueNotification(run.tx, { tenantId: run.tenantId, userId: mentorId, code: 'trajectory_mentor_confirm', payload: { title: run.t.title, step: node.title ?? null, userId: run.enr.userId }, dedupKey: `trajectory_mentor:${run.enr.id}:${node.id}`, refType: 'trajectory_enrollment', refId: run.enr.id })
      }
      return
    }
  }
}

/** Узел выполнен → активировать следующие (кроме branch — он выбирает ветку сам). */
async function complete(run: Run, node: Node): Promise<void> {
  const outs = run.g.out.get(node.id) ?? []
  for (const e of outs) {
    const next = run.g.byId.get(e.toNodeId)
    if (!next) continue
    const st = run.states.get(next.id)!
    if (st.status === 'locked') await activate(run, next)
    else if (next.kind === 'and' && st.status === 'available') await checkAnd(run, next)
  }
}

async function checkAnd(run: Run, node: Node): Promise<void> {
  const ins = run.g.inc.get(node.id) ?? []
  if (!ins.every(e => run.states.get(e.fromNodeId)?.status === 'done')) return
  await setState(run, node.id, { status: 'done', finishedAt: new Date() })
  return complete(run, node)
}

function matches(c: BranchCondition, s: NodeState): boolean {
  switch (c.op) {
    case 'passed': return s.passed === true
    case 'failed': return s.passed === false
    case 'score_gte': return s.score != null && Number(s.score) >= c.value
    case 'else': return false
  }
}

/** «Розгалуження за результатом»: результат ближайшего блока «Завдання» на входе → первая подходящая ветка, иначе «інакше». */
async function resolveBranch(run: Run, node: Node): Promise<void> {
  const ins = run.g.inc.get(node.id) ?? []
  const src = ins.map(e => run.states.get(e.fromNodeId)!).find(s => run.g.byId.get(s.nodeId)?.kind === 'task' && s.passed !== null) ?? ins.map(e => run.states.get(e.fromNodeId)!)[0]
  const outs = run.g.out.get(node.id) ?? []
  const chosen = outs.find(e => e.condition && src && matches(e.condition as BranchCondition, src)) ?? outs.find(e => (e.condition as BranchCondition | null)?.op === 'else')
  await setState(run, node.id, { status: 'done', finishedAt: new Date(), chosenEdgeId: chosen?.id ?? null, passed: src?.passed ?? null, score: src?.score ?? null })
  for (const e of outs) {
    if (e.id === chosen?.id) continue
    const st = run.states.get(e.toNodeId)
    // Невыбранная ветка пропускается, только если в узел нет другого пути (иначе он откроется по нему)
    const onlyFromHere = (run.g.inc.get(e.toNodeId) ?? []).every(x => x.fromNodeId === node.id)
    if (st?.status === 'locked' && onlyFromHere) await setState(run, e.toNodeId, { status: 'skipped', reason: 'branch_not_taken', finishedAt: new Date() })
  }
  if (chosen) { const next = run.g.byId.get(chosen.toNodeId); if (next && run.states.get(next.id)!.status === 'locked') await activate(run, next) }
}

/** Узел «Завдання» создаёт назначение той же транзакцией: правила — из узла, источник — траектория (kind=trajectory). */
async function createNodeAssignment(run: Run, node: Node): Promise<string | null> {
  const params = (node.params ?? {}) as Record<string, unknown>
  const dueDays = typeof params.dueDays === 'number' ? params.dueDays : undefined
  const input = assignmentCreateSchema.parse({
    subjectType: node.contentType, subjectId: node.contentId, title: node.title || undefined,
    audience: { rules: [{ type: 'user', ids: [run.enr.userId] }], match: 'any' },
    dueMode: dueDays ? 'relative' : 'none', dueDays: dueDays ?? 14, isMandatory: true, autoSync: false, status: 'active',
    params: Object.fromEntries(Object.entries(params).filter(([k]) => k !== 'dueDays')),
    method: { automationRuleId: run.enr.ruleId ?? null },
    reminders: { notifyOnAssign: true },
  })
  const r = await createAssignmentTx(run.tx, { tenantId: run.tenantId, actorId: run.actorId }, input, { kind: 'trajectory', trajectoryId: run.t.id, nodeId: node.id, enrollmentId: run.enr.id })
  if (!r.ok) {
    // Контент пропал (архив) — узел недоступен, человек идёт дальше не может; это видно в ленте
    await setState(run, node.id, { status: 'failed', reason: `content_${r.code}`, finishedAt: new Date() })
    return null
  }
  run.fx.expand.push(r.assignmentId)
  return r.assignmentId
}

/** Пересчёт статуса и прогресса прохождения (docs/17 §7.1–7.2): прогресс — по блокам «Завдання». */
async function settle(run: Run): Promise<void> {
  const tasks = run.g.nodes.filter(n => n.kind === 'task')
  const relevant = tasks.filter(n => run.states.get(n.id)?.status !== 'skipped')
  const done = relevant.filter(n => run.states.get(n.id)?.status === 'done').length
  const pct = relevant.length ? Math.round((done / relevant.length) * 10000) / 100 : 0
  const finish = run.g.nodes.find(n => n.kind === 'finish')
  const finished = finish ? run.states.get(finish.id)?.status === 'done' : false
  const active = [...run.states.values()].some(s => s.status === 'available' || s.status === 'in_progress')
  const now = new Date()
  let status = run.enr.status
  let completedAt = run.enr.completedAt
  if (finished) { status = 'done'; completedAt = completedAt ?? now }
  else if (!active && run.enr.status !== 'not_assigned') status = 'failed' // некуда идти: доступ закрыт или контент недоступен
  else if (run.enr.status === 'not_started' || run.enr.status === 'not_assigned') status = 'in_progress'
  await run.tx.update(trajectoryEnrollments).set({ status, completedAt, progressPct: String(finished ? 100 : pct), lastActivityAt: now, updatedAt: now }).where(eq(trajectoryEnrollments.id, run.enr.id))
  if (finished && run.enr.status !== 'done') {
    await enqueueNotification(run.tx, { tenantId: run.tenantId, userId: run.enr.userId, code: 'trajectory_finished', payload: { title: run.t.title }, dedupKey: `trajectory_finished:${run.enr.id}`, refType: 'trajectory_enrollment', refId: run.enr.id })
    await recordAudit(run.tx, { tenantId: run.tenantId, actorId: null, action: 'trajectory.finished', entity: 'trajectory_enrollment', entityId: run.enr.id, after: { userId: run.enr.userId } })
  }
}

async function applyEffects(tenantId: string, fx: Effects) {
  for (const aid of fx.expand) await expandAssignment(tenantId, aid).catch(err => console.error('trajectory expand', err))
  if (fx.timers.length) {
    const { enqueueTrajectoryTimer } = await import('./queue')
    for (const t of fx.timers) await enqueueTrajectoryTimer(tenantId, t.stateId, t.at).catch(err => console.error('trajectory timer', err))
  }
}

/** Старт прохождения: активирует Start и всё, что за ним; вне транзакции — раскрытие назначений и таймеры. */
export async function startEnrollment(tenantId: string, enrollmentId: string, actorId: string | null = null): Promise<boolean> {
  const fx = newEffects()
  const ok = await withTenant(tenantId, actorId, async (tx) => {
    const run = await loadRun(tx, tenantId, enrollmentId, actorId, fx)
    if (!run || run.enr.cancelledAt || run.enr.status === 'not_assigned' || run.enr.startedAt) return false
    if (run.enr.availableFrom && run.enr.availableFrom > new Date()) return false
    await tx.update(trajectoryEnrollments).set({ startedAt: new Date(), status: 'in_progress', updatedAt: new Date() }).where(eq(trajectoryEnrollments.id, enrollmentId))
    run.enr = { ...run.enr, startedAt: new Date(), status: 'in_progress' }
    const start = run.g.nodes.find(n => n.kind === 'start')
    if (start) await activate(run, start)
    await settle(run)
    return true
  })
  if (ok) await applyEffects(tenantId, fx)
  return ok
}

const RESULT_TYPE: Record<string, ContentType> = { course: 'course', quiz: 'test', test: 'test', workshop: 'workshop', meetup: 'meetup', webinar: 'webinar', resource: 'resource', complex_test: 'complex_test', training_program: 'training_program', poll: 'poll', assessment: 'assessment', check_list: 'check_list' }

/**
 * Результат по контенту у человека (вызывается там же, где programs.onItemResult).
 * Пройдено → узел done, дальше по графу. Не пройдено → узел failed только если за ним стоит
 * «Розгалуження» (ему нужен результат); иначе узел остаётся открытым — человек пробует ещё.
 */
export async function onTaskResult(tenantId: string, userId: string, itemType: string, contentId: string, result: { passed: boolean, score?: number | null }): Promise<number> {
  const contentType = RESULT_TYPE[itemType]
  if (!contentType) return 0
  const fx = newEffects()
  const n = await withTenant(tenantId, null, async (tx) => {
    const rows = await tx.select({ id: trajectoryNodeStates.id, enrollmentId: trajectoryNodeStates.enrollmentId, nodeId: trajectoryNodeStates.nodeId })
      .from(trajectoryNodeStates)
      .innerJoin(trajectoryNodes, eq(trajectoryNodes.id, trajectoryNodeStates.nodeId))
      .innerJoin(trajectoryEnrollments, eq(trajectoryEnrollments.id, trajectoryNodeStates.enrollmentId))
      .where(and(
        eq(trajectoryEnrollments.userId, userId), eq(trajectoryEnrollments.status, 'in_progress'), isNull(trajectoryEnrollments.cancelledAt),
        eq(trajectoryNodes.kind, 'task'), eq(trajectoryNodes.contentType, contentType), eq(trajectoryNodes.contentId, contentId),
        inArray(trajectoryNodeStates.status, ['available', 'in_progress']),
      ))
    let n = 0
    for (const r of rows) {
      const run = await loadRun(tx, tenantId, r.enrollmentId, null, fx)
      if (!run) continue
      const node = run.g.byId.get(r.nodeId)!
      const score = result.score == null ? null : String(result.score)
      if (result.passed) {
        await setState(run, node.id, { status: 'done', passed: true, score, finishedAt: new Date() })
        await complete(run, node)
      }
      else {
        const hasBranch = (run.g.out.get(node.id) ?? []).some(e => run.g.byId.get(e.toNodeId)?.kind === 'branch')
        await setState(run, node.id, { status: hasBranch ? 'failed' : 'in_progress', passed: false, score, finishedAt: hasBranch ? new Date() : null })
        if (hasBranch) for (const e of run.g.out.get(node.id) ?? []) { const next = run.g.byId.get(e.toNodeId); if (next?.kind === 'branch' && run.states.get(next.id)!.status === 'locked') await activate(run, next) }
      }
      await settle(run)
      n++
    }
    return n
  })
  await applyEffects(tenantId, fx)
  return n
}

/**
 * Таймер узла (обработчик задачи pg-boss `trajectory.timer`; тест зовёт напрямую).
 * delay — пропустить дальше; stop_delay — закрыть доступ к следующим невыполненным блокам.
 */
export async function fireTimer(tenantId: string, stateId: string): Promise<'delay' | 'stop_delay' | 'noop'> {
  const fx = newEffects()
  const r = await withTenant(tenantId, null, async (tx) => {
    const [s] = await tx.select().from(trajectoryNodeStates).where(eq(trajectoryNodeStates.id, stateId))
    if (!s?.firesAt) return 'noop' as const
    const run = await loadRun(tx, tenantId, s.enrollmentId, null, fx)
    if (!run || run.enr.cancelledAt || run.enr.status !== 'in_progress') return 'noop' as const
    const node = run.g.byId.get(s.nodeId)
    if (!node) return 'noop' as const
    if (node.kind === 'delay' && s.status === 'available') {
      await setState(run, node.id, { status: 'done', finishedAt: new Date(), firesAt: null })
      await complete(run, node)
      await settle(run)
      return 'delay' as const
    }
    if (node.kind === 'stop_delay') {
      await setState(run, node.id, { firesAt: null })
      const now = new Date()
      for (const e of run.g.out.get(node.id) ?? []) {
        const st = run.states.get(e.toNodeId)
        if (!st || st.status === 'done' || st.status === 'skipped' || st.status === 'failed') continue
        await setState(run, e.toNodeId, { status: 'failed', reason: 'access_closed', finishedAt: now })
        if (st.assignmentId) await closeNodeAssignment(tx, tenantId, st.assignmentId, run.enr.userId, 'access_closed')
      }
      await enqueueNotification(tx, { tenantId, userId: run.enr.userId, code: 'trajectory_access_closed', payload: { title: run.t.title, step: node.title ?? null }, dedupKey: `trajectory_closed:${run.enr.id}:${node.id}`, refType: 'trajectory_enrollment', refId: run.enr.id })
      await recordAudit(tx, { tenantId, actorId: null, action: 'trajectory.access_closed', entity: 'trajectory_enrollment', entityId: run.enr.id, after: { nodeId: node.id, userId: run.enr.userId } })
      await settle(run)
      return 'stop_delay' as const
    }
    return 'noop' as const
  })
  await applyEffects(tenantId, fx)
  return r
}

/** Снять назначение узла у человека: запись cancelled_at, назначение — в архив. */
async function closeNodeAssignment(tx: TenantTx, tenantId: string, assignmentId: string, userId: string, reason: string) {
  const now = new Date()
  await tx.update(enrollments).set({ cancelledAt: now, cancelReason: reason, updatedAt: now })
    .where(and(eq(enrollments.assignmentId, assignmentId), eq(enrollments.userId, userId), isNull(enrollments.cancelledAt), inArray(enrollments.status, ['not_started', 'in_progress'])))
  await tx.update(assignments).set({ status: 'archived', autoSync: false, updatedAt: now }).where(and(eq(assignments.id, assignmentId), eq(assignments.kind, 'trajectory')))
  void tenantId
}

/** Подтверждение наставником (узел mentor): наставник из прохождения, руководитель точки или админ (assignment.create). */
export async function confirmMentor(ctx: Ctx, enrollmentId: string, nodeId: string, opts: { isAdmin: boolean }): Promise<{ ok: true } | { ok: false, code: 'not_found' | 'not_mentor' | 'not_waiting' }> {
  const fx = newEffects()
  const r = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const run = await loadRun(tx, ctx.tenantId, enrollmentId, ctx.actorId, fx)
    if (!run) return { ok: false as const, code: 'not_found' as const }
    const node = run.g.byId.get(nodeId)
    const st = run.states.get(nodeId)
    if (!node || node.kind !== 'mentor' || !st) return { ok: false as const, code: 'not_found' as const }
    if (st.status !== 'available') return { ok: false as const, code: 'not_waiting' as const }
    const allowed = opts.isAdmin || run.enr.mentorId === ctx.actorId || (await mentorFor(tx, run.enr.userId, null)) === ctx.actorId
    if (!allowed) return { ok: false as const, code: 'not_mentor' as const }
    await setState(run, nodeId, { status: 'done', passed: true, finishedAt: new Date() })
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'trajectory.mentor_confirm', entity: 'trajectory_enrollment', entityId: enrollmentId, after: { nodeId, userId: run.enr.userId } })
    await complete(run, node)
    await settle(run)
    return { ok: true as const }
  })
  await applyEffects(ctx.tenantId, fx)
  return r
}

/** Снятие прохождения (Г-15.2 для траекторий, ручное снятие): признак cancelled_at, назначения открытых узлов — в архив. */
export async function cancelTrajectoryEnrollment(tenantId: string, enrollmentId: string, opts: { actorId: string | null, reason: string, onLeaveCondition?: string }): Promise<boolean> {
  return withTenant(tenantId, opts.actorId, async (tx) => {
    const [e] = await tx.select().from(trajectoryEnrollments).where(eq(trajectoryEnrollments.id, enrollmentId))
    if (!e || e.cancelledAt || e.status === 'done') return false
    const now = new Date()
    await tx.update(trajectoryEnrollments).set({ cancelledAt: now, cancelReason: opts.reason, updatedAt: now }).where(eq(trajectoryEnrollments.id, enrollmentId))
    const open = await tx.select().from(trajectoryNodeStates).where(and(eq(trajectoryNodeStates.enrollmentId, enrollmentId), inArray(trajectoryNodeStates.status, ['available', 'in_progress'])))
    for (const s of open) {
      await tx.update(trajectoryNodeStates).set({ status: 'skipped', reason: 'cancelled', finishedAt: now, firesAt: null, updatedAt: now }).where(eq(trajectoryNodeStates.id, s.id))
      if (s.assignmentId) await closeNodeAssignment(tx, tenantId, s.assignmentId, e.userId, opts.reason)
    }
    await recordAudit(tx, { tenantId, actorId: opts.actorId, action: 'trajectory.cancel', entity: 'trajectory_enrollment', entityId: enrollmentId, after: { userId: e.userId, reason: opts.reason, onLeaveCondition: opts.onLeaveCondition ?? null }, })
    return true
  })
}

/** Ежедневный скан (из due.scan): открыть отложенные правилом прохождения; подстраховать таймеры, если задача очереди потерялась. */
export async function trajectoryScan(tenantId: string): Promise<{ opened: number, fired: number }> {
  const toStart = await withTenant(tenantId, null, tx => tx.select({ id: trajectoryEnrollments.id }).from(trajectoryEnrollments)
    .where(and(isNull(trajectoryEnrollments.startedAt), isNull(trajectoryEnrollments.cancelledAt), eq(trajectoryEnrollments.status, 'not_started'), sql`${trajectoryEnrollments.availableFrom} <= now()`)))
  let opened = 0
  for (const e of toStart) if (await startEnrollment(tenantId, e.id)) opened++
  const due = await withTenant(tenantId, null, tx => tx.select({ id: trajectoryNodeStates.id }).from(trajectoryNodeStates).where(sql`${trajectoryNodeStates.firesAt} <= now() - interval '1 hour'`))
  let fired = 0
  for (const s of due) if (await fireTimer(tenantId, s.id) !== 'noop') fired++
  return { opened, fired }
}

// ── Кабинет ───────────────────────────────────────────────────────────────────────────

export async function myTrajectories(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({
      id: trajectoryEnrollments.id, trajectoryId: trajectories.id, title: trajectories.title, coverKey: trajectories.coverKey, status: trajectoryEnrollments.status,
      progressPct: trajectoryEnrollments.progressPct, startedAt: trajectoryEnrollments.startedAt, completedAt: trajectoryEnrollments.completedAt, availableFrom: trajectoryEnrollments.availableFrom,
      total: sql<number>`(select count(*)::int from trajectory_nodes n where n.trajectory_id = ${trajectories.id} and n.kind = 'task')`,
      done: sql<number>`(select count(*)::int from trajectory_node_states s join trajectory_nodes n on n.id = s.node_id where s.enrollment_id = ${trajectoryEnrollments.id} and n.kind = 'task' and s.status = 'done')`,
    }).from(trajectoryEnrollments).innerJoin(trajectories, eq(trajectories.id, trajectoryEnrollments.trajectoryId))
      .where(and(eq(trajectoryEnrollments.userId, ctx.actorId), isNull(trajectoryEnrollments.cancelledAt), sql`${trajectoryEnrollments.status} <> 'not_assigned'`))
      .orderBy(desc(trajectoryEnrollments.updatedAt))
  })
}

/** Лента прохождения (мокап MyTrajectory): фактический путь человека — узлы в порядке активации, без канвы (docs/17 §5.2). */
export async function myTrajectory(ctx: Ctx, enrollmentId: string, opts: { any?: boolean } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [enr] = await tx.select().from(trajectoryEnrollments).where(and(eq(trajectoryEnrollments.id, enrollmentId), ...(opts.any ? [] : [eq(trajectoryEnrollments.userId, ctx.actorId)])))
    if (!enr) return null
    const [t] = await tx.select().from(trajectories).where(eq(trajectories.id, enr.trajectoryId))
    const g = await loadGraph(tx, enr.trajectoryId)
    const states = new Map((await tx.select().from(trajectoryNodeStates).where(eq(trajectoryNodeStates.enrollmentId, enr.id))).map(s => [s.nodeId, s]))
    const titles = await nodeTitles(tx, g.nodes)
    // Порядок ленты — топологический от Start; показываем узлы, которых человек достиг или которые впереди по выбранному пути
    const order: string[] = []; const seen = new Set<string>()
    const start = g.nodes.find(n => n.kind === 'start')
    const q = start ? [start.id] : []
    while (q.length) {
      const id = q.shift()!
      if (seen.has(id)) continue
      seen.add(id); order.push(id)
      const st = states.get(id)
      const node = g.byId.get(id)!
      const outs = g.out.get(id) ?? []
      if (node.kind === 'branch' && st?.chosenEdgeId) { const e = outs.find(x => x.id === st.chosenEdgeId); if (e) q.push(e.toNodeId); continue }
      for (const e of outs) q.push(e.toNodeId)
    }
    const asgIds = [...states.values()].map(s => s.assignmentId).filter((x): x is string => !!x)
    const enrs = asgIds.length ? await tx.select({ id: enrollments.id, assignmentId: enrollments.assignmentId, status: enrollments.status, progress: enrollments.progressPct }).from(enrollments).where(and(inArray(enrollments.assignmentId, asgIds), eq(enrollments.userId, enr.userId), isNull(enrollments.cancelledAt))) : []
    const steps = order.filter(id => !['start', 'finish'].includes(g.byId.get(id)!.kind) && states.get(id)?.status !== 'skipped').map((id) => {
      const n = g.byId.get(id)!, s = states.get(id)
      const ce = enrs.find(e => e.assignmentId === s?.assignmentId)
      return {
        nodeId: id, kind: n.kind, title: n.title ?? titles.get(id) ?? null, contentTitle: titles.get(id) ?? null, contentType: n.contentType, contentId: n.contentId, days: n.days,
        status: s?.status ?? 'locked', activatedAt: s?.activatedAt ?? null, finishedAt: s?.finishedAt ?? null, firesAt: s?.firesAt ?? null, score: s?.score ?? null, passed: s?.passed ?? null, reason: s?.reason ?? null,
        assignmentId: s?.assignmentId ?? null, courseEnrollmentId: ce?.id ?? null, courseProgress: ce?.progress ?? null,
      }
    })
    const tasks = steps.filter(s => s.kind === 'task')
    return { id: enr.id, trajectoryId: enr.trajectoryId, title: t!.title, status: enr.status, progressPct: enr.progressPct, mentorId: enr.mentorId, startedAt: enr.startedAt, completedAt: enr.completedAt, total: tasks.length, done: tasks.filter(s => s.status === 'done').length, steps }
  })
}

/** Люди на траектории (админ): текущий шаг и статус — для колонки «ЛЮДЕЙ» и отчёта. */
export async function trajectoryPeople(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [t] = await tx.select({ id: trajectories.id }).from(trajectories).where(eq(trajectories.id, id))
    if (!t) return null
    return tx.select({
      enrollmentId: trajectoryEnrollments.id, userId: users.id, fullName: users.fullName, status: trajectoryEnrollments.status, source: trajectoryEnrollments.source,
      progressPct: trajectoryEnrollments.progressPct, startedAt: trajectoryEnrollments.startedAt, completedAt: trajectoryEnrollments.completedAt, requestedAt: trajectoryEnrollments.requestedAt,
      cancelledAt: trajectoryEnrollments.cancelledAt, availableFrom: trajectoryEnrollments.availableFrom, mentorId: trajectoryEnrollments.mentorId,
      currentStep: sql<string | null>`(select coalesce(n.title, n.kind) from trajectory_node_states s join trajectory_nodes n on n.id = s.node_id where s.enrollment_id = ${trajectoryEnrollments.id} and s.status in ('available', 'in_progress') order by s.activated_at limit 1)`,
    }).from(trajectoryEnrollments).innerJoin(users, eq(users.id, trajectoryEnrollments.userId))
      .where(eq(trajectoryEnrollments.trajectoryId, id)).orderBy(users.fullName)
  })
}
