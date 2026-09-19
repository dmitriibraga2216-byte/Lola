import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { revisionDiff } from '../../../../services/wiki'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const q = z.object({ from: z.coerce.number().int().min(1), to: z.coerce.number().int().min(1) }).safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Вкажіть версії')
  const r = await revisionDiff({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, q.data.from, q.data.to)
  if (!r) return apiError(event, 404, 'not_found', 'Версію не знайдено')
  return apiData(r)
})
