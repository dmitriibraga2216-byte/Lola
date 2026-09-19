import { requireScope, can } from '../../../../services/access'
import { getRun } from '../../../../services/checklists'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'checklist.run')
  const r = await getRun({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, { canSeeUnpublished: can(a, 'report.tenant') })
  if (!r) return apiError(event, 404, 'not_found', 'Прогін не знайдено')
  if (r.observerId !== a.userId && !can(a, 'report.team')) return apiError(event, 403, 'forbidden', 'Немає доступу')
  return apiData(r)
})
