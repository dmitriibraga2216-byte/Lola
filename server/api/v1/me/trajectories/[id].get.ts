import { requireScope } from '../../../../services/access'
import { myTrajectory } from '../../../../services/trajectories'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** Лента шагов моей траектории (мокап MyTrajectory): только мой фактический путь. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const r = await myTrajectory({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Траєкторію не знайдено')
  return apiData(r)
})
