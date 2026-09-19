import { requireScope } from '../../../../../services/access'
import { listDeliveries } from '../../../../../services/webhooks'
import { apiData } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.integrations')
  return apiData(await listDeliveries({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!))
})
