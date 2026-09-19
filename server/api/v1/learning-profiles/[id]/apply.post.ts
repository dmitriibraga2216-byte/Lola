import { requireScope } from '../../../../services/access'
import { applyProfile } from '../../../../services/automation'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.publish')
  const r = await applyProfile({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Профіль не знайдено або вимкнений')
  return apiData(r)
})
