import { and, desc, eq, ilike, ne, or, sql, type SQL } from 'drizzle-orm'
import { platformAudit, tenantLimits, tenants } from '../db/schema'
import { KEYSETS, encodeKeyset } from '../../shared/domain/keyset'
import type { TenantFlag, TenantListQuery } from '../../shared/schemas/platformOperators'
import { keysetAfter, keysetAt } from '../utils/keyset'
import { EMPLOYEES_ONLY } from './repo/people'
import { getTenantCard, platformDb } from './platform'

/**
 * Консоль оператора: список компаний и обзор карточки (docs/24 §4.1–4.2, docs/25 §7 п. 4, 6).
 * Агрегаты, не содержимое. Метки строки считает сервер:
 *  - `payment_overdue` — подписка в `grace`/`readonly` или `paid_until` в прошлом (docs/v2/35 §7.8);
 *  - `limit_near` — есть открытое предупреждение лимита (`limit_notices`, порог 80 %, §7.9) —
 *    то же, по которому тенант видит баннер, а не второй расчёт;
 *  - `suspended` — компания приостановлена оператором (docs/25 §8).
 */

const OVERDUE = sql`exists (select 1 from tenant_limits l where l.tenant_id = ${tenants.id}
  and (l.status in ('grace', 'readonly') or (l.paid_until is not null and l.paid_until < current_date)))`
const LIMIT_NEAR = sql`exists (select 1 from limit_notices n where n.tenant_id = ${tenants.id} and n.resolved_at is null)`

export interface TenantListRow {
  id: string
  slug: string
  name: string
  status: string
  plan: string
  createdAt: string
  activeUsers: number
  flags: TenantFlag[]
}

/** `withBilling` — видны ли оператору деньги (`billing.read`): без права метки и фильтра «прострочена оплата» нет. */
export async function listTenantsPage(q: TenantListQuery, opts: { withBilling: boolean }): Promise<{ items: TenantListRow[], cursor: string | null }> {
  const limit = q.limit ?? 30
  const where: (SQL | undefined)[] = [
    q.q ? or(ilike(tenants.name, `%${q.q.replace(/[%_\\]/g, m => `\\${m}`)}%`), ilike(tenants.slug, `%${q.q.replace(/[%_\\]/g, m => `\\${m}`)}%`)) : undefined,
    q.plan ? eq(tenants.plan, q.plan) : undefined,
    q.status ? eq(tenants.status, q.status) : undefined,
    q.flag === 'payment_overdue' && opts.withBilling ? OVERDUE : undefined,
    q.flag === 'limit_near' ? LIMIT_NEAR : undefined,
    q.flag === 'suspended' ? eq(tenants.status, 'suspended') : undefined,
    keysetAfter(KEYSETS.platformTenants, q.cursor, [tenants.createdAt, tenants.id], 'desc'),
  ]
  const rows = await platformDb().select({
    id: tenants.id, slug: tenants.slug, name: tenants.name, status: tenants.status, plan: tenants.plan,
    createdAt: tenants.createdAt, cursorAt: keysetAt(tenants.createdAt),
    activeUsers: sql<number>`(select count(*)::int from users u where u.tenant_id = ${tenants.id} and u.status = 'active' and not u.is_blocked ${EMPLOYEES_ONLY('u')})`,
    overdue: sql<boolean>`${OVERDUE}`,
    limitNear: sql<boolean>`${LIMIT_NEAR}`,
  }).from(tenants).where(and(...where)).orderBy(desc(tenants.createdAt), desc(tenants.id)).limit(limit + 1)
  const page = rows.slice(0, limit)
  const last = rows.length > limit ? page[page.length - 1] : undefined
  return {
    items: page.map(r => ({
      id: r.id, slug: r.slug, name: r.name, status: r.status, plan: r.plan, createdAt: r.createdAt.toISOString(), activeUsers: r.activeUsers,
      flags: [
        ...(r.overdue && opts.withBilling ? ['payment_overdue' as const] : []),
        ...(r.limitNear ? ['limit_near' as const] : []),
        ...(r.status === 'suspended' ? ['suspended' as const] : []),
      ],
    })),
    cursor: last ? encodeKeyset(KEYSETS.platformTenants, [last.cursorAt, last.id]) : null,
  }
}

/**
 * Обзор карточки компании: статус, тариф, потребление по осям (те же счётчики, что у проверки при
 * операции и баннера, `usageByAxis`), последние действия операторов по ней. Подписка (оплачено до,
 * grace) — только тем, кому видны деньги (`billing.read`): у `support` её нет.
 */
export async function tenantOverview(id: string, opts: { withBilling: boolean }) {
  const card = await getTenantCard(id)
  if (!card) return null
  const { usageByAxis } = await import('./usageCounters')
  const consumption = await usageByAxis(id)
  const recent = await platformDb().select({
    id: platformAudit.id, action: platformAudit.action, adminEmail: platformAudit.adminEmail, createdAt: platformAudit.createdAt,
  }).from(platformAudit).where(and(eq(platformAudit.subjectTenantId, id), ne(platformAudit.action, 'platform.request')))
    .orderBy(desc(platformAudit.createdAt)).limit(10)
  const [sub] = opts.withBilling
    ? await platformDb().select({ status: tenantLimits.status, paidUntil: tenantLimits.paidUntil, graceUntil: tenantLimits.graceUntil, aiUntil: tenantLimits.aiUntil, billingPeriod: tenantLimits.billingPeriod })
      .from(tenantLimits).where(eq(tenantLimits.tenantId, id))
    : []
  const flags: TenantFlag[] = []
  const [f] = await platformDb().select({ overdue: sql<boolean>`${OVERDUE}`, limitNear: sql<boolean>`${LIMIT_NEAR}` }).from(tenants).where(eq(tenants.id, id))
  if (f?.overdue && opts.withBilling) flags.push('payment_overdue')
  if (f?.limitNear) flags.push('limit_near')
  if (card.status === 'suspended') flags.push('suspended')
  return {
    tenant: { id: card.id, slug: card.slug, name: card.name, status: card.status, plan: card.plan, trialEndsAt: card.trial_ends_at, createdAt: card.created_at, archivedAt: card.archived_at },
    stats: { activeUsers: card.active_users, totalUsers: card.total_users, wau: card.wau, completed30d: card.completed_30d },
    flags,
    subscription: sub ?? null,
    consumption: consumption.map(c => ({ axis: c.axis, used: c.used, limit: c.limit, pct: c.pct, level: c.level, source: c.source })),
    recent: recent.map(r => ({ ...r, id: String(r.id) })),
  }
}
