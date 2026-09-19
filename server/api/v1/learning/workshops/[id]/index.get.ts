import { requireScope } from '../../../../../services/access'
import { workshopForLearner } from '../../../../../services/workshops'
import { apiData, apiError } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const e = getQuery(event).enrollmentId
  const w = await workshopForLearner({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, typeof e === 'string' ? e : undefined)
  if (!w) return apiError(event, 404, 'not_found', 'Практикум не знайдено')
  return apiData(w)
})
