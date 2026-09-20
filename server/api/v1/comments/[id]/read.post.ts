import { requireScope } from '../../../../services/access'
import { markCommentRead } from '../../../../services/comments'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.view')
  const ok = await markCommentRead({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!ok) return apiError(event, 404, 'not_found', 'Коментар не знайдено')
  return apiData({ ok: true })
})
