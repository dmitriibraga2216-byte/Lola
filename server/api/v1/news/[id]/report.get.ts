import { requireScope } from '../../../../services/access'
import { newsAckReport } from '../../../../services/news'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'knowledge.manage')
  const r = await newsAckReport({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Новину не знайдено')
  return apiData(r)
})
