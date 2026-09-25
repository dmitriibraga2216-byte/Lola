import { requireScope } from '../../../../services/access'
import { getProvider } from '../../../../services/ai/providers'
import { apiData } from '../../../../utils/apiResponse'
import { providerFail } from '../../../../utils/aiErrors'

/** GET /ai/providers/:id — профиль (`docs/v2/30` §10). Чужой тенант — `404` (CLAUDE.md п. 15). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'ai.audit')
  const p = await getProvider({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  return p ? apiData(p) : providerFail(event, 'not_found')
})
