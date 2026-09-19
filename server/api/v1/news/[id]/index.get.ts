import { requireScope } from '../../../../services/access'
import { getNews } from '../../../../services/news'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const n = await getNews({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!n) return apiError(event, 404, 'not_found', 'Новину не знайдено')
  return apiData(n)
})
