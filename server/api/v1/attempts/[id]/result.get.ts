import { requireScope } from '../../../../services/access'
import { getAttemptResult } from '../../../../services/attempts'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.attempt')
  const r = await getAttemptResult({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Спробу не знайдено')
  if (r.locked) return apiError(event, 423, 'attempt.locked', 'Спроба ще триває')
  return apiData(r)
})
