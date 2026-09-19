import { requireScope } from '../../../../../services/access'
import { disconnect, SECRET_KEYS, type Provider } from '../../../../../services/secrets'
import { apiData, apiError } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.integrations')
  const provider = getRouterParam(event, 'provider') as Provider
  if (!(provider in SECRET_KEYS)) return apiError(event, 404, 'not_found', 'Невідома інтеграція')
  await disconnect({ tenantId: a.tenantId, actorId: a.userId }, provider)
  return apiData({ ok: true })
})
