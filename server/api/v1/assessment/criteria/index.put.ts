import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { upsertCriterion } from '../../../../services/assessment'
import { apiData, apiError } from '../../../../utils/apiResponse'
const schema = z.object({ id: z.string().uuid().optional(), groupId: z.string().uuid(), text: z.string().min(3).max(300), description: z.string().max(1000).optional(), scaleId: z.string().uuid(), weight: z.number().min(0.1).max(100).optional(), isCritical: z.boolean().optional(), requiresCommentBelow: z.number().nullable().optional(), competencyId: z.string().uuid().nullable().optional(), requiresPhoto: z.boolean().optional(), sort: z.number().int().optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assessment.manage')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте критерій', { issues: p.error.issues })
  const r = await upsertCriterion({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Критерій не знайдено')
  return apiData(r)
})
