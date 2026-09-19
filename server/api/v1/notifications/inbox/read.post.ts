import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { markRead } from '../../../../services/notifications'
import { apiData } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = z.object({ ids: z.array(z.string().uuid()).max(100).optional() }).safeParse(await readBody(event) ?? {})
  return apiData({ read: await markRead({ tenantId: a.tenantId, actorId: a.userId }, p.success ? p.data.ids : undefined) })
})
