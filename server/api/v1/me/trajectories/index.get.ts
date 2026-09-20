import { requireScope } from '../../../../services/access'
import { myTrajectories } from '../../../../services/trajectories'
import { apiData } from '../../../../utils/apiResponse'
/** Мои траектории (docs/04 §4.4 GET /me/trajectories). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  return apiData(await myTrajectories({ tenantId: a.tenantId, actorId: a.userId }))
})
