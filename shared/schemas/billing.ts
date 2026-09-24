import { z } from 'zod'
import { KEYSETS } from '../domain/keyset'
import { keysetCursorSchema } from './keyset'

/** Контракты оплаты и смены тарифа (docs/v2/35-billing-limits.md §3.5, §6, §10, PR-10). */

/**
 * Приём платежа оператором вручную (`POST /platform/tenants/:id/payments`, `35` §10).
 * Провайдер не подключён (`44` §8): статус пишется сразу `paid`, отдельного вебхука
 * подтверждения нет. Комментарий обязателен — как и у любого действия оператора (§5.6).
 *
 * `planCode`/`addonCode`/`qty` — только для соответствующего `kind`: подписка ссылается на
 * тариф (для истории — какой тариф оплачен, план тенанту эта ручка не меняет, см.
 * `changeTenantPlan`), аддон — на код опции каталога и на количество шагов.
 */
export const tenantPaymentSchema = z.object({
  kind: z.enum(['subscription', 'addon', 'adjustment']),
  planCode: z.string().trim().min(1).max(60).optional(),
  addonCode: z.string().trim().min(1).max(60).optional(),
  qty: z.number().int().min(1).max(1000).optional(),
  billingPeriod: z.enum(['month', 'year']).optional(),
  amountMinor: z.number().int().min(0).max(1_000_000_000_00),
  currency: z.string().trim().length(3).toUpperCase().default('EUR'),
  method: z.enum(['bank_transfer', 'card', 'manual']).optional(),
  invoiceNumber: z.string().trim().min(1).max(80).optional(),
  status: z.enum(['paid', 'refunded', 'written_off']).default('paid'),
  comment: z.string().trim().min(10).max(500),
})
export type TenantPaymentInput = z.infer<typeof tenantPaymentSchema>

/** Фильтры «Історії платежів» (`35` §5.3, §9): період, тип, статус. */
export const tenantPaymentsQuerySchema = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  kind: z.enum(['subscription', 'addon', 'adjustment']).optional(),
  status: z.enum(['pending', 'paid', 'failed', 'refunded', 'written_off']).optional(),
  cursor: keysetCursorSchema(KEYSETS.payments).optional(),
  limit: z.number().int().min(1).max(100).default(30),
})
export type TenantPaymentsQuery = z.infer<typeof tenantPaymentsQuerySchema>

/** Прямая смена тарифа оператором (§7.10 «может назначить любой план»), без preflight-заявки владельца. */
export const platformPlanChangeSchema = z.object({
  toPlanCode: z.string().trim().min(1).max(60),
  billingPeriod: z.enum(['month', 'year']),
  comment: z.string().trim().min(10).max(500),
})
export type PlatformPlanChangeInput = z.infer<typeof platformPlanChangeSchema>

/**
 * Точечное продление дат подписки без платежа (§7.10 «может сдвинуть paid_until, grace_until,
 * ai_until»; §5.6 «Продовжити доступ», «Продовжити ШІ») — в отличие от `PUT /limits`, который
 * заменяет **все** переопределения осей целиком, здесь каждое поле необязательно и трогает
 * только то, что передано (иначе сохранение обычных лимитов стирало бы даты подписки).
 */
export const platformExtendSchema = z.object({
  paidUntil: z.string().date().nullable().optional(),
  graceUntil: z.string().date().nullable().optional(),
  aiUntil: z.string().date().nullable().optional(),
  comment: z.string().trim().min(10).max(500),
})
export type PlatformExtendInput = z.infer<typeof platformExtendSchema>
