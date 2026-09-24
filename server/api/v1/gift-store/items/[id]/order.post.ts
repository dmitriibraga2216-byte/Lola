import { requireScope } from '../../../../../services/access'
import { placeOrder } from '../../../../../services/shop'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/**
 * POST /gift-store/items/:id/order (docs/04 §4.13): покупка → резерв на 14 днів, бонуси списуються
 * одразу. Особого права не треба — людина замовляє собі (`learn.view`).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const r = await placeOrder({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r.ok) {
    switch (r.code) {
      case 'not_found': return apiError(event, 404, 'not_found', 'Подарунок не знайдено або його зняли з вітрини')
      case 'not_employee': return apiError(event, 403, 'shop.employees_only', 'Магазин подарунків доступний співробітникам компанії')
      case 'out_of_stock': return apiError(event, 409, 'shop.out_of_stock', 'Цей подарунок закінчився — оберіть інший або зазирніть пізніше')
      case 'limit_reached': return apiError(event, 409, 'shop.limit_reached', 'Ви вже замовили цей подарунок максимальну кількість разів', r.details)
      case 'insufficient_bonuses': return apiError(event, 409, 'shop.insufficient_bonuses', 'Бонусів поки не вистачає — їх нараховують за виконані завдання', r.details)
    }
  }
  return apiData({ order: r.order, balance: r.balance })
})
