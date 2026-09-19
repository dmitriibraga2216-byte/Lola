import { requireScope } from '../../../../services/access'
import { getChecklist } from '../../../../services/checklists'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'checklist.run')
  const r = await getChecklist({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Чек-лист не знайдено')
  return apiData(r)
})
