import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { plans, tenantLimits, tenants } from '../db/schema'
import { withTenant } from '../utils/withTenant'

/**
 * Действующие лимиты тенанта (docs/24 §4.4, docs/25 §10): переопределение из `tenant_limits`,
 * иначе — тариф `plans`, иначе — без лимита (null). `activeJobs` — квота задач на круг round-robin (docs/25 §5),
 * по умолчанию DEFAULT_ACTIVE_JOBS. Кеш на процесс 60 с; панель оператора сбрасывает его при записи.
 */
export interface EffectiveLimits {
  users: number | null
  storageGb: number | null
  smsPerMonth: number | null
  apiPerMinute: number | null
  webhooks: number | null
  activeJobs: number
  overridden: (keyof Omit<EffectiveLimits, 'overridden'>)[]
}

export const DEFAULT_ACTIVE_JOBS = 100

const TTL_MS = 60_000
const cache = new Map<string, { at: number, v: EffectiveLimits }>()

export function invalidateLimits(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId)
  else cache.clear()
}

export async function effectiveLimits(tenantId: string): Promise<EffectiveLimits> {
  const hit = cache.get(tenantId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v
  const [t] = await db.select({ plan: tenants.plan }).from(tenants).where(eq(tenants.id, tenantId))
  const [p] = t ? await db.select().from(plans).where(eq(plans.code, t.plan)) : []
  const [o] = await withTenant(tenantId, null, tx => tx.select().from(tenantLimits).where(eq(tenantLimits.tenantId, tenantId)))
  const pick = <K extends keyof Omit<EffectiveLimits, 'overridden' | 'activeJobs'>>(k: K, planValue: number | null | undefined): number | null =>
    o?.[k] ?? planValue ?? null
  const overridden = (['users', 'storageGb', 'smsPerMonth', 'apiPerMinute', 'webhooks', 'activeJobs'] as const).filter(k => o?.[k] != null)
  const v: EffectiveLimits = {
    users: pick('users', p?.maxUsers),
    storageGb: pick('storageGb', p?.maxStorageGb),
    smsPerMonth: pick('smsPerMonth', p?.maxSmsPerMonth),
    apiPerMinute: o?.apiPerMinute ?? null,
    webhooks: o?.webhooks ?? null,
    activeJobs: o?.activeJobs ?? DEFAULT_ACTIVE_JOBS,
    overridden,
  }
  cache.set(tenantId, { at: Date.now(), v })
  return v
}
