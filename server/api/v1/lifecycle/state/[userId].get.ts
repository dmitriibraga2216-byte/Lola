import { requireScope } from '../../../../services/access'
import { personState } from '../../../../services/lifecycleState'
import { previousPeriods } from '../../../../services/offboarding'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * GET /lifecycle/state/:userId — текущий этап и история (docs/v2/33 §5.3, §10).
 * Вместе с ними — прошлые периоды работы: блок «Попередній період роботи» (§7.8).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'lifecycle.view')
  const userId = getRouterParam(event, 'userId')!
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  const state = await personState(ctx, userId)
  if (!state) return apiError(event, 404, 'not_found', 'Людину не знайдено')
  return apiData({ ...state, previousPeriods: await previousPeriods(ctx, userId) })
})
