import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { listSessions } from '../../../../../services/meetupSessions'
import { apiData } from '../../../../../utils/apiResponse'

/** GET /meetups/:id/sessions — список сесій заняття/вебінару (docs/18 §14.1), опційно по призначенню. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'meetup.view')
  const q = z.object({ taskId: z.string().uuid().optional() }).parse(getQuery(event))
  return apiData(await listSessions({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, q))
})
