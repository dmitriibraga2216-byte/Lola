import { requireScope } from '../../../../services/access'
import { getRule } from '../../../../services/automation'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const r = await getRule({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Правило не знайдено')
  return apiData(r)
})
