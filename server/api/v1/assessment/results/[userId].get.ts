import { z } from 'zod'
import { requireScope, can } from '../../../../services/access'
import { resultsFor } from '../../../../services/assessment'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assessment.own')
  const userId = getRouterParam(event, 'userId')!
  const asManager = can(a, 'assessment.team')
  if (userId !== a.userId && !asManager) return apiError(event, 403, 'forbidden', 'Немає доступу до чужих результатів')
  const q = z.object({ cycleId: z.string().uuid() }).safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Вкажіть cycleId')
  const r = await resultsFor({ tenantId: a.tenantId, actorId: a.userId }, userId, q.data.cycleId, { asManager: asManager && userId !== a.userId })
  if (!r) return apiError(event, 404, 'not_found', 'Результатів немає')
  return apiData(r)
})
