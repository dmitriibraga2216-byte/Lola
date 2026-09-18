import { and, eq, isNull, sql } from 'drizzle-orm'
import type { z } from 'zod'
import { assignments, automationRules, automationRuns, learningProfiles, userPlacements, users } from '../db/schema'
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

export type RuleTrigger = 'user.created' | 'user.activated' | 'user.placement_changed' | 'course.completed' | 'course.failed' | 'certificate.expiring' | 'assignment.overdue'

export async function listRules(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async tx => tx.select().from(automationRules).orderBy(automationRules.name))
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

type Conditions = { positionIds?: string[], locationIds?: string[], courseIds?: string[], tags?: string[] }

async function matchesConditions(tx: TenantTx, userId: string, cond: Conditions, payload: Record<string, unknown>): Promise<boolean> {
  if (cond.courseIds?.length && !cond.courseIds.includes(String(payload.courseId))) return false
  if (cond.positionIds?.length || cond.locationIds?.length) {
    const [pl] = await tx.select().from(userPlacements).where(and(eq(userPlacements.userId, userId), eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt)))
    if (!pl) return false
    if (cond.positionIds?.length && !cond.positionIds.includes(pl.positionId)) return false
    if (cond.locationIds?.length && !cond.locationIds.includes(pl.locationId)) return false
  }
  if (cond.tags?.length) {
    const [u] = await tx.select({ tags: users.tags }).from(users).where(eq(users.id, userId))
    if (!u || !cond.tags.some(t => u.tags.includes(t))) return false
  }
  return true
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
    const rules = await tx.select().from(automationRules).where(and(
      eq(automationRules.trigger, trigger),
      ...(opts.ruleId ? [eq(automationRules.id, opts.ruleId)] : [eq(automationRules.isActive, true)]),
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
  const { syncAssignments } = await import('./assignments')
  await syncAssignments(tenantId)
}
