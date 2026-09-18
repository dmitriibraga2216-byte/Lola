import { questionSchema } from '../../../../shared/schemas/quizzes'
import { requireScope } from '../../../services/access'
import { createQuestion } from '../../../services/questions'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'question.manage')
  const p = questionSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте питання', { issues: p.error.issues })
  return apiData(await createQuestion({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
