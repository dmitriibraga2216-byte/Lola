import { and, desc, eq, gte, lt, lte, or, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { planAddons, planPrices, plans, tenantAddons, tenantPayments, tenants } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { effectiveLimits } from './tenantLimits'
import type { TenantPaymentsQuery } from '../../shared/schemas/billing'

/**
 * Витрина `/settings/billing` (docs/v2/35-billing-limits.md §5.1, §10 `GET /billing/summary`).
 * Читает то же самое, что уже посчитано `effectiveLimits()` (docs/v2/44 В-5) — второй формулы
 * подписки здесь нет.
 *
 * `withPrice` — скрывает цену от `admin` (`35` §2: суммы видит только `owner`,
 * `billing.payments.view`); счётчики и даты видит и `admin` (`billing.view`).
 */
export interface BillingSummary {
  plan: { code: string, name: string, titleUk: string | null, tier: number }
  /** Цена за выбранный период — только когда вызывающий видит `billing.payments.view`. */
  priceMinor: number | null
  currency: string
  subscription: Awaited<ReturnType<typeof effectiveLimits>>['subscription']
  ai: { status: 'active' | 'expired' | 'off', until: string | null, termDays: number | null, included: boolean }
  addons: { addonCode: string, name: string, axis: string, qty: number, unitStep: number, validUntil: string | null }[]
}

export async function billingSummary(tenantId: string, withPrice: boolean): Promise<BillingSummary> {
  const [t] = await db.select({ plan: tenants.plan }).from(tenants).where(eq(tenants.id, tenantId))
  const [plan] = t ? await db.select().from(plans).where(eq(plans.code, t.plan)) : []
  const eff = await effectiveLimits(tenantId)

  let priceMinor: number | null = null
  if (withPrice && plan) {
    const [price] = await db.select().from(planPrices).where(and(
      eq(planPrices.planCode, plan.code),
      eq(planPrices.billingPeriod, eff.subscription.billingPeriod),
      eq(planPrices.currency, eff.subscription.currency),
      lte(planPrices.validFrom, sql`current_date`),
      or(sql`${planPrices.validTo} is null`, gte(planPrices.validTo, sql`current_date`)),
    )).orderBy(desc(planPrices.validFrom)).limit(1)
    priceMinor = price ? Number(price.amountMinor) : null
  }

  const addonRows = await withTenant(tenantId, null, tx => tx
    .select({ addonCode: tenantAddons.addonCode, name: planAddons.name, axis: planAddons.axis, qty: tenantAddons.qty, unitStep: tenantAddons.unitStep, validUntil: tenantAddons.validUntil })
    .from(tenantAddons)
    .innerJoin(planAddons, eq(planAddons.code, tenantAddons.addonCode))
    .where(and(
      lte(tenantAddons.validFrom, sql`current_date`),
      or(sql`${tenantAddons.validUntil} is null`, gte(tenantAddons.validUntil, sql`current_date`)),
    )))

  return {
    plan: { code: t?.plan ?? 'trial', name: plan?.name ?? t?.plan ?? 'trial', titleUk: plan?.titleUk ?? null, tier: plan?.tier ?? 0 },
    priceMinor,
    currency: eff.subscription.currency,
    subscription: eff.subscription,
    ai: { status: eff.subscription.aiStatus, until: eff.subscription.aiUntil, termDays: plan?.aiTermDays ?? null, included: plan?.aiIncluded ?? true },
    addons: addonRows.map(a => ({ ...a, unitStep: Number(a.unitStep) })),
  }
}

export interface TenantPaymentRow {
  id: string
  kind: string
  planCode: string | null
  addonCode: string | null
  billingPeriod: string | null
  periodFrom: string | null
  periodTo: string | null
  amountMinor: number
  currency: string
  status: string
  method: string | null
  invoiceNumber: string | null
  comment: string | null
  createdAt: string
}

/** «Історія платежів» (`35` §5.3, §9): только `owner` (`billing.payments.view`). */
export async function listTenantPayments(tenantId: string, query: TenantPaymentsQuery): Promise<{ items: TenantPaymentRow[], nextCursor: string | null }> {
  const limit = query.limit
  const conditions = [
    query.from ? gte(tenantPayments.createdAt, new Date(query.from)) : undefined,
    query.to ? lt(tenantPayments.createdAt, new Date(new Date(query.to).getTime() + 86_400_000)) : undefined,
    query.kind ? eq(tenantPayments.kind, query.kind) : undefined,
    query.status ? eq(tenantPayments.status, query.status) : undefined,
    query.cursor ? lt(tenantPayments.createdAt, new Date(query.cursor)) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined)

  const rows = await withTenant(tenantId, null, tx => tx
    .select().from(tenantPayments)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(tenantPayments.createdAt))
    .limit(limit + 1))

  const items = rows.slice(0, limit).map(r => ({
    id: r.id,
    kind: r.kind,
    planCode: r.planCode,
    addonCode: r.addonCode,
    billingPeriod: r.billingPeriod,
    periodFrom: r.periodFrom,
    periodTo: r.periodTo,
    amountMinor: Number(r.amountMinor),
    currency: r.currency,
    status: r.status,
    method: r.method,
    invoiceNumber: r.invoiceNumber,
    comment: r.comment,
    createdAt: r.createdAt.toISOString(),
  }))
  const nextCursor = rows.length > limit ? items[items.length - 1]!.createdAt : null
  return { items, nextCursor }
}
