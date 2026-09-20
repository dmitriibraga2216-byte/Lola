import { requireScope } from '../../../services/access'
import { tenantSpace } from '../../../services/settings'
import { apiData } from '../../../utils/apiResponse'
/** GET /settings/tenant (docs/24 §3.1, §9): простір, бренд, slug, модули, значения по умолчанию. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  return apiData(await tenantSpace({ tenantId: a.tenantId, actorId: a.userId }))
})
