import { ordersFilterSchema } from '../../../../../shared/schemas/gamification'
import { requireAnyScope } from '../../../../services/access'
import { listOrders } from '../../../../services/shop'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** GET /gift-store/orders?tab=pending|issued|cancelled — «До видачі» / «Видано» у своїй області (мокап ShopAdmin). */
export default defineEventHandler(async (event) => {
  const a = await requireAnyScope(event, ['shop.manage', 'shop.issue'])
  const q = ordersFilterSchema.safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Перевірте фільтри', { issues: q.error.issues })
  const r = await listOrders({ tenantId: a.tenantId, actorId: a.userId }, a, q.data)
  if (!r.ok) return apiError(event, 403, 'forbidden', 'Немає доступу')
  return apiData({ rows: r.rows, counts: r.counts })
})
