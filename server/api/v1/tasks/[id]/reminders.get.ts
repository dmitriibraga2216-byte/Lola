import { requireScope } from '../../../../services/access'
import { getReminders } from '../../../../services/tasks'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const r = await getReminders({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Призначення не знайдено')
  return apiData(r)
})
