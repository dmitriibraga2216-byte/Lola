import { questionGroupUpdateSchema } from '../../../../shared/schemas/quizzes'
import { requireScope } from '../../../services/access'
import { updateGroup } from '../../../services/questions'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'question.manage')
  const p = questionGroupUpdateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте назву групи')
  const g = await updateGroup({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!g) return apiError(event, 404, 'not_found', 'Групу не знайдено')
  return apiData(g)
})
