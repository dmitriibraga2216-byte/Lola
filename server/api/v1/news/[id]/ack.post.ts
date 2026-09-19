import { requireScope } from '../../../../services/access'
import { ackNews } from '../../../../services/news'
import { apiData } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  return apiData(await ackNews({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!))
})
