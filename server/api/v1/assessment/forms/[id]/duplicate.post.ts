import { requireScope } from '../../../../../services/access'
import { duplicateForm } from '../../../../../services/assessment'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** «Дублювати новою версією» замороженої анкети (docs/20 §14.4, docs/33 D-038). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assessment.manage')
  const r = await duplicateForm({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Анкету не знайдено')
  return apiData(r)
})
