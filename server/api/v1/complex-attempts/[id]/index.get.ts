import { requireScope } from '../../../../services/access'
import { syncComplex } from '../../../../services/complexTests'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.attempt')
  const r = await syncComplex({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Спробу не знайдено')
  return apiData(r)
})
