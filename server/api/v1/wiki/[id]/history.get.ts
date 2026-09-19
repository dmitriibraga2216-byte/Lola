import { requireScope } from '../../../../services/access'
import { pageHistory } from '../../../../services/wiki'
import { apiData } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  return apiData(await pageHistory({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!))
})
