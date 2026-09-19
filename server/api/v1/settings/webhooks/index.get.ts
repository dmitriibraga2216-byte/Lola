import { requireScope } from '../../../../services/access'
import { listEndpoints, WEBHOOK_EVENTS } from '../../../../services/webhooks'
import { apiData } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.integrations')
  return apiData({ endpoints: await listEndpoints({ tenantId: a.tenantId, actorId: a.userId }), events: WEBHOOK_EVENTS })
})
