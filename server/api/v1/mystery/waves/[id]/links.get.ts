import { requireScope } from '../../../../../services/access'
import { listLinks } from '../../../../../services/mystery'
import { apiData } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'report.tenant')
  return apiData(await listLinks({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!))
})
