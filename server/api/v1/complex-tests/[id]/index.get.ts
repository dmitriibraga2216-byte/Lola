import { requireScope } from '../../../../services/access'
import { complexIntro } from '../../../../services/complexTests'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.attempt')
  const r = await complexIntro({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Комплексний тест не знайдено')
  return apiData(r)
})
