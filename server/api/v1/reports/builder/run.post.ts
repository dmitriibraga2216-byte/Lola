import { z } from 'zod'
import { reportScope, requireScope } from '../../../../services/access'
import { runReport } from '../../../../services/reportBuilder'
import { apiData, apiError } from '../../../../utils/apiResponse'
export const specSchema = z.object({ entity: z.enum(['people', 'enrollments', 'attempts']), fields: z.array(z.string().regex(/^[a-z_]+$/)).min(1).max(20), filters: z.record(z.unknown()).optional(), groupBy: z.string().regex(/^[a-z_]+$/).nullable().optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'report.builder')
  const p = specSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте звіт', { issues: p.error.issues })
  return apiData(await runReport({ tenantId: a.tenantId, actorId: a.userId }, p.data, 500, await reportScope(a, 'report.team')))
})
