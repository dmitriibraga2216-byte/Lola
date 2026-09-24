import { orderStatusSchema } from '../../../../../../shared/schemas/gamification'
import { requireScope } from '../../../../../services/access'
import { setOrderStatus } from '../../../../../services/shop'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/**
 * POST /gift-store/orders/:id/status (docs/04 §4.13, docs/21 Г-21.1): `ready` | `issued` | `cancelled`.
 * Покупець сам може лише скасувати своє ще не підготовлене замовлення; решта — відповідальний за видачу.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = orderStatusSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Статус — ready, issued або cancelled', { issues: p.error.issues })
  const r = await setOrderStatus({ tenantId: a.tenantId, actorId: a.userId }, a, getRouterParam(event, 'id')!, p.data)
  if (!r.ok) {
    switch (r.code) {
      case 'not_found': return apiError(event, 404, 'not_found', 'Замовлення не знайдено')
      case 'forbidden': return apiError(event, 403, 'forbidden', 'Це замовлення видають на іншій точці')
      case 'invalid_transition': return apiError(event, 409, 'shop.invalid_transition', 'Замовлення вже в іншому стані — оновіть сторінку', r.details)
      case 'reason_required': return apiError(event, 400, 'shop.reason_required', 'Напишіть людині, чому замовлення скасовано', r.details)
    }
  }
  return apiData(r.order)
})
