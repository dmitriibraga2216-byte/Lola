import { requireScope } from '../../../../../services/access'
import { listGroups } from '../../../../../services/questions'
import { apiData, apiError } from '../../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.view')
  const g = await listGroups({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!g) return apiError(event, 404, 'not_found', 'Тест не знайдено')
  return apiData(g)
})
