import { requireScope } from '../../../../services/access'
import { ruleUsers } from '../../../../services/automation'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** «Список користувачів» — кто подпадает под правило прямо сейчас (docs/15 §3.6). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const r = await ruleUsers({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Правило не знайдено')
  return apiData(r)
})
