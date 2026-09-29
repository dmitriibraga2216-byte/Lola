import { and, desc, eq, inArray, lte, or, sql, gte, isNull } from 'drizzle-orm'
import { db } from '../db/client'
import { planChangeRequests, planPrices, plans, tenantLimits, tenants } from '../db/schema'
import { withTenant, type TenantTx } from '../utils/withTenant'
import type { PlanChangeBlocker, PlanChangeInput, PlanChangePreflightInput } from '../../shared/schemas/billing'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import { billingRecipients } from './limitNotices'
import { effectiveLimits, invalidateLimits, planLimitOf, projectedLimits } from './tenantLimits'
import { billingWindow, measureLive } from './usageCounters'
import { addDays, todayIn } from './subscriptionStatus'

/**
 * Смена тарифа владельцем (docs/v2/35-billing-limits.md §5.2, §6.1, §7.6, §10, критерий §13 к. 7).
 *
 * **Вниз** — заявка `plan_change_requests`: предпросмотр считает превышения по каждой оси
 * (`current` против нового `effective`, §7.6 п. 1); есть превышения — `blocked`, и владелец видит,
 * что сделать («заблокуйте 17 співробітників»), нет — переход назначается `scheduled` **с первого
 * дня следующего оплаченного периода** (§7.6 п. 2) и применяется задачей `billing.plan_change_apply`.
 * «Перерахувати» — повторный предпросмотр той же заявки: превышения ушли — `blocked → preflight`.
 *
 * **Вверх** — не самообслуживание: переход вверх применяется сразу с доплатой (§7.6 п. 4), а
 * платёжного провайдера нет — оплату и смену тарифа проводит оператор в консоли (решение
 * владельца по вопросу 17, `docs/v2/44` В-21; `changeTenantPlan`). Ручка отвечает `422
 * plan_change.upgrade_manual`, экран показывает подсказку обратиться к менеджеру.
 *
 * Превышения считаются только по осям, у которых **тариф задаёт лимит** и факт моментальный:
 * `users_active`, `candidates_active`, `storage_bytes` (§7.1, три примера §7.6 п. 3). Счётчики
 * периода (ИИ, SMS, выгрузки) обнуляются с новым периодом, с которого и действует переход;
 * `integrations_active` и частота API в тарифе не заданы (`AXIS_PLAN_COLUMN`), переход вниз их
 * не меняет. Лимит «после перехода» — та же формула §7.3 (`projectedLimits`) с теми же
 * переопределениями оператора и доплатами (§7.8 п. 1): второй формулы нет.
 *
 * Порядок тиров — `plans.tier`, при равном тире — `plans.sort` (§3.1: «карточки тиров по `sort`»).
 */

const BLOCKER_AXES = ['users_active', 'candidates_active', 'storage_bytes'] as const

/** Заблокированная заявка живёт 30 дней, затем `cancelled` (§7.6 п. 4). */
export const BLOCKED_TTL_DAYS = 30

type PlanRow = typeof plans.$inferSelect
export type PlanDirection = 'current' | 'up' | 'down'

export function directionOf(from: Pick<PlanRow, 'tier' | 'sort' | 'code'> | undefined, to: Pick<PlanRow, 'tier' | 'sort' | 'code'>): PlanDirection {
  if (!from || from.code === to.code) return from ? 'current' : 'up'
  if (to.tier !== from.tier) return to.tier < from.tier ? 'down' : 'up'
  if (to.sort !== from.sort) return to.sort < from.sort ? 'down' : 'up'
  return 'up'
}

/** Превышения по осям: факт против лимита после перехода (§7.6 п. 1). Пустой массив — переход возможен. */
export function blockersOf(current: Partial<Record<PlanChangeBlocker['axis'], number>>, limits: Partial<Record<PlanChangeBlocker['axis'], number | null>>): PlanChangeBlocker[] {
  const out: PlanChangeBlocker[] = []
  for (const axis of BLOCKER_AXES) {
    const limit = limits[axis]
    const used = current[axis] ?? 0
    if (limit != null && used > limit) out.push({ axis, current: used, newLimit: limit, excess: used - limit })
  }
  return out
}

/** Текущий факт по осям превышений — моментальным пересчётом, как у проверки при операции (§7.5). */
async function currentUsage(tenantId: string): Promise<Record<PlanChangeBlocker['axis'], number>> {
  const out = {} as Record<PlanChangeBlocker['axis'], number>
  for (const axis of BLOCKER_AXES) out[axis] = await measureLive(tenantId, axis)
  return out
}

async function computeBlockers(tenantId: string, planCode: string, usage?: Record<PlanChangeBlocker['axis'], number>): Promise<PlanChangeBlocker[] | null> {
  const limits = await projectedLimits(tenantId, planCode)
  if (!limits) return null
  return blockersOf(usage ?? await currentUsage(tenantId), limits)
}

/** Первый день следующего оплаченного периода (§7.6 п. 2): конец окна, содержащего сегодня, плюс день. */
export async function nextPeriodStart(tenantId: string, today?: string): Promise<string> {
  const { subscription } = await effectiveLimits(tenantId)
  const at = today ? new Date(`${today}T00:00:00Z`) : new Date()
  return addDays(billingWindow(subscription, at).end, 1)
}

/** Тарифы, из которых можно выбирать: действующие на сегодня (`is_active`, `valid_from`/`valid_to`). */
async function catalogPlans(): Promise<PlanRow[]> {
  return db.select().from(plans).where(and(
    eq(plans.isActive, true),
    lte(plans.validFrom, sql`current_date`),
    or(isNull(plans.validTo), gte(plans.validTo, sql`current_date`)),
  )).orderBy(plans.tier, plans.sort)
}

async function tenantPlan(tenantId: string): Promise<PlanRow | undefined> {
  const [t] = await db.select({ plan: tenants.plan }).from(tenants).where(eq(tenants.id, tenantId))
  if (!t) return undefined
  const [p] = await db.select().from(plans).where(eq(plans.code, t.plan))
  return p
}

// ── Каталог (§5.2) ───────────────────────────────────────────────────────────────────────

export interface PlanCard {
  code: string
  name: string
  titleUk: string | null
  tier: number
  direction: PlanDirection
  /** Цена за месяц при помесячной и при годовой оплате — только владельцу (§2). */
  prices: { month: number | null, year: number | null } | null
  /** «Економія N %» годовой оплаты против помесячной. */
  annualSavingPct: number | null
  limits: { users: number | null, candidates: number | null, storageBytes: number | null, aiGenerateOps: number | null, aiReviewOps: number | null, aiInterviewOps: number | null }
  /** Превышения при переходе на этот тариф — только для тиров ниже текущего. */
  blockers: PlanChangeBlocker[]
}

export interface PlanRequestView {
  id: string
  toPlanCode: string
  billingPeriod: 'month' | 'year'
  status: 'preflight' | 'blocked' | 'scheduled' | 'applied' | 'cancelled'
  blockers: PlanChangeBlocker[]
  effectiveAt: string | null
}

export interface PlanCatalog {
  currentPlanCode: string
  billingPeriod: 'month' | 'year'
  currency: string
  /** Дата, с которой применится переход вниз (§7.6 п. 2). */
  nextPeriodStart: string
  plans: PlanCard[]
  /** Открытая или назначенная заявка — для строки «Тариф зміниться DD.MM.YYYY». */
  request: PlanRequestView | null
}

type BlockerJson = { axis: PlanChangeBlocker['axis'], current: number, new_limit: number, excess: number }
const toJson = (b: PlanChangeBlocker[]): BlockerJson[] => b.map(x => ({ axis: x.axis, current: x.current, new_limit: x.newLimit, excess: x.excess }))
const fromJson = (b: unknown): PlanChangeBlocker[] => (Array.isArray(b) ? b as BlockerJson[] : []).map(x => ({ axis: x.axis, current: Number(x.current), newLimit: Number(x.new_limit), excess: Number(x.excess) }))

function requestView(r: typeof planChangeRequests.$inferSelect): PlanRequestView {
  return {
    id: r.id,
    toPlanCode: r.toPlanCode,
    billingPeriod: r.billingPeriod as 'month' | 'year',
    status: r.status as PlanRequestView['status'],
    blockers: fromJson(r.blockers),
    effectiveAt: r.effectiveAt,
  }
}

async function openRequest(tx: TenantTx, tenantId: string, statuses: string[]) {
  const [r] = await tx.select().from(planChangeRequests)
    .where(and(eq(planChangeRequests.tenantId, tenantId), inArray(planChangeRequests.status, statuses)))
    .orderBy(desc(planChangeRequests.createdAt)).limit(1)
  return r
}

export async function planCatalog(tenantId: string, withPrice: boolean): Promise<PlanCatalog> {
  const current = await tenantPlan(tenantId)
  const eff = await effectiveLimits(tenantId)
  const currency = eff.subscription.currency
  const list = await catalogPlans()
  const usage = await currentUsage(tenantId)

  const priceRows = withPrice && list.length
    ? await db.select().from(planPrices).where(and(
        inArray(planPrices.planCode, list.map(p => p.code)),
        eq(planPrices.currency, currency),
        lte(planPrices.validFrom, sql`current_date`),
        or(isNull(planPrices.validTo), gte(planPrices.validTo, sql`current_date`)),
      )).orderBy(desc(planPrices.validFrom))
    : []
  const priceOf = (code: string, period: 'month' | 'year') => {
    const row = priceRows.find(r => r.planCode === code && r.billingPeriod === period)
    return row ? Number(row.amountMinor) : null
  }

  const cards: PlanCard[] = []
  for (const p of list) {
    const direction = directionOf(current, p)
    const month = withPrice ? priceOf(p.code, 'month') : null
    const year = withPrice ? priceOf(p.code, 'year') : null
    cards.push({
      code: p.code,
      name: p.name,
      titleUk: p.titleUk,
      tier: p.tier,
      direction,
      prices: withPrice ? { month, year } : null,
      annualSavingPct: month && year != null && month > 0 ? Math.round((1 - year / month) * 100) : null,
      limits: {
        users: planLimitOf(p, 'users_active'),
        candidates: planLimitOf(p, 'candidates_active'),
        storageBytes: planLimitOf(p, 'storage_bytes'),
        aiGenerateOps: planLimitOf(p, 'ai_generate_ops'),
        aiReviewOps: planLimitOf(p, 'ai_review_ops'),
        aiInterviewOps: planLimitOf(p, 'ai_interview_ops'),
      },
      blockers: direction === 'down' ? (await computeBlockers(tenantId, p.code, usage)) ?? [] : [],
    })
  }

  const request = await withTenant(tenantId, null, tx => openRequest(tx, tenantId, ['preflight', 'blocked', 'scheduled']))
  return {
    currentPlanCode: current?.code ?? 'trial',
    billingPeriod: eff.subscription.billingPeriod,
    currency,
    nextPeriodStart: await nextPeriodStart(tenantId),
    plans: cards,
    request: request ? requestView(request) : null,
  }
}

// ── Заявка (§7.6, §10) ───────────────────────────────────────────────────────────────────

export interface PlanChangeCtx { tenantId: string, actorId: string }

export type PreflightResult =
  | { ok: true, request: PlanRequestView, allowed: boolean }
  | { ok: false, code: 'not_found' | 'upgrade_manual' | 'same_plan' }

export type PlanChangeResult =
  | { ok: true, request: PlanRequestView }
  | { ok: false, code: 'not_found' | 'upgrade_manual' | 'same_plan' | 'conflict' | 'not_applicable' }
  | { ok: false, code: 'limit_exceeded', request: PlanRequestView }

/** Одна заявка тенанта за раз: два владельца на разных тирах выстраиваются в очередь (§12). */
const planChangeLock = (tenantId: string) => sql`select pg_advisory_xact_lock(hashtextextended(${`plan_change:${tenantId}`}, 0))`

async function target(tenantId: string, planCode: string): Promise<{ ok: true, plan: PlanRow, from: PlanRow | undefined } | { ok: false, code: 'not_found' | 'upgrade_manual' | 'same_plan' }> {
  const plan = (await catalogPlans()).find(p => p.code === planCode)
  // Тариф вне каталога (выключен, не действует) — `404`, как непубличный в §10
  if (!plan) return { ok: false, code: 'not_found' }
  const from = await tenantPlan(tenantId)
  const dir = directionOf(from, plan)
  if (dir === 'current') return { ok: false, code: 'same_plan' }
  if (dir === 'up') return { ok: false, code: 'upgrade_manual' }
  return { ok: true, plan, from }
}

/**
 * Записать открытую заявку тенанта на `to`: та же заявка обновляется («Перерахувати»), заявка на
 * другой тариф или период закрывается `cancelled` — открытой остаётся одна. Уведомление
 * `plan_change_blocked` (§8) — только при **входе** в `blocked`, а не на каждый пересчёт.
 */
async function upsertOpen(tx: TenantTx, ctx: PlanChangeCtx, from: PlanRow | undefined, to: PlanRow, period: 'month' | 'year', blockers: PlanChangeBlocker[]) {
  const status = blockers.length ? 'blocked' : 'preflight'
  const open = await openRequest(tx, ctx.tenantId, ['preflight', 'blocked'])
  let row: typeof planChangeRequests.$inferSelect
  if (open && open.toPlanCode === to.code && open.billingPeriod === period) {
    ;[row] = await tx.update(planChangeRequests)
      .set({ status, blockers: toJson(blockers), requestedBy: ctx.actorId })
      .where(eq(planChangeRequests.id, open.id)).returning() as [typeof planChangeRequests.$inferSelect]
  }
  else {
    if (open) await tx.update(planChangeRequests).set({ status: 'cancelled', decidedAt: new Date() }).where(eq(planChangeRequests.id, open.id))
    ;[row] = await tx.insert(planChangeRequests).values({
      tenantId: ctx.tenantId, fromPlanCode: from?.code ?? null, toPlanCode: to.code, billingPeriod: period,
      status, blockers: toJson(blockers), requestedBy: ctx.actorId,
    }).returning() as [typeof planChangeRequests.$inferSelect]
  }
  if (status === 'blocked' && open?.status !== 'blocked') await notifyBlocked(tx, ctx.tenantId, row, to, blockers)
  return row
}

async function notifyBlocked(tx: TenantTx, tenantId: string, row: { id: string }, to: PlanRow, blockers: PlanChangeBlocker[]) {
  const { defaultDictionary } = await import('./translations')
  const dict = defaultDictionary('uk')
  const axes = blockers.map(b => dict[`billing.axis.${b.axis}`] ?? b.axis).join(', ')
  for (const r of await billingRecipients(tx, ['owner'])) {
    await enqueueNotification(tx, {
      tenantId, userId: r.user_id, code: 'plan_change_blocked',
      payload: { plan_name: to.titleUk ?? to.name, axes },
      dedupKey: `plan_change_blocked:${row.id}:${r.user_id}`,
    })
  }
}

/** `POST /billing/plan-change/preflight` и «Перерахувати» (§7.6 п. 1, 3, 4). */
export async function preflightPlanChange(ctx: PlanChangeCtx, input: PlanChangePreflightInput): Promise<PreflightResult> {
  const t = await target(ctx.tenantId, input.planCode)
  if (!t.ok) return t
  const blockers = (await computeBlockers(ctx.tenantId, t.plan.code))!
  const effectiveAt = await nextPeriodStart(ctx.tenantId)
  const row = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    await tx.execute(planChangeLock(ctx.tenantId))
    return upsertOpen(tx, ctx, t.from, t.plan, input.billingPeriod, blockers)
  })
  return { ok: true, allowed: blockers.length === 0, request: { ...requestView(row), effectiveAt: blockers.length ? null : effectiveAt } }
}

/**
 * `POST /billing/plan-change` — «Підключити» (§6.1, §7.6 п. 2–3). Превышения пересчитываются
 * здесь же, под блокировкой: предпросмотр мог устареть. Есть — `409 limit_exceeded` с
 * `details.blockers` (§10), заявка `blocked`; нет — `scheduled` с первого дня следующего периода.
 * Уже назначенный переход — `409 conflict`: второй «Підключити» не перезаписывает первый (§12),
 * сменить решение — отменить назначенный (`DELETE`).
 */
export async function requestPlanChange(ctx: PlanChangeCtx, input: PlanChangeInput): Promise<PlanChangeResult> {
  const t = await target(ctx.tenantId, input.planCode)
  if (!t.ok) return t
  const effectiveAt = await nextPeriodStart(ctx.tenantId)
  return withTenant(ctx.tenantId, ctx.actorId, async (tx): Promise<PlanChangeResult> => {
    await tx.execute(planChangeLock(ctx.tenantId))
    if (await openRequest(tx, ctx.tenantId, ['scheduled'])) return { ok: false, code: 'conflict' }
    const blockers = (await computeBlockers(ctx.tenantId, t.plan.code))!
    const row = await upsertOpen(tx, ctx, t.from, t.plan, input.billingPeriod, blockers)
    if (blockers.length) return { ok: false, code: 'limit_exceeded', request: requestView(row) }
    const [scheduled] = await tx.update(planChangeRequests)
      .set({ status: 'scheduled', effectiveAt, decidedBy: ctx.actorId, decidedAt: new Date() })
      .where(eq(planChangeRequests.id, row.id)).returning()
    await recordAudit(tx, {
      tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'billing.plan_change_scheduled',
      entity: 'plan_change_requests', entityId: row.id,
      before: { plan: t.from?.code ?? null },
      after: { plan: t.plan.code, billingPeriod: input.billingPeriod, effectiveAt },
    })
    return { ok: true, request: requestView(scheduled!) }
  })
}

/** `DELETE /billing/plan-change/:id` — отмена; применённую не отменить (`409`, §10). */
export async function cancelPlanChange(ctx: PlanChangeCtx, id: string): Promise<PlanChangeResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx): Promise<PlanChangeResult> => {
    await tx.execute(planChangeLock(ctx.tenantId))
    const [row] = await tx.select().from(planChangeRequests).where(and(eq(planChangeRequests.tenantId, ctx.tenantId), eq(planChangeRequests.id, id)))
    if (!row) return { ok: false, code: 'not_found' }
    if (row.status === 'applied' || row.status === 'cancelled') return { ok: false, code: 'not_applicable' }
    const [done] = await tx.update(planChangeRequests).set({ status: 'cancelled', decidedBy: ctx.actorId, decidedAt: new Date() })
      .where(eq(planChangeRequests.id, id)).returning()
    await recordAudit(tx, {
      tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'billing.plan_change_cancelled',
      entity: 'plan_change_requests', entityId: id, before: { status: row.status }, after: { status: 'cancelled' },
    })
    return { ok: true, request: requestView(done!) }
  })
}

// ── Задача `billing.plan_change_apply` (§11, ежедневно 00:10) ────────────────────────────

/**
 * Применяет `scheduled`, чей `effective_at` наступил (по поясу тенанта), и закрывает `blocked`
 * старше 30 дней (§7.6 п. 4). Перед применением превышения пересчитываются: за время ожидания
 * тенант мог снова набрать людей, и молча применённый тариф ниже факта заблокировал бы их
 * работу — такая заявка возвращается в `blocked` с уведомлением владельцу.
 */
export async function applyScheduledPlanChanges(tenantId: string, today?: string): Promise<{ applied: number, blocked: number, expired: number }> {
  const [t] = await db.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, tenantId))
  const day = today ?? todayIn(t?.timezone ?? 'Europe/Kyiv')
  const res = { applied: 0, blocked: 0, expired: 0 }

  const due = await withTenant(tenantId, null, tx => tx.select().from(planChangeRequests).where(and(
    eq(planChangeRequests.tenantId, tenantId), eq(planChangeRequests.status, 'scheduled'), lte(planChangeRequests.effectiveAt, day),
  )))
  for (const r of due) {
    const [to] = await db.select().from(plans).where(eq(plans.code, r.toPlanCode))
    if (!to) continue
    const blockers = (await computeBlockers(tenantId, to.code)) ?? []
    await withTenant(tenantId, null, async (tx) => {
      await tx.execute(planChangeLock(tenantId))
      const [still] = await tx.select({ status: planChangeRequests.status }).from(planChangeRequests).where(eq(planChangeRequests.id, r.id))
      if (still?.status !== 'scheduled') return
      if (blockers.length) {
        await tx.update(planChangeRequests).set({ status: 'blocked', blockers: toJson(blockers) }).where(eq(planChangeRequests.id, r.id))
        await notifyBlocked(tx, tenantId, r, to, blockers)
        res.blocked++
        return
      }
      const [before] = await tx.select({ plan: tenants.plan }).from(tenants).where(eq(tenants.id, tenantId))
      await tx.update(tenants).set({ plan: to.code }).where(eq(tenants.id, tenantId))
      await tx.insert(tenantLimits).values({ tenantId, billingPeriod: r.billingPeriod })
        .onConflictDoUpdate({ target: tenantLimits.tenantId, set: { billingPeriod: r.billingPeriod, updatedAt: new Date() } })
      await tx.update(planChangeRequests).set({ status: 'applied', decidedAt: new Date() }).where(eq(planChangeRequests.id, r.id))
      await recordAudit(tx, {
        tenantId, actorId: null, action: 'billing.plan_change_applied', entity: 'plan_change_requests', entityId: r.id,
        before: { plan: before?.plan ?? null }, after: { plan: to.code, billingPeriod: r.billingPeriod, effectiveAt: r.effectiveAt },
      })
      for (const u of await billingRecipients(tx)) {
        await enqueueNotification(tx, {
          tenantId, userId: u.user_id, code: 'plan_changed',
          payload: { plan_name: to.titleUk ?? to.name, effective_at: r.effectiveAt },
          dedupKey: `plan_changed:${r.id}:${u.user_id}`,
        })
      }
      res.applied++
    })
  }
  if (res.applied) invalidateLimits(tenantId)

  res.expired = await withTenant(tenantId, null, async (tx) => {
    const rows = await tx.update(planChangeRequests).set({ status: 'cancelled', decidedAt: new Date() }).where(and(
      eq(planChangeRequests.tenantId, tenantId), eq(planChangeRequests.status, 'blocked'),
      sql`${planChangeRequests.createdAt} < (${day}::date - ${BLOCKED_TTL_DAYS}::int)`,
    )).returning({ id: planChangeRequests.id })
    return rows.length
  })
  return res
}
