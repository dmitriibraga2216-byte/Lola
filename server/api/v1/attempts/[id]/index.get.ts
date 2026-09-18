import { requireScope } from '../../../../services/access'
import { getAttemptState } from '../../../../services/attempts'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** Состояние без эталонов — проверяется тестом attempt-leak. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.attempt')
  const s = await getAttemptState({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!s) return apiError(event, 404, 'not_found', 'Спробу не знайдено')
  return apiData(s)
})
