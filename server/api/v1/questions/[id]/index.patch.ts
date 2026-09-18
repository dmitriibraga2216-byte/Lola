import { questionUpdateSchema } from '../../../../../shared/schemas/quizzes'
import { requireScope } from '../../../../services/access'
import { updateQuestion } from '../../../../services/questions'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'question.manage')
  const p = questionUpdateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте питання', { issues: p.error.issues })
  const q = await updateQuestion({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!q) return apiError(event, 404, 'not_found', 'Питання не знайдено')
  return apiData(q)
})
