import { requireScope } from '../../../../../services/access'
import { submissionForReview } from '../../../../../services/workshops'
import { apiData, apiError } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'review.queue')
  const r = await submissionForReview({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Роботу не знайдено')
  return apiData(r)
})
