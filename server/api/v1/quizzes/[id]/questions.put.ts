import { quizQuestionsSchema } from '../../../../../shared/schemas/quizzes'
import { requireScope } from '../../../../services/access'
import { setQuizQuestions } from '../../../../services/questions'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'question.manage')
  const p = quizQuestionsSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Невірний склад тесту', { issues: p.error.issues })
  const q = await setQuizQuestions({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.items)
  if (!q) return apiError(event, 404, 'not_found', 'Тест не знайдено')
  return apiData(q)
})
