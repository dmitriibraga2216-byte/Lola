import { annulSchema } from '../../../../../shared/schemas/quizzes'
import { requireScope } from '../../../../services/access'
import { annulAttempt } from '../../../../services/attempts'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'review.grade')
  const p = annulSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть причину (5–500 символів)')
  const r = await annulAttempt({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.reason)
  if (!r) return apiError(event, 404, 'not_found', 'Спробу не знайдено')
  return apiData(r)
})
