import { requireScope } from '../../../../../services/access'
import { programLadder } from '../../../../../services/programs'
import { apiData, apiError } from '../../../../../utils/apiResponse'
/** Лента шагов человека (docs/17 §5.2); :id — program_enrollment. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const r = await programLadder({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Програму не знайдено')
  return apiData(r)
})
