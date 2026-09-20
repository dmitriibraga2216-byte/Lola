import { requireScope } from '../../../services/access'
import { tenantSettings } from '../../../services/settings'
import { apiData } from '../../../utils/apiResponse'
/** GET /settings/modules (docs/24 §3.2): переключатели модулей. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  return apiData((await tenantSettings({ tenantId: a.tenantId, actorId: a.userId })).modules)
})
