import { requireScope, can } from '../../../../../services/access'
import { getTask } from '../../../../../services/assessment'
import { apiData, apiError } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assessment.own')
  const r = await getTask({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Завдання не знайдено')
  if (r.task.raterUserId !== a.userId && !can(a, 'assessment.run')) return apiError(event, 403, 'forbidden', 'Це не ваше завдання')
  return apiData(r)
})
