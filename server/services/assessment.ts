import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import {
  assessmentAnswers, assessmentCycles, assessmentForms, assessmentItems, assessmentTasks, competencies, competencyAssessments, criteria, criteriaGroups,
  locations, scaleLevels, scales, userPlacements, users,
} from '../db/schema'
import type { Audience } from '../../shared/schemas/assignments'
import type { AssessmentFormInput, CriteriaGroupInput, CriterionInput } from '../../shared/schemas/assessment'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import { resolveAudience } from './audience'
import { enqueueNotification } from './notifications'

interface Ctx { tenantId: string, actorId: string }

/** Шкала уровней (scales.kind=levels) в виде, удобном для подсчёта: значения и подписи. */
export interface ScaleOption { value: number, label: string }
export interface ScaleInfo { id: string, name: string, options: ScaleOption[], min: number, max: number }

export async function loadScale(tx: TenantTx, scaleId: string): Promise<ScaleInfo | null> {
  const [s] = await tx.select({ id: scales.id, name: scales.name }).from(scales).where(eq(scales.id, scaleId))
  if (!s) return null
  const levels = await tx.select({ label: scaleLevels.label, value: scaleLevels.value }).from(scaleLevels).where(eq(scaleLevels.scaleId, scaleId)).orderBy(asc(scaleLevels.sortOrder))
  const options = levels.filter(l => l.value != null).map(l => ({ value: Number(l.value), label: l.label }))
  const values = options.map(o => o.value)
  return { id: s.id, name: s.name, options, min: values.length ? Math.min(...values) : 0, max: values.length ? Math.max(...values) : 1 }
}

// ── Словарь: группы и критерии (docs/20 §3.2, §14.6) ─────────────────────

export async function listGroups(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const groups = await tx.select().from(criteriaGroups).orderBy(asc(criteriaGroups.sort), asc(criteriaGroups.name))
    const items = await tx.select().from(criteria).orderBy(asc(criteria.sort), asc(criteria.createdAt))
    // «Де використовуються» (мокап CriteriaGroups): в анкетах, в чек-листах
    const inForms = new Map((await tx.select({ id: assessmentItems.criterionId, n: sql<number>`count(distinct ${assessmentItems.formId})::int` }).from(assessmentItems).groupBy(assessmentItems.criterionId)).map(r => [r.id, r.n]))
    const inChecklists = new Map((await tx.execute(sql`select (i->>'criterionId')::uuid as id, count(distinct c.id)::int as n from checklists c, jsonb_array_elements(c.items) i where i->>'criterionId' is not null group by 1`) as unknown as { id: string, n: number }[]).map(r => [r.id, r.n]))
    return groups.map(g => ({
      ...g,
      criteria: items.filter(c => c.groupId === g.id).map(c => ({ ...c, usedInForms: inForms.get(c.id) ?? 0, usedInChecklists: inChecklists.get(c.id) ?? 0 })),
    }))
  })
}

/** Сводка библиотеки: «В анкетах оцінки N · В чек-листах N · Прив'язано до компетенцій N». */
export async function libraryUsage(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.execute(sql`
      select (select count(distinct form_id)::int from assessment_items) as forms,
             (select count(distinct c.id)::int from checklists c, jsonb_array_elements(c.items) i where i->>'criterionId' is not null) as checklists,
             (select count(*)::int from criteria where competency_id is not null) as competencies`) as unknown as { forms: number, checklists: number, competencies: number }[]
    return r!
  })
}

export async function upsertGroup(ctx: Ctx, input: CriteriaGroupInput) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const values = { name: input.name, description: input.description ?? null, sort: input.sort ?? 0, weight: String(input.weight ?? 1), tags: input.tags ?? [] }
    if (input.id) {
      const [r] = await tx.update(criteriaGroups).set({ ...values, updatedAt: new Date() }).where(eq(criteriaGroups.id, input.id)).returning()
      return r ?? null
    }
    const [r] = await tx.insert(criteriaGroups).values({ tenantId: ctx.tenantId, ...values }).returning()
    return r!
  })
}

export async function upsertCriterion(ctx: Ctx, input: CriterionInput) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const values = {
      groupId: input.groupId, text: input.text, description: input.description ?? null, weight: String(input.weight ?? 1),
      isCritical: input.isCritical ?? false, competencyId: input.competencyId ?? null, requiresPhoto: input.requiresPhoto ?? false, sort: input.sort ?? 0,
    }
    if (input.id) {
      const [r] = await tx.update(criteria).set({ ...values, updatedAt: new Date() }).where(eq(criteria.id, input.id)).returning()
      return r ?? null
    }
    const [r] = await tx.insert(criteria).values({ tenantId: ctx.tenantId, ...values }).returning()
    return r!
  })
}

export type DeleteCriterionResult = { ok: true } | { ok: false, code: 'not_found' | 'in_use', forms?: number }

/** Критерий, который уже стоит в замороженной анкете, удалить нельзя — состав заморожен (docs/20 §14.4). */
export async function deleteCriterion(ctx: Ctx, id: string): Promise<DeleteCriterionResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const locked = await tx.select({ id: assessmentItems.formId }).from(assessmentItems).innerJoin(assessmentForms, eq(assessmentForms.id, assessmentItems.formId))
      .where(and(eq(assessmentItems.criterionId, id), eq(assessmentForms.isLocked, true)))
    if (locked.length) return { ok: false as const, code: 'in_use' as const, forms: locked.length }
    const [r] = await tx.delete(criteria).where(eq(criteria.id, id)).returning({ id: criteria.id })
    return r ? { ok: true as const } : { ok: false as const, code: 'not_found' as const }
  })
}

// ── Анкеты (docs/20 §14.2, §14.4) ─────────────────────────────────────────

/** Роли оценщиков по умолчанию (docs/20 Г-20.1): вес и анонимность — свойство роли (Г-20.2). */
export const RATER_ROLE_DEFAULTS = [
  { kind: 'manager', weight: 2, anonymous: false },
  { kind: 'self', weight: 0, anonymous: false },
  { kind: 'peer', weight: 1, anonymous: true },
  { kind: 'subordinate', weight: 1, anonymous: true },
  { kind: 'mentor', weight: 1, anonymous: false },
] as const

export async function listForms(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.execute(sql`
      select f.id, f.title, f.kind, f.is_active, f.is_locked, f.tags, f.updated_at, f.created_at, s.name as scale_name,
             (select count(*)::int from assessment_items i where i.form_id = f.id) as criteria_count,
             (select count(*)::int from assessment_cycles c where c.form_id = f.id) as cycles_count
      from assessment_forms f join scales s on s.id = f.scale_id
      order by f.updated_at desc limit 500`) as unknown as Promise<Record<string, unknown>[]>
  })
}

export async function getForm(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [f] = await tx.select().from(assessmentForms).where(eq(assessmentForms.id, id))
    if (!f) return null
    const items = await tx.select({ criterionId: assessmentItems.criterionId, norm: assessmentItems.norm, cluster: assessmentItems.cluster, sortOrder: assessmentItems.sortOrder, text: criteria.text, groupId: criteria.groupId, groupName: criteriaGroups.name })
      .from(assessmentItems).innerJoin(criteria, eq(criteria.id, assessmentItems.criterionId)).innerJoin(criteriaGroups, eq(criteriaGroups.id, criteria.groupId))
      .where(eq(assessmentItems.formId, id)).orderBy(asc(assessmentItems.sortOrder))
    const scale = await loadScale(tx, f.scaleId)
    return { ...f, scale, items: items.map(i => ({ ...i, norm: Number(i.norm) })), raterRoles: RATER_ROLE_DEFAULTS }
  })
}

export type FormSaveResult = { ok: true, form: typeof assessmentForms.$inferSelect } | { ok: false, code: 'not_found' | 'locked' | 'bad_scale' | 'bad_norm', fields?: string[], max?: number }

/** Что из замороженной анкеты пытались изменить (docs/20 §14.4): шкала, состав критериев, нормы, тип, правила комментирования. */
function frozenDiff(before: typeof assessmentForms.$inferSelect, beforeItems: { criterionId: string, norm: string, cluster: string | null }[], input: AssessmentFormInput): string[] {
  const changed: string[] = []
  if (before.kind !== input.kind) changed.push('kind')
  if (before.scaleId !== input.scaleId) changed.push('scaleId')
  for (const k of ['allowCommentGroups', 'commentGroupsRequired', 'commentWhenAboveNorm', 'commentWhenBelowNorm', 'commentWhenEqual', 'zeroMeansNoGrade'] as const) if (before[k] !== input[k]) changed.push(k)
  const was = new Map(beforeItems.map(i => [i.criterionId, i]))
  if (was.size !== input.items.length || input.items.some(i => !was.has(i.criterionId))) changed.push('items')
  else if (input.items.some(i => Number(was.get(i.criterionId)!.norm) !== i.norm)) changed.push('norms')
  return changed
}

export async function saveForm(ctx: Ctx, input: AssessmentFormInput): Promise<FormSaveResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const scale = await loadScale(tx, input.scaleId)
    if (!scale || !scale.options.length) return { ok: false as const, code: 'bad_scale' as const }
    const badNorm = input.items.filter(i => i.norm < scale.min || i.norm > scale.max)
    if (badNorm.length) return { ok: false as const, code: 'bad_norm' as const, fields: badNorm.map(i => i.criterionId), max: scale.max }
    const params = {
      kind: input.kind, scaleId: input.scaleId, allowCommentGroups: input.allowCommentGroups, commentGroupsRequired: input.commentGroupsRequired,
      commentWhenAboveNorm: input.commentWhenAboveNorm, commentWhenBelowNorm: input.commentWhenBelowNorm, commentWhenEqual: input.commentWhenEqual, zeroMeansNoGrade: input.zeroMeansNoGrade,
    }
    const card = { title: input.title, description: input.description ?? null, instruction: input.instruction ?? [], tags: input.tags, isActive: input.isActive }
    if (input.id) {
      const [before] = await tx.select().from(assessmentForms).where(eq(assessmentForms.id, input.id))
      if (!before) return { ok: false as const, code: 'not_found' as const }
      const beforeItems = await tx.select({ criterionId: assessmentItems.criterionId, norm: assessmentItems.norm, cluster: assessmentItems.cluster }).from(assessmentItems).where(eq(assessmentItems.formId, input.id))
      if (before.isLocked) {
        const changed = frozenDiff(before, beforeItems, input)
        if (changed.length) return { ok: false as const, code: 'locked' as const, fields: changed }
        const [f] = await tx.update(assessmentForms).set({ ...card, updatedAt: new Date() }).where(eq(assessmentForms.id, input.id)).returning()
        await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'assessment.form.update', entity: 'assessment_form', entityId: input.id, before: { title: before.title }, after: { title: input.title, locked: true } })
        return { ok: true as const, form: f! }
      }
      const [f] = await tx.update(assessmentForms).set({ ...card, ...params, updatedAt: new Date() }).where(eq(assessmentForms.id, input.id)).returning()
      await tx.delete(assessmentItems).where(eq(assessmentItems.formId, input.id))
      await tx.insert(assessmentItems).values(input.items.map((i, idx) => ({ tenantId: ctx.tenantId, formId: input.id!, criterionId: i.criterionId, norm: String(i.norm), cluster: i.cluster ?? null, sortOrder: idx })))
      await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'assessment.form.update', entity: 'assessment_form', entityId: input.id, before: { title: before.title, kind: before.kind, scaleId: before.scaleId, items: beforeItems.length }, after: { title: input.title, kind: input.kind, scaleId: input.scaleId, items: input.items.length } })
      return { ok: true as const, form: f! }
    }
    const [f] = await tx.insert(assessmentForms).values({ tenantId: ctx.tenantId, ...card, ...params }).returning()
    await tx.insert(assessmentItems).values(input.items.map((i, idx) => ({ tenantId: ctx.tenantId, formId: f!.id, criterionId: i.criterionId, norm: String(i.norm), cluster: i.cluster ?? null, sortOrder: idx })))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'assessment.form.create', entity: 'assessment_form', entityId: f!.id, after: { title: input.title, kind: input.kind, items: input.items.length } })
    return { ok: true as const, form: f! }
  })
}

/** Заморозка при первом заполнении (docs/20 §14.4): дальше шкала, состав и нормы не меняются. */
export async function lockForm(tx: TenantTx, tenantId: string, formId: string, actorId: string | null) {
  const [r] = await tx.update(assessmentForms).set({ isLocked: true, updatedAt: new Date() }).where(and(eq(assessmentForms.id, formId), eq(assessmentForms.isLocked, false))).returning({ id: assessmentForms.id })
  if (r) await recordAudit(tx, { tenantId, actorId, action: 'assessment.form.lock', entity: 'assessment_form', entityId: formId, after: { isLocked: true } })
}

export interface FormCriterion { id: string, text: string, description: string | null, weight: number, isCritical: boolean, competencyId: string | null, norm: number, cluster: string | null }
export interface FormGroup { id: string, name: string, description: string | null, weight: number, criteria: FormCriterion[] }
export interface FormStructure { form: typeof assessmentForms.$inferSelect, scale: ScaleInfo, groups: FormGroup[] }

/** Анкета в развёрнутом виде: группы (из словаря) с критериями и нормами, одна шкала — для заполнения и подсчёта. */
export async function formStructure(tx: TenantTx, formId: string): Promise<FormStructure | null> {
  const [form] = await tx.select().from(assessmentForms).where(eq(assessmentForms.id, formId))
  if (!form) return null
  const scale = await loadScale(tx, form.scaleId)
  if (!scale) return null
  const rows = await tx.select({ item: assessmentItems, crit: criteria, group: criteriaGroups })
    .from(assessmentItems).innerJoin(criteria, eq(criteria.id, assessmentItems.criterionId)).innerJoin(criteriaGroups, eq(criteriaGroups.id, criteria.groupId))
    .where(eq(assessmentItems.formId, formId)).orderBy(asc(criteriaGroups.sort), asc(assessmentItems.sortOrder))
  const groups: FormGroup[] = []
  for (const r of rows) {
    let g = groups.find(x => x.id === r.group.id)
    if (!g) { g = { id: r.group.id, name: r.group.name, description: r.group.description, weight: Number(r.group.weight), criteria: [] }; groups.push(g) }
    g.criteria.push({ id: r.crit.id, text: r.crit.text, description: r.crit.description, weight: Number(r.crit.weight), isCritical: r.crit.isCritical, competencyId: r.crit.competencyId, norm: Number(r.item.norm), cluster: r.item.cluster })
  }
  return { form, scale, groups }
}

// ── Циклы (docs/20 §3.3, §7.1) ─────────────────────────────────────────

export const RATER_KINDS = ['self', 'manager', 'peer', 'subordinate', 'mentor'] as const
export type RaterKind = typeof RATER_KINDS[number]

export async function listCycles(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.execute(sql`
      select c.id, c.title, c.status, c.period_from, c.period_to, c.starts_at, c.ends_at, c.rater_kinds, c.anonymous_for_subject, c.min_raters_to_show, c.calibration,
             f.title as form_title,
             (select count(*)::int from assessment_tasks t where t.cycle_id = c.id) as tasks_total,
             (select count(*)::int from assessment_tasks t where t.cycle_id = c.id and t.status = 'submitted') as tasks_submitted,
             (select count(distinct t.subject_user_id)::int from assessment_tasks t where t.cycle_id = c.id) as subjects_count
      from assessment_cycles c join assessment_forms f on f.id = c.form_id
      order by c.created_at desc limit 200
    `) as unknown as Promise<Record<string, unknown>[]>
  })
}

export async function createCycle(ctx: Ctx, input: {
  title: string, formId: string, periodFrom: string, periodTo: string, startsAt: string, endsAt: string, subjects: Audience,
  raterKinds: RaterKind[], peersCount?: number, peersSelection?: string, anonymousForSubject?: boolean, minRatersToShow?: number, selfFirst?: boolean, calibration?: boolean,
}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [c] = await tx.insert(assessmentCycles).values({
      tenantId: ctx.tenantId, title: input.title, formId: input.formId, periodFrom: input.periodFrom, periodTo: input.periodTo,
      startsAt: new Date(input.startsAt), endsAt: new Date(input.endsAt), subjects: input.subjects, raterKinds: input.raterKinds,
      peersCount: input.peersCount ?? null, peersSelection: input.peersSelection ?? 'auto', anonymousForSubject: input.anonymousForSubject ?? true,
      minRatersToShow: input.minRatersToShow ?? 3, selfFirst: input.selfFirst ?? false, calibration: input.calibration ?? false, createdBy: ctx.actorId,
    }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'assessment.cycle.create', entity: 'assessment_cycle', entityId: c!.id })
    return c!
  })
}

interface Placement { userId: string, locationId: string, positionId: string, managerId: string | null }

async function placementsOf(tx: TenantTx, userIds: string[]): Promise<Map<string, Placement>> {
  if (!userIds.length) return new Map()
  const rows = await tx.select({ userId: userPlacements.userId, locationId: userPlacements.locationId, positionId: userPlacements.positionId, managerId: locations.managerId })
    .from(userPlacements).innerJoin(locations, eq(locations.id, userPlacements.locationId))
    .where(and(inArray(userPlacements.userId, userIds), eq(userPlacements.isPrimary, true), sql`${userPlacements.endedAt} is null`))
  return new Map(rows.map(r => [r.userId, r]))
}

/**
 * Назначение оценщиков (docs/20 §7.1): self — сам; manager — руководитель точки;
 * peer — коллеги той же точки и позиции, случайно, не больше 5 оцениваемых на одного;
 * subordinate — люди точки, где оцениваемый руководитель; mentor — наставники точки.
 */
export async function startCycle(ctx: Ctx, cycleId: string): Promise<{ ok: true, tasks: number, subjects: number } | { ok: false, code: 'not_found' | 'bad_status' | 'no_subjects' }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [c] = await tx.select().from(assessmentCycles).where(eq(assessmentCycles.id, cycleId))
    if (!c) return { ok: false as const, code: 'not_found' as const }
    if (c.status !== 'draft') return { ok: false as const, code: 'bad_status' as const }
    const subjects = [...await resolveAudience(tx, c.subjects as Audience)]
    if (!subjects.length) return { ok: false as const, code: 'no_subjects' as const }

    const kinds = c.raterKinds as RaterKind[]
    const pl = await placementsOf(tx, subjects)
    const load = new Map<string, number>() // rater → сколько уже оценивает
    const tasks: { subjectUserId: string, raterUserId: string, raterKind: string }[] = []
    const add = (s: string, r: string, kind: string) => {
      if (tasks.some(t => t.subjectUserId === s && t.raterUserId === r)) return
      tasks.push({ subjectUserId: s, raterUserId: r, raterKind: kind })
      load.set(r, (load.get(r) ?? 0) + 1)
    }

    // Все активные люди с размещением — для peer/subordinate/mentor
    const everyone = await tx.select({ userId: userPlacements.userId, locationId: userPlacements.locationId, positionId: userPlacements.positionId, status: users.status })
      .from(userPlacements).innerJoin(users, eq(users.id, userPlacements.userId))
      .where(and(eq(userPlacements.isPrimary, true), sql`${userPlacements.endedAt} is null`, eq(users.status, 'active')))
    const mentorIds = new Set((await tx.execute(sql`select ur.user_id from user_roles ur join roles r on r.id = ur.role_id where r.code = 'mentor'`) as unknown as { user_id: string }[]).map(r => r.user_id))

    for (const s of subjects) {
      const p = pl.get(s)
      if (kinds.includes('self')) add(s, s, 'self')
      if (kinds.includes('manager') && p?.managerId && p.managerId !== s) add(s, p.managerId, 'manager')
      if (kinds.includes('peer') && p) {
        const pool = everyone.filter(e => e.userId !== s && e.locationId === p.locationId && e.positionId === p.positionId && (load.get(e.userId) ?? 0) < 5)
        for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j]!, pool[i]!] }
        for (const e of pool.slice(0, c.peersCount ?? 2)) add(s, e.userId, 'peer')
      }
      if (kinds.includes('subordinate')) {
        const managed = await tx.select({ id: locations.id }).from(locations).where(eq(locations.managerId, s))
        const locIds = new Set(managed.map(l => l.id))
        for (const e of everyone.filter(e => locIds.has(e.locationId) && e.userId !== s).slice(0, 5)) add(s, e.userId, 'subordinate')
      }
      if (kinds.includes('mentor') && p) {
        for (const e of everyone.filter(e => e.locationId === p.locationId && mentorIds.has(e.userId) && e.userId !== s)) add(s, e.userId, 'mentor')
      }
    }

    if (tasks.length) {
      await tx.insert(assessmentTasks).values(tasks.map(t => ({ tenantId: ctx.tenantId, cycleId, ...t, dueAt: c.endsAt })))
      for (const t of tasks) {
        await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: t.raterUserId, code: 'assessment_task_assigned', payload: { title: c.title, due: c.endsAt.toISOString(), kind: t.raterKind }, dedupKey: `at_assigned:${cycleId}:${t.raterUserId}` })
      }
    }
    await tx.update(assessmentCycles).set({ status: 'active', updatedAt: new Date() }).where(eq(assessmentCycles.id, cycleId))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'assessment.cycle.start', entity: 'assessment_cycle', entityId: cycleId, after: { tasks: tasks.length, subjects: subjects.length } })
    return { ok: true as const, tasks: tasks.length, subjects: subjects.length }
  })
}

export async function cycleMonitor(ctx: Ctx, cycleId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [c] = await tx.select().from(assessmentCycles).where(eq(assessmentCycles.id, cycleId))
    if (!c) return null
    const rows = await tx.execute(sql`
      select t.id, t.status, t.rater_kind, t.due_at, t.submitted_at, s.id as subject_id, s.full_name as subject_name, r.id as rater_id, r.full_name as rater_name
      from assessment_tasks t join users s on s.id = t.subject_user_id join users r on r.id = t.rater_user_id
      where t.cycle_id = ${cycleId}::uuid order by s.full_name, t.rater_kind
    `) as unknown as Record<string, unknown>[]
    return { cycle: c, tasks: rows }
  })
}

export async function remindCycle(ctx: Ctx, cycleId: string): Promise<number> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [c] = await tx.select().from(assessmentCycles).where(eq(assessmentCycles.id, cycleId))
    if (!c) return 0
    const pending = await tx.select({ raterUserId: assessmentTasks.raterUserId }).from(assessmentTasks)
      .where(and(eq(assessmentTasks.cycleId, cycleId), inArray(assessmentTasks.status, ['pending', 'in_progress'])))
    const day = new Date().toISOString().slice(0, 10)
    let n = 0
    for (const r of new Set(pending.map(p => p.raterUserId))) {
      if (await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: r, code: 'assessment_due_soon', payload: { title: c.title, due: c.endsAt.toISOString() }, dedupKey: `at_remind:${cycleId}:${r}:${day}` })) n++
    }
    return n
  })
}

// ── Задачи оценщика и ответы (docs/20 §3.4, §5.2) ───────────────────────

export async function myTasks(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rating = await tx.execute(sql`
      select t.id, t.status, t.rater_kind, t.due_at, c.id as cycle_id, c.title as cycle_title, s.full_name as subject_name, s.id as subject_id,
             (select count(*)::int from assessment_answers a where a.task_id = t.id and (a.value is not null or a.is_na)) as answered
      from assessment_tasks t join assessment_cycles c on c.id = t.cycle_id join users s on s.id = t.subject_user_id
      where t.rater_user_id = ${ctx.actorId}::uuid and c.status = 'active' order by t.due_at, s.full_name
    `) as unknown as Record<string, unknown>[]
    const rated = await tx.execute(sql`
      select c.id as cycle_id, c.title, c.status, c.ends_at,
             (select count(*)::int from assessment_tasks t where t.cycle_id = c.id and t.subject_user_id = ${ctx.actorId}::uuid) as raters,
             (select count(*)::int from assessment_tasks t where t.cycle_id = c.id and t.subject_user_id = ${ctx.actorId}::uuid and t.status = 'submitted') as submitted
      from assessment_cycles c
      where c.status in ('active', 'calibration', 'finished') and exists (select 1 from assessment_tasks t where t.cycle_id = c.id and t.subject_user_id = ${ctx.actorId}::uuid)
      order by c.created_at desc
    `) as unknown as Record<string, unknown>[]
    return { rating, rated }
  })
}

export async function getTask(ctx: Ctx, taskId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [t] = await tx.select().from(assessmentTasks).where(eq(assessmentTasks.id, taskId))
    if (!t) return null
    const [c] = await tx.select().from(assessmentCycles).where(eq(assessmentCycles.id, t.cycleId))
    const [subject] = await tx.select({ id: users.id, fullName: users.fullName }).from(users).where(eq(users.id, t.subjectUserId))
    const structure = await formStructure(tx, c!.formId)
    const answers = await tx.select().from(assessmentAnswers).where(eq(assessmentAnswers.taskId, taskId))
    // Кто увидит комментарии (docs/20 §5.2): при анонимности — руководитель; иначе и сам человек
    const commentsVisibleTo = c!.anonymousForSubject ? 'manager' : 'subject_and_manager'
    const role = RATER_ROLE_DEFAULTS.find(r => r.kind === t.raterKind)
    return {
      task: t, cycle: c!, subject, structure,
      answers: answers.map(a => ({ criterionId: a.criterionId, value: a.value != null ? Number(a.value) : null, comment: a.comment, isNa: a.isNa })),
      groupComments: t.groupComments as Record<string, string>,
      commentsVisibleTo,
      // Г-20.2: анонимность — свойство роли; порог показа — из цикла
      isAnonymous: role?.anonymous ?? false, minRatersToShow: c!.minRatersToShow,
    }
  })
}

/** Автосохранение ответов; первое сохранение замораживает анкету (docs/20 §14.4). Правила комментирования — при отправке. */
export async function saveAnswers(ctx: Ctx, taskId: string, answers: { criterionId: string, value: number | null, comment?: string | null, isNa?: boolean }[], groupComments?: Record<string, string>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [t] = await tx.select().from(assessmentTasks).where(and(eq(assessmentTasks.id, taskId), eq(assessmentTasks.raterUserId, ctx.actorId)))
    if (!t || !['pending', 'in_progress'].includes(t.status)) return null
    const [c] = await tx.select({ formId: assessmentCycles.formId }).from(assessmentCycles).where(eq(assessmentCycles.id, t.cycleId))
    const structure = await formStructure(tx, c!.formId)
    if (!structure) return null
    const known = new Set(structure.groups.flatMap(g => g.criteria.map(cr => cr.id)))
    const scaleValues = new Set(structure.scale.options.map(o => o.value))
    for (const a of answers) {
      if (!known.has(a.criterionId)) continue
      if (a.value != null && !scaleValues.has(a.value)) return { saved: 0, badValue: a.criterionId }
      await tx.insert(assessmentAnswers).values({ tenantId: ctx.tenantId, taskId, criterionId: a.criterionId, value: a.value != null ? String(a.value) : null, comment: a.comment ?? null, isNa: a.isNa ?? false })
        .onConflictDoUpdate({ target: [assessmentAnswers.taskId, assessmentAnswers.criterionId], set: { value: a.value != null ? String(a.value) : null, comment: a.comment ?? null, isNa: a.isNa ?? false, updatedAt: new Date() } })
    }
    const patch: Partial<typeof assessmentTasks.$inferInsert> = { updatedAt: new Date() }
    if (t.status === 'pending') patch.status = 'in_progress'
    if (groupComments && structure.form.allowCommentGroups) patch.groupComments = groupComments
    await tx.update(assessmentTasks).set(patch).where(eq(assessmentTasks.id, taskId))
    await lockForm(tx, ctx.tenantId, c!.formId, ctx.actorId)
    return { saved: answers.length }
  })
}

export type SubmitResult = { ok: true } | { ok: false, code: 'not_found' | 'bad_status' | 'incomplete' | 'comment_required' | 'group_comment_required', criterionIds?: string[], groupIds?: string[] }

/** Правило комментирования для оценки против нормы (docs/20 §14.2): комментарий обязателен ниже нормы, разрешён выше/при совпадении. */
export function commentRule(form: { commentWhenBelowNorm: boolean, commentWhenAboveNorm: boolean, commentWhenEqual: boolean, zeroMeansNoGrade: boolean }, value: number | null, norm: number): 'required' | 'allowed' | 'none' {
  if (value == null || (form.zeroMeansNoGrade && value === 0)) return 'none'
  if (value < norm) return form.commentWhenBelowNorm ? 'required' : 'none'
  if (value > norm) return form.commentWhenAboveNorm ? 'allowed' : 'none'
  return form.commentWhenEqual ? 'allowed' : 'none'
}

/** Отправка: все критерии отвечены (или n/a), комментарий обязателен ниже нормы (docs/20 §13.2, §14.2), комментарий к группе — по правилу. */
export async function submitTask(ctx: Ctx, taskId: string): Promise<SubmitResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [t] = await tx.select().from(assessmentTasks).where(and(eq(assessmentTasks.id, taskId), eq(assessmentTasks.raterUserId, ctx.actorId)))
    if (!t) return { ok: false as const, code: 'not_found' as const }
    if (!['pending', 'in_progress'].includes(t.status)) return { ok: false as const, code: 'bad_status' as const }
    const [c] = await tx.select().from(assessmentCycles).where(eq(assessmentCycles.id, t.cycleId))
    const structure = await formStructure(tx, c!.formId)
    if (!structure) return { ok: false as const, code: 'not_found' as const }
    const answers = new Map((await tx.select().from(assessmentAnswers).where(eq(assessmentAnswers.taskId, taskId))).map(a => [a.criterionId, a]))
    const missing: string[] = []
    const needComment: string[] = []
    const needGroupComment: string[] = []
    const groupComments = t.groupComments as Record<string, string>
    for (const g of structure.groups) {
      for (const cr of g.criteria) {
        const a = answers.get(cr.id)
        if (!a || (a.value == null && !a.isNa)) { missing.push(cr.id); continue }
        if (a.isNa) continue
        if (commentRule(structure.form, Number(a.value), cr.norm) === 'required' && !(a.comment ?? '').trim()) needComment.push(cr.id)
      }
      if (structure.form.allowCommentGroups && structure.form.commentGroupsRequired && !(groupComments[g.id] ?? '').trim()) needGroupComment.push(g.id)
    }
    if (missing.length) return { ok: false as const, code: 'incomplete' as const, criterionIds: missing }
    if (needComment.length) return { ok: false as const, code: 'comment_required' as const, criterionIds: needComment }
    if (needGroupComment.length) return { ok: false as const, code: 'group_comment_required' as const, groupIds: needGroupComment }
    await tx.update(assessmentTasks).set({ status: 'submitted', submittedAt: new Date(), updatedAt: new Date() }).where(eq(assessmentTasks.id, taskId))
    await lockForm(tx, ctx.tenantId, c!.formId, ctx.actorId)
    return { ok: true as const }
  })
}

/** Отказ коллеги («не працював з цією людиною») — назначается следующий кандидат (docs/20 §12). */
export async function declineTask(ctx: Ctx, taskId: string, reason: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [t] = await tx.select().from(assessmentTasks).where(and(eq(assessmentTasks.id, taskId), eq(assessmentTasks.raterUserId, ctx.actorId)))
    if (!t || !['pending', 'in_progress'].includes(t.status)) return null
    await tx.update(assessmentTasks).set({ status: 'declined', declineReason: reason, updatedAt: new Date() }).where(eq(assessmentTasks.id, taskId))
    let replacement: string | null = null
    if (t.raterKind === 'peer') {
      const pl = await placementsOf(tx, [t.subjectUserId])
      const p = pl.get(t.subjectUserId)
      if (p) {
        const taken = new Set((await tx.select({ r: assessmentTasks.raterUserId }).from(assessmentTasks).where(and(eq(assessmentTasks.cycleId, t.cycleId), eq(assessmentTasks.subjectUserId, t.subjectUserId)))).map(x => x.r))
        const pool = await tx.select({ userId: userPlacements.userId }).from(userPlacements).innerJoin(users, eq(users.id, userPlacements.userId))
          .where(and(eq(userPlacements.locationId, p.locationId), eq(userPlacements.positionId, p.positionId), eq(userPlacements.isPrimary, true), sql`${userPlacements.endedAt} is null`, eq(users.status, 'active')))
        const cand = pool.map(x => x.userId).filter(id => id !== t.subjectUserId && !taken.has(id))
        if (cand.length) {
          replacement = cand[Math.floor(Math.random() * cand.length)]!
          await tx.insert(assessmentTasks).values({ tenantId: ctx.tenantId, cycleId: t.cycleId, subjectUserId: t.subjectUserId, raterUserId: replacement, raterKind: 'peer', dueAt: t.dueAt })
          const [c] = await tx.select({ title: assessmentCycles.title }).from(assessmentCycles).where(eq(assessmentCycles.id, t.cycleId))
          await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: replacement, code: 'assessment_task_assigned', payload: { title: c?.title, due: t.dueAt.toISOString(), kind: 'peer' }, dedupKey: `at_assigned:${t.cycleId}:${replacement}` })
        }
      }
    }
    return { declined: true, replacement }
  })
}

// ── Подсчёт и результаты (docs/20 §7.2–7.3, §5.1) ───────────────────────

export interface GroupScore { groupId: string, name: string, weight: number, byKind: Record<string, { avg: number | null, n: number }> }

/** Средние по группам и видам оценщиков: Σ(оценка×вес)/Σ(вес), n/a вне знаменателя. */
export async function computeResults(tx: TenantTx, cycleId: string, subjectUserId: string) {
  const [c] = await tx.select().from(assessmentCycles).where(eq(assessmentCycles.id, cycleId))
  if (!c) return null
  const structure = await formStructure(tx, c.formId)
  if (!structure) return null
  const tasks = await tx.select().from(assessmentTasks).where(and(eq(assessmentTasks.cycleId, cycleId), eq(assessmentTasks.subjectUserId, subjectUserId), eq(assessmentTasks.status, 'submitted')))
  const answers = tasks.length ? await tx.select().from(assessmentAnswers).where(inArray(assessmentAnswers.taskId, tasks.map(t => t.id))) : []
  const kindOfTask = new Map(tasks.map(t => [t.id, t.raterKind]))
  const ratersByKind: Record<string, number> = {}
  for (const t of tasks) ratersByKind[t.raterKind] = (ratersByKind[t.raterKind] ?? 0) + 1
  // «Значення 0 означає відсутність оцінки» — ноль вне знаменателя, как n/a
  const counted = (a: typeof assessmentAnswers.$inferSelect) => !a.isNa && a.value != null && !(structure.form.zeroMeansNoGrade && Number(a.value) === 0)

  const groups: GroupScore[] = structure.groups.map((g) => {
    const byKind: Record<string, { avg: number | null, n: number }> = {}
    for (const kind of new Set(tasks.map(t => t.raterKind))) {
      let num = 0, den = 0
      for (const cr of g.criteria) {
        for (const a of answers.filter(a => a.criterionId === cr.id && kindOfTask.get(a.taskId) === kind && counted(a))) {
          num += Number(a.value) * cr.weight; den += cr.weight
        }
      }
      byKind[kind] = { avg: den ? Math.round((num / den) * 100) / 100 : null, n: ratersByKind[kind] ?? 0 }
    }
    return { groupId: g.id, name: g.name, weight: g.weight, byKind }
  })
  const overall: Record<string, number | null> = {}
  for (const kind of Object.keys(ratersByKind)) {
    let num = 0, den = 0
    for (const g of groups) { const v = g.byKind[kind]?.avg; if (v != null) { num += v * g.weight; den += g.weight } }
    overall[kind] = den ? Math.round((num / den) * 100) / 100 : null
  }
  // «Розрив із нормою» (Г-20.3): факт (среднее по всем оценщикам, кроме самооценки) минус норма критерия
  const criteriaGaps = structure.groups.flatMap(g => g.criteria.map((cr) => {
    const vals = answers.filter(a => a.criterionId === cr.id && kindOfTask.get(a.taskId) !== 'self' && counted(a)).map(a => Number(a.value))
    const avg = vals.length ? Math.round((vals.reduce((x, y) => x + y, 0) / vals.length) * 100) / 100 : null
    return { criterionId: cr.id, groupId: g.id, text: cr.text, norm: cr.norm, avg, gap: avg == null ? null : Math.round((avg - cr.norm) * 100) / 100 }
  }))
  // Комментарии по критериям (для отображения с учётом анонимности)
  const comments = answers.filter(a => (a.comment ?? '').trim()).map(a => ({ criterionId: a.criterionId, kind: kindOfTask.get(a.taskId)!, comment: a.comment!, taskId: a.taskId }))
  return { cycle: c, structure, groups, overall, ratersByKind, comments, criteriaGaps }
}

/** Результат для человека (docs/20 §7.2): при анонимности — без авторов; блок коллег скрыт, если их меньше порога. */
export async function resultsFor(ctx: Ctx, subjectUserId: string, cycleId: string, opts: { asManager: boolean }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const r = await computeResults(tx, cycleId, subjectUserId)
    if (!r) return null
    const isSelf = subjectUserId === ctx.actorId
    const anon = r.cycle.anonymousForSubject && isSelf
    const hiddenKinds = new Set<string>()
    for (const kind of ['peer', 'subordinate', 'mentor']) {
      if ((r.ratersByKind[kind] ?? 0) > 0 && (r.ratersByKind[kind] ?? 0) < r.cycle.minRatersToShow && !opts.asManager) hiddenKinds.add(kind)
    }
    const groups = r.groups.map(g => ({ ...g, byKind: Object.fromEntries(Object.entries(g.byKind).filter(([k]) => !hiddenKinds.has(k))) }))
    const overall = Object.fromEntries(Object.entries(r.overall).filter(([k]) => !hiddenKinds.has(k)))
    const gaps = groups.map(g => ({ groupId: g.groupId, selfVsManager: g.byKind.self?.avg != null && g.byKind.manager?.avg != null ? Math.round((g.byKind.self.avg - g.byKind.manager.avg) * 100) / 100 : null }))
    const comments = r.comments.filter(c => !hiddenKinds.has(c.kind)).map(c => anon ? { criterionId: c.criterionId, kind: c.kind, comment: c.comment } : c)
    return { cycle: { id: r.cycle.id, title: r.cycle.title, status: r.cycle.status, minRatersToShow: r.cycle.minRatersToShow, anonymousForSubject: r.cycle.anonymousForSubject }, groups, overall, gaps, ratersByKind: r.ratersByKind, hiddenKinds: [...hiddenKinds], comments, criteriaGaps: r.criteriaGaps, scale: r.structure.scale, structure: r.structure.groups.map(g => ({ id: g.id, name: g.name, criteria: g.criteria.map(c => ({ id: c.id, text: c.text, norm: c.norm })) })) }
  })
}

/** Калибровка (docs/20 §7.9): руководитель корректирует свою оценку с обязательным комментарием, всё в журнале. */
export async function calibrateAnswer(ctx: Ctx, taskId: string, criterionId: string, value: number, comment: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [t] = await tx.select().from(assessmentTasks).where(and(eq(assessmentTasks.id, taskId), eq(assessmentTasks.raterUserId, ctx.actorId), eq(assessmentTasks.raterKind, 'manager')))
    if (!t) return null
    const [c] = await tx.select({ status: assessmentCycles.status }).from(assessmentCycles).where(eq(assessmentCycles.id, t.cycleId))
    if (c?.status !== 'calibration') return null
    const [before] = await tx.select().from(assessmentAnswers).where(and(eq(assessmentAnswers.taskId, taskId), eq(assessmentAnswers.criterionId, criterionId)))
    await tx.update(assessmentAnswers).set({ value: String(value), updatedAt: new Date() }).where(and(eq(assessmentAnswers.taskId, taskId), eq(assessmentAnswers.criterionId, criterionId)))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'assessment.calibrate', entity: 'assessment_answer', entityId: before?.id ?? null, before: { value: before?.value }, after: { value, comment } })
    return { ok: true }
  })
}

/** Завершение цикла: критерии с компетенцией → оценка компетенции source=assessment (docs/20 §7.6, §13.6). */
export async function finishCycle(ctx: Ctx | { tenantId: string, actorId: null }, cycleId: string): Promise<{ ok: true, subjects: number, competencyAssessments: number } | { ok: false, code: 'not_found' | 'bad_status' }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [c] = await tx.select().from(assessmentCycles).where(eq(assessmentCycles.id, cycleId))
    if (!c) return { ok: false as const, code: 'not_found' as const }
    if (!['active', 'calibration'].includes(c.status)) return { ok: false as const, code: 'bad_status' as const }
    // Незаполненные задачи истекают
    await tx.update(assessmentTasks).set({ status: 'expired', updatedAt: new Date() }).where(and(eq(assessmentTasks.cycleId, cycleId), inArray(assessmentTasks.status, ['pending', 'in_progress'])))
    const subjects = [...new Set((await tx.select({ s: assessmentTasks.subjectUserId }).from(assessmentTasks).where(eq(assessmentTasks.cycleId, cycleId))).map(x => x.s))]
    let n = 0
    for (const s of subjects) {
      const r = await computeResults(tx, cycleId, s)
      if (!r) continue
      // Уровень компетенции — по оценке руководителя (приоритет), иначе средняя по всем; маппинг шкалы: value → round
      const managerTasks = new Set((await tx.select({ id: assessmentTasks.id }).from(assessmentTasks).where(and(eq(assessmentTasks.cycleId, cycleId), eq(assessmentTasks.subjectUserId, s), eq(assessmentTasks.status, 'submitted')))).map(t => t.id))
      const answers = managerTasks.size ? await tx.select().from(assessmentAnswers).where(inArray(assessmentAnswers.taskId, [...managerTasks])) : []
      const kindOf = new Map((await tx.select({ id: assessmentTasks.id, kind: assessmentTasks.raterKind }).from(assessmentTasks).where(eq(assessmentTasks.cycleId, cycleId))).map(t => [t.id, t.kind]))
      const compIds = [...new Set(r.structure.groups.flatMap(g => g.criteria.map(c => c.competencyId)).filter((x): x is string => !!x))]
      const compMax = new Map(compIds.length ? (await tx.select({ id: competencies.id, levels: competencies.levels }).from(competencies).where(inArray(competencies.id, compIds))).map(c => [c.id, Math.max(...(c.levels as { level: number }[]).map(l => l.level), 1)]) : [])
      for (const g of r.structure.groups) {
        for (const cr of g.criteria) {
          if (!cr.competencyId) continue
          const vals = answers.filter(a => a.criterionId === cr.id && !a.isNa && a.value != null)
          const mgr = vals.filter(a => kindOf.get(a.taskId) === 'manager')
          const use = mgr.length ? mgr : vals
          if (!use.length) continue
          const avg = use.reduce((acc, a) => acc + Number(a.value), 0) / use.length
          const { min, max } = r.structure.scale
          // Маппинг шкалы на уровни компетенции (docs/19 §3.3): доля от диапазона шкалы × число уровней
          const levelsMax = compMax.get(cr.competencyId) ?? 5
          const level = Math.max(1, Math.min(levelsMax, Math.round(((avg - min) / Math.max(max - min, 1)) * levelsMax)))
          const { defaultValidUntil } = await import('./development')
          await tx.insert(competencyAssessments).values({ tenantId: ctx.tenantId, userId: s, competencyId: cr.competencyId, level, source: 'assessment', evidenceId: cycleId, assessedBy: ctx.actorId, comment: `Цикл «${c.title}»`, validUntil: defaultValidUntil() })
          n++
        }
      }
      await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: s, code: 'assessment_results_ready', payload: { title: c.title }, dedupKey: `at_results:${cycleId}:${s}` })
    }
    await tx.update(assessmentCycles).set({ status: 'finished', finishedAt: new Date(), updatedAt: new Date() }).where(eq(assessmentCycles.id, cycleId))
    if (c.createdBy) await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: c.createdBy, code: 'assessment_cycle_finished', payload: { title: c.title, subjects: subjects.length }, dedupKey: `at_finished:${cycleId}` })
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'assessment.cycle.finish', entity: 'assessment_cycle', entityId: cycleId, after: { subjects: subjects.length, competencyAssessments: n } })
    return { ok: true as const, subjects: subjects.length, competencyAssessments: n }
  })
}

export async function toCalibration(ctx: Ctx, cycleId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.update(assessmentCycles).set({ status: 'calibration', updatedAt: new Date() }).where(and(eq(assessmentCycles.id, cycleId), eq(assessmentCycles.status, 'active'), eq(assessmentCycles.calibration, true))).returning({ id: assessmentCycles.id })
    return !!r
  })
}

export async function cancelCycle(ctx: Ctx, cycleId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.update(assessmentCycles).set({ status: 'cancelled', updatedAt: new Date() }).where(and(eq(assessmentCycles.id, cycleId), inArray(assessmentCycles.status, ['draft', 'active', 'calibration']))).returning({ id: assessmentCycles.id })
    if (r) await tx.update(assessmentTasks).set({ status: 'expired', updatedAt: new Date() }).where(and(eq(assessmentTasks.cycleId, cycleId), inArray(assessmentTasks.status, ['pending', 'in_progress'])))
    return !!r
  })
}

/** Ежедневный сканер: напоминания за 2 дня и в день срока, руководителю — о незаполненных после срока; закрытие по ends_at. */
export async function assessmentScan(tenantId: string): Promise<{ reminded: number, finished: number, escalated: number }> {
  const out = { reminded: 0, finished: 0, escalated: 0 }
  const active = await withTenant(tenantId, null, tx => tx.select().from(assessmentCycles).where(eq(assessmentCycles.status, 'active')))
  const now = Date.now()
  for (const c of active) {
    const left = Math.ceil((c.endsAt.getTime() - now) / 86_400_000)
    if (left <= 0) {
      const r = await finishCycle({ tenantId, actorId: null }, c.id)
      if (r.ok) out.finished++
      continue
    }
    if (left === 2 || left === 0) {
      out.reminded += await withTenant(tenantId, null, async (tx) => {
        const pending = await tx.select({ r: assessmentTasks.raterUserId }).from(assessmentTasks).where(and(eq(assessmentTasks.cycleId, c.id), inArray(assessmentTasks.status, ['pending', 'in_progress'])))
        let n = 0
        for (const r of new Set(pending.map(p => p.r))) {
          if (await enqueueNotification(tx, { tenantId, userId: r, code: 'assessment_due_soon', payload: { title: c.title, due: c.endsAt.toISOString() }, dedupKey: `at_due:${c.id}:${r}:${left}` })) n++
        }
        return n
      })
    }
  }
  return out
}
