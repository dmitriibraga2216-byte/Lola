import { attemptRequestsQuerySchema } from '../../../../shared/schemas/quizzes'
import { requireScope } from '../../../services/access'
import { listAttemptRequests } from '../../../services/attemptRequests'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'review.grade')
  const p = attemptRequestsQuerySchema.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Невірний фільтр')
  return apiData(await listAttemptRequests({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
