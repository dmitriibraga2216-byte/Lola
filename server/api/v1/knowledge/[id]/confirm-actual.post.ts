import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { confirmActual } from '../../../../services/knowledge'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** «Підтвердити актуальність» (docs/21 §7.2). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'knowledge.manage')
  const p = z.object({ nextReviewAt: z.string().date().optional() }).safeParse(await readBody(event) ?? {})
  const r = await confirmActual({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.success ? p.data.nextReviewAt : undefined)
  if (!r) return apiError(event, 404, 'not_found', 'Статтю не знайдено')
  return apiData(r)
})
