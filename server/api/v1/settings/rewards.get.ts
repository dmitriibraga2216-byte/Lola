import { requireScope } from '../../../services/access'
import { rewardRules } from '../../../services/rewards'
import { apiData } from '../../../utils/apiResponse'

/** GET /settings/rewards — «Правила нарахування» балів і бонусів за виконання завдання (docs/21 §3.7). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  return apiData(await rewardRules({ tenantId: a.tenantId, actorId: a.userId }))
})
