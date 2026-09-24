import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  assignmentCompetencies, assignments, competencies, competencyAssessments, competencyCategories, courses, developmentGoals, developmentPlans, goalStatuses,
  positionProfilePositions, positionProfiles, strategicPlans, userPlacements, users,
} from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import { currentLevels, defaultValidUntil, effectiveRequirements, levelLabel, profileForPosition } from './development'
import type { CompetencyLevel, Requirement } from './development'
import { scopeSql } from './access'
import { EMPLOYEES_ONLY } from './repo/people'
import { DEFAULT_REMINDERS } from '../../shared/schemas/assignments'
import type { DisplayAs } from '../../shared/enums'
import { managerIdOf, managerIdsOf } from './orgManager'

interface Ctx { tenantId: string, actorId: string }

/**
 * Развитие, часть 2 (docs/19): матрица компетенций, отчёты, применение профиля к людям,
 * автозачёт компетенции курсом, закрытие ИПР по периоду, стратегические планы, категории,
 * настройки модуля (порог суммы заявки, согласование целей).
 */

// ── Настройки модуля (tenants.settings.development) ──────────────────

export interface DevelopmentSettings {
  goalsNeedApproval: boolean // docs/19 §7.4
  externalTrainingThreshold: number // §7.7: сумма, выше которой в маршруте появляется администратор
  careerAssessmentFormId: string | null // §7.9: анкета оценки готовности для карьерной заявки
  competencyDisplayAs: DisplayAs // §14.1 «Шкала компетенцій»: показывать рівень як назву чи як число
}
const DEFAULTS: DevelopmentSettings = { goalsNeedApproval: false, externalTrainingThreshold: 5000, careerAssessmentFormId: null, competencyDisplayAs: 'label' }

export async function developmentSettings(tx: TenantTx, tenantId: string): Promise<DevelopmentSettings> {
  const [t] = await tx.execute(sql`select coalesce(settings->'development', '{}'::jsonb) as d from tenants where id = ${tenantId}::uuid`) as unknown as { d: Partial<DevelopmentSettings> }[]
  return { ...DEFAULTS, ...(t?.d ?? {}) }
}
export async function getDevelopmentSettings(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, tx => developmentSettings(tx, ctx.tenantId))
}
export async function updateDevelopmentSettings(ctx: Ctx, patch: Partial<DevelopmentSettings>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const before = await developmentSettings(tx, ctx.tenantId)
    const next = { ...before, ...patch }
    await tx.execute(sql`update tenants set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{development}', ${JSON.stringify(next)}::jsonb) where id = ${ctx.tenantId}::uuid`)
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'settings.development', entity: 'tenant', entityId: ctx.tenantId, before, after: next })
    return next
  })
}

// ── Категории компетенций (docs/19 §3.1) ─────────────────────────────

export async function listCategories(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, tx => tx.select().from(competencyCategories).orderBy(asc(competencyCategories.sort), asc(competencyCategories.name)))
}
export async function upsertCategory(ctx: Ctx, input: { id?: string, name: string, sort?: number }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    if (input.id) {
      const [r] = await tx.update(competencyCategories).set({ name: input.name, sort: input.sort ?? 0, updatedAt: new Date() }).where(eq(competencyCategories.id, input.id)).returning()
      return r ?? null
    }
    const [r] = await tx.insert(competencyCategories).values({ tenantId: ctx.tenantId, name: input.name, sort: input.sort ?? 0 }).returning()
    return r!
  })
}
export async function deleteCategory(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async tx => (await tx.delete(competencyCategories).where(eq(competencyCategories.id, id)).returning({ id: competencyCategories.id })).length > 0)
}

// ── Матрица компетенций (docs/19 §5.6, §13.6) ────────────────────────

/** Строки — люди точки, столбцы — компетенции их профилей; цвет: teal = соответствует, sun = ниже на 1, coral = ниже на 2+. */
export async function competencyMatrix(ctx: Ctx, filter: { locationId?: string, scope?: string[] | null } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const people = await tx.execute(sql`
      select u.id, u.full_name, up.position_id, up.position_level_id, p.name as position, l.name as location, up.location_id
      from users u join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null
      join positions p on p.id = up.position_id join locations l on l.id = up.location_id
      where u.status = 'active' and not u.is_hidden ${EMPLOYEES_ONLY()}
        ${filter.locationId ? sql`and up.location_id = ${filter.locationId}::uuid` : sql``}
        ${scopeSql(filter.scope ?? null, sql`up.location_id`)}
      order by l.name, u.full_name limit 300
    `) as unknown as { id: string, full_name: string, position_id: string, position_level_id: string | null, position: string, location: string, location_id: string }[]
    const profiles = await tx.select().from(positionProfiles).where(eq(positionProfiles.isActive, true))
    // D-031: профіль може покривати кілька посад — карта посада → профіль через position_profile_positions
    const links = profiles.length ? await tx.select({ profileId: positionProfilePositions.profileId, positionId: positionProfilePositions.positionId }).from(positionProfilePositions) : []
    const byId = new Map(profiles.map(p => [p.id, p]))
    const byPosition = new Map(profiles.map(p => [p.positionId, p]))
    for (const l of links) { const p = byId.get(l.profileId); if (p && !byPosition.has(l.positionId)) byPosition.set(l.positionId, p) }
    const compIds = [...new Set(profiles.flatMap(p => (p.competencyRequirements as Requirement[]).map(r => r.competencyId)))]
    const comps = compIds.length ? await tx.select({ id: competencies.id, name: competencies.name, kind: competencies.kind, linkedCourses: competencies.linkedCourses, levels: competencies.levels }).from(competencies).where(sql`${competencies.id} in ${compIds}`) : []
    const levelsById = new Map(comps.map(c => [c.id, c.levels as CompetencyLevel[]]))
    const columns = comps.map(c => ({ id: c.id, name: c.name, kind: c.kind }))
    const { competencyDisplayAs: displayAs } = await developmentSettings(tx, ctx.tenantId)
    const rows = []
    for (const u of people) {
      const profile = byPosition.get(u.position_id)
      const reqs = profile ? effectiveRequirements(profile.competencyRequirements as Requirement[], profile.usePositionLevels, u.position_level_id) : []
      const levels = await currentLevels(tx, u.id)
      const cells = reqs.map((r) => {
        const cur = levels.get(r.competencyId)?.level ?? 0
        const gap = Math.max(0, r.requiredLevel - cur)
        const compLevels = levelsById.get(r.competencyId) ?? []
        return {
          competencyId: r.competencyId, current: cur, required: r.requiredLevel, gap, isCritical: r.isCritical ?? false, color: gap === 0 ? 'teal' : gap === 1 ? 'sun' : 'coral', source: levels.get(r.competencyId)?.source ?? null,
          currentLabel: levelLabel(compLevels, cur), requiredLabel: levelLabel(compLevels, r.requiredLevel),
        }
      })
      rows.push({ userId: u.id, fullName: u.full_name, position: u.position, location: u.location, hasProfile: reqs.length > 0, cells, fits: cells.length > 0 && cells.every(c => c.gap === 0) })
    }
    const withProfile = rows.filter(r => r.hasProfile)
    return { columns, rows, displayAs, summary: { people: rows.length, withProfile: withProfile.length, fit: withProfile.filter(r => r.fits).length, fitPct: withProfile.length ? Math.round(withProfile.filter(r => r.fits).length / withProfile.length * 100) : null } }
  })
}

/** История оценок компетенции у человека — клик по ячейке (docs/19 §5.6). */
export async function competencyHistory(ctx: Ctx, userId: string, competencyId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.execute(sql`
      select a.id, a.level, a.source, a.assessed_at, a.valid_until, a.comment, u.full_name as assessed_by
      from competency_assessments a left join users u on u.id = a.assessed_by
      where a.user_id = ${userId}::uuid and a.competency_id = ${competencyId}::uuid order by a.assessed_at desc limit 50
    `) as unknown as Record<string, unknown>[]
    const [c] = await tx.select({ name: competencies.name, levels: competencies.levels, linkedCourses: competencies.linkedCourses }).from(competencies).where(eq(competencies.id, competencyId))
    const compLevels = (c?.levels ?? []) as CompetencyLevel[]
    const withLabel = rows.map(r => ({ ...r, levelLabel: levelLabel(compLevels, r.level as number) }))
    const courseRows = c?.linkedCourses.length ? await tx.select({ id: courses.id, title: courses.title }).from(courses).where(sql`${courses.id} in ${c.linkedCourses}`) : []
    const { competencyDisplayAs: displayAs } = await developmentSettings(tx, ctx.tenantId)
    return { competency: c ?? null, history: withLabel, whatToLearn: courseRows, displayAs }
  })
}

// ── Отчёты (docs/19 §9) ───────────────────────────────────────────────

/** «Розриви»: топ компетенций с наибольшим суммарным разрывом — какие курсы нужны сети. */
export async function gapsReport(ctx: Ctx, scope: string[] | null = null) {
  const m = await competencyMatrix(ctx, { scope })
  const acc = new Map<string, { competencyId: string, name: string, people: number, withGap: number, critical: number, totalGap: number }>()
  for (const col of m.columns) acc.set(col.id, { competencyId: col.id, name: col.name, people: 0, withGap: 0, critical: 0, totalGap: 0 })
  for (const r of m.rows) for (const c of r.cells) {
    const a = acc.get(c.competencyId)
    if (!a) continue
    a.people++
    if (c.gap > 0) { a.withGap++; a.totalGap += c.gap; if (c.isCritical) a.critical++ }
  }
  return [...acc.values()].filter(a => a.people > 0).sort((a, b) => b.totalGap - a.totalGap)
}

/** «Цілі»: поставлено / достигнуто / просрочено — по точкам. */
export async function goalsReport(ctx: Ctx, filter: { from?: string, to?: string, scope?: string[] | null } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, tx => tx.execute(sql`
    select coalesce(l.name, '—') as location,
           count(*)::int as total,
           count(*) filter (where s.is_success)::int as achieved,
           count(*) filter (where s.is_final and not s.is_success)::int as not_achieved,
           count(*) filter (where not s.is_final and g.due_at < current_date)::int as overdue,
           count(*) filter (where not s.is_final and g.due_at >= current_date)::int as in_progress
    from development_goals g join goal_statuses s on s.code = g.status_code and s.tenant_id = g.tenant_id
    left join user_placements up on up.user_id = g.user_id and up.is_primary and up.ended_at is null
    left join locations l on l.id = up.location_id
    where not g.is_strategic ${filter.from ? sql`and g.created_at >= ${filter.from}::date` : sql``} ${filter.to ? sql`and g.created_at < (${filter.to}::date + 1)` : sql``}
      ${scopeSql(filter.scope ?? null, sql`up.location_id`)}
    group by 1 order by 1
  `) as unknown as Promise<Record<string, unknown>[]>)
}

/** «Зовнішнє навчання»: заявки и суммы по подразделениям; окупаемость — сдал ли человек аттестацию после обучения. */
export async function externalTrainingReport(ctx: Ctx, filter: { from?: string, to?: string, scope?: string[] | null } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, tx => tx.execute(sql`
    select coalesce(ou.name, '—') as org_unit, r.status, count(*)::int as requests, coalesce(sum(r.cost), 0)::numeric as total_cost,
           count(*) filter (where r.status = 'completed' and exists (
             select 1 from attempts a where a.user_id = r.user_id and a.passed and a.submitted_at > coalesce(r.starts_at::timestamptz, r.decided_at)))::int as passed_after
    from external_training_requests r
    left join user_placements up on up.user_id = r.user_id and up.is_primary and up.ended_at is null
    left join org_units ou on ou.id = up.org_unit_id
    where true ${filter.from ? sql`and r.created_at >= ${filter.from}::date` : sql``} ${filter.to ? sql`and r.created_at < (${filter.to}::date + 1)` : sql``}
      ${scopeSql(filter.scope ?? null, sql`up.location_id`)}
    group by 1, 2 order by 1, 2
  `) as unknown as Promise<Record<string, unknown>[]>)
}

/** «Готовність до підвищення»: кто соответствует профилю указанной (следующей) должности. */
export async function promotionReadiness(ctx: Ctx, positionId: string, scope: string[] | null = null) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const profile = await profileForPosition(tx, positionId)
    if (!profile) return { profile: null, people: [] }
    // Кандидат ещё не на этой должности — берём общее требование (без привязки к уровню посади).
    const reqs = effectiveRequirements(profile.competencyRequirements as Requirement[], profile.usePositionLevels, null)
    const people = await tx.execute(sql`
      select u.id, u.full_name, p.name as position, l.name as location
      from users u join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null
      join positions p on p.id = up.position_id join locations l on l.id = up.location_id
      where u.status = 'active' and not u.is_hidden and up.position_id <> ${positionId}::uuid ${EMPLOYEES_ONLY()} ${scopeSql(scope, sql`up.location_id`)}
      order by u.full_name limit 500
    `) as unknown as { id: string, full_name: string, position: string, location: string }[]
    const out = []
    for (const u of people) {
      const levels = await currentLevels(tx, u.id)
      const gaps = reqs.map(r => ({ competencyId: r.competencyId, gap: Math.max(0, r.requiredLevel - (levels.get(r.competencyId)?.level ?? 0)) }))
      const fit = reqs.length ? reqs.filter((r, i) => gaps[i]!.gap === 0).length / reqs.length : 0
      out.push({ ...u, fitPct: Math.round(fit * 100), missing: gaps.filter(g => g.gap > 0).length })
    }
    return { profile: { id: profile.id, requirements: reqs.length }, people: out.sort((a, b) => b.fitPct - a.fitPct) }
  })
}

// ── Профиль → люди на должности (docs/19 §5.5) ───────────────────────

/** Усі посади профілю (D-031): головна + додаткові; головна — завжди, навіть якщо зв'язків ще немає. */
async function profilePositionIds(tx: TenantTx, profileId: string, headPositionId: string): Promise<string[]> {
  const rows = await tx.select({ positionId: positionProfilePositions.positionId }).from(positionProfilePositions).where(eq(positionProfilePositions.profileId, profileId))
  return [...new Set([headPositionId, ...rows.map(r => r.positionId)])]
}

/** «Застосувати до людей на посаді»: создаёт назначения обязательного контента профиля тем, у кого его нет. */
export async function applyPositionProfile(ctx: Ctx, profileId: string): Promise<{ assignments: number, enrolled: number } | null> {
  const created = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [p] = await tx.select().from(positionProfiles).where(eq(positionProfiles.id, profileId))
    if (!p || !p.isActive) return null
    const items = p.mandatoryContent as { subjectType: string, subjectId: string, dueDays?: number }[]
    const positionIds = await profilePositionIds(tx, p.id, p.positionId)
    const audience = { rules: [{ type: 'position', ids: positionIds }], match: 'any' }
    const ids: string[] = []
    for (const item of items) {
      const [existing] = await tx.select({ id: assignments.id }).from(assignments).where(and(eq(assignments.subjectId, item.subjectId), eq(assignments.kind, 'auto'), sql`${assignments.status} <> 'archived'`, sql`${assignments.audience}::text = ${JSON.stringify(audience)}`))
      if (existing) { ids.push(existing.id); continue }
      const [a] = await tx.insert(assignments).values({
        tenantId: ctx.tenantId, title: `Профіль посади: обовʼязкове`, kind: 'auto', subjectType: item.subjectType, subjectId: item.subjectId, audience,
        dueMode: 'relative', dueDays: item.dueDays ?? 30, isMandatory: true, autoSync: true, status: 'active', createdBy: ctx.actorId,
        reminders: DEFAULT_REMINDERS,
      }).returning({ id: assignments.id })
      ids.push(a!.id)
    }
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'position_profile.apply', entity: 'position_profile', entityId: profileId, after: { assignments: ids.length } })
    return ids
  })
  if (!created) return null
  const { expandAssignment } = await import('./assignments')
  let enrolled = 0
  for (const aid of created) enrolled += await expandAssignment(ctx.tenantId, aid)
  return { assignments: created.length, enrolled }
}

/**
 * Сколько людей соответствует профилю (docs/19 §5.5) — для карточки профиля.
 * `perPerson` (docs/31 `PositionProfile`, screens-7) — «Відповідність профілю N% — ПІБ» по
 * кожній людині на посаді: відсоток вимог компетенцій, яким людина відповідає (рівень ≥ вимоги),
 * відсортовано за відсотком за зменшенням.
 */
export async function profileCoverage(ctx: Ctx, profileId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [p] = await tx.select().from(positionProfiles).where(eq(positionProfiles.id, profileId))
    if (!p) return null
    const allReqs = p.competencyRequirements as Requirement[]
    const positionIds = await profilePositionIds(tx, p.id, p.positionId)
    const people = await tx.select({ userId: userPlacements.userId, fullName: users.fullName, positionLevelId: userPlacements.positionLevelId })
      .from(userPlacements).innerJoin(users, eq(users.id, userPlacements.userId))
      .where(and(inArray(userPlacements.positionId, positionIds), eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt)))
    let fit = 0
    const ids: string[] = []
    const perPerson: { userId: string, fullName: string, percent: number, fit: boolean }[] = []
    for (const u of people) {
      const reqs = effectiveRequirements(allReqs, p.usePositionLevels, u.positionLevelId)
      const levels = await currentLevels(tx, u.userId)
      const met = reqs.filter(r => (levels.get(r.competencyId)?.level ?? 0) >= r.requiredLevel).length
      const ok = met === reqs.length
      const percent = reqs.length ? Math.round((met / reqs.length) * 100) : 100
      perPerson.push({ userId: u.userId, fullName: u.fullName, percent, fit: ok })
      if (ok) { fit++; ids.push(u.userId) }
    }
    perPerson.sort((a, b) => b.percent - a.percent)
    return { people: people.length, fit, fitUserIds: ids, perPerson }
  })
}

// ── Курс закрывает разрыв (docs/19 §7.3, Б.4: только при сданном итоговом тесте) ──

export async function onCourseCompletedCompetency(tenantId: string, userId: string, courseId: string, enrollmentId: string): Promise<boolean> {
  return withTenant(tenantId, null, async (tx) => {
    const [c] = await tx.select({ competencyId: courses.competencyId, level: courses.competencyLevel, versionId: courses.publishedVersionId }).from(courses).where(eq(courses.id, courseId))
    if (!c?.competencyId || !c.level) return false
    // Итоговый тест: любой урок-тест курса; нужна сданная попытка этого человека
    const quizzes = await tx.execute(sql`
      select l.item_id from lessons l join modules m on m.id = l.module_id where m.course_version_id = ${c.versionId}::uuid and l.item_type = 'quiz'
    `) as unknown as { item_id: string }[]
    if (!quizzes.length) return false
    const [passed] = await tx.execute(sql`select 1 from attempts a where a.user_id = ${userId}::uuid and a.passed and a.quiz_id in ${quizzes.map(q => q.item_id)} limit 1`) as unknown as unknown[]
    if (!passed) return false
    const levels = await currentLevels(tx, userId)
    if ((levels.get(c.competencyId)?.level ?? 0) >= c.level) return false
    // docs/19 Г-19.2: завершённое задание — source=task, срок дії за замовчуванням 12 місяців.
    await tx.insert(competencyAssessments).values({ tenantId, userId, competencyId: c.competencyId, level: c.level, source: 'task', evidenceId: enrollmentId, comment: 'Курс завершено, підсумковий тест складено', validUntil: defaultValidUntil() })
    return true
  })
}

/**
 * Компетенції завдання (docs/15 Г-15.3 `assignment_competencies`, docs/19 Г-19.2) — долг Spec 15,
 * закрытый в Spec 19: завершённое назначение з привʼязаними компетенціями частково підтверджує їх
 * (`source=task`) — не вище ніж на 1 щабель і лише якщо поточний рівень нижчий за вимогу профілю.
 * Без вимоги профілю (компетенція не потрібна на посаді людини) — підтвердження не ставиться.
 */
export async function onAssignmentCompletedCompetencies(tenantId: string, userId: string, assignmentId: string | null, enrollmentId: string): Promise<number> {
  if (!assignmentId) return 0
  return withTenant(tenantId, null, tx => confirmAssignmentCompetencies(tx, tenantId, userId, assignmentId, enrollmentId))
}

/**
 * Та сама логіка всередині вже відкритої транзакції — для єдиного хука «завдання завершено»
 * (`taskCompletion.ts`, docs/33 D-020/D-034): підтвердження компетенцій і запис журналу атомарні.
 * `evidenceId` — id джерела (запис курсу, попытка, прогон чек-листа …), не обов'язково enrollment.
 */
export async function confirmAssignmentCompetencies(tx: TenantTx, tenantId: string, userId: string, assignmentId: string, evidenceId: string | null): Promise<number> {
  {
    const compIds = (await tx.select({ id: assignmentCompetencies.competencyId }).from(assignmentCompetencies).where(eq(assignmentCompetencies.assignmentId, assignmentId))).map(r => r.id)
    if (!compIds.length) return 0
    const [pl] = await tx.select({ positionId: userPlacements.positionId, positionLevelId: userPlacements.positionLevelId })
      .from(userPlacements).where(and(eq(userPlacements.userId, userId), eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt)))
    if (!pl) return 0
    const profile = await profileForPosition(tx, pl.positionId)
    if (!profile) return 0
    const reqs = effectiveRequirements(profile.competencyRequirements as Requirement[], profile.usePositionLevels, pl.positionLevelId)
      .filter(r => compIds.includes(r.competencyId))
    if (!reqs.length) return 0
    const levels = await currentLevels(tx, userId)
    let n = 0
    for (const r of reqs) {
      const cur = levels.get(r.competencyId)?.level ?? 0
      if (cur >= r.requiredLevel) continue
      const level = Math.min(cur + 1, r.requiredLevel)
      await tx.insert(competencyAssessments).values({ tenantId, userId, competencyId: r.competencyId, level, source: 'task', evidenceId, comment: 'Завершено призначення з привʼязаною компетенцією', validUntil: defaultValidUntil() })
      n++
    }
    return n
  }
}

// ── Смена должности → пересчёт разрыва, критический → руководителю (docs/19 §12) ──

export async function gapDetectedOnPlacement(tenantId: string, userId: string) {
  return withTenant(tenantId, null, async (tx) => {
    const [pl] = await tx.execute(sql`select up.position_id, up.position_level_id, u.full_name from user_placements up join users u on u.id = up.user_id where up.user_id = ${userId}::uuid and up.is_primary and up.ended_at is null`) as unknown as { position_id: string, position_level_id: string | null, full_name: string }[]
    // Руководитель — из `resolveManager()` (П-16.4), а не колонкой в этом же запросе.
    if (!pl) return 0
    const managerId = await managerIdOf(tx, userId)
    if (!managerId) return 0
    const profile = await profileForPosition(tx, pl.position_id)
    if (!profile) return 0
    const levels = await currentLevels(tx, userId)
    const reqs = effectiveRequirements(profile.competencyRequirements as Requirement[], profile.usePositionLevels, pl.position_level_id)
    const critical = reqs.filter(r => r.isCritical && (levels.get(r.competencyId)?.level ?? 0) < r.requiredLevel)
    if (!critical.length) return 0
    const names = await tx.select({ name: competencies.name }).from(competencies).where(sql`${competencies.id} in ${critical.map(c => c.competencyId)}`)
    await enqueueNotification(tx, { tenantId, userId: managerId, code: 'competency_gap_detected', payload: { name: pl.full_name, competencies: names.map(n => n.name).join(', ') }, dedupKey: `gap:${userId}:${pl.position_id}` })
    return critical.length
  })
}

// ── Истечение срока действия оценки (docs/19 Г-19.2, §8) ──────────────

/**
 * Ежедневно: за 14 дней до `valid_until` — предупреждение человеку; в день истечения — уведомление
 * и, если это открыло критический разрыв по профилю должности, `competency_gap_detected` руководителю.
 * Снятие подтверждения не требует отдельного действия — просроченная запись уже не участвует
 * в `currentLevels()` (docs/19 Г-19.2 «оцінка старша за 12 місяців … не вважається підтвердженою»).
 */
export async function competencyExpiryScan(tenantId: string): Promise<{ warned: number, expired: number }> {
  return withTenant(tenantId, null, async (tx) => {
    const out = { warned: 0, expired: 0 }
    const day = new Date().toISOString().slice(0, 10)
    const warning = await tx.execute(sql`
      select a.id, a.user_id, a.competency_id, c.name from competency_assessments a join competencies c on c.id = a.competency_id
      where a.tenant_id = ${tenantId}::uuid and a.valid_until::date = current_date + 14
    `) as unknown as { id: string, user_id: string, competency_id: string, name: string }[]
    for (const w of warning) {
      if (await enqueueNotification(tx, { tenantId, userId: w.user_id, code: 'competency_expiring', payload: { name: w.name }, dedupKey: `comp_exp_warn:${w.id}:${day}` })) out.warned++
    }
    const expired = await tx.execute(sql`
      select distinct a.user_id, a.competency_id, c.name from competency_assessments a join competencies c on c.id = a.competency_id
      where a.tenant_id = ${tenantId}::uuid and a.valid_until::date = current_date - 1
    `) as unknown as { user_id: string, competency_id: string, name: string }[]
    for (const e of expired) {
      if (await enqueueNotification(tx, { tenantId, userId: e.user_id, code: 'competency_expired', payload: { name: e.name }, dedupKey: `comp_exp:${e.user_id}:${e.competency_id}:${day}` })) out.expired++
      // Истечение могло открыть критический разрыв по профилю должности — та же логика, что при смене должности (docs/19 §12).
      const [pl] = await tx.execute(sql`select up.position_id, up.position_level_id, u.full_name from user_placements up join users u on u.id = up.user_id where up.user_id = ${e.user_id}::uuid and up.is_primary and up.ended_at is null`) as unknown as { position_id: string, position_level_id: string | null, full_name: string }[]
      if (!pl) continue
      const managerId = await managerIdOf(tx, e.user_id)
      if (!managerId) continue
      const profile = await profileForPosition(tx, pl.position_id)
      if (!profile) continue
      const req = effectiveRequirements(profile.competencyRequirements as Requirement[], profile.usePositionLevels, pl.position_level_id).find(r => r.competencyId === e.competency_id)
      if (!req?.isCritical) continue
      const levels = await currentLevels(tx, e.user_id)
      if ((levels.get(e.competency_id)?.level ?? 0) < req.requiredLevel) {
        await enqueueNotification(tx, { tenantId, userId: managerId, code: 'competency_gap_detected', payload: { name: pl.full_name, competencies: e.name }, dedupKey: `gap_exp:${e.user_id}:${e.competency_id}:${day}` })
      }
    }
    return out
  })
}

// ── Закрытие ИПР по периоду (docs/19 §7.6, §13.5) ─────────────────────

/** Ежедневно: за 7 дней — напоминание; по окончании — цели без результата → «Не досягнуто», план → review, руководителю задача закрыть. */
export async function planPeriodScan(tenantId: string): Promise<{ ending: number, ended: number, goalsClosed: number }> {
  return withTenant(tenantId, null, async (tx) => {
    const out = { ending: 0, ended: 0, goalsClosed: 0 }
    const ending = await tx.select().from(developmentPlans).where(and(eq(developmentPlans.status, 'active'), sql`${developmentPlans.periodTo} = current_date + 7`))
    for (const p of ending) {
      const to = p.ownerId ?? p.userId
      if (await enqueueNotification(tx, { tenantId, userId: to, code: 'plan_period_ending', payload: { until: p.periodTo }, dedupKey: `plan_ending:${p.id}` })) out.ending++
    }
    const [notAchieved] = await tx.select({ code: goalStatuses.code }).from(goalStatuses).where(and(eq(goalStatuses.isFinal, true), eq(goalStatuses.isSuccess, false))).orderBy(asc(goalStatuses.sort)).limit(1)
    const ended = await tx.select().from(developmentPlans).where(and(sql`${developmentPlans.status} in ('active', 'on_approval', 'draft')`, sql`${developmentPlans.periodTo} < current_date`))
    for (const p of ended) {
      if (notAchieved) {
        const open = await tx.execute(sql`
          select g.id, g.status_code from development_goals g join goal_statuses s on s.code = g.status_code and s.tenant_id = g.tenant_id
          where g.plan_id = ${p.id}::uuid and not s.is_final
        `) as unknown as { id: string, status_code: string }[]
        for (const g of open) {
          await tx.update(developmentGoals).set({ statusCode: notAchieved.code, evaluatedAt: new Date(), evaluation: 'Період плану завершено без результату', updatedAt: new Date() }).where(eq(developmentGoals.id, g.id))
          await tx.execute(sql`insert into goal_status_log (tenant_id, goal_id, from_status, to_status, actor_id, comment) values (${tenantId}::uuid, ${g.id}::uuid, ${g.status_code}, ${notAchieved.code}, null, 'Автоматично: період плану завершено')`)
          out.goalsClosed++
        }
      }
      await tx.update(developmentPlans).set({ status: 'review', updatedAt: new Date() }).where(eq(developmentPlans.id, p.id))
      const to = p.ownerId ?? p.userId
      await enqueueNotification(tx, { tenantId, userId: to, code: 'plan_period_ended', payload: { planId: p.id }, dedupKey: `plan_ended:${p.id}` })
      out.ended++
    }
    return out
  })
}

// ── Напоминание об отчёте после внешнего обучения (docs/19 §7.8) ──────

export async function requestReportScan(tenantId: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const rows = await tx.execute(sql`
      select r.id, r.user_id, r.title
      from external_training_requests r
      where r.status = 'approved' and r.report is null and coalesce(r.starts_at, r.decided_at::date) < current_date - 14
    `) as unknown as { id: string, user_id: string, title: string }[]
    // Руководители всех адресатов одним резолвом (П-16.4).
    const managers = await managerIdsOf(tx, rows.map(r => r.user_id))
    let n = 0
    const week = new Date().toISOString().slice(0, 7) + ':' + Math.floor(new Date().getDate() / 7)
    for (const r of rows) {
      if (await enqueueNotification(tx, { tenantId, userId: r.user_id, code: 'request_report_required', payload: { title: r.title }, dedupKey: `req_report:${r.id}:${week}` })) n++
      const managerId = managers.get(r.user_id)
      if (managerId) await enqueueNotification(tx, { tenantId, userId: managerId, code: 'request_report_required_manager', payload: { title: r.title }, dedupKey: `req_report_m:${r.id}:${week}` })
    }
    return n
  })
}

// ── Карьерная заявка одобрена (docs/19 §7.9) ─────────────────────────

/** Назначить обязательное обучение профиля целевой должности; при настроенной анкете — открыть цикл оценки готовности. */
export async function careerApproved(tx: TenantTx, ctx: Ctx, r: { id: string, userId: string, targetPositionId: string }, formId: string | null) {
  const profile = await profileForPosition(tx, r.targetPositionId)
  const items = (profile?.mandatoryContent ?? []) as { subjectType: string, subjectId: string, dueDays?: number }[]
  const ids: string[] = []
  for (const item of items) {
    const [a] = await tx.insert(assignments).values({
      tenantId: ctx.tenantId, title: 'Карʼєрна заявка: обучение цільової посади', kind: 'career', subjectType: item.subjectType, subjectId: item.subjectId,
      audience: { rules: [{ type: 'user', ids: [r.userId] }], match: 'any' }, dueMode: 'relative', dueDays: item.dueDays ?? 30, isMandatory: true, autoSync: false, status: 'active', createdBy: ctx.actorId,
      reminders: DEFAULT_REMINDERS,
    }).returning({ id: assignments.id })
    ids.push(a!.id)
  }
  if (ids.length) {
    const { expandAssignment } = await import('./assignments')
    setImmediate(() => Promise.all(ids.map(id => expandAssignment(ctx.tenantId, id))).catch(err => console.error('career assignments', err)))
  }
  if (formId) {
    const { createCycle } = await import('./assessment')
    const today = new Date().toISOString().slice(0, 10)
    const end = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)
    const cycle = await createCycle(ctx, { title: 'Оцінка готовності до підвищення', formId, periodFrom: today, periodTo: end, startsAt: today, endsAt: end, subjects: { rules: [{ type: 'user', ids: [r.userId] }], match: 'any' }, raterKinds: ['self', 'manager'] }).catch(() => null)
    if (cycle) await tx.execute(sql`update career_requests set assessment_id = ${cycle.id}::uuid where id = ${r.id}::uuid`)
  }
  return ids.length
}

// ── Стратегические планы (docs/19 §3.8) ───────────────────────────────

export async function listStrategicPlans(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, tx => tx.execute(sql`
    select s.*, ou.name as org_unit_name, u.full_name as owner_name from strategic_plans s
    left join org_units ou on ou.id = s.org_unit_id left join users u on u.id = s.owner_id order by s.period_from desc
  `) as unknown as Promise<Record<string, unknown>[]>)
}
export async function upsertStrategicPlan(ctx: Ctx, input: { id?: string, title: string, periodFrom: string, periodTo: string, orgUnitId?: string | null, goals?: unknown[], budget?: number | null, kpi?: unknown[], status?: 'draft' | 'active' | 'closed' }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const values = { title: input.title, periodFrom: input.periodFrom, periodTo: input.periodTo, orgUnitId: input.orgUnitId ?? null, goals: input.goals ?? [], budget: input.budget != null ? String(input.budget) : null, kpi: input.kpi ?? [], status: input.status ?? 'draft' }
    if (input.id) {
      const [r] = await tx.update(strategicPlans).set({ ...values, updatedAt: new Date() }).where(eq(strategicPlans.id, input.id)).returning()
      return r ?? null
    }
    const [r] = await tx.insert(strategicPlans).values({ tenantId: ctx.tenantId, ownerId: ctx.actorId, ...values }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'strategic_plan.create', entity: 'strategic_plan', entityId: r!.id, after: { title: input.title } })
    return r!
  })
}
export async function deleteStrategicPlan(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async tx => (await tx.delete(strategicPlans).where(eq(strategicPlans.id, id)).returning({ id: strategicPlans.id })).length > 0)
}


