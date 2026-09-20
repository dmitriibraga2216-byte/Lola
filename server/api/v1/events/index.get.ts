import { can, requireScope } from '../../../services/access'
import { listEvents, listEventsForUser } from '../../../services/hubExtra'
import { apiData } from '../../../utils/apiResponse'

/** GET /events — управляющему (?all=1) полный список, остальным — афиша, куда запрошены (docs/21 §10). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  const all = can(a, 'meetup.manage') && getQuery(event).all === '1'
  return apiData(all ? await listEvents(ctx) : await listEventsForUser(ctx))
})
