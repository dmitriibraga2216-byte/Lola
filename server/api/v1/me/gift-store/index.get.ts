import { requireScope } from '../../../../services/access'
import { showcase } from '../../../../services/shop'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** GET /me/gift-store — вітрина «Магазин подарунків» (мокап Shop): баланс, категорії, товари з причиною, чому не можна замовити. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const r = await showcase({ tenantId: a.tenantId, actorId: a.userId })
  if (!r.ok) return apiError(event, 403, 'shop.employees_only', 'Магазин подарунків доступний співробітникам компанії')
  const { ok: _ok, ...data } = r
  return apiData(data)
})
