import { and, eq, inArray, sql } from 'drizzle-orm'
import type { z } from 'zod'
import { assignments, automationRules, automationRuns, learningProfiles, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import { expandAssignment } from './assignments'
import { resolveAudience } from './audience'
import { enqueueNotification } from './notifications'
import type { profileSchema, ruleSchema } from '../../shared/schemas/assignments'

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
        kind: 'profile',
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
        reminders: { enabled: true, beforeDays: [3, 1], onDueDay: true, afterDays: [1, 3, 7], channels: ['telegram'], notifyManagerAfterDays: 1, notifyOnAssign: true },
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

export async function listRules(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rules = await tx.select().from(automationRules).orderBy(automationRules.name)
    const { programsUsingRules } = await import('./programs')
    const used = await programsUsingRules(tx, rules.map(r => r.id))
    return rules.map(r => ({ ...r, usedBy: used.get(r.id) ?? [] }))
  })
}

export async function deleteRule(ctx: Ctx, id: string): Promise<{ ok: true } | { ok: false, code: 'not_found' | 'in_use', usedBy: string[] }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.select({ id: automationRules.id, name: automationRules.name }).from(automationRules).where(eq(automationRules.id, id))
    if (!r) return { ok: false as const, code: 'not_found' as const, usedBy: [] }
    const { programsUsingRules } = await import('./programs')
    const used = (await programsUsingRules(tx, [id])).get(id) ?? []
    if (used.length) return { ok: false as const, code: 'in_use' as const, usedBy: used.map(u => u.title) }
    await tx.delete(automationRules).where(eq(automationRules.id, id))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'rule.delete', entity: 'automation_rule', entityId: id, before: { name: r.name } })
    return { ok: true as const }
  })
}

export async function createRule(ctx: Ctx, input: z.infer<typeof ruleSchema>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.insert(automationRules).values({ tenantId: ctx.tenantId, ...input }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'rule.create', entity: 'automation_rule', entityId: r!.id, after: { name: input.name, trigger: input.trigger } })
    return r!
  })
}

export async function updateRule(ctx: Ctx, id: string, input: Partial<z.infer<typeof ruleSchema>>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.update(automationRules).set({ ...input, updatedAt: new Date() }).where(eq(automationRules.id, id)).returning()
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
    const people = await tx.select({ id: users.id, fullName: users.fullName }).from(users).where(eq(users.status, 'active')).orderBy(users.fullName)
    const out: { id: string, fullName: string }[] = []
    for (const p of people) if (await matchesConditions(tx, p.id, rule.conditions as Conditions)) out.push(p)
    return out
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
      if (!await matchesConditions(tx, userId, rule.conditions as Conditions, payload)) {
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
                reminders: { enabled: true, beforeDays: [3, 1], onDueDay: true, afterDays: [1, 3, 7], channels: ['telegram'], notifyManagerAfterDays: 1, notifyOnAssign: true },
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

      if (!opts.dryRun) {
        await tx.insert(automationRuns).values({ tenantId, ruleId: rule.id, userId, triggerPayload: payload, actionsResult: done, status: 'ok' }).onConflictDoNothing()
        await tx.update(automationRules).set({ lastRunAt: new Date(), stats: sql`jsonb_set(coalesce(${automationRules.stats}, '{}'), '{runs}', (coalesce(${automationRules.stats}->>'runs', '0')::int + 1)::text::jsonb)` }).where(eq(automationRules.id, rule.id))
      }
      results.push({ ruleId: rule.id, ruleName: rule.name, status: 'ok', actions: done })
    }
  })

  if (!opts.dryRun) for (const aid of toExpand) await expandAssignment(tenantId, aid)
  return results
}

/** Триггер: кто-то попал на позицию (docs/15 §7.2, §7.6) — sync + правила. */
export async function onPlacementChanged(tenantId: string, userId: string) {
  await runRules(tenantId, 'user.placement_changed', userId)
  // docs/19 §12: новая должность → пересчёт разрыва, критический разрыв — руководителю
  const { gapDetectedOnPlacement } = await import('./developmentExtra')
  await gapDetectedOnPlacement(tenantId, userId).catch(err => console.error('gapDetectedOnPlacement', err))
  const { syncAssignments } = await import('./assignments')
  await syncAssignments(tenantId)
}
