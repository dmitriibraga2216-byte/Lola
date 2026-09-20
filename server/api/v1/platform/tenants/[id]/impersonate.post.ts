import { impersonateSchema } from '../../../../../../shared/schemas/settings'
import { requirePlatform } from '../../../../../utils/platformGuard'
import { impersonate } from '../../../../../services/platform'
import { apiData, apiError } from '../../../../../utils/apiResponse'
import { setSessionCookies } from '../../../../../utils/authCookies'
/** Вход «от имени» (docs/24 §4.5): причина 10–500 знаков обязательна, сессия 60 минут, всё в журналах, cookie тенантской сессии. */
export default defineEventHandler(async (event) => {
  const actor = requirePlatform(event)
  const p = impersonateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Опишіть причину — це побачить клієнт у своєму журналі (10–500 символів)')
  const r = await impersonate(getRouterParam(event, 'id')!, p.data.userId, p.data.reason, actor)
  if (!r) return apiError(event, 404, 'not_found', 'Користувача не знайдено або неактивний')
  setSessionCookies(event, r.token)
  return apiData({ ok: true, expiresAt: r.expiresAt.toISOString() })
})
