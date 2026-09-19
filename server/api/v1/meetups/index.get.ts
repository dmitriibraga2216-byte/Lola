import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { schedule } from '../../../services/meetups'
import { apiData } from '../../../utils/apiResponse'
/** GET /meetups — расписание с фильтрами (docs/18 §10 /meetups/schedule). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'meetup.view')
  const q = z.object({ from: z.string().optional(), to: z.string().optional(), mine: z.coerce.boolean().optional(), kind: z.enum(['meetup', 'webinar']).optional(), locationId: z.string().uuid().optional() }).parse(getQuery(event))
  return apiData(await schedule({ tenantId: a.tenantId, actorId: a.userId }, q))
})
