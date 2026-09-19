import { requireScope } from '../../../../services/access'
import { oauthDisconnect } from '../../../../services/oauth'
import { providerParam } from './status.get'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.integrations')
  const p = providerParam(event)
  if (!p) return apiError(event, 404, 'not_found', 'Невідомий провайдер')
  await oauthDisconnect({ tenantId: a.tenantId, actorId: a.userId }, p)
  return apiData({ ok: true })
})
