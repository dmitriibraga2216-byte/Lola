import { requireScope } from '../../../../services/access'
import { upsertCriterion } from '../../../../services/assessment'
import { criterionSchema } from '../../../../../shared/schemas/assessment'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assessment.manage')
  const p = criterionSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте критерій', { issues: p.error.issues })
  const r = await upsertCriterion({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Критерій не знайдено')
  return apiData(r)
})
