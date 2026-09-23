import { requireScope } from '../../../services/access'
import { recruitingSettings } from '../../../services/settings'
import { apiData } from '../../../utils/apiResponse'

/** GET /settings/recruiting — флаг модуля и его сроки (docs/v2/28 §7.5, §7.9). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  return apiData(await recruitingSettings({ tenantId: a.tenantId, actorId: a.userId }))
})
