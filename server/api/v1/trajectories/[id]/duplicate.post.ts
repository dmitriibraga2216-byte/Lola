import { requireScope } from '../../../../services/access'
import { duplicateTrajectory } from '../../../../services/trajectories'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'program.manage')
  const t = await duplicateTrajectory({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!t) return apiError(event, 404, 'not_found', 'Траєкторію не знайдено')
  return apiData(t)
})
