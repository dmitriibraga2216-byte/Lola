import { planCreateSchema } from '../../../../../shared/schemas/platformPlans'
import { createPlan } from '../../../../services/platformPlans'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { requirePlatform } from '../../../../utils/platformGuard'
import { planError } from './_errors'

/** POST /platform/plans (docs/24 §4.4.2): новый тариф сетки — только колонки `plans`. */
export default defineEventHandler(async (event) => {
  const op = requirePlatform(event, 'billing.plans')
  const p = planCreateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте код, назву й ліміти тарифу', { issues: p.error.issues })
  const r = await createPlan(op, p.data)
  if (!r.ok) return planError(event, r)
  return apiData(r.plan)
})
