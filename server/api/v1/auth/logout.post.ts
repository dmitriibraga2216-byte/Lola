import type { AuthContext } from '../../../services/session'
import { revokeSession } from '../../../services/session'
import { logSecurity } from '../../../services/securityLog'
import { stopImpersonation } from '../../../services/impersonation'
import { apiData } from '../../../utils/apiResponse'
import { clearSessionCookies } from '../../../utils/authCookies'

export default defineEventHandler(async (event) => {
  const auth = event.context.auth as AuthContext | undefined
  if (auth) {
    // Выход из сессии «от имени» — это `impersonation.ended` (docs/16 §15), а не обычный logout
    if (!(auth.impersonatorAdminId && await stopImpersonation(auth))) {
      await revokeSession(auth)
      await logSecurity({ tenantId: auth.tenantId, userId: auth.userId, event: 'logout' })
    }
  }
  clearSessionCookies(event)
  return apiData({ ok: true })
})
