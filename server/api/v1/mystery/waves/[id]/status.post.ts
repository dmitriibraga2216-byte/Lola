import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { setWaveStatus } from '../../../../../services/mystery'
import { apiData, apiError } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'report.tenant')
  const p = z.object({ status: z.enum(['active', 'published', 'closed']) }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть статус')
  const w = await setWaveStatus({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.status)
  if (!w) return apiError(event, 404, 'not_found', 'Хвилю не знайдено')
  return apiData(w)
})
