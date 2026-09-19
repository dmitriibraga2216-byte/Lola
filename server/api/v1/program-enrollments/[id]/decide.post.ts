import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { decideRequest } from '../../../../services/programs'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const p = z.object({ approve: z.boolean() }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть рішення')
  const r = await decideRequest({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.approve)
  if (!r) return apiError(event, 404, 'not_found', 'Заявку не знайдено')
  return apiData(r)
})
