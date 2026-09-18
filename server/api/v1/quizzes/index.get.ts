import { requireScope } from '../../../services/access'
import { listQuizzes } from '../../../services/questions'
import { apiData } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.view')
  return apiData(await listQuizzes({ tenantId: a.tenantId, actorId: a.userId }))
})
