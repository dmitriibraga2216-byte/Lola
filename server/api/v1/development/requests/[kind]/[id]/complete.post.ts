import { z } from 'zod'
import { requireScope } from '../../../../../../services/access'
import { completeExternal } from '../../../../../../services/requests'
import { apiData, apiError } from '../../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.own')
  const p = z.object({ report: z.string().min(10).max(5000) }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Напишіть звіт (від 10 символів)')
  const r = await completeExternal({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.report)
  if (!r) return apiError(event, 404, 'not_found', 'Заявку не знайдено або вона не схвалена')
  return apiData(r)
})
