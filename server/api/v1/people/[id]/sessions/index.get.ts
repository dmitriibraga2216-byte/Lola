import { requireScope } from '../../../../../services/access'
import { listSessions } from '../../../../../services/people'
import { apiData } from '../../../../../utils/apiResponse'

/** Активність: сесії людини (docs/16 §5.2 «Активність»). */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.view')
  return apiData(await listSessions({ tenantId: access.tenantId, actorId: access.userId }, getRouterParam(event, 'id')!))
})
