import { requireScope } from '../../../../services/access'
import { myOrders } from '../../../../services/shop'
import { apiData } from '../../../../utils/apiResponse'

/** GET /me/gift-store/orders — «Придбані»: свої замовлення зі станом (docs/05 §5.14.10). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  return apiData(await myOrders({ tenantId: a.tenantId, actorId: a.userId }))
})
