import { requireScope } from '../../../../services/access'
import { authUrl } from '../../../../services/oauth'
import { providerParam } from './status.get'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.integrations')
  const p = providerParam(event)
  if (!p) return apiError(event, 404, 'not_found', 'Невідомий провайдер')
  const r = await authUrl({ tenantId: a.tenantId, actorId: a.userId }, p)
  if ('error' in r) return apiError(event, 409, 'not_configured', 'Інтеграцію не налаштовано. Зверніться до адміністратора Lola')
  return apiData(r)
})
