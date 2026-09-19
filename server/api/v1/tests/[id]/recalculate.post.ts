import { recalculateSchema } from '../../../../../shared/schemas/quizzes'
import { requireScope } from '../../../../services/access'
import { recalculateQuiz } from '../../../../services/attempts'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** «Перерахувати» все завершённые попытки теста после правки ключа. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'question.manage')
  const p = recalculateSchema.safeParse((await readBody(event).catch(() => ({}))) ?? {})
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Коментар до 500 символів')
  const r = await recalculateQuiz({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.comment)
  if (!r) return apiError(event, 404, 'not_found', 'Тест не знайдено')
  return apiData(r)
})
