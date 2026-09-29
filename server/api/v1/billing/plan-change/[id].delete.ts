import { requireScope } from '../../../../services/access'
import { cancelPlanChange } from '../../../../services/planChange'
import { apiData } from '../../../../utils/apiResponse'
import { planChangeError } from '../../../../utils/planChangeErrors'

/**
 * DELETE /billing/plan-change/:id (docs/v2/35 §7.6, §10): отмена заявки. Применённую не отменить —
 * `409`; чужая заявка не видна под RLS — `404` (CLAUDE.md п. 15).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'billing.manage')
  const r = await cancelPlanChange({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r.ok) return planChangeError(event, r.code)
  return apiData(r)
})
