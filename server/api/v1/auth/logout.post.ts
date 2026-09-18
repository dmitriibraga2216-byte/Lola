import type { AuthContext } from '../../../services/session'
import { revokeSession } from '../../../services/session'
import { logSecurity } from '../../../services/securityLog'
import { apiData } from '../../../utils/apiResponse'
import { clearSessionCookies } from '../../../utils/authCookies'

export default defineEventHandler(async (event) => {
  const auth = event.context.auth as AuthContext | undefined
  if (auth) {
    await revokeSession(auth)
    await logSecurity({ tenantId: auth.tenantId, userId: auth.userId, event: 'logout' })
  }
  clearSessionCookies(event)
  return apiData({ ok: true })
})
