import { requireScope } from '../../../../../services/access'
import { getForm } from '../../../../../services/assessment'
import { apiData, apiError } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assessment.run')
  const r = await getForm({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Анкету не знайдено')
  return apiData(r)
})
