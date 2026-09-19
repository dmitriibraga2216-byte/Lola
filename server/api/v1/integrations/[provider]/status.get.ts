import { requireScope } from '../../../../services/access'
import { oauthStatus } from '../../../../services/oauth'
import type { OAuthProvider } from '../../../../services/oauth'
import { apiData, apiError } from '../../../../utils/apiResponse'
export const providerParam = (event: Parameters<typeof getRouterParam>[0]): OAuthProvider | null => {
  const p = getRouterParam(event, 'provider')
  return p === 'google' || p === 'zoom' ? p : null
}
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.integrations')
  const p = providerParam(event)
  if (!p) return apiError(event, 404, 'not_found', 'Невідомий провайдер')
  return apiData(await oauthStatus({ tenantId: a.tenantId, actorId: a.userId }, p))
})
