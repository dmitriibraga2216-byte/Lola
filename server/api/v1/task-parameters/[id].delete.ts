import { requireScope } from '../../../services/access'
import { deleteTaskParameter } from '../../../services/tasks'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const ok = await deleteTaskParameter({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!ok) return apiError(event, 404, 'not_found', 'Параметр не знайдено')
  return apiData({ ok: true })
})
