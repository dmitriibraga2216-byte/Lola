import { recalculateSchema } from '../../../../../shared/schemas/quizzes'
import { requireScope } from '../../../../services/access'
import { recalculateAttempt } from '../../../../services/attempts'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** «Перерахувати» (docs/22 §13.7): по текущему ключу, новая запись результата, снимок не трогается. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'question.manage')
  const p = recalculateSchema.safeParse((await readBody(event).catch(() => ({}))) ?? {})
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Коментар до 500 символів')
  const r = await recalculateAttempt({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.comment)
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Спробу не знайдено')
    return apiError(event, 409, 'attempt.in_progress', 'Спроба ще триває або анульована — перераховувати нічого')
  }
  return apiData(r)
})
