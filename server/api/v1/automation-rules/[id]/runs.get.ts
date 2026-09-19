import { requireScope } from '../../../../services/access'
import { listRuns } from '../../../../services/automation'
import { apiData } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  return apiData(await listRuns({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!))
})
