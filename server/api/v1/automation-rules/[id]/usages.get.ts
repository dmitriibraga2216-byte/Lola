import { requireScope } from '../../../../services/access'
import { ruleUsages } from '../../../../services/automation'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** «Використовується для»: траектории, программы, назначения (docs/04 §4.10). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const r = await ruleUsages({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Правило не знайдено')
  return apiData(r)
})
