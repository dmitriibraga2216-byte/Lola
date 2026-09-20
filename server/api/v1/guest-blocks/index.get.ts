import { requireScope } from '../../../services/access'
import { getGuestBlocks } from '../../../services/hubExtra'
import { apiData } from '../../../utils/apiResponse'

/** GET /guest-blocks — гостевая страница тенанта (docs/04 §4.13, docs/21 Г-21.3). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  return apiData(await getGuestBlocks({ tenantId: a.tenantId, actorId: a.userId }))
})
