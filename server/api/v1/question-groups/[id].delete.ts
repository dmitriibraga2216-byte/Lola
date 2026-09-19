import { requireScope } from '../../../services/access'
import { deleteGroup } from '../../../services/questions'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'question.manage')
  const g = await deleteGroup({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!g) return apiError(event, 404, 'not_found', 'Групу не знайдено')
  return apiData(g)
})
