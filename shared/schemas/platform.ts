import { z } from 'zod'

/** Контракты панели оператора (docs/04 §4.17, docs/24 §9, docs/25 §7–8, §10). */

export const TENANT_STATUSES = ['active', 'suspended', 'archived'] as const
export type TenantStatus = typeof TENANT_STATUSES[number]

const limit = z.number().int().min(0).max(1_000_000_000).nullable().optional()

/** Переопределение лимитов тенанта (`tenant_limits`): null/пропуск — лимит тарифа. */
export const tenantLimitsSchema = z.object({
  users: limit,
  storageGb: limit,
  smsPerMonth: limit,
  apiPerMinute: limit,
  webhooks: limit,
  activeJobs: z.number().int().min(1).max(10_000).nullable().optional(),
})
export type TenantLimitsInput = z.infer<typeof tenantLimitsSchema>

export const tenantSuspendSchema = z.object({ reason: z.string().trim().max(500).optional() })

/** Удаление подтверждается slug тенанта — защита от клика по соседней строке (docs/24 §7 п. 5). */
export const tenantPurgeSchema = z.object({ confirmSlug: z.string().trim().min(3).max(40) })

/** Собственный домен клиента (docs/25 §16.1, докс/33 D-059): без протокола, нижний регистр, DNS-имя. */
export const customDomainSchema = z.string().trim().toLowerCase()
  .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/, 'Домен без протоколу, напр. navchannya.kappi.ua')
  .max(255)

export const tenantPatchSchema = z.object({
  plan: z.string().optional(),
  trialEndsAt: z.string().datetime().nullable().optional(),
  name: z.string().min(2).max(120).optional(),
  settings: z.record(z.unknown()).optional(),
  customDomain: customDomainSchema.nullable().optional(),
})
