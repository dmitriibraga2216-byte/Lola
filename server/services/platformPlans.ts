import { asc, eq, inArray, sql } from 'drizzle-orm'
import { auditLog, planAddons, platformAudit, plans, tenantLimits, tenants } from '../db/schema'
import { currentRequestContext } from '../utils/requestContext'
import { platformDb, type PlatformAuth } from './platform'
import { invalidateLimits } from './tenantLimits'
import { PLAN_LIMIT_FIELDS, type PlanCreateInput, type PlanLimitField, type PlanUpdateInput } from '../../shared/schemas/platformPlans'

/**
 * Каталог тарифов в консоли оператора (docs/24 §4.4.2, §9 «CRUD `/platform/plans`»; docs/v2/35 §3.1).
 *
 * Тариф — платформенная строка без `tenant_id`: правка одной строки меняет лимиты всех компаний на
 * ней, потому что `effectiveLimits()` читает `plans.max_*` вживую (docs/v2/35 §7.3). Отсюда три
 * правила (решение docs/v2/44 В-21):
 *  1. Правка и архивация тарифа, на котором есть компании, требуют причины 10–500 знаков — как вход
 *     «від імені» и смена тарифа; число компаний консоль показывает до сохранения.
 *  2. **Ослабление** лимита (больше или «без обмежень») применяется ко всем сразу. **Ужесточение**
 *     компаниям на тарифе не применяется молча: их прежний лимит закрепляется переопределением
 *     `tenant_limits` по этой оси (если своего переопределения нет) — отдельной записью в
 *     `platform_audit` и `audit_log` тенанта. Новые компании получают новый лимит.
 *  3. Ужесточить «без обмежень» до числа при компаниях на тарифе нельзя (`plan.limit_unpinnable`):
 *     «без обмежень» переопределением не выражается — `null` в `tenant_limits` значит «как в тарифе».
 *
 * Удаления нет — только архив (`is_active = false`): на `code` ссылаются `tenants.plan`, платежи и
 * заявки смены тарифа. Архивный тариф не назначается новым компаниям, действующие остаются на нём.
 * Работает только под `PLATFORM_DATABASE_URL` (BYPASSRLS), как остальная консоль.
 */

/** Тариф, которым создаётся компания без явного плана (`createTenant`) — в архив не уходит. */
export const DEFAULT_PLAN_CODE = 'trial'

/** Ось тарифа → колонка переопределения тенанта (та же раскладка, что в `tenantLimits.ts`). */
const LIMIT_COLUMN: Record<PlanLimitField, 'users' | 'storageGb' | 'smsPerMonth' | 'candidates' | 'aiGenerateOps' | 'aiReviewOps' | 'aiInterviewOps' | 'exportRows'> = {
  maxUsers: 'users',
  maxStorageGb: 'storageGb',
  maxSmsPerMonth: 'smsPerMonth',
  maxCandidates: 'candidates',
  maxAiGenerateOps: 'aiGenerateOps',
  maxAiReviewOps: 'aiReviewOps',
  maxAiInterviewOps: 'aiInterviewOps',
  maxExportRows: 'exportRows',
}

type Plan = typeof plans.$inferSelect
type Tx = Parameters<Parameters<ReturnType<typeof platformDb>['transaction']>[0]>[0]

export type PlanError =
  | { ok: false, code: 'not_found' | 'code_taken' | 'unknown_addon' | 'default_locked' | 'wrong_state' }
  | { ok: false, code: 'reason_required', companies: number }
  | { ok: false, code: 'limit_unpinnable', companies: number, fields: PlanLimitField[] }

/** Сравнение лимитов: `null` — «без обмежень», то есть больше любого числа. */
const tighter = (before: number | null, after: number | null) => after != null && (before == null || after < before)

async function audit(tx: Tx, actor: PlatformAuth, input: { action: string, tenantId?: string | null, entity: string, entityId: string, before?: unknown, after?: unknown }) {
  await tx.insert(platformAudit).values({
    adminId: actor.adminId,
    adminEmail: actor.email,
    action: input.action,
    subjectTenantId: input.tenantId ?? null,
    entity: input.entity,
    entityId: input.entityId,
    before: input.before ?? null,
    after: input.after ?? null,
    requestContext: currentRequestContext(),
  })
}

async function companiesOn(tx: Tx, code: string): Promise<string[]> {
  return (await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.plan, code))).map(r => r.id)
}

async function unknownAddons(tx: Tx, codes: string[] | undefined): Promise<boolean> {
  if (!codes?.length) return false
  const found = await tx.select({ code: planAddons.code }).from(planAddons).where(inArray(planAddons.code, codes))
  return found.length !== new Set(codes).size
}

/** Сетка тарифов с числом компаний на каждом — оператор видит, кого заденет правка. */
export async function listPlansForOperator() {
  const db = platformDb()
  const rows = await db.select().from(plans).orderBy(asc(plans.sort), asc(plans.code))
  const counts = await db.select({ plan: tenants.plan, n: sql<number>`count(*)::int` }).from(tenants).groupBy(tenants.plan)
  const byPlan = new Map(counts.map(c => [c.plan, c.n]))
  return rows.map(p => ({ ...p, companies: byPlan.get(p.code) ?? 0 }))
}

export async function createPlan(actor: PlatformAuth, input: PlanCreateInput): Promise<{ ok: true, plan: Plan } | PlanError> {
  return platformDb().transaction(async (tx) => {
    const [taken] = await tx.select({ code: plans.code }).from(plans).where(eq(plans.code, input.code))
    if (taken) return { ok: false as const, code: 'code_taken' as const }
    if (await unknownAddons(tx, input.addonsAllowed)) return { ok: false as const, code: 'unknown_addon' as const }
    const [plan] = await tx.insert(plans).values(input).returning()
    await audit(tx, actor, { action: 'plan.create', entity: 'plans', entityId: plan!.code, after: input })
    return { ok: true as const, plan: plan! }
  })
}

/**
 * Правка тарифа. Возвращает число компаний на тарифе и число компаний, которым прежний лимит
 * закреплён переопределением (правило 2 выше), — консоль показывает их в итоговом сообщении.
 */
export async function updatePlan(actor: PlatformAuth, code: string, input: PlanUpdateInput): Promise<{ ok: true, plan: Plan, companies: number, pinned: number } | PlanError> {
  const r = await platformDb().transaction(async (tx) => {
    // `for update` — две правки одного тарифа не закрепляют лимиты по устаревшему «до»
    const [before] = await tx.select().from(plans).where(eq(plans.code, code)).for('update')
    if (!before) return { ok: false as const, code: 'not_found' as const }
    const { reason, ...fields } = input
    const changed = (Object.keys(fields) as (keyof typeof fields)[])
      .filter(k => fields[k] !== undefined && JSON.stringify(fields[k]) !== JSON.stringify(before[k]))
    const companyIds = await companiesOn(tx, code)
    if (!changed.length) return { ok: true as const, plan: before, companies: companyIds.length, pinned: 0 }
    if (companyIds.length && !reason) return { ok: false as const, code: 'reason_required' as const, companies: companyIds.length }
    if (changed.includes('addonsAllowed') && await unknownAddons(tx, fields.addonsAllowed)) return { ok: false as const, code: 'unknown_addon' as const }

    const tightened = PLAN_LIMIT_FIELDS.filter(f => changed.includes(f) && tighter(before[f], fields[f] ?? null))
    if (companyIds.length) {
      const unpinnable = tightened.filter(f => before[f] == null)
      if (unpinnable.length) return { ok: false as const, code: 'limit_unpinnable' as const, companies: companyIds.length, fields: unpinnable }
    }

    let pinned = 0
    if (tightened.length && companyIds.length) {
      const own = await tx.select().from(tenantLimits).where(inArray(tenantLimits.tenantId, companyIds))
      const ownBy = new Map(own.map(o => [o.tenantId, o]))
      for (const tenantId of companyIds) {
        const row = ownBy.get(tenantId)
        const set: Partial<Record<typeof LIMIT_COLUMN[PlanLimitField], number>> = {}
        for (const f of tightened) {
          const col = LIMIT_COLUMN[f]
          if (row?.[col] == null) set[col] = before[f]!
        }
        if (!Object.keys(set).length) continue // своё переопределение по всем осям — тариф его не касается
        if (row) await tx.update(tenantLimits).set({ ...set, updatedBy: actor.adminId, updatedAt: new Date() }).where(eq(tenantLimits.tenantId, tenantId))
        else await tx.insert(tenantLimits).values({ tenantId, ...set, updatedBy: actor.adminId })
        const after = { pinned: set, plan: code, reason, cause: 'plan.update' }
        await audit(tx, actor, { action: 'tenant.limits', tenantId, entity: 'tenant_limits', entityId: tenantId, before: Object.fromEntries(Object.keys(set).map(c => [c, null])), after })
        await tx.insert(auditLog).values({ tenantId, actorId: null, action: 'tenant.limits', entity: 'tenant_limits', entityId: tenantId, after: { ...after, by: actor.email }, requestContext: currentRequestContext() })
        pinned++
      }
    }

    const set = Object.fromEntries(changed.map(k => [k, fields[k] ?? null])) as Partial<Plan>
    const [plan] = await tx.update(plans).set(set).where(eq(plans.code, code)).returning()
    await audit(tx, actor, {
      action: 'plan.update',
      entity: 'plans',
      entityId: code,
      before: Object.fromEntries(changed.map(k => [k, before[k]])),
      after: { ...set, reason: reason ?? null, companies: companyIds.length, pinned },
    })
    return { ok: true as const, plan: plan!, companies: companyIds.length, pinned }
  })
  // Кеш эффективных лимитов — на процесс и по тенанту; тариф общий, сбрасываем целиком
  if (r.ok) invalidateLimits()
  return r
}

/** «В архів» (`is_active = false`) и обратно. Компании на тарифе остаются, их лимиты не меняются. */
export async function setPlanArchived(actor: PlatformAuth, code: string, archived: boolean, reason?: string): Promise<{ ok: true, plan: Plan, companies: number } | PlanError> {
  return platformDb().transaction(async (tx) => {
    const [before] = await tx.select().from(plans).where(eq(plans.code, code)).for('update')
    if (!before) return { ok: false as const, code: 'not_found' as const }
    if (archived && code === DEFAULT_PLAN_CODE) return { ok: false as const, code: 'default_locked' as const }
    if (before.isActive !== archived) return { ok: false as const, code: 'wrong_state' as const }
    const companyIds = await companiesOn(tx, code)
    if (companyIds.length && !reason) return { ok: false as const, code: 'reason_required' as const, companies: companyIds.length }
    const [plan] = await tx.update(plans).set({ isActive: !archived }).where(eq(plans.code, code)).returning()
    await audit(tx, actor, { action: archived ? 'plan.archive' : 'plan.restore', entity: 'plans', entityId: code, before: { isActive: before.isActive }, after: { isActive: !archived, reason: reason ?? null, companies: companyIds.length } })
    return { ok: true as const, plan: plan!, companies: companyIds.length }
  })
}
