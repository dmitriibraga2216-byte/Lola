import type { AuthContext } from '../../../../services/session'
import { stopImpersonation } from '../../../../services/impersonation'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { clearSessionCookies } from '../../../../utils/authCookies'
/** POST /auth/impersonation/stop — кнопка «Вихід» на плашке (docs/24 §4.5): сессия отзывается, `impersonation.ended`. */
export default defineEventHandler(async (event) => {
  const auth = event.context.auth as AuthContext | undefined
  if (!auth?.impersonatorAdminId) return apiError(event, 400, 'not_impersonated', 'Ця сесія не є входом «від імені»')
  await stopImpersonation(auth)
  clearSessionCookies(event)
  return apiData({ ok: true })
})
