import { requireScope } from '../../../../../services/access'
import { revokeToken } from '../../../../../services/apiTokens'
import { apiData, apiError } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.integrations')
  const r = await revokeToken({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Токен не знайдено')
  return apiData({ ok: true })
})
