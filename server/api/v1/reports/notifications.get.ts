import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { notificationsReport } from '../../../services/notifications'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.notifications')
  const q = z.object({ from: z.string().date().optional(), to: z.string().date().optional() }).parse(getQuery(event))
  return apiData(await notificationsReport({ tenantId: a.tenantId, actorId: a.userId }, q))
})
