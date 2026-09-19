import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { feedback } from '../../../../services/knowledge'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** «Чи було корисно?» (docs/21 §5.2). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = z.object({ helpful: z.boolean(), comment: z.string().max(1000).optional() }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Оберіть відповідь')
  const r = await feedback({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.helpful, p.data.comment)
  if (!r) return apiError(event, 404, 'not_found', 'Статтю не знайдено')
  return apiData(r)
})
