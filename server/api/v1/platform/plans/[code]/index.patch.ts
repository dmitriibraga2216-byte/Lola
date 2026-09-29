import { planUpdateSchema } from '../../../../../../shared/schemas/platformPlans'
import { updatePlan } from '../../../../../services/platformPlans'
import { apiData, apiError } from '../../../../../utils/apiResponse'
import { requirePlatform } from '../../../../../utils/platformGuard'
import { planError } from '../_errors'

/**
 * PATCH /platform/plans/:code (docs/24 §4.4.2): правка тарифа. Есть компании — нужна причина;
 * ужесточённый лимит им закрепляется прежним значением (docs/v2/44 В-21).
 */
export default defineEventHandler(async (event) => {
  const op = requirePlatform(event, 'billing.plans')
  const p = planUpdateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте поля тарифу', { issues: p.error.issues })
  const r = await updatePlan(op, getRouterParam(event, 'code')!, p.data)
  if (!r.ok) return planError(event, r)
  return apiData(r)
})
