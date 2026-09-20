import { requireScope } from '../../../../services/access'
import { getTrajectory } from '../../../../services/trajectories'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'program.manage')
  const t = await getTrajectory({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!t) return apiError(event, 404, 'not_found', 'Траєкторію не знайдено') // чужой тенант — тоже 404 (CLAUDE.md п. 15)
  return apiData(t)
})
