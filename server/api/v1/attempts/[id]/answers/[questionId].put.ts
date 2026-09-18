import { answerSchema } from '../../../../../../shared/schemas/quizzes'
import { requireScope } from '../../../../../services/access'
import { saveAnswer } from '../../../../../services/attempts'
import { apiData, apiError } from '../../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.attempt')
  const p = answerSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Невірна відповідь')
  const r = await saveAnswer({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, getRouterParam(event, 'questionId')!, p.data.answer, p.data.timeSpentSec)
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Питання не знайдено')
    if (r.code === 'deadline') return apiError(event, 423, 'attempt.deadline', 'Час вийшов')
    return apiError(event, 423, 'attempt.locked', 'Спроба вже завершена')
  }
  return apiData({ ok: true })
})
