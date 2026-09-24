import { z } from 'zod'
import { MAX_REWARD } from '../domain/gamification'
import { POINTS_CURRENCIES, POINTS_EVENTS } from '../enums'

/**
 * Контракти бонусів і магазину подарунків (docs/04 §4.13 `/gift-store/*`, `/bonuses/*`,
 * `/me/bonuses`; docs/21 Г-21.1). Один источник для клиента и сервера (CLAUDE.md п. 7).
 */

/** Категорія товару (docs/21 §14.3 «Додати нову категорію»). */
export const shopCategorySchema = z.object({
  name: z.string().trim().min(1).max(60),
})

/**
 * Товар (docs/21 Г-21.1 `[решение]`): назва, опис, зображення, категорія, вартість у бонусах,
 * залишок (null — без обмеження), точка видачі (null — будь-яка), ліміт на людину (null — без
 * ліміту), «Опубліковано».
 */
export const shopItemSchema = z.object({
  title: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).nullable().optional(),
  imageKey: z.string().uuid().nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  priceBonuses: z.number().int().min(1).max(MAX_REWARD),
  stock: z.number().int().min(0).max(100_000).nullable().optional(),
  locationId: z.string().uuid().nullable().optional(),
  limitPerUser: z.number().int().min(1).max(1000).nullable().optional(),
  isActive: z.boolean().optional(),
})
export type ShopItemInput = z.infer<typeof shopItemSchema>
export const shopItemPatchSchema = shopItemSchema.partial()
export type ShopItemPatch = z.infer<typeof shopItemPatchSchema>

/**
 * POST /gift-store/orders/:id/status (docs/04): `ready` | `issued` | `cancelled`. Причина
 * обязательна, когда заказ отменяет не сам покупатель — человеку нужно объяснить, почему
 * бонусы вернулись, а подарка не будет; проверка — в сервисе, он знает, кто отменяет.
 */
export const orderStatusSchema = z.object({
  status: z.enum(['ready', 'issued', 'cancelled']),
  reason: z.string().trim().max(500).optional(),
})
export type OrderStatusInput = z.infer<typeof orderStatusSchema>
/** Минимальная длина причины отмены — как у отзыва сертификата, «чтобы было что прочитать». */
export const CANCEL_REASON_MIN = 3

/** POST /bonuses/adjust — «Нарахувати вручну»: знак задаёт начисление или списание, причина обязательна. */
export const bonusAdjustSchema = z.object({
  userId: z.string().uuid(),
  delta: z.number().int().min(-MAX_REWARD).max(MAX_REWARD).refine(v => v !== 0, { message: 'Сума не може дорівнювати нулю' }),
  comment: z.string().trim().min(3).max(300),
})
export type BonusAdjustInput = z.infer<typeof bonusAdjustSchema>

/** GET /bonuses/ledger — журнал операцій: период, человек, событие; курсор — id строки книги. */
export const ledgerFilterSchema = z.object({
  currency: z.enum(POINTS_CURRENCIES).default('bonuses'),
  userId: z.string().uuid().optional(),
  event: z.enum(POINTS_EVENTS).optional(),
  q: z.string().trim().max(100).optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type LedgerFilter = z.infer<typeof ledgerFilterSchema>

/** GET /bonuses/balances — «Керування бонусами»: реестр людей с текущим остатком. */
export const balancesFilterSchema = z.object({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(200).default(50),
})
export type BalancesFilter = z.infer<typeof balancesFilterSchema>

/** GET /gift-store/orders — вкладки «До видачі» (reserved + ready), «Видано», «Скасовано». */
export const ordersFilterSchema = z.object({
  tab: z.enum(['pending', 'issued', 'cancelled']).default('pending'),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})
export type OrdersFilter = z.infer<typeof ordersFilterSchema>
