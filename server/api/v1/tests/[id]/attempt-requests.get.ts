import { requireScope } from '../../../../services/access'
import { myAttemptRequests } from '../../../../services/attemptRequests'
import { apiData } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.attempt')
  return apiData(await myAttemptRequests({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!))
})
