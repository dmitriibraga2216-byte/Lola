import { requireScope } from '../../../services/access'
import { pendingAnnouncements } from '../../../services/news'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  return apiData(await pendingAnnouncements({ tenantId: a.tenantId, actorId: a.userId }))
})
