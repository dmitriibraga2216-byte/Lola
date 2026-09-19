import { z } from 'zod'
import { requirePlatform } from '../../../../../utils/platformGuard'
import { impersonate } from '../../../../../services/platform'
import { apiData, apiError } from '../../../../../utils/apiResponse'
import { setSessionCookies } from '../../../../../utils/authCookies'
/** Вход «от имени» (docs/01 §1.5): причина обязательна, всё в журналах, cookie тенантской сессии. */
const schema = z.object({ userId: z.string().uuid(), reason: z.string().min(10).max(500) })
export default defineEventHandler(async (event) => {
  const actor = requirePlatform(event)
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть причину (від 10 символів)')
  const r = await impersonate(getRouterParam(event, 'id')!, p.data.userId, p.data.reason, actor)
  if (!r) return apiError(event, 404, 'not_found', 'Користувача не знайдено або неактивний')
  setSessionCookies(event, r.token)
  setCookie(event, 'lola_impersonated', actor.email, { httpOnly: false, sameSite: 'lax', path: '/', maxAge: 3600 })
  return apiData({ ok: true })
})
