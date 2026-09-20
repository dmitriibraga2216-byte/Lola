import { requireScope } from '../../../../../services/access'
import { myTrajectory } from '../../../../../services/trajectories'
import { apiData, apiError } from '../../../../../utils/apiResponse'
/** Лента прохождения глазами руководителя/админа. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'program.manage')
  const r = await myTrajectory({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, { any: true })
  if (!r) return apiError(event, 404, 'not_found', 'Прохождення не знайдено')
  return apiData(r)
})
