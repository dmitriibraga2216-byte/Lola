import { commentsQuerySchema } from '../../../../shared/schemas/catalog'
import { requireScope } from '../../../services/access'
import { listComments } from '../../../services/comments'
import { apiData, apiError } from '../../../utils/apiResponse'

/** GET /comments — єдина стрічка коментарів (докс/10 §14.2, мокап Comments). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.view')
  const p = commentsQuerySchema.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте фільтри')
  return apiData(await listComments({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
