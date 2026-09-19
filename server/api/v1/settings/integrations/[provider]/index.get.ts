import { requireScope } from '../../../../../services/access'
import { integrationStatus, SECRET_KEYS, type Provider } from '../../../../../services/secrets'
import { apiData, apiError } from '../../../../../utils/apiResponse'
/** docs/09 §9.2 шаг 1: is_configured() — два разных ответа: ключи есть / аккаунт подключён. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.integrations')
  const provider = getRouterParam(event, 'provider') as Provider
  if (!(provider in SECRET_KEYS)) return apiError(event, 404, 'not_found', 'Невідома інтеграція')
  return apiData(await integrationStatus({ tenantId: a.tenantId, actorId: a.userId }, provider))
})
