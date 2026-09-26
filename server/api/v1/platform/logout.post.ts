import { PLATFORM_COOKIE } from '../../../middleware/01.session'
import { revokePlatformSession } from '../../../services/platform'
import { apiData } from '../../../utils/apiResponse'
import { clearPlatformCookie } from '../../../utils/authCookies'

/** POST /platform/logout — сессия оператора гаснет в базе, cookie снимается. */
export default defineEventHandler(async (event) => {
  const token = getCookie(event, PLATFORM_COOKIE)
  if (token) await revokePlatformSession(token)
  clearPlatformCookie(event)
  return apiData({ ok: true })
})
