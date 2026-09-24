import { requireScope } from '../../../../services/access'
import { listShopCategories } from '../../../../services/shop'
import { apiData } from '../../../../utils/apiResponse'

/** GET /gift-store/categories — довідник категорій товарів з кількістю товарів. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'shop.manage')
  return apiData(await listShopCategories({ tenantId: a.tenantId, actorId: a.userId }))
})
