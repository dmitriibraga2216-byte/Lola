import { requireScope } from '../../../../../services/access'
import { cycleMonitor } from '../../../../../services/assessment'
import { apiData, apiError } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assessment.run')
  const r = await cycleMonitor({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Цикл не знайдено')
  return apiData(r)
})
