import { z } from 'zod'
import { platformLogin } from '../../../services/platform'
import { hitRateLimit } from '../../../services/rateLimit'
import { PLATFORM_COOKIE } from '../../../middleware/01.session'
import { apiData, apiError } from '../../../utils/apiResponse'
import { clientIp } from '../../../utils/authCookies'
const schema = z.object({ email: z.string().email(), password: z.string().min(8) })
export default defineEventHandler(async (event) => {
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'E-mail і пароль')
  if (!await hitRateLimit(`ops:login:${clientIp(event)}`, 10, 900)) return apiError(event, 429, 'rate_limited', 'Забагато спроб')
  const r = await platformLogin(p.data.email, p.data.password)
  if (!r) return apiError(event, 401, 'auth_required', 'Невірний e-mail або пароль')
  setCookie(event, PLATFORM_COOKIE, r.token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 12 * 3600, path: '/' })
  return apiData({ ok: true })
})
