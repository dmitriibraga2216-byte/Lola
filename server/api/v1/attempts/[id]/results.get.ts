import { requireScope } from '../../../../services/access'
import { listAttemptResults } from '../../../../services/attempts'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'review.queue')
  const r = await listAttemptResults({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Спробу не знайдено')
  return apiData(r)
})
