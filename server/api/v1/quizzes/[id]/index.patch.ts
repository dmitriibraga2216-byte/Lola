import { quizUpdateSchema } from '../../../../../shared/schemas/quizzes'
import { requireScope } from '../../../../services/access'
import { updateQuiz } from '../../../../services/questions'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'question.manage')
  const p = quizUpdateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте поля тесту', { issues: p.error.issues })
  const q = await updateQuiz({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!q) return apiError(event, 404, 'not_found', 'Тест не знайдено')
  if (q === 'kind_locked') return apiError(event, 409, 'quiz.kind_locked', 'Вид «Співбесіда» не змінюється, поки за тестом є спроби. Створіть новий тест')
  return apiData(q)
})
