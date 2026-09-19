import { requireScope } from '../../../../services/access'
import { profileCoverage } from '../../../../services/developmentExtra'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'position_profile.manage')
  const r = await profileCoverage({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Профіль не знайдено')
  return apiData(r)
})
