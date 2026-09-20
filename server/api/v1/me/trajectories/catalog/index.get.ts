import { requireScope } from '../../../../../services/access'
import { catalogTrajectories } from '../../../../../services/trajectories'
import { apiData } from '../../../../../utils/apiResponse'
/** Каталог траекторий: catalog_free (самозапись) и catalog_request (заявка). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  return apiData(await catalogTrajectories({ tenantId: a.tenantId, actorId: a.userId }))
})
