import { requireScope } from '../../../../services/access'
import { trajectoryUsages } from '../../../../services/trajectories'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'program.manage')
  const r = await trajectoryUsages({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Траєкторію не знайдено')
  return apiData(r)
})
