import { tenantSelectSchema } from '../../../../../shared/schemas/auth'
import { usersByPhone } from '../../../../services/authLookup'
import { passwordSelectable } from '../../../../services/password'
import { createSession, verifySelectToken } from '../../../../services/session'
import { logSecurity } from '../../../../services/securityLog'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { clientIp, onHostTenant, setSessionCookies } from '../../../../utils/authCookies'

export default defineEventHandler(async (event) => {
  const parsed = tenantSelectSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    return apiError(event, 400, 'validation_failed', 'Невірний запит')
  }

  const claim = verifySelectToken(parsed.data.selectToken)
  if (!claim) {
    return apiError(event, 401, 'auth_required', 'Сесія вибору протухла. Увійдіть ще раз')
  }

  // Токен выбора выдаётся и после кода (телефон), и после пароля (`pwd:<tenant>/<user>,…` — только учётки,
  // где пароль совпал, docs/04 §4.2). Вход по паролю всё ещё должен быть разрешён и человек не заблокирован.
  const byEmail = claim.phone.startsWith('pwd:')
  const users = byEmail ? await passwordSelectable(claim.phone.slice(4)) : await usersByPhone(claim.phone)
  const user = onHostTenant(event, users as { tenant_id: string, user_id: string }[]).find(u => u.tenant_id === parsed.data.tenantId)
  if (!user) {
    return apiError(event, 404, 'not_found', 'Простір не знайдено')
  }

  const { token, twoFactor } = await createSession({
    tenantId: user.tenant_id,
    userId: user.user_id,
    userAgent: getHeader(event, 'user-agent'),
    ip: clientIp(event),
    loginMethod: byEmail ? 'password' : 'otp',
  })
  setSessionCookies(event, token)

  // Второй фактор (docs/24 §3.4): пространство выбрано, но вход завершит код приложения
  if (twoFactor) return apiData({ ok: true, twoFactor })

  await logSecurity({
    tenantId: user.tenant_id,
    userId: user.user_id,
    event: 'login.success',
    meta: { method: byEmail ? 'password' : 'otp', tenantSelected: true },
    ip: clientIp(event),
    userAgent: getHeader(event, 'user-agent'),
  })

  return apiData({ ok: true, twoFactor: null })
})
