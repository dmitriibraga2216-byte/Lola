import { commentReplySchema } from '../../../../../shared/schemas/catalog'
import { requireScope } from '../../../../services/access'
import { replyToComment } from '../../../../services/comments'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** POST /comments/:id/reply — відповідь прямо зі стрічки (докс/10 §14.2, наше рішення). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.view')
  const p = commentReplySchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Введіть відповідь')
  const r = await replyToComment({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.body)
  if (!r.ok) return apiError(event, 404, 'not_found', 'Коментар не знайдено')
  return apiData(r)
})
