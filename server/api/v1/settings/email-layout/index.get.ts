import { requireScope } from '../../../../services/access'
import { tenantSettings } from '../../../../services/settings'
import { apiData } from '../../../../utils/apiResponse'
/** GET /settings/email-layout (docs/23 §13.5 `/notifications/email-template-settings`): шапка/підвал/лого листа. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  return apiData((await tenantSettings({ tenantId: a.tenantId, actorId: a.userId })).emailLayout)
})
