import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { upsertScale } from '../../../services/assessment'
import { apiData, apiError } from '../../../utils/apiResponse'
const schema = z.object({ id: z.string().uuid().optional(), name: z.string().min(1).max(100), kind: z.enum(['binary', 'ordinal', 'percent', 'letters']), options: z.array(z.object({ value: z.number(), label: z.string().min(1).max(60), color: z.enum(['coral', 'sun', 'teal', 'muted']).optional() })).min(2).max(12), passThreshold: z.number().nullable().optional(), allowNa: z.boolean().optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assessment.manage')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте шкалу', { issues: p.error.issues })
  const r = await upsertScale({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Шкалу не знайдено')
  return apiData(r)
})
