import { quizSchema } from '../../../../shared/schemas/quizzes'
import { requireScope } from '../../../services/access'
import { createQuiz } from '../../../services/questions'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'question.manage')
  const p = quizSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте поля тесту', { issues: p.error.issues })
  return apiData(await createQuiz({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
