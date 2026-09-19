import { requireScope } from '../../../../../services/access'
import { claim } from '../../../../../services/workshops'
import { apiData, apiError } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'review.grade')
  const r = await claim({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r.ok) {
    if (r.code === 'already_claimed') return apiError(event, 409, 'already_claimed', 'Роботу вже взяв інший наставник')
    if (r.code === 'self_review') return apiError(event, 403, 'review.self', 'Не можна перевіряти власну роботу')
    return apiError(event, 404, 'not_found', 'Роботу не знайдено')
  }
  return apiData(r)
})
