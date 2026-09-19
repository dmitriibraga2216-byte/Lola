import { requireScope } from '../../../services/access'
import { sendTest } from '../../../services/notifications'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  return apiData({ queued: await sendTest({ tenantId: a.tenantId, actorId: a.userId }) })
})
