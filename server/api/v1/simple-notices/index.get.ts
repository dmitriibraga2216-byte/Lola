import { can, requireScope } from '../../../services/access'
import { listSimpleNotices } from '../../../services/notices'
import { apiData } from '../../../utils/apiResponse'

/** GET /simple-notices — управляющему все (?all=1), остальным — действующие плашки. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const all = can(a, 'knowledge.manage') && getQuery(event).all === '1'
  return apiData(await listSimpleNotices({ tenantId: a.tenantId, actorId: a.userId }, { activeOnly: !all }))
})
