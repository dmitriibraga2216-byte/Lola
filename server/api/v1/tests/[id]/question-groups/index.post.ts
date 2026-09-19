import { questionGroupSchema } from '../../../../../../shared/schemas/quizzes'
import { requireScope } from '../../../../../services/access'
import { createGroup } from '../../../../../services/questions'
import { apiData, apiError } from '../../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'question.manage')
  const p = questionGroupSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть назву групи (до 120 символів)')
  const g = await createGroup({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!g) return apiError(event, 404, 'not_found', 'Тест не знайдено')
  return apiData(g)
})
