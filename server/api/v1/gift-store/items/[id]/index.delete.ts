import { requireScope } from '../../../../../services/access'
import { deleteShopItem } from '../../../../../services/shop'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** DELETE /gift-store/items/:id — мʼяке видалення: товар зникає з вітрини, замовлення і книга лишаються. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'shop.manage')
  const ok = await deleteShopItem({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!ok) return apiError(event, 404, 'not_found', 'Подарунок не знайдено')
  return apiData({ ok: true })
})
