import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { competencyHistory } from '../../../services/developmentExtra'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.team')
  const q = z.object({ userId: z.string().uuid(), competencyId: z.string().uuid() }).safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Вкажіть людину і компетенцію')
  return apiData(await competencyHistory({ tenantId: a.tenantId, actorId: a.userId }, q.data.userId, q.data.competencyId))
})
