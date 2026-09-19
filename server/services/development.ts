import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  competencies, competencyAssessments, courses, developmentGoals, developmentPlans, goalComments, goalStatusLog,
  goalStatuses, positionProfiles, positions, userPlacements, users,
} from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'

interface Ctx { tenantId: string, actorId: string }

export interface CompetencyLevel { level: number, title: string, behavior: string }
export interface Requirement { competencyId: string, requiredLevel: number, isCritical?: boolean }

/** Приоритет источника оценки (docs/19 §3.3): certification > assessment > test > manager > self. */
const SOURCE_PRIORITY: Record<string, number> = { certification: 5, assessment: 4, test: 3, workshop: 3, manager: 2, self: 1 }

// ── Компетенции ────────────────────────────────────────────────────────

export async function listCompetencies(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({
      id: competencies.id, name: competencies.name, kind: competencies.kind, categoryId: competencies.categoryId, description: competencies.description,
      levels: competencies.levels, linkedCourses: competencies.linkedCourses, isActive: competencies.isActive,
      usedIn: sql<number>`(select count(*)::int from ${positionProfiles} p where p.competency_requirements @> jsonb_build_array(jsonb_build_object('competencyId', ${competencies.id}::text)))`,
    }).from(competencies).orderBy(asc(competencies.name))
  })
}

export async function createCompetency(ctx: Ctx, input: { name: string, kind: string, description?: string, categoryId?: string, levels: CompetencyLevel[], linkedCourses?: string[], linkedKnowledge?: string[] }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [c] = await tx.insert(competencies).values({
      tenantId: ctx.tenantId, name: input.name, kind: input.kind, description: input.description ?? null, categoryId: input.categoryId ?? null,
      levels: input.levels, linkedCourses: input.linkedCourses ?? [], linkedKnowledge: input.linkedKnowledge ?? [],
    }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'competency.create', entity: 'competency', entityId: c!.id, after: { name: input.name } })
    return c!
  })
}

export async function updateCompetency(ctx: Ctx, id: string, input: Partial<{ name: string, kind: string, description: string, levels: CompetencyLevel[], linkedCourses: string[], linkedKnowledge: string[], isActive: boolean }>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [c] = await tx.update(competencies).set({ ...input, updatedAt: new Date() }).where(eq(competencies.id, id)).returning()
    return c ?? null
  })
}

// ── Профили должностей ─────────────────────────────────────────────────

export async function listPositionProfiles(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({
      id: positionProfiles.id, positionId: positionProfiles.positionId, positionName: positions.name, positionLevelId: positionProfiles.positionLevelId,
      description: positionProfiles.description, competencyRequirements: positionProfiles.competencyRequirements, mandatoryContent: positionProfiles.mandatoryContent,
      probationDays: positionProfiles.probationDays, isActive: positionProfiles.isActive, updatedAt: positionProfiles.updatedAt,
      people: sql<number>`(select count(*)::int from ${userPlacements} up where up.position_id = ${positionProfiles.positionId} and up.ended_at is null)`,
    }).from(positionProfiles).innerJoin(positions, eq(positions.id, positionProfiles.positionId)).orderBy(asc(positions.name))
  })
}

export async function upsertPositionProfile(ctx: Ctx, input: { positionId: string, positionLevelId?: string | null, description?: string, competencyRequirements: Requirement[], mandatoryContent?: { subjectType: string, subjectId: string, dueDays: number }[], probationDays?: number | null }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [p] = await tx.insert(positionProfiles).values({
      tenantId: ctx.tenantId, positionId: input.positionId, positionLevelId: input.positionLevelId ?? null, description: input.description ?? null,
      competencyRequirements: input.competencyRequirements, mandatoryContent: input.mandatoryContent ?? [], probationDays: input.probationDays ?? null, updatedBy: ctx.actorId,
    }).onConflictDoUpdate({
      target: [positionProfiles.tenantId, positionProfiles.positionId, positionProfiles.positionLevelId],
      set: { description: input.description ?? null, competencyRequirements: input.competencyRequirements, mandatoryContent: input.mandatoryContent ?? [], probationDays: input.probationDays ?? null, updatedBy: ctx.actorId, updatedAt: new Date() },
    }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'position_profile.upsert', entity: 'position_profile', entityId: p!.id })
    return p!
  })
}

// ── Оценки уровня и разрыв ─────────────────────────────────────────────

export async function assessCompetency(ctx: Ctx, input: { userId: string, competencyId: string, level: number, source: string, evidenceId?: string, comment?: string, validMonths?: number }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [c] = await tx.select({ levels: competencies.levels }).from(competencies).where(eq(competencies.id, input.competencyId))
    if (!c) return null
    const max = Math.max(...(c.levels as CompetencyLevel[]).map(l => l.level))
    if (input.level < 1 || input.level > max) return null
    const [a] = await tx.insert(competencyAssessments).values({
      tenantId: ctx.tenantId, userId: input.userId, competencyId: input.competencyId, level: input.level, source: input.source,
      evidenceId: input.evidenceId ?? null, assessedBy: ctx.actorId, comment: input.comment ?? null,
      validUntil: input.validMonths ? new Date(Date.now() + input.validMonths * 30 * 86_400_000) : null,
    }).returning()
    return a!
  })
}

/** Текущие уровни человека: последняя действующая оценка с наивысшим приоритетом источника. */
export async function currentLevels(tx: TenantTx, userId: string): Promise<Map<string, { level: number, source: string, assessedAt: Date }>> {
  const rows = await tx.select().from(competencyAssessments)
    .where(and(eq(competencyAssessments.userId, userId), sql`(${competencyAssessments.validUntil} is null or ${competencyAssessments.validUntil} > now())`))
    .orderBy(desc(competencyAssessments.assessedAt))
  const best = new Map<string, { level: number, source: string, assessedAt: Date, prio: number }>()
  for (const r of rows) {
    const prio = SOURCE_PRIORITY[r.source] ?? 0
    const cur = best.get(r.competencyId)
    if (!cur || prio > cur.prio) best.set(r.competencyId, { level: r.level, source: r.source, assessedAt: r.assessedAt, prio })
  }
  return new Map([...best].map(([k, v]) => [k, { level: v.level, source: v.source, assessedAt: v.assessedAt }]))
}

/** «Мій розвиток» блок 1 (docs/19 §5.1): профиль должности с текущим/требуемым уровнем и разрывом. */
export async function competencyGap(ctx: Ctx, userId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [pl] = await tx.select({ positionId: userPlacements.positionId, positionName: positions.name })
      .from(userPlacements).innerJoin(positions, eq(positions.id, userPlacements.positionId))
      .where(and(eq(userPlacements.userId, userId), eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt)))
    if (!pl) return { position: null, profile: null, items: [] }
    const [profile] = await tx.select().from(positionProfiles).where(and(eq(positionProfiles.positionId, pl.positionId), eq(positionProfiles.isActive, true)))
    if (!profile) return { position: pl, profile: null, items: [] }

    const reqs = profile.competencyRequirements as Requirement[]
    const comps = reqs.length ? await tx.select().from(competencies).where(inArray(competencies.id, reqs.map(r => r.competencyId))) : []
    const levels = await currentLevels(tx, userId)
    const courseIds = [...new Set(comps.flatMap(c => c.linkedCourses))]
    const courseRows = courseIds.length ? await tx.select({ id: courses.id, title: courses.title }).from(courses).where(inArray(courses.id, courseIds)) : []
    const courseById = new Map(courseRows.map(c => [c.id, c.title]))

    const items = reqs.map((r) => {
      const c = comps.find(x => x.id === r.competencyId)
      const cur = levels.get(r.competencyId)
      const maxLevel = c ? Math.max(...(c.levels as CompetencyLevel[]).map(l => l.level)) : 5
      return {
        competencyId: r.competencyId, name: c?.name ?? '?', kind: c?.kind, requiredLevel: r.requiredLevel, isCritical: r.isCritical ?? false,
        currentLevel: cur?.level ?? 0, source: cur?.source ?? null, maxLevel,
        gap: Math.max(0, r.requiredLevel - (cur?.level ?? 0)),
        levels: c?.levels ?? [],
        whatToLearn: (c?.linkedCourses ?? []).map(id => ({ id, title: courseById.get(id) ?? '?' })),
      }
    })
    return { position: pl, profile: { id: profile.id, probationDays: profile.probationDays }, items }
  })
}

// ── ИПР ────────────────────────────────────────────────────────────────

async function managerOf(tx: TenantTx, userId: string): Promise<string | null> {
  const rows = await tx.execute(sql`select l.manager_id from user_placements up join locations l on l.id = up.location_id where up.user_id = ${userId}::uuid and up.is_primary and up.ended_at is null limit 1`) as unknown as { manager_id: string | null }[]
  return rows[0]?.manager_id ?? null
}

export async function myPlan(ctx: Ctx, userId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [plan] = await tx.select().from(developmentPlans).where(and(eq(developmentPlans.userId, userId), sql`${developmentPlans.status} <> 'closed'`)).orderBy(desc(developmentPlans.createdAt)).limit(1)
    const goals = await tx.select({
      id: developmentGoals.id, title: developmentGoals.title, kind: developmentGoals.kind, dueAt: developmentGoals.dueAt, statusCode: developmentGoals.statusCode,
      progressPct: developmentGoals.progressPct, competencyId: developmentGoals.competencyId, targetLevel: developmentGoals.targetLevel, planId: developmentGoals.planId,
      statusName: goalStatuses.name, statusColor: goalStatuses.color, isFinal: goalStatuses.isFinal,
    }).from(developmentGoals).innerJoin(goalStatuses, eq(goalStatuses.code, developmentGoals.statusCode))
      .where(eq(developmentGoals.userId, userId)).orderBy(asc(developmentGoals.dueAt))
    const statuses = await tx.select().from(goalStatuses).orderBy(asc(goalStatuses.sort))
    return { plan: plan ?? null, goals, statuses }
  })
}

export async function createPlan(ctx: Ctx, input: { userId: string, periodFrom: string, periodTo: string, summary?: string }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const ownerId = await managerOf(tx, input.userId)
    const [p] = await tx.insert(developmentPlans).values({ tenantId: ctx.tenantId, userId: input.userId, periodFrom: input.periodFrom, periodTo: input.periodTo, ownerId, summary: input.summary ?? null, createdBy: ctx.actorId }).returning()
    return p!
  })
}

export type PlanTransition = 'submit' | 'approve' | 'return' | 'review' | 'close'
const PLAN_FLOW: Record<PlanTransition, { from: string[], to: string }> = {
  submit: { from: ['draft'], to: 'on_approval' },
  approve: { from: ['on_approval'], to: 'active' },
  return: { from: ['on_approval', 'review'], to: 'draft' },
  review: { from: ['active'], to: 'review' },
  close: { from: ['review', 'active'], to: 'closed' },
}

export async function transitionPlan(ctx: Ctx, planId: string, action: PlanTransition, comment?: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [p] = await tx.select().from(developmentPlans).where(eq(developmentPlans.id, planId))
    if (!p) return { ok: false as const, code: 'not_found' as const }
    const flow = PLAN_FLOW[action]
    if (!flow.from.includes(p.status)) return { ok: false as const, code: 'bad_transition' as const }
    const now = new Date()
    await tx.update(developmentPlans).set({
      status: flow.to,
      ...(action === 'approve' ? { approvedBy: ctx.actorId, approvedAt: now } : {}),
      ...(action === 'close' ? { closedAt: now, resultComment: comment ?? null } : {}),
      updatedAt: now,
    }).where(eq(developmentPlans.id, planId))
    if (action === 'submit' && p.ownerId) {
      await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: p.ownerId, code: 'plan_on_approval', payload: { planId }, dedupKey: `plan_appr:${planId}:${now.getTime()}` })
    }
    if (action === 'approve' || action === 'return') {
      await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: p.userId, code: action === 'approve' ? 'plan_approved' : 'plan_returned', payload: { comment: comment ?? '' }, dedupKey: `plan_${action}:${planId}:${now.getTime()}` })
    }
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: `plan.${action}`, entity: 'development_plan', entityId: planId, before: { status: p.status }, after: { status: flow.to } })
    return { ok: true as const, status: flow.to }
  })
}

// ── Цели ───────────────────────────────────────────────────────────────

export async function createGoal(ctx: Ctx, input: { userId: string, planId?: string, title: string, description?: string, kind: string, competencyId?: string, targetLevel?: number, metric?: string, linkedContent?: unknown[], dueAt: string, mentorId?: string }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [initial] = await tx.select({ code: goalStatuses.code }).from(goalStatuses).where(eq(goalStatuses.isInitial, true)).limit(1)
    const [g] = await tx.insert(developmentGoals).values({
      tenantId: ctx.tenantId, userId: input.userId, planId: input.planId ?? null, title: input.title, description: input.description ?? null, kind: input.kind,
      competencyId: input.competencyId ?? null, targetLevel: input.targetLevel ?? null, metric: input.metric ?? null, linkedContent: input.linkedContent ?? [],
      dueAt: input.dueAt, statusCode: initial?.code ?? 'planned', mentorId: input.mentorId ?? null, createdBy: ctx.actorId,
    }).returning()
    await tx.insert(goalStatusLog).values({ tenantId: ctx.tenantId, goalId: g!.id, fromStatus: null, toStatus: g!.statusCode, actorId: ctx.actorId })
    return g!
  })
}

export async function getGoal(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [g] = await tx.select().from(developmentGoals).where(eq(developmentGoals.id, id))
    if (!g) return null
    const [status] = await tx.select().from(goalStatuses).where(eq(goalStatuses.code, g.statusCode))
    const transitions = status ? await tx.select().from(goalStatuses).where(inArray(goalStatuses.code, status.allowedTransitions.length ? status.allowedTransitions : ['__none__'])).orderBy(asc(goalStatuses.sort)) : []
    const log = await tx.select({ id: goalStatusLog.id, fromStatus: goalStatusLog.fromStatus, toStatus: goalStatusLog.toStatus, actorName: users.fullName, comment: goalStatusLog.comment, createdAt: goalStatusLog.createdAt })
      .from(goalStatusLog).leftJoin(users, eq(users.id, goalStatusLog.actorId)).where(eq(goalStatusLog.goalId, id)).orderBy(desc(goalStatusLog.createdAt))
    const comments = await tx.select({ id: goalComments.id, authorName: users.fullName, body: goalComments.body, createdAt: goalComments.createdAt })
      .from(goalComments).innerJoin(users, eq(users.id, goalComments.authorId)).where(eq(goalComments.goalId, id)).orderBy(asc(goalComments.createdAt))
    const [comp] = g.competencyId ? await tx.select({ name: competencies.name, levels: competencies.levels }).from(competencies).where(eq(competencies.id, g.competencyId)) : []
    return { ...g, status, transitions, log, comments, competency: comp ?? null }
  })
}

export async function updateGoalProgress(ctx: Ctx, id: string, input: { progressPct?: number, result?: string, description?: string, metric?: string }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [g] = await tx.update(developmentGoals).set({ ...input, updatedAt: new Date() }).where(and(eq(developmentGoals.id, id), eq(developmentGoals.userId, ctx.actorId))).returning()
    return g ?? null
  })
}

export type GoalTransitionResult = { ok: true, status: string } | { ok: false, code: 'not_found' | 'not_allowed' | 'forbidden' | 'comment_required' }

/** Смена статуса по настраиваемому жизненному циклу (docs/19 §3.6) с протоколом. */
export async function transitionGoal(ctx: Ctx, goalId: string, toCode: string, opts: { comment?: string, scopes: string[], evaluation?: string }): Promise<GoalTransitionResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [g] = await tx.select().from(developmentGoals).where(eq(developmentGoals.id, goalId))
    if (!g) return { ok: false as const, code: 'not_found' as const }
    const [from] = await tx.select().from(goalStatuses).where(eq(goalStatuses.code, g.statusCode))
    const [to] = await tx.select().from(goalStatuses).where(eq(goalStatuses.code, toCode))
    if (!from || !to || !from.allowedTransitions.includes(toCode)) return { ok: false as const, code: 'not_allowed' as const }
    const isOwner = g.userId === ctx.actorId
    const canSet = to.whoCanSet.some(s => opts.scopes.includes(s) && (s !== 'development.own' || isOwner))
    if (!canSet) return { ok: false as const, code: 'forbidden' as const }
    if (to.requiresComment && !(opts.comment ?? '').trim()) return { ok: false as const, code: 'comment_required' as const }

    const now = new Date()
    await tx.update(developmentGoals).set({
      statusCode: toCode,
      ...(to.isFinal ? { evaluatedBy: ctx.actorId, evaluatedAt: now, evaluation: opts.evaluation ?? opts.comment ?? null } : {}),
      ...(to.isSuccess ? { progressPct: 100 } : {}),
      updatedAt: now,
    }).where(eq(developmentGoals.id, goalId))
    await tx.insert(goalStatusLog).values({ tenantId: ctx.tenantId, goalId, fromStatus: g.statusCode, toStatus: toCode, actorId: ctx.actorId, comment: opts.comment ?? null })

    // Достигнутая цель по компетенции → оценка уровня от руководителя
    if (to.isSuccess && g.competencyId && g.targetLevel && !isOwner) {
      await tx.insert(competencyAssessments).values({ tenantId: ctx.tenantId, userId: g.userId, competencyId: g.competencyId, level: g.targetLevel, source: 'manager', evidenceId: goalId, assessedBy: ctx.actorId, comment: `Ціль «${g.title}» досягнута` })
    }
    const notifyTo = isOwner ? await managerOf(tx, g.userId) : g.userId
    if (notifyTo && notifyTo !== ctx.actorId) {
      await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: notifyTo, code: 'goal_status', payload: { title: g.title, status: to.name, comment: opts.comment ?? '' }, dedupKey: `goal:${goalId}:${toCode}:${now.getTime()}` })
    }
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'goal.transition', entity: 'development_goal', entityId: goalId, before: { status: g.statusCode }, after: { status: toCode } })
    return { ok: true as const, status: toCode }
  })
}

export async function addGoalComment(ctx: Ctx, goalId: string, body: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [c] = await tx.insert(goalComments).values({ tenantId: ctx.tenantId, goalId, authorId: ctx.actorId, body: body.slice(0, 2000) }).returning()
    return c!
  })
}

/** «Цілі співробітників» (docs/19 §5.3): для руководителя. */
export async function teamGoals(ctx: Ctx, filter: { status?: string, overdue?: boolean, locationId?: string } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.execute(sql`
      select g.id, g.title, g.kind, g.due_at, g.status_code, s.name as status_name, s.color as status_color, s.is_final, g.progress_pct,
             u.id as user_id, u.full_name, l.name as location, (g.due_at < current_date and not s.is_final) as is_overdue
      from development_goals g
      join goal_statuses s on s.code = g.status_code and s.tenant_id = g.tenant_id
      join users u on u.id = g.user_id
      left join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null
      left join locations l on l.id = up.location_id
      where true
        ${filter.status ? sql`and g.status_code = ${filter.status}` : sql``}
        ${filter.overdue ? sql`and g.due_at < current_date and not s.is_final` : sql``}
        ${filter.locationId ? sql`and up.location_id = ${filter.locationId}` : sql``}
      order by (g.due_at < current_date and not s.is_final) desc, g.due_at asc limit 500
    `) as unknown as Promise<Record<string, unknown>[]>
  })
}

// ── Настройка статусов (docs/19 §3.6) ──────────────────────────────────

export async function listGoalStatuses(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async tx => tx.select().from(goalStatuses).orderBy(asc(goalStatuses.sort)))
}

export async function upsertGoalStatus(ctx: Ctx, input: { code: string, name: string, color: string, sort: number, isInitial?: boolean, isFinal?: boolean, isSuccess?: boolean, requiresComment?: boolean, allowedTransitions: string[], whoCanSet: string[] }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [s] = await tx.insert(goalStatuses).values({ tenantId: ctx.tenantId, ...input }).onConflictDoUpdate({
      target: [goalStatuses.tenantId, goalStatuses.code],
      set: { name: input.name, color: input.color, sort: input.sort, isInitial: input.isInitial ?? false, isFinal: input.isFinal ?? false, isSuccess: input.isSuccess ?? false, requiresComment: input.requiresComment ?? false, allowedTransitions: input.allowedTransitions, whoCanSet: input.whoCanSet, updatedAt: new Date() },
    }).returning()
    return s!
  })
}

/** Фоновая: цели с истёкшим сроком — напоминание человеку и наставнику (раз в день). */
export async function goalDueScan(tenantId: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const rows = await tx.execute(sql`
      select g.id, g.user_id, g.mentor_id, g.title, g.due_at from development_goals g
      join goal_statuses s on s.code = g.status_code and s.tenant_id = g.tenant_id
      where not s.is_final and g.due_at in (current_date + 3, current_date, current_date - 1)
    `) as unknown as { id: string, user_id: string, mentor_id: string | null, title: string, due_at: string }[]
    let n = 0
    const day = new Date().toISOString().slice(0, 10)
    for (const g of rows) {
      if (await enqueueNotification(tx, { tenantId, userId: g.user_id, code: 'goal_due', payload: { title: g.title, due: g.due_at }, dedupKey: `goal_due:${g.id}:${day}` })) n++
      if (g.mentor_id) await enqueueNotification(tx, { tenantId, userId: g.mentor_id, code: 'goal_due_mentor', payload: { title: g.title, due: g.due_at }, dedupKey: `goal_due_m:${g.id}:${day}` })
    }
    return n
  })
}
