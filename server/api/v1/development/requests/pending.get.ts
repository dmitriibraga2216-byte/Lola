import { requireScope, can } from '../../../../services/access'
import { pendingRequests } from '../../../../services/requests'
import { apiData } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'request.decide')
  return apiData(await pendingRequests({ tenantId: a.tenantId, actorId: a.userId }, { isHr: can(a, 'development.manage'), isAdmin: can(a, 'settings.tenant') }))
})
