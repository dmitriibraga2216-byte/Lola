import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { registerOthers } from '../../../../services/meetups'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'meetup.attendance')
  const p = z.object({ userIds: z.array(z.string().uuid()).min(1).max(200) }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Оберіть людей')
  return apiData(await registerOthers({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.userIds))
})
