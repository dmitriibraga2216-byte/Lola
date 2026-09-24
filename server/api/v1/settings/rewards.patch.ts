import { rewardRulesPatchSchema } from '../../../../shared/schemas/settings'
import { requireScope } from '../../../services/access'
import { updateRewardRules } from '../../../services/rewards'
import { apiData, apiError } from '../../../utils/apiResponse'

/** PATCH /settings/rewards — правка правил по типах контенту; зміни — в audit_log. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const p = rewardRulesPatchSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Бали й бонуси — цілі числа від 0 до 10000', { issues: p.error.issues })
  return apiData(await updateRewardRules({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
