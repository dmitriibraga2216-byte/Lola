import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { listScales } from '../../../services/scales'
import { apiData } from '../../../utils/apiResponse'
/** GET /scales?kind=range|levels (docs/04 §4.16, docs/24 Г-24.4). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.view')
  const kind = z.enum(['range', 'levels']).optional().safeParse(getQuery(event).kind || undefined)
  return apiData(await listScales({ tenantId: a.tenantId, actorId: a.userId }, kind.success ? kind.data : undefined))
})
