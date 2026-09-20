import type { AuthContext } from '../../../services/session'
import { revokeAllSessions } from '../../../services/session'
import { logSecurity } from '../../../services/securityLog'
import { apiData, apiError } from '../../../utils/apiResponse'
import { clearSessionCookies } from '../../../utils/authCookies'

export default defineEventHandler(async (event) => {
  const auth = event.context.auth as AuthContext | undefined
  if (!auth) return apiError(event, 401, 'auth_required', 'Потрібен вхід')

  const revoked = await revokeAllSessions(auth)
  await logSecurity({
    tenantId: auth.tenantId,
    userId: auth.userId,
    event: 'session.revoked',
    meta: { reason: 'logout_all', revoked },
  })
  clearSessionCookies(event)
  return apiData({ revoked })
})
