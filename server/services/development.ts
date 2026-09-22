import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { currentRequestContext } from '../utils/requestContext'
import {
  competencies, competencyAssessments, courses, developmentGoals, developmentPlans, goalComments, goalStatusLog,
  goalStatuses, positionProfilePositions, positionProfiles, positions, userPlacements, users,
} from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import { scopeSql } from './access'

interface Ctx { tenantId: string, actorId: string }

export interface CompetencyLevel { level: number, title: string, behavior: string }
export interface Requirement { competencyId: string, requiredLevel: number, isCritical?: boolean, positionLevelId?: string | null }

/**
 * Текст рівня компетенції по тумблеру `competencyDisplayAs` (docs/19 §14.1, docs/33 D-032):
 * `label` — назва варіанту з власної структури рівнів компетенції, `value` — саме число.
 * Використовується на всіх екранах виводу рівня (матриця, картка людини, історія), не тільки
 * «Мій розвиток», де ця мітка вже була.
 */
export function levelLabel(levels: CompetencyLevel[], level: number): string {
  return levels.find(l => l.level === level)?.title ?? String(level)
}

/** Приоритет источника оценки (docs/19 Г-19.2, docs/02 `user_competencies.source`): assessment > task > manual. */
const SOURCE_PRIORITY: Record<string, number> = { assessment: 3, task: 2, manual: 1 }

/** Срок действия оценки по умолчанию — 12 месяцев (docs/19 Г-19.2); `months=null` — безстроково. */
export function defaultValidUntil(months: number | null = 12): Date | null {
  return months == null ? null : new Date(Date.now() + months * 30 * 86_400_000)
}

/**
 * Требования профиля, действующие для конкретного человека (docs/19 §14.2 «Використовувати
 * рівні посади»): если тумблер выключен — уровень требования игнорируется, требование общее
 * для всей должности; если включён — для компетенции берётся требование с `positionLevelId`,
 * совпадающим с фактическим уровнем должности человека, а при его отсутствии — требование
 * без `positionLevelId` (общее). Требования, заданные только под другой уровень, не применяются.
 */
export function effectiveRequirements(reqs: Requirement[], usePositionLevels: boolean, userPositionLevelId: string | null): Requirement[] {
  if (!usePositionLevels) return reqs.map(r => ({ ...r, positionLevelId: undefined }))
  const byCompetency = new Map<string, Requirement[]>()
  for (const r of reqs) {
    const list = byCompetency.get(r.competencyId) ?? []
    list.push(r)
    byCompetency.set(r.competencyId, list)
  }
  const out: Requirement[] = []
  for (const list of byCompetency.values()) {
    const forLevel = userPositionLevelId ? list.find(r => r.positionLevelId === userPositionLevelId) : undefined
    const generic = list.find(r => !r.positionLevelId)
    const chosen = forLevel ?? generic
    if (chosen) out.push(chosen)
  }
  return out
}

// ── Компетенции ────────────────────────────────────────────────────────

export async function listCompetencies(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({
      id: competencies.id, name: competencies.name, kind: competencies.kind, categoryId: competencies.categoryId, description: competencies.description,
      levels: competencies.levels, linkedCourses: competencies.linkedCourses, isActive: competencies.isActive,
      // Колонка «Створено» (docs/31 `Competencies`, screens-7)
      createdAt: competencies.createdAt,
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

/** Посади профілю (docs/33 D-031): усі, включно з головною (першою) — для «Список посад» (docs/19 §14.2). */
const profilePositionsSql = sql<string[]>`coalesce((select array_agg(pp.position_id order by (pp.position_id = ${positionProfiles.positionId}) desc, pp.created_at) from ${positionProfilePositions} pp where pp.profile_id = ${positionProfiles.id}), array[${positionProfiles.positionId}]::uuid[])`

/**
 * Активний профіль за посадою — через `position_profile_positions` (D-031: один профіль на кілька посад).
 * Раніше — `position_profiles.position_id = X`; головна посада теж лежить у таблиці зв'язку (бекфіл міграцією 0051).
 */
export async function profileForPosition(tx: TenantTx, positionId: string) {
  const [profile] = await tx.select().from(positionProfiles)
    .where(and(eq(positionProfiles.isActive, true), sql`${positionProfiles.id} in (select pp.profile_id from ${positionProfilePositions} pp where pp.position_id = ${positionId}::uuid)`))
    .orderBy(asc(positionProfiles.createdAt)).limit(1)
  return profile ?? null
}

export async function listPositionProfiles(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({
      id: positionProfiles.id, positionId: positionProfiles.positionId, positionName: positions.name, positionLevelId: positionProfiles.positionLevelId,
      positionIds: profilePositionsSql,
      positionNames: sql<string[]>`coalesce((select array_agg(ps.name order by (ps.id = ${positionProfiles.positionId}) desc, ps.name) from ${positionProfilePositions} pp join ${positions} ps on ps.id = pp.position_id where pp.profile_id = ${positionProfiles.id}), array[${positions.name}]::text[])`,
      description: positionProfiles.description, goals: positionProfiles.goals, responsibilities: positionProfiles.responsibilities, usePositionLevels: positionProfiles.usePositionLevels,
      competencyRequirements: positionProfiles.competencyRequirements, mandatoryContent: positionProfiles.mandatoryContent,
      probationDays: positionProfiles.probationDays, isActive: positionProfiles.isActive, updatedAt: positionProfiles.updatedAt,
      people: sql<number>`(select count(*)::int from ${userPlacements} up where up.position_id = any(${profilePositionsSql}) and up.ended_at is null)`,
    }).from(positionProfiles).innerJoin(positions, eq(positions.id, positionProfiles.positionId)).orderBy(asc(positions.name))
  })
}

export type UpsertProfileResult = { ok: true, profile: typeof positionProfiles.$inferSelect, positionIds: string[] } | { ok: false, code: 'position_taken', positionId: string }

/**
 * Профіль: головна посада (`positionId`) + додаткові (`positionIds`, D-031). Одна посада — в одному профілі:
 * якщо посада вже є в іншому профілі — `position_taken`, щоб вимоги до людини не двоїлися.
 */
export async function upsertPositionProfile(ctx: Ctx, input: { positionId: string, positionIds?: string[], positionLevelId?: string | null, description?: string, goals?: unknown, responsibilities?: unknown, usePositionLevels?: boolean, competencyRequirements: Requirement[], mandatoryContent?: { subjectType: string, subjectId: string, dueDays: number }[], probationDays?: number | null }): Promise<UpsertProfileResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const values = {
      description: input.description ?? null, goals: input.goals ?? null, responsibilities: input.responsibilities ?? null, usePositionLevels: input.usePositionLevels ?? false,
      competencyRequirements: input.competencyRequirements, mandatoryContent: input.mandatoryContent ?? [], probationDays: input.probationDays ?? null, updatedBy: ctx.actorId,
    }
    const positionIds = [input.positionId, ...(input.positionIds ?? []).filter(id => id !== input.positionId)]
    // Посада вже в іншому профілі (не з цією головною посадою) — відмова до запису
    const [taken] = await tx.select({ positionId: positionProfilePositions.positionId }).from(positionProfilePositions)
      .innerJoin(positionProfiles, eq(positionProfiles.id, positionProfilePositions.profileId))
      .where(and(inArray(positionProfilePositions.positionId, positionIds), sql`${positionProfiles.positionId} <> ${input.positionId}::uuid`)).limit(1)
    if (taken) return { ok: false as const, code: 'position_taken' as const, positionId: taken.positionId }
    // Пошук існуючого — через `is not distinct from`: unique-індекс з NULL у position_level_id не спрацьовує на upsert
    const [existing] = await tx.select({ id: positionProfiles.id }).from(positionProfiles)
      .where(and(eq(positionProfiles.positionId, input.positionId), sql`${positionProfiles.positionLevelId} is not distinct from ${input.positionLevelId ?? null}::uuid`))
    const [p] = existing
      ? await tx.update(positionProfiles).set({ ...values, updatedAt: new Date() }).where(eq(positionProfiles.id, existing.id)).returning()
      : await tx.insert(positionProfiles).values({ tenantId: ctx.tenantId, positionId: input.positionId, positionLevelId: input.positionLevelId ?? null, ...values }).returning()
    await tx.delete(positionProfilePositions).where(and(eq(positionProfilePositions.profileId, p!.id), sql`${positionProfilePositions.positionId} <> all(array[${sql.join(positionIds.map(id => sql`${id}::uuid`), sql`, `)}]::uuid[])`))
    await tx.insert(positionProfilePositions).values(positionIds.map(positionId => ({ tenantId: ctx.tenantId, profileId: p!.id, positionId }))).onConflictDoNothing()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'position_profile.upsert', entity: 'position_profile', entityId: p!.id, after: { positionIds } })
    return { ok: true as const, profile: p!, positionIds }
  })
}

// ── Оценки уровня и разрыв ─────────────────────────────────────────────

export type AssessCompetencyResult = { ok: true, assessment: typeof competencyAssessments.$inferSelect } | { ok: false, code: 'not_found' | 'level_out_of_scale' | 'self' }

/**
 * Ручная оценка компетенции (docs/19 Г-19.2 «Ручна установка керівником — з причиною та в аудит»):
 * всегда `source=manual`, причина обязательна, самому себе — нельзя (иначе теряется смысл «в аудит»).
 */
export async function assessCompetency(ctx: Ctx, input: { userId: string, competencyId: string, level: number, reason: string, evidenceId?: string, validMonths?: number | null }): Promise<AssessCompetencyResult> {
  if (input.userId === ctx.actorId) return { ok: false, code: 'self' }
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [c] = await tx.select({ levels: competencies.levels }).from(competencies).where(eq(competencies.id, input.competencyId))
    if (!c) return { ok: false as const, code: 'not_found' as const }
    const max = Math.max(...(c.levels as CompetencyLevel[]).map(l => l.level))
    if (input.level < 1 || input.level > max) return { ok: false as const, code: 'level_out_of_scale' as const }
    const [a] = await tx.insert(competencyAssessments).values({
      tenantId: ctx.tenantId, userId: input.userId, competencyId: input.competencyId, level: input.level, source: 'manual',
      evidenceId: input.evidenceId ?? null, assessedBy: ctx.actorId, comment: input.reason,
      validUntil: input.validMonths === undefined ? defaultValidUntil() : defaultValidUntil(input.validMonths),
    }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'competency.assess_manual', entity: 'user', entityId: input.userId, after: { competencyId: input.competencyId, level: input.level, reason: input.reason } })
    return { ok: true as const, assessment: a! }
  })
}

/** Текущие уровни человека: последняя действующая оценка с наивысшим приоритетом источника (просроченные `validUntil` игнорируются). */
export async function currentLevels(tx: TenantTx, userId: string): Promise<Map<string, { level: number, source: string, assessedAt: Date, validUntil: Date | null }>> {
  const rows = await tx.select().from(competencyAssessments)
    .where(and(eq(competencyAssessments.userId, userId), sql`(${competencyAssessments.validUntil} is null or ${competencyAssessments.validUntil} > now())`))
    .orderBy(desc(competencyAssessments.assessedAt))
  const best = new Map<string, { level: number, source: string, assessedAt: Date, validUntil: Date | null, prio: number }>()
  for (const r of rows) {
    const prio = SOURCE_PRIORITY[r.source] ?? 0
    const cur = best.get(r.competencyId)
    if (!cur || prio > cur.prio) best.set(r.competencyId, { level: r.level, source: r.source, assessedAt: r.assessedAt, validUntil: r.validUntil, prio })
  }
  return new Map([...best].map(([k, v]) => [k, { level: v.level, source: v.source, assessedAt: v.assessedAt, validUntil: v.validUntil }]))
}

/** «Мій розвиток» блок 1 (docs/19 §5.1): профиль должности с текущим/требуемым уровнем и разрывом. */
export async function competencyGap(ctx: Ctx, userId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [pl] = await tx.select({ positionId: userPlacements.positionId, positionName: positions.name, positionLevelId: userPlacements.positionLevelId })
      .from(userPlacements).innerJoin(positions, eq(positions.id, userPlacements.positionId))
      .where(and(eq(userPlacements.userId, userId), eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt)))
    if (!pl) return { position: null, profile: null, items: [], displayAs: 'label' as const }
    const profile = await profileForPosition(tx, pl.positionId)
    if (!profile) return { position: pl, profile: null, items: [], displayAs: 'label' as const }

    const allReqs = profile.competencyRequirements as Requirement[]
    const reqs = effectiveRequirements(allReqs, profile.usePositionLevels, pl.positionLevelId)
    const comps = reqs.length ? await tx.select().from(competencies).where(inArray(competencies.id, reqs.map(r => r.competencyId))) : []
    const levels = await currentLevels(tx, userId)
    const courseIds = [...new Set(comps.flatMap(c => c.linkedCourses))]
    const courseRows = courseIds.length ? await tx.select({ id: courses.id, title: courses.title }).from(courses).where(inArray(courses.id, courseIds)) : []
    const courseById = new Map(courseRows.map(c => [c.id, c.title]))
    const { developmentSettings } = await import('./developmentExtra')
    const settings = await developmentSettings(tx, ctx.tenantId)

    const items = reqs.map((r) => {
      const c = comps.find(x => x.id === r.competencyId)
      const cur = levels.get(r.competencyId)
      const compLevels = (c?.levels ?? []) as CompetencyLevel[]
      const maxLevel = compLevels.length ? Math.max(...compLevels.map(l => l.level)) : 5
      const expiringInDays = cur?.validUntil ? Math.ceil((+cur.validUntil - Date.now()) / 86_400_000) : null
      return {
        competencyId: r.competencyId, name: c?.name ?? '?', kind: c?.kind, requiredLevel: r.requiredLevel, isCritical: r.isCritical ?? false,
        currentLevel: cur?.level ?? 0, source: cur?.source ?? null, maxLevel,
        currentLevelLabel: cur ? compLevels.find(l => l.level === cur.level)?.title ?? String(cur.level) : null,
        validUntil: cur?.validUntil ?? null, expiringSoon: expiringInDays != null && expiringInDays <= 14,
        gap: Math.max(0, r.requiredLevel - (cur?.level ?? 0)),
        levels: compLevels,
        whatToLearn: (c?.linkedCourses ?? []).map(id => ({ id, title: courseById.get(id) ?? '?' })),
      }
    })
    return { position: pl, profile: { id: profile.id, probationDays: profile.probationDays, goals: profile.goals, responsibilities: profile.responsibilities }, items, displayAs: settings.competencyDisplayAs }
  })
}

// ── ИПР ────────────────────────────────────────────────────────────────

async function managerOf(tx: TenantTx, userId: string): Promise<string | null> {
  const rows = await tx.execute(sql`select l.manager_id from user_placements up join locations l on l.id = up.location_id where up.user_id = ${userId}::uuid and up.is_primary and up.ended_at is null limit 1`) as unknown as { manager_id: string | null }[]
  return rows[0]?.manager_id ?? null
}

export async function myPlan(ctx: Ctx, userId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    // «наставник» плану (docs/19 §3.4, screens-7) — поруч з періодом на картці «Ціль плану»
    const [plan] = await tx.select({
      id: developmentPlans.id, tenantId: developmentPlans.tenantId, userId: developmentPlans.userId,
      periodFrom: developmentPlans.periodFrom, periodTo: developmentPlans.periodTo, ownerId: developmentPlans.ownerId,
      mentorId: developmentPlans.mentorId, mentorName: users.fullName,
      status: developmentPlans.status, summary: developmentPlans.summary, createdBy: developmentPlans.createdBy,
      approvedBy: developmentPlans.approvedBy, approvedAt: developmentPlans.approvedAt, closedAt: developmentPlans.closedAt,
      resultComment: developmentPlans.resultComment, createdAt: developmentPlans.createdAt, updatedAt: developmentPlans.updatedAt,
    }).from(developmentPlans).leftJoin(users, eq(users.id, developmentPlans.mentorId))
      .where(and(eq(developmentPlans.userId, userId), sql`${developmentPlans.status} <> 'closed'`)).orderBy(desc(developmentPlans.createdAt)).limit(1)
    const goals = await tx.select({
      id: developmentGoals.id, title: developmentGoals.title, kind: developmentGoals.kind, dueAt: developmentGoals.dueAt, statusCode: developmentGoals.statusCode,
      progressPct: developmentGoals.progressPct, competencyId: developmentGoals.competencyId, targetLevel: developmentGoals.targetLevel, planId: developmentGoals.planId, approvedAt: developmentGoals.approvedAt, returnComment: developmentGoals.returnComment,
      statusName: goalStatuses.name, statusColor: goalStatuses.color, isFinal: goalStatuses.isFinal,
    }).from(developmentGoals).innerJoin(goalStatuses, eq(goalStatuses.code, developmentGoals.statusCode))
      // isStrategic=false — особисті цілі ІПР, не вузли дерева «Стратегічний план» (docs/19 §14.4)
      .where(and(eq(developmentGoals.userId, userId), eq(developmentGoals.isStrategic, false))).orderBy(asc(developmentGoals.dueAt))
    const statuses = await tx.select().from(goalStatuses).orderBy(asc(goalStatuses.sort))
    return { plan: plan ?? null, goals, statuses }
  })
}

export async function createPlan(ctx: Ctx, input: { userId: string, periodFrom: string, periodTo: string, summary?: string, mentorId?: string | null }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const ownerId = await managerOf(tx, input.userId)
    const [p] = await tx.insert(developmentPlans).values({ tenantId: ctx.tenantId, userId: input.userId, periodFrom: input.periodFrom, periodTo: input.periodTo, ownerId, mentorId: input.mentorId ?? null, summary: input.summary ?? null, createdBy: ctx.actorId }).returning()
    return p!
  })
}

/** Наставник плану (docs/19 §3.4, screens-7) — призначає керівник, окремо від затвердження плану. */
export async function setPlanMentor(ctx: Ctx, planId: string, mentorId: string | null) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select({ mentorId: developmentPlans.mentorId }).from(developmentPlans).where(eq(developmentPlans.id, planId))
    if (!before) return null
    const [p] = await tx.update(developmentPlans).set({ mentorId, updatedAt: new Date() }).where(eq(developmentPlans.id, planId)).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'development_plan.mentor', entity: 'development_plan', entityId: planId, before: { mentorId: before.mentorId }, after: { mentorId } })
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

/** Вкладки списку планів (докс/31 `DevelopmentPlans`, `[рішення]` докс/28 «Spec 19 (продовження)»):
 *  «Активні» — план ще відкритий і потребує дій (включно з «На перевірці» після завершення періоду),
 *  «Неактивні» — ще не стартував (чернетка/на погодженні), «Виконані» — закритий. */
const PLAN_TAB_STATUSES = { active: ['active', 'review'], inactive: ['draft', 'on_approval'], done: ['closed'] } as const
export type PlanTab = keyof typeof PLAN_TAB_STATUSES

/**
 * Список планів розвитку для адмінки (докс/19 §5.3-подібний список, мокап `DevelopmentPlans`):
 * людина · ціль (`summary`) · період · кроків (готово з усіх) · прогрес · стан. Область видимості —
 * `developmentPlanScope()` в ендпоінті: `null` — уся мережа, інакше — точки з `development.team`.
 */
export async function listDevelopmentPlans(ctx: Ctx, filter: { tab?: PlanTab, scope: string[] | null }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.execute(sql`
      select p.id, p.user_id, u.full_name, pos.name as position, l.name as location,
             p.summary, p.period_from, p.period_to, p.status, p.mentor_id, m.full_name as mentor_name,
             count(g.id)::int as steps_total,
             count(g.id) filter (where gs.is_final)::int as steps_done
      from development_plans p
      join users u on u.id = p.user_id
      left join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null
      left join positions pos on pos.id = up.position_id
      left join locations l on l.id = up.location_id
      left join users m on m.id = p.mentor_id
      left join development_goals g on g.plan_id = p.id and not g.is_strategic
      left join goal_statuses gs on gs.code = g.status_code and gs.tenant_id = g.tenant_id
      where true
        ${filter.tab ? sql`and p.status in ${PLAN_TAB_STATUSES[filter.tab]}` : sql``}
        ${scopeSql(filter.scope, sql`up.location_id`)}
      group by p.id, u.full_name, pos.name, l.name, m.full_name
      order by p.period_to desc, u.full_name
      limit 500
    `) as unknown as { id: string, user_id: string, full_name: string, position: string | null, location: string | null, summary: string | null, period_from: string, period_to: string, status: string, mentor_id: string | null, mentor_name: string | null, steps_total: number, steps_done: number }[]
    const [counts] = await tx.execute(sql`
      select
        count(*) filter (where p.status in ${PLAN_TAB_STATUSES.active})::int as active,
        count(*) filter (where p.status in ${PLAN_TAB_STATUSES.inactive})::int as inactive,
        count(*) filter (where p.status in ${PLAN_TAB_STATUSES.done})::int as done
      from development_plans p
      left join user_placements up on up.user_id = p.user_id and up.is_primary and up.ended_at is null
      where true ${scopeSql(filter.scope, sql`up.location_id`)}
    `) as unknown as { active: number, inactive: number, done: number }[]
    return {
      items: rows.map(r => ({ ...r, progressPct: r.steps_total ? Math.round((r.steps_done / r.steps_total) * 100) : 0 })),
      counts: counts ?? { active: 0, inactive: 0, done: 0 },
    }
  })
}

/** Картка плану для адмінки/керівника: план + всі його кроки-цілі (докс/31 `DevelopmentPlans`). */
export async function getPlanCard(ctx: Ctx, planId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [plan] = await tx.select({
      id: developmentPlans.id, userId: developmentPlans.userId, fullName: users.fullName,
      periodFrom: developmentPlans.periodFrom, periodTo: developmentPlans.periodTo, ownerId: developmentPlans.ownerId,
      mentorId: developmentPlans.mentorId, mentorName: sql<string | null>`(select full_name from users where id = ${developmentPlans.mentorId})`,
      status: developmentPlans.status, summary: developmentPlans.summary,
      approvedBy: developmentPlans.approvedBy, approvedAt: developmentPlans.approvedAt, closedAt: developmentPlans.closedAt,
      resultComment: developmentPlans.resultComment, createdAt: developmentPlans.createdAt,
    }).from(developmentPlans).innerJoin(users, eq(users.id, developmentPlans.userId)).where(eq(developmentPlans.id, planId))
    if (!plan) return null
    const [placement] = await tx.select({ locationId: userPlacements.locationId })
      .from(userPlacements).where(and(eq(userPlacements.userId, plan.userId), eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt)))
    const goals = await tx.select({
      id: developmentGoals.id, title: developmentGoals.title, kind: developmentGoals.kind, dueAt: developmentGoals.dueAt,
      statusCode: developmentGoals.statusCode, statusName: goalStatuses.name, statusColor: goalStatuses.color, isFinal: goalStatuses.isFinal,
      progressPct: developmentGoals.progressPct,
    }).from(developmentGoals).innerJoin(goalStatuses, eq(goalStatuses.code, developmentGoals.statusCode))
      .where(and(eq(developmentGoals.planId, planId), eq(developmentGoals.isStrategic, false))).orderBy(asc(developmentGoals.dueAt))
    const statuses = await tx.select().from(goalStatuses).orderBy(asc(goalStatuses.sort))
    return { plan, locationId: placement?.locationId ?? null, goals, statuses }
  })
}

/** Редагування плану (докс/28 «Spec 19 (продовження)»: раніше PATCH не існувало зовсім) — період і ціль (`summary`); статус — тільки через `transitionPlan`. */
export async function updatePlan(ctx: Ctx, planId: string, input: { summary?: string | null, periodFrom?: string, periodTo?: string }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select({ periodFrom: developmentPlans.periodFrom, periodTo: developmentPlans.periodTo, summary: developmentPlans.summary }).from(developmentPlans).where(eq(developmentPlans.id, planId))
    if (!before) return null
    const [p] = await tx.update(developmentPlans).set({ ...input, updatedAt: new Date() }).where(eq(developmentPlans.id, planId)).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'plan.update', entity: 'development_plan', entityId: planId, before, after: input })
    return p!
  })
}

// ── Цели ───────────────────────────────────────────────────────────────

export type CreateGoalResult = { ok: true, goal: typeof developmentGoals.$inferSelect } | { ok: false, code: 'due_past' | 'due_outside_plan' | 'level_not_higher' | 'competency_required' }

/** Цель (docs/19 §6.1): срок > сегодня и ≤ конца периода ИПР; целевой уровень выше текущего; при типе competency — компетенция обязательна.
 *  Если тенант включил согласование (§7.4) и цель ставит сам человек — она ждёт руководителя. */
export async function createGoal(ctx: Ctx, input: { userId: string, planId?: string, title: string, description?: string, kind: string, competencyId?: string, targetLevel?: number, metric?: string, linkedContent?: unknown[], dueAt: string, mentorId?: string }): Promise<CreateGoalResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const today = new Date().toISOString().slice(0, 10)
    if (input.dueAt <= today) return { ok: false as const, code: 'due_past' as const }
    if (input.planId) {
      const [plan] = await tx.select({ periodTo: developmentPlans.periodTo }).from(developmentPlans).where(eq(developmentPlans.id, input.planId))
      if (plan && input.dueAt > plan.periodTo) return { ok: false as const, code: 'due_outside_plan' as const }
    }
    if (input.kind === 'competency' && !input.competencyId) return { ok: false as const, code: 'competency_required' as const }
    if (input.competencyId && input.targetLevel) {
      const cur = (await currentLevels(tx, input.userId)).get(input.competencyId)?.level ?? 0
      if (input.targetLevel <= cur) return { ok: false as const, code: 'level_not_higher' as const }
    }
    const { developmentSettings } = await import('./developmentExtra')
    const settings = await developmentSettings(tx, ctx.tenantId)
    const isOwner = input.userId === ctx.actorId
    const needsApproval = settings.goalsNeedApproval && isOwner
    const [initial] = await tx.select({ code: goalStatuses.code }).from(goalStatuses).where(eq(goalStatuses.isInitial, true)).limit(1)
    const [g] = await tx.insert(developmentGoals).values({
      tenantId: ctx.tenantId, userId: input.userId, planId: input.planId ?? null, title: input.title, description: input.description ?? null, kind: input.kind,
      competencyId: input.competencyId ?? null, targetLevel: input.targetLevel ?? null, metric: input.metric ?? null, linkedContent: input.linkedContent ?? [],
      dueAt: input.dueAt, statusCode: initial?.code ?? 'planned', mentorId: input.mentorId ?? null, createdBy: ctx.actorId,
      ...(needsApproval ? {} : { approvedBy: ctx.actorId, approvedAt: new Date() }),
    }).returning()
    await tx.insert(goalStatusLog).values({ tenantId: ctx.tenantId, goalId: g!.id, fromStatus: null, toStatus: g!.statusCode, actorId: ctx.actorId, requestContext: currentRequestContext() })
    const mgr = await managerOf(tx, input.userId)
    if (needsApproval && mgr) await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: mgr, code: 'goal_needs_approval', payload: { title: input.title, goalId: g!.id }, dedupKey: `goal_appr:${g!.id}` })
    else if (!isOwner) await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: input.userId, code: 'goal_created', payload: { title: input.title, due: input.dueAt }, dedupKey: `goal_created:${g!.id}` })
    return { ok: true as const, goal: g! }
  })
}

/** Согласование цели руководителем (docs/19 §5.3, §7.4): «Погодити» / «Повернути» с комментарием. */
export async function approveGoal(ctx: Ctx, goalId: string, decision: 'approve' | 'return', comment?: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [g] = await tx.select().from(developmentGoals).where(eq(developmentGoals.id, goalId))
    if (!g) return { ok: false as const, code: 'not_found' as const }
    if (g.userId === ctx.actorId) return { ok: false as const, code: 'self' as const }
    if (decision === 'return' && !(comment ?? '').trim()) return { ok: false as const, code: 'comment_required' as const }
    await tx.update(developmentGoals).set(decision === 'approve'
      ? { approvedBy: ctx.actorId, approvedAt: new Date(), returnComment: null, updatedAt: new Date() }
      : { approvedBy: null, approvedAt: null, returnComment: comment!, updatedAt: new Date() }).where(eq(developmentGoals.id, goalId))
    await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: g.userId, code: decision === 'approve' ? 'goal_approved' : 'goal_returned', payload: { title: g.title, comment: comment ?? '' }, dedupKey: `goal_${decision}:${goalId}:${Date.now()}` })
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: `goal.${decision}`, entity: 'development_goal', entityId: goalId, after: { comment: comment ?? null } })
    return { ok: true as const }
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
    const { developmentSettings } = await import('./developmentExtra')
    const { competencyDisplayAs: displayAs } = await developmentSettings(tx, ctx.tenantId)
    const targetLevelLabel = comp && g.targetLevel != null ? levelLabel(comp.levels as CompetencyLevel[], g.targetLevel) : null
    return { ...g, status, transitions, log, comments, competency: comp ?? null, displayAs, targetLevelLabel }
  })
}

export async function updateGoalProgress(ctx: Ctx, id: string, input: { progressPct?: number, result?: string, description?: string, metric?: string }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [g] = await tx.update(developmentGoals).set({ ...input, updatedAt: new Date() }).where(and(eq(developmentGoals.id, id), eq(developmentGoals.userId, ctx.actorId))).returning()
    return g ?? null
  })
}

export type GoalTransitionResult = { ok: true, status: string } | { ok: false, code: 'not_found' | 'not_allowed' | 'forbidden' | 'comment_required' | 'not_approved' }

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
    // Несогласованная цель не двигается по жизненному циклу (docs/19 §7.4)
    if (!g.approvedAt && !from.isInitial) return { ok: false as const, code: 'not_approved' as const }
    if (!g.approvedAt && !to.isInitial) return { ok: false as const, code: 'not_approved' as const }
    if (to.requiresComment && !(opts.comment ?? '').trim()) return { ok: false as const, code: 'comment_required' as const }

    const now = new Date()
    await tx.update(developmentGoals).set({
      statusCode: toCode,
      ...(to.isFinal ? { evaluatedBy: ctx.actorId, evaluatedAt: now, evaluation: opts.evaluation ?? opts.comment ?? null } : {}),
      ...(to.isSuccess ? { progressPct: 100 } : {}),
      updatedAt: now,
    }).where(eq(developmentGoals.id, goalId))
    await tx.insert(goalStatusLog).values({ tenantId: ctx.tenantId, goalId, fromStatus: g.statusCode, toStatus: toCode, actorId: ctx.actorId, comment: opts.comment ?? null, requestContext: currentRequestContext() })

    // Достигнутая цель по компетенции → ручная оценка уровня от руководителя (docs/19 Г-19.2: source=manual, с причиной)
    if (to.isSuccess && g.competencyId && g.targetLevel && !isOwner) {
      await tx.insert(competencyAssessments).values({ tenantId: ctx.tenantId, userId: g.userId, competencyId: g.competencyId, level: g.targetLevel, source: 'manual', evidenceId: goalId, assessedBy: ctx.actorId, comment: `Ціль «${g.title}» досягнута`, validUntil: defaultValidUntil() })
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
      select g.id, g.title, g.kind, g.due_at, g.status_code, s.name as status_name, s.color as status_color, s.is_final, g.progress_pct, g.approved_at, g.return_comment,
             u.id as user_id, u.full_name, l.name as location, (g.due_at < current_date and not s.is_final) as is_overdue
      from development_goals g
      join goal_statuses s on s.code = g.status_code and s.tenant_id = g.tenant_id
      join users u on u.id = g.user_id
      left join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null
      left join locations l on l.id = up.location_id
      where not g.is_strategic
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

// ── Дерево цілей «Стратегічний план» (docs/19 §14.4, §5; [рішення] докс/28 «Spec 19 (продовження)») ─
//
// У знятому ТЗ (`19` §3.5) `development_goals` — тільки особисті цілі ІПР. Ре-аудит §14.4 показав,
// що в еталоні «Стратегічний план» (/mbo) — дерево з `parent_id`, де цілі компанії («Напрямок»)
// каскадом розкриваються до особистих цілей людей: той самий життєвий цикл статусів і протокол
// (`goal_status_log`), просто інша вкладеність. Замість нової таблиці/сервісу — та сама
// `development_goals` + `parentId` (self-FK, docs/33) і `isStrategic` (`true` — вузол дерева,
// відділяє його від особистих цілей ІПР, які інакше потрапили б у «Мій розвиток»/«Цілі
// співробітників» тієї самої людини). `kind='result'` — найближче з уже існуючого перечня
// (`competency|learning|result|project`, CLAUDE.md п. 13 — нового значення не заводимо).
// Погодження не потрібне (`approvedBy/At` проставляються одразу): «Стратегічний план» веде
// адміністратор (docs/19 §2), а не сама людина, тож механізм §7.4 тут не застосовується.

export type TreeGoalResult = { ok: true, goal: typeof developmentGoals.$inferSelect } | { ok: false, code: 'parent_not_found' | 'user_not_found' }

/** Дерево цілей компанії — `isStrategic=true`; фронт будує вкладеність із `parentId` сам. */
export async function listGoalTree(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const items = await tx.select({
      id: developmentGoals.id, parentId: developmentGoals.parentId, title: developmentGoals.title,
      userId: developmentGoals.userId, ownerName: users.fullName, dueAt: developmentGoals.dueAt,
      statusCode: developmentGoals.statusCode, statusName: goalStatuses.name, statusColor: goalStatuses.color,
      isFinal: goalStatuses.isFinal, isSuccess: goalStatuses.isSuccess, progressPct: developmentGoals.progressPct,
      createdAt: developmentGoals.createdAt,
    }).from(developmentGoals)
      .innerJoin(goalStatuses, eq(goalStatuses.code, developmentGoals.statusCode))
      .leftJoin(users, eq(users.id, developmentGoals.userId))
      .where(eq(developmentGoals.isStrategic, true))
      .orderBy(asc(developmentGoals.createdAt))
    const statuses = await tx.select().from(goalStatuses).orderBy(asc(goalStatuses.sort))
    return { items, statuses }
  })
}

export async function createTreeGoal(ctx: Ctx, input: { parentId?: string | null, title: string, userId: string, dueAt?: string | null }): Promise<TreeGoalResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    if (input.parentId) {
      const [p] = await tx.select({ id: developmentGoals.id }).from(developmentGoals).where(and(eq(developmentGoals.id, input.parentId), eq(developmentGoals.isStrategic, true)))
      if (!p) return { ok: false as const, code: 'parent_not_found' as const }
    }
    const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId))
    if (!u) return { ok: false as const, code: 'user_not_found' as const }
    const [initial] = await tx.select({ code: goalStatuses.code }).from(goalStatuses).where(eq(goalStatuses.isInitial, true)).limit(1)
    const [g] = await tx.insert(developmentGoals).values({
      tenantId: ctx.tenantId, userId: input.userId, parentId: input.parentId ?? null, isStrategic: true,
      title: input.title, kind: 'result', dueAt: input.dueAt ?? null, statusCode: initial?.code ?? 'planned',
      approvedBy: ctx.actorId, approvedAt: new Date(), createdBy: ctx.actorId,
    }).returning()
    await tx.insert(goalStatusLog).values({ tenantId: ctx.tenantId, goalId: g!.id, fromStatus: null, toStatus: g!.statusCode, actorId: ctx.actorId, requestContext: currentRequestContext() })
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'goal_tree.create', entity: 'development_goal', entityId: g!.id, after: { title: input.title, parentId: input.parentId ?? null } })
    return { ok: true as const, goal: g! }
  })
}

export async function updateTreeGoal(ctx: Ctx, id: string, input: { title?: string, userId?: string, dueAt?: string | null, progressPct?: number }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(developmentGoals).where(and(eq(developmentGoals.id, id), eq(developmentGoals.isStrategic, true)))
    if (!before) return null
    const [g] = await tx.update(developmentGoals).set({ ...input, updatedAt: new Date() }).where(eq(developmentGoals.id, id)).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'goal_tree.update', entity: 'development_goal', entityId: id, before: { title: before.title, userId: before.userId, dueAt: before.dueAt }, after: input })
    return g!
  })
}

/** Видалення вузла — каскадом (`parent_id` FK `on delete cascade`) видаляє й усе піддерево. */
export async function deleteTreeGoal(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [g] = await tx.delete(developmentGoals).where(and(eq(developmentGoals.id, id), eq(developmentGoals.isStrategic, true))).returning({ id: developmentGoals.id, title: developmentGoals.title })
    if (!g) return false
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'goal_tree.delete', entity: 'development_goal', entityId: id, before: { title: g.title } })
    return true
  })
}

/** Фоновая: цели с истёкшим сроком — напоминание человеку и наставнику (раз в день). */
export async function goalDueScan(tenantId: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const rows = await tx.execute(sql`
      select g.id, g.user_id, g.mentor_id, g.title, g.due_at from development_goals g
      join goal_statuses s on s.code = g.status_code and s.tenant_id = g.tenant_id
      where not g.is_strategic and not s.is_final and g.due_at in (current_date + 3, current_date, current_date - 1)
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
