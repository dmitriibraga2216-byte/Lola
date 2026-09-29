import { planArchiveSchema } from '../../../../../../shared/schemas/platformPlans'
import { setPlanArchived } from '../../../../../services/platformPlans'
import { apiData, apiError } from '../../../../../utils/apiResponse'
import { requirePlatform } from '../../../../../utils/platformGuard'
import { planError } from '../_errors'

/** POST /platform/plans/:code/restore (docs/24 §4.4.2): повернути з архіву. */
export default defineEventHandler(async (event) => {
  const op = requirePlatform(event, 'billing.plans')
  const p = planArchiveSchema.safeParse((await readBody(event)) ?? {})
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Причина — 10–500 знаків', { issues: p.error.issues })
  const r = await setPlanArchived(op, getRouterParam(event, 'code')!, false, p.data.reason)
  if (!r.ok) return planError(event, r)
  return apiData(r)
})
