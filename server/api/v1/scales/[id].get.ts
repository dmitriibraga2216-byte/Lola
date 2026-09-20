import { requireScope } from '../../../services/access'
import { getScale } from '../../../services/scales'
import { apiData, apiError } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.view')
  const s = await getScale({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!s) return apiError(event, 404, 'not_found', 'Шкалу не знайдено')
  return apiData(s)
})
