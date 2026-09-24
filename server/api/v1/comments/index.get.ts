import { commentsQuerySchema } from '../../../../shared/schemas/catalog'
import { requireScope } from '../../../services/access'
import { listComments } from '../../../services/comments'
import { apiError } from '../../../utils/apiResponse'

/** GET /comments — єдина стрічка коментарів (докс/10 §14.2, мокап Comments); `meta.cursor` — наступна сторінка. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.view')
  const p = commentsQuerySchema.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте фільтри', { issues: p.error.issues })
  const page = await listComments({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  return { data: page.items, meta: { cursor: page.cursor, limit: p.data.limit } }
})
