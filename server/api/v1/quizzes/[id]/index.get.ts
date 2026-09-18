import { requireScope } from '../../../../services/access'
import { getQuizEditor } from '../../../../services/questions'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.view')
  const e = await getQuizEditor({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!e) return apiError(event, 404, 'not_found', 'Тест не знайдено')
  return apiData(e)
})
