import { requireScope } from '../../../../services/access'
import { announcementReport } from '../../../../services/news'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'knowledge.manage')
  const r = await announcementReport({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Оголошення не знайдено')
  return apiData(r)
})
