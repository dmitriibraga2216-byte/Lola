import { requireScope } from '../../../../../../services/access'
import { selfEnroll } from '../../../../../../services/trajectories'
import { apiData, apiError } from '../../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const r = await selfEnroll({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r.ok) {
    if (r.code === 'not_found' || r.code === 'not_published') return apiError(event, 404, 'not_found', 'Траєкторію не знайдено')
    if (r.code === 'not_in_catalog') return apiError(event, 422, 'trajectory.not_in_catalog', 'Ця траєкторія призначається інакше — зверніться до керівника')
    return apiError(event, 409, 'trajectory.finished_no_reassign', 'Ви вже пройшли цю траєкторію')
  }
  return apiData(r)
})
