import { requireScope } from '../../../../services/access'
import { trajectoryPeople } from '../../../../services/trajectories'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** Кто на траектории: статус, текущий шаг (docs/04 §4.10 GET /trajectories/:id/audience). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'program.manage')
  const r = await trajectoryPeople({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Траєкторію не знайдено')
  return apiData(r)
})
