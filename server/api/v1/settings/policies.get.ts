import { requireScope } from '../../../services/access'
import { tenantSettings } from '../../../services/settings'
import { apiData } from '../../../utils/apiResponse'
/** GET /settings/policies (docs/24 §3.4, §3.4.1): десять групп эталона + сессии/OTP, с дефолтами. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  return apiData((await tenantSettings({ tenantId: a.tenantId, actorId: a.userId })).policies)
})
