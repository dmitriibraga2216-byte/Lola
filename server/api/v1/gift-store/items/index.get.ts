import { requireScope } from '../../../../services/access'
import { listShopItems } from '../../../../services/shop'
import { apiData } from '../../../../utils/apiResponse'

/** GET /gift-store/items (docs/04 §4.13) — «Товари» (мокап ShopAdmin): з категорією, залишком і скільки замовлено. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'shop.manage')
  return apiData(await listShopItems({ tenantId: a.tenantId, actorId: a.userId }))
})
