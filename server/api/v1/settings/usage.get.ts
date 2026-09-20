import { requireScope } from '../../../services/access'
import { usageView } from '../../../services/usage'
import { apiData } from '../../../utils/apiResponse'
/** GET /settings/usage (docs/24 §4.4.1, мокап TenantStats): последний сбор, тариф, лимиты, история. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  return apiData(await usageView({ tenantId: a.tenantId, actorId: a.userId }))
})
