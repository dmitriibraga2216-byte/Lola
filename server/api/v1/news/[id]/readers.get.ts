import { requireScope } from '../../../../services/access'
import { newsReaders } from '../../../../services/news'
import { apiData } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'knowledge.manage')
  return apiData(await newsReaders({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!))
})
