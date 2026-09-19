import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { addGoalComment } from '../../../../../services/development'
import { apiData, apiError } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.own')
  const p = z.object({ body: z.string().min(1).max(2000) }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Порожній коментар')
  return apiData(await addGoalComment({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.body))
})
