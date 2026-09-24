import { can, requireScope } from '../../../../services/access'
import { listTokens } from '../../../../services/apiTokens'
import { SCOPES, SESSION_ONLY_SCOPES, isSessionOnlyScope } from '../../../../../shared/domain/roles'
import { apiData } from '../../../../utils/apiResponse'

/**
 * GET /settings/api-tokens (docs/09 §9.6): токены и скоупы, которые **можно** выдать токену —
 * без `sessionOnly` (docs/v2/44 В-20) и без прав, которых нет у выдающего (docs/24 Г-24.1).
 * Те же два правила сервер проверяет при выдаче (`createToken`); список для формы — только подсказка.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.integrations')
  return apiData({
    tokens: await listTokens({ tenantId: a.tenantId, actorId: a.userId }),
    scopes: SCOPES.filter(s => !isSessionOnlyScope(s) && can(a, s)),
    sessionOnly: SESSION_ONLY_SCOPES,
  })
})
