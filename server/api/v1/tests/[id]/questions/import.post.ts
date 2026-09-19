import { questionsImportSchema } from '../../../../../../shared/schemas/quizzes'
import { requireScope } from '../../../../../services/access'
import { importQuestions } from '../../../../../services/questions'
import { apiData, apiError } from '../../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'question.manage')
  const p = questionsImportSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Оберіть питання для додавання', { issues: p.error.issues })
  const r = await importQuestions({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Тест не знайдено')
    if (r.code === 'group_not_found') return apiError(event, 404, 'not_found', 'Групу питань не знайдено')
    return apiError(event, 404, 'not_found', 'Частину питань не знайдено — оновіть список і спробуйте ще раз')
  }
  return apiData(r)
})
