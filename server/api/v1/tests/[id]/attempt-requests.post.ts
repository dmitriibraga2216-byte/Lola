import { attemptRequestSchema } from '../../../../../shared/schemas/quizzes'
import { requireScope } from '../../../../services/access'
import { createAttemptRequest } from '../../../../services/attemptRequests'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.attempt')
  const p = attemptRequestSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Опишіть причину (10–300 символів)')
  const r = await createAttemptRequest({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Тест не знайдено')
    if (r.code === 'already_pending') return apiError(event, 409, 'attempt_request.pending', 'Запит уже надіслано — дочекайтеся рішення')
    return apiError(event, 422, 'attempt_request.not_exhausted', 'У вас ще є спроби — запит не потрібен')
  }
  return apiData(r)
})
