import { and, eq, inArray, sql } from 'drizzle-orm'
import { currentRequestContext } from '../utils/requestContext'
import type { z } from 'zod'
import { assignments, automationRuleDimensions, automationRules, automationRuns, learningProfiles, tags, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import { expandAssignment } from './assignments'
import { resolveAudience } from './audience'
import { enqueueNotification } from './notifications'
import { employeeOnly } from './repo/people'
import { DEFAULT_REMINDERS } from '../../shared/schemas/assignments'
import type { RuleDimensionInput, profileSchema, ruleSchema } from '../../shared/schemas/assignments'

interface Ctx { tenantId: string, actorId: string }

// ── Профили обучения должности (docs/15 §3.5, §7.11) ──────────────────

export async function listProfiles(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async tx => tx.select().from(learningProfiles).orderBy(learningProfiles.name))
}

export async function createProfile(ctx: Ctx, input: z.infer<typeof profileSchema>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [p] = await tx.insert(learningProfiles).values({ tenantId: ctx.tenantId, ...input }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'profile.create', entity: 'learning_profile', entityId: p!.id, after: { name: input.name } })
    return p!
  })
}

export async function updateProfile(ctx: Ctx, id: string, input: Partial<z.infer<typeof profileSchema>>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [p] = await tx.update(learningProfiles).set({ ...input, updatedAt: new Date() }).where(eq(learningProfiles.id, id)).returning()
    return p ?? null
  })
}

function profileAudience(scope: { positionIds?: string[], locationIds?: string[], orgUnitIds?: string[] }) {
  const rules = []
  if (scope.positionIds?.length) rules.push({ type: 'position' as const, ids: scope.positionIds, locationIds: scope.locationIds?.length ? scope.locationIds : undefined })
  else if (scope.locationIds?.length) rules.push({ type: 'location' as const, ids: scope.locationIds })
  if (scope.orgUnitIds?.length) rules.push({ type: 'org_unit' as const, ids: scope.orgUnitIds, includeChildren: true })
  return { rules, match: 'all' as const }
}

export async function previewProfile(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [p] = await tx.select().from(learningProfiles).where(eq(learningProfiles.id, id))
    if (!p) return null
    const ids = await resolveAudience(tx, profileAudience(p.scope as { positionIds?: string[] }))
    return { count: ids.size, items: (p.items as unknown[]).length }
  })
}

/**
 * Применение профиля = автоназначение (docs/15 §7.11): на каждый item — назначение
 * kind=profile с аудиторией профиля и autoSync. Уже пройденные с действующим
 * результатом не назначаются заново (проверка в expandAssignment).
 */
export async function applyProfile(ctx: Ctx, id: string): Promise<{ assignments: number, enrolled: number } | null> {
  const created = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [p] = await tx.select().from(learningProfiles).where(eq(learningProfiles.id, id))
    if (!p || !p.isActive) return null
    const audience = profileAudience(p.scope as { positionIds?: string[] })
    const items = p.items as { subjectType: string, subjectId: string, dueDays: number, isMandatory: boolean }[]
    const ids: string[] = []
    for (const item of items) {
      const [existing] = await tx.select({ id: assignments.id }).from(assignments).where(and(
        eq(assignments.profileId, id), eq(assignments.subjectId, item.subjectId), sql`${assignments.status} <> 'archived'`,
      ))
      if (existing) {
        await tx.update(assignments).set({ audience, dueDays: item.dueDays, isMandatory: item.isMandatory, status: 'active', updatedAt: new Date() }).where(eq(assignments.id, existing.id))
        ids.push(existing.id)
        continue
      }
      const [a] = await tx.insert(assignments).values({
        tenantId: ctx.tenantId,
        title: `${p.name}: профіль`,
        kind: 'auto', // task_type: профиль — разновидность автоматического назначения; источник — profileId
        subjectType: item.subjectType,
        subjectId: item.subjectId,
        audience,
        dueMode: 'relative',
        dueDays: item.dueDays,
        isMandatory: item.isMandatory,
        autoSync: true,
        status: 'active',
        createdBy: ctx.actorId,
        profileId: id,
        reminders: DEFAULT_REMINDERS,
      }).returning({ id: assignments.id })
      ids.push(a!.id)
    }
    await tx.update(learningProfiles).set({ lastAppliedAt: new Date() }).where(eq(learningProfiles.id, id))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'profile.apply', entity: 'learning_profile', entityId: id, after: { assignments: ids.length } })
    return ids
  })
  if (!created) return null
  let enrolled = 0
  for (const aid of created) enrolled += await expandAssignment(ctx.tenantId, aid)
  return { assignments: created.length, enrolled }
}

// ── Правила автоматизации (docs/15 §3.6, §7.6–7.9) ────────────────────

export type RuleTrigger = 'user.activated' | 'user.attributes_changed' | 'user.created' | 'user.placement_changed' | 'course.completed' | 'course.failed' | 'certificate.expiring' | 'assignment.overdue'

/** «Отримали зазначені атрибути» = любое изменение размещения/меток; «вперше активовані» = первый вход. */
const TRIGGER_ALIASES: Record<string, RuleTrigger[]> = {
  'user.placement_changed': ['user.placement_changed', 'user.attributes_changed'],
  'user.tag_changed': ['user.attributes_changed'],
  'user.activated': ['user.activated'],
}

/** Измерения правила → плоские условия для matchesConditions (метки — по имени в users.tags). */
export async function dimensionsToConditions(tx: TenantTx, dims: { dimension: string, mode: string, valueIds: string[] }[]): Promise<Conditions> {
  const cond: Conditions = {}
  for (const d of dims) {
    if (d.mode === 'any' || d.valueIds.length === 0) continue
    const invert = d.mode === 'exclude'
    if (d.dimension === 'city') { cond.cityIds = d.valueIds; cond.cityInvert = invert }
    else if (d.dimension === 'position') { cond.positionIds = d.valueIds; cond.positionInvert = invert }
    else if (d.dimension === 'org_unit') { cond.orgUnitIds = d.valueIds; cond.orgUnitInvert = invert }
    else if (d.dimension === 'tag') {
      const rows = await tx.select({ name: tags.name }).from(tags).where(inArray(tags.id, d.valueIds))
      cond.tags = rows.map(r => r.name); cond.tagInvert = invert
      if (cond.tags.length === 0) cond.tags = ['\u0000'] // выбранных меток больше нет: include → никто, exclude → все
    }
  }
  return cond
}

/** Полные условия правила: четыре измерения из таблицы + прочее из conditions jsonb (courseIds, locationIds, daysBefore). */
export async function ruleConditions(tx: TenantTx, rule: { id: string, conditions: unknown }): Promise<Conditions> {
  const dims = await tx.select().from(automationRuleDimensions).where(eq(automationRuleDimensions.ruleId, rule.id))
  return { ...(rule.conditions as Conditions), ...await dimensionsToConditions(tx, dims) }
}

export async function saveDimensions(tx: TenantTx, tenantId: string, ruleId: string, dims: RuleDimensionInput[]) {
  await tx.delete(automationRuleDimensions).where(eq(automationRuleDimensions.ruleId, ruleId))
  const rows = RULE_DIMENSION_KEYS.map((dimension) => {
    const d = dims.find(x => x.dimension === dimension)
    return { tenantId, ruleId, dimension, mode: d?.mode ?? 'any', valueIds: d?.valueIds ?? [] }
  })
  await tx.insert(automationRuleDimensions).values(rows)
}
const RULE_DIMENSION_KEYS = ['city', 'position', 'org_unit', 'tag'] as const

/** Названия значений измерений — для сводки «Буде призначено» и колонки «Аудиторія». */
async function dimensionLabels(tx: TenantTx, dims: { dimension: string, valueIds: string[] }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const ids = (d: string) => dims.filter(x => x.dimension === d).flatMap(x => x.valueIds)
  const q = async (table: string, list: string[]) => {
    if (!list.length) return
    const rows = await tx.execute(sql`select id, name from ${sql.identifier(table)} where id in (${sql.join(list.map(x => sql`${x}::uuid`), sql`, `)})`) as unknown as { id: string, name: string }[]
    for (const r of rows) out.set(r.id, r.name)
  }
  await q('cities', ids('city')); await q('positions', ids('position')); await q('org_units', ids('org_unit')); await q('tags', ids('tag'))
  return out
}

export type RuleUsage = { kind: 'trajectory' | 'program' | 'assignment', id: string, title: string }

/** «Використовується для»: обратные ссылки — траектории, программы, назначения (docs/04 §4.10). */
export async function ruleUsagesTx(tx: TenantTx, ruleIds: string[]): Promise<Map<string, RuleUsage[]>> {
  const out = new Map<string, RuleUsage[]>()
  if (!ruleIds.length) return out
  const push = (ruleId: string, u: RuleUsage) => out.set(ruleId, [...(out.get(ruleId) ?? []), u])
  const { trajectoriesUsingRules } = await import('./trajectories')
  for (const [ruleId, list] of await trajectoriesUsingRules(tx, ruleIds)) for (const t of list) push(ruleId, { kind: 'trajectory', ...t })
  const { programsUsingRules } = await import('./programs')
  for (const [ruleId, list] of await programsUsingRules(tx, ruleIds)) for (const p of list) push(ruleId, { kind: 'program', ...p })
  const rows = await tx.select({ id: assignments.id, title: assignments.title, ruleId: assignments.automationRuleId }).from(assignments)
    .where(and(inArray(assignments.automationRuleId, ruleIds), sql`${assignments.status} <> 'archived'`, eq(assignments.kind, 'manual')))
  for (const a of rows) push(a.ruleId!, { kind: 'assignment', id: a.id, title: a.title })
  return out
}

export async function ruleUsages(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.select({ id: automationRules.id }).from(automationRules).where(eq(automationRules.id, id))
    if (!r) return null
    return (await ruleUsagesTx(tx, [id])).get(id) ?? []
  })
}

function serializeRule(r: typeof automationRules.$inferSelect, dims: typeof automationRuleDimensions.$inferSelect[], labels: Map<string, string>, usedBy: RuleUsage[]) {
  const dimensions = RULE_DIMENSION_KEYS.map((dimension) => {
    const d = dims.find(x => x.dimension === dimension)
    return { dimension, mode: d?.mode ?? 'any', valueIds: d?.valueIds ?? [], values: (d?.valueIds ?? []).map(id => ({ id, name: labels.get(id) ?? '?' })) }
  })
  return { ...r, dimensions, usedBy }
}

export async function listRules(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rules = await tx.select().from(automationRules).orderBy(automationRules.name)
    const dims = rules.length ? await tx.select().from(automationRuleDimensions).where(inArray(automationRuleDimensions.ruleId, rules.map(r => r.id))) : []
    const labels = await dimensionLabels(tx, dims)
    const used = await ruleUsagesTx(tx, rules.map(r => r.id))
    return rules.map(r => serializeRule(r, dims.filter(d => d.ruleId === r.id), labels, used.get(r.id) ?? []))
  })
}

export async function getRule(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.select().from(automationRules).where(eq(automationRules.id, id))
    if (!r) return null
    const dims = await tx.select().from(automationRuleDimensions).where(eq(automationRuleDimensions.ruleId, id))
    return serializeRule(r, dims, await dimensionLabels(tx, dims), (await ruleUsagesTx(tx, [id])).get(id) ?? [])
  })
}

/**
 * Правило «посада → курси за замовчуванням» (docs/v2/39 П-24.3, PR-39) правится только из
 * справочника должностей (`positionDefaults.ts`): там его аудитория пересобирается при смене
 * состава группы. Общий редактор правил его показывает, но не меняет и не удаляет — иначе
 * аудитория правила и привязка к должности разошлись бы.
 */
export class RuleBoundToPositionError extends Error {
  statusCode = 409
  data = { code: 'rule_bound_to_position', message: 'Це правило курсів за замовчуванням посади — змінюйте його в довіднику посад' }
  constructor() { super('rule_bound_to_position') }
}

export async function deleteRule(ctx: Ctx, id: string): Promise<{ ok: true } | { ok: false, code: 'not_found' | 'in_use', usedBy: string[] }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.select({ id: automationRules.id, name: automationRules.name, positionId: automationRules.positionId, positionGroupId: automationRules.positionGroupId }).from(automationRules).where(eq(automationRules.id, id))
    if (!r) return { ok: false as const, code: 'not_found' as const, usedBy: [] }
    if (r.positionId || r.positionGroupId) throw new RuleBoundToPositionError()
    const used = (await ruleUsagesTx(tx, [id])).get(id) ?? []
    if (used.length) return { ok: false as const, code: 'in_use' as const, usedBy: used.map(u => u.title) }
    await tx.delete(automationRules).where(eq(automationRules.id, id))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'rule.delete', entity: 'automation_rule', entityId: id, before: { name: r.name } })
    return { ok: true as const }
  })
}

export async function createRule(ctx: Ctx, input: z.infer<typeof ruleSchema>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const { dimensions, ...rest } = input
    const [r] = await tx.insert(automationRules).values({ tenantId: ctx.tenantId, ...rest }).returning()
    await saveDimensions(tx, ctx.tenantId, r!.id, dimensions)
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'rule.create', entity: 'automation_rule', entityId: r!.id, after: { name: input.name, trigger: input.trigger, dimensions } })
    return r!
  })
}

export async function updateRule(ctx: Ctx, id: string, input: Partial<z.infer<typeof ruleSchema>>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const { dimensions, ...rest } = input
    const [before] = await tx.select().from(automationRules).where(eq(automationRules.id, id))
    if (!before) return null
    if (before.positionId || before.positionGroupId) throw new RuleBoundToPositionError()
    const [r] = await tx.update(automationRules).set({ ...rest, updatedAt: new Date() }).where(eq(automationRules.id, id)).returning()
    if (dimensions) await saveDimensions(tx, ctx.tenantId, id, dimensions)
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'rule.update', entity: 'automation_rule', entityId: id, before: { name: before.name, isActive: before.isActive }, after: { ...rest, dimensions } })
    return r ?? null
  })
}

export async function listRuns(ctx: Ctx, ruleId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({
      id: automationRuns.id, userId: automationRuns.userId, fullName: users.fullName,
      status: automationRuns.status, actionsResult: automationRuns.actionsResult, error: automationRuns.error, createdAt: automationRuns.createdAt,
    }).from(automationRuns).leftJoin(users, eq(users.id, automationRuns.userId))
      .where(eq(automationRuns.ruleId, ruleId)).orderBy(sql`${automationRuns.createdAt} desc`).limit(200)
  })
}

export type Conditions = {
  cityIds?: string[], cityInvert?: boolean, positionIds?: string[], positionInvert?: boolean, orgUnitIds?: string[], orgUnitInvert?: boolean,
  tags?: string[], tagInvert?: boolean, locationIds?: string[], courseIds?: string[],
}

/** Группа условий эталона: пусто = «Будь-який»; invert = «Всі, окрім». */
const groupOk = (wanted: string[] | undefined, invert: boolean | undefined, actual: string[]): boolean => {
  if (!wanted?.length) return true
  const hit = wanted.some(w => actual.includes(w))
  return invert ? !hit : hit
}

export async function matchesConditions(tx: TenantTx, userId: string, cond: Conditions, payload: Record<string, unknown> = {}): Promise<boolean> {
  if (cond.courseIds?.length && !cond.courseIds.includes(String(payload.courseId))) return false
  const [row] = await tx.execute(sql`
    select u.tags, u.city_id, up.position_id, up.location_id, l.org_unit_id
    from users u
    left join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null
    left join locations l on l.id = up.location_id
    where u.id = ${userId}::uuid
  `) as unknown as { tags: string[], city_id: string | null, position_id: string | null, location_id: string | null, org_unit_id: string | null }[]
  if (!row) return false
  if (!groupOk(cond.cityIds, cond.cityInvert, row.city_id ? [row.city_id] : [])) return false
  if (!groupOk(cond.positionIds, cond.positionInvert, row.position_id ? [row.position_id] : [])) return false
  if (!groupOk(cond.orgUnitIds, cond.orgUnitInvert, row.org_unit_id ? [row.org_unit_id] : [])) return false
  if (!groupOk(cond.tags, cond.tagInvert, row.tags ?? [])) return false
  if (cond.locationIds?.length && !(row.location_id && cond.locationIds.includes(row.location_id))) return false
  return true
}

/** «Список користувачів»: кто подпадает под условия прямо сейчас (docs/15 §3.6). */
export async function ruleUsers(ctx: Ctx, ruleId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [rule] = await tx.select().from(automationRules).where(eq(automationRules.id, ruleId))
    if (!rule) return null
    return peopleMatching(tx, await ruleConditions(tx, rule))
  })
}

async function peopleMatching(tx: TenantTx, cond: Conditions) {
  // Автоматизация работает по штату: кандидату обучение выдаётся своим сценарием (П-16.1)
  const people = await tx.select({ id: users.id, fullName: users.fullName }).from(users).where(employeeOnly(eq(users.status, 'active'))).orderBy(users.fullName)
  const out: { id: string, fullName: string }[] = []
  for (const p of people) if (await matchesConditions(tx, p.id, cond)) out.push(p)
  return out
}

/** «Буде призначено: N людей на зараз» — без побочных эффектов; по сохранённому правилу или по измерениям формы. */
export async function previewRule(ctx: Ctx, input: { ruleId: string } | { dimensions: RuleDimensionInput[] }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    let cond: Conditions
    if ('ruleId' in input) {
      const [rule] = await tx.select().from(automationRules).where(eq(automationRules.id, input.ruleId))
      if (!rule) return null
      cond = await ruleConditions(tx, rule)
    }
    else cond = await dimensionsToConditions(tx, input.dimensions)
    const people = await peopleMatching(tx, cond)
    return { count: people.length, people }
  })
}

/** «Виконати вручну»: разовый запуск правила по всем подходящим людям. */
export async function runRuleManually(ctx: Ctx, ruleId: string, opts: { dryRun?: boolean } = {}) {
  const people = await ruleUsers(ctx, ruleId)
  if (!people) return null
  const [rule] = await withTenant(ctx.tenantId, ctx.actorId, tx => tx.select().from(automationRules).where(eq(automationRules.id, ruleId)))
  const results: { userId: string, fullName: string, status: string, actions: unknown[] }[] = []
  for (const p of people) {
    const r = await runRules(ctx.tenantId, rule!.trigger as RuleTrigger, p.id, { manual: true }, { dryRun: opts.dryRun, ruleId })
    results.push({ userId: p.id, fullName: p.fullName, status: r[0]?.status ?? 'skipped', actions: r[0]?.actions ?? [] })
  }
  return { rule: rule!, total: people.length, ran: results.filter(r => r.status === 'ok').length, results }
}

type Action
  = | { type: 'assign_content', subjectType: string, subjectId: string, dueDays: number }
    | { type: 'notify_user', code: string, text: string }
    | { type: 'notify_manager', text: string }
    | { type: 'add_tag', tag: string }
    | { type: 'remove_tag', tag: string }

/**
 * Запуск правил по событию (docs/15 §7.6–7.8). dryRun — тестовый запуск:
 * показывает, что произошло бы, без записи. oncePerUser — через unique в automation_runs.
 */
export async function runRules(tenantId: string, trigger: RuleTrigger, userId: string, payload: Record<string, unknown> = {}, opts: { dryRun?: boolean, ruleId?: string } = {}) {
  const results: { ruleId: string, ruleName: string, status: string, actions: unknown[] }[] = []
  const toExpand: string[] = []
  const toStart: string[] = []

  await withTenant(tenantId, null, async (tx) => {
    const triggers = [...new Set([trigger, ...(TRIGGER_ALIASES[trigger] ?? [])])]
    const rules = await tx.select().from(automationRules).where(and(
      opts.ruleId ? eq(automationRules.id, opts.ruleId) : inArray(automationRules.trigger, triggers),
      ...(opts.ruleId ? [] : [eq(automationRules.isActive, true)]),
    ))

    for (const rule of rules) {
      const runLimit = rule.runLimit as { oncePerUser?: boolean }
      if (runLimit.oncePerUser !== false && !opts.dryRun) {
        const [done] = await tx.select({ id: automationRuns.id }).from(automationRuns).where(and(eq(automationRuns.ruleId, rule.id), eq(automationRuns.userId, userId)))
        if (done) { results.push({ ruleId: rule.id, ruleName: rule.name, status: 'skipped:once_per_user', actions: [] }); continue }
      }
      if (!await matchesConditions(tx, userId, await ruleConditions(tx, rule), payload)) {
        results.push({ ruleId: rule.id, ruleName: rule.name, status: 'skipped:conditions', actions: [] })
        continue
      }

      const done: unknown[] = []
      for (const action of rule.actions as Action[]) {
        switch (action.type) {
          case 'assign_content': {
            if (opts.dryRun) { done.push({ type: action.type, subjectId: action.subjectId, wouldAssign: true }); break }
            // Одно назначение kind=auto на правило+курс, аудитория user растёт по срабатываниям
            const [existing] = await tx.select().from(assignments).where(and(
              eq(assignments.kind, 'auto'), eq(assignments.subjectId, action.subjectId), sql`${assignments.audience}->>'ruleId' = ${rule.id}`, sql`${assignments.status} <> 'archived'`,
            ))
            let aid: string
            if (existing) {
              const aud = existing.audience as { rules: { type: string, ids: string[] }[], ruleId: string }
              const userRule = aud.rules.find(r => r.type === 'user')
              if (userRule && !userRule.ids.includes(userId)) userRule.ids.push(userId)
              await tx.update(assignments).set({ audience: aud, updatedAt: new Date() }).where(eq(assignments.id, existing.id))
              aid = existing.id
            }
            else {
              const [a] = await tx.insert(assignments).values({
                tenantId, title: `${rule.name}: автоматично`, kind: 'auto', subjectType: action.subjectType, subjectId: action.subjectId,
                audience: { rules: [{ type: 'user', ids: [userId] }], match: 'any', ruleId: rule.id },
                startsAt: rule.assignDelayDays ? new Date(Date.now() + rule.assignDelayDays * 86_400_000) : new Date(),
                dueMode: 'relative', dueDays: action.dueDays, isMandatory: true, autoSync: true, status: 'active', createdBy: null,
                reminders: DEFAULT_REMINDERS,
                automationRuleId: rule.id, onLeaveCondition: rule.onLeaveCondition, // Г-15.2: поведение при выходе из-под условия наследуется от правила
              }).returning({ id: assignments.id })
              aid = a!.id
            }
            toExpand.push(aid)
            done.push({ type: action.type, assignmentId: aid })
            break
          }
          case 'notify_user':
            if (!opts.dryRun) await enqueueNotification(tx, { tenantId, userId, code: action.code || 'automation', payload: { text: action.text }, dedupKey: `rule:${rule.id}:${userId}:notify` })
            done.push({ type: action.type })
            break
          case 'add_tag':
          case 'remove_tag': {
            if (opts.dryRun) { done.push({ type: action.type, tag: action.tag }); break }
            const [u] = await tx.select({ tags: users.tags }).from(users).where(eq(users.id, userId))
            const next = action.type === 'add_tag' ? [...new Set([...(u?.tags ?? []), action.tag])] : (u?.tags ?? []).filter(t => t !== action.tag)
            await tx.update(users).set({ tags: next }).where(eq(users.id, userId))
            done.push({ type: action.type, tag: action.tag })
            break
          }
          case 'notify_manager':
            done.push({ type: action.type, note: 'через дайджест' })
            break
        }
      }

      // Программы/траектории с режимом automation, привязанные к правилу (docs/17 §3.4, §7.8)
      const { assignProgramsForRule } = await import('./programs')
      for (const r of await assignProgramsForRule(tx, tenantId, rule.id, userId, { dryRun: !!opts.dryRun, delayDays: rule.assignDelayDays })) done.push(r)
      // Траектории с assign_mode=automation (docs/17 §14.1): узлы выдаются по мере прохождения
      const { assignTrajectoriesForRule } = await import('./trajectories')
      for (const r of await assignTrajectoriesForRule(tx, tenantId, rule.id, userId, { dryRun: !!opts.dryRun, delayDays: rule.assignDelayDays })) { done.push(r); if (r.enrollmentId && r.started) toStart.push(r.enrollmentId) }

      if (!opts.dryRun) {
        await tx.insert(automationRuns).values({ tenantId, ruleId: rule.id, userId, triggerPayload: payload, actionsResult: done, status: 'ok', requestContext: currentRequestContext() }).onConflictDoNothing()
        await tx.update(automationRules).set({ lastRunAt: new Date(), stats: sql`jsonb_set(coalesce(${automationRules.stats}, '{}'), '{runs}', (coalesce(${automationRules.stats}->>'runs', '0')::int + 1)::text::jsonb)` }).where(eq(automationRules.id, rule.id))
      }
      results.push({ ruleId: rule.id, ruleName: rule.name, status: 'ok', actions: done })
    }
  })

  if (!opts.dryRun) for (const aid of toExpand) await expandAssignment(tenantId, aid)
  if (!opts.dryRun && toStart.length) {
    const { startEnrollment } = await import('./trajectories')
    for (const eid of toStart) await startEnrollment(tenantId, eid).catch(err => console.error('trajectory.start', err))
  }
  return results
}

/** Триггер: кто-то попал на позицию (docs/15 §7.2, §7.6) — sync + правила. */
export async function onPlacementChanged(tenantId: string, userId: string) {
  await runRules(tenantId, 'user.placement_changed', userId)
  // docs/16 §14.1: группы «з оргструктури» пересобираются при смене размещения
  const { rebuildOrgGroups } = await import('./groups')
  await rebuildOrgGroups(tenantId).catch(err => console.error('rebuildOrgGroups', err))
  // docs/19 §12: новая должность → пересчёт разрыва, критический разрыв — руководителю
  const { gapDetectedOnPlacement } = await import('./developmentExtra')
  await gapDetectedOnPlacement(tenantId, userId).catch(err => console.error('gapDetectedOnPlacement', err))
  const { syncAssignments } = await import('./assignments')
  await syncAssignments(tenantId)
}
