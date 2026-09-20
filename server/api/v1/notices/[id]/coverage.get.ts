import { requireScope } from '../../../../services/access'
import { coverage } from '../../../../services/notices'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** GET /notices/:id/coverage — кто подтвердил, кто нет, по точкам (docs/04 §4.13). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'knowledge.manage')
  const r = await coverage({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Оголошення не знайдено')
  return apiData(r)
})
