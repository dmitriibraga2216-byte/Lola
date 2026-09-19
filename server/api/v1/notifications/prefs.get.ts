import { requireScope } from '../../../services/access'
import { listPrefs } from '../../../services/notifications'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  return apiData(await listPrefs({ tenantId: a.tenantId, actorId: a.userId }))
})
