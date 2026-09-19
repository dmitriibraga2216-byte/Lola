import { attemptRequestDecideSchema } from '../../../../../shared/schemas/quizzes'
import { requireScope } from '../../../../services/access'
import { decideAttemptRequest } from '../../../../services/attemptRequests'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'review.grade')
  const p = attemptRequestDecideSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть рішення')
  const r = await decideAttemptRequest({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Запит не знайдено')
    if (r.code === 'self_decision') return apiError(event, 403, 'attempt_request.self', 'Не можна вирішувати власний запит')
    return apiError(event, 409, 'conflict', 'Рішення щодо запиту вже ухвалено')
  }
  return apiData(r)
})
