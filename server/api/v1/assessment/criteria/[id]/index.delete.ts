import { requireScope } from '../../../../../services/access'
import { deleteCriterion } from '../../../../../services/assessment'
import { apiData, apiError } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assessment.manage')
  const ok = await deleteCriterion({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!ok) return apiError(event, 404, 'not_found', 'Критерій не знайдено')
  return apiData({ ok: true })
})
