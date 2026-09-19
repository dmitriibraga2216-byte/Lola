import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { listNotifications } from '../../../services/notifications'
import { apiData } from '../../../utils/apiResponse'
const q = z.object({ userId: z.string().uuid().optional(), status: z.string().optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'audit.view')
  return apiData(await listNotifications({ tenantId: a.tenantId, actorId: a.userId }, q.parse(getQuery(event))))
})
