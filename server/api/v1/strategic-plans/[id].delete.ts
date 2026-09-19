import { requireScope } from '../../../services/access'
import { deleteStrategicPlan } from '../../../services/developmentExtra'
import { apiData, apiError } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.manage')
  const ok = await deleteStrategicPlan({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!ok) return apiError(event, 404, 'not_found', 'План не знайдено')
  return apiData({ ok: true })
})
