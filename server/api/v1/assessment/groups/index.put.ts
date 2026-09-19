import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { upsertGroup } from '../../../../services/assessment'
import { apiData, apiError } from '../../../../utils/apiResponse'
const schema = z.object({ id: z.string().uuid().optional(), name: z.string().min(1).max(120), description: z.string().max(1000).optional(), sort: z.number().int().min(0).max(999).optional(), weight: z.number().min(0.1).max(100).optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assessment.manage')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте групу', { issues: p.error.issues })
  const r = await upsertGroup({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Групу не знайдено')
  return apiData(r)
})
