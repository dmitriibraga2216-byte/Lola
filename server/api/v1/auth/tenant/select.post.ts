import { tenantSelectSchema } from '../../../../../shared/schemas/auth'
import { usersByPhone } from '../../../../services/authLookup'
import { usersByEmail } from '../../../../services/password'
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

  // Токен выбора выдаётся и после кода (телефон), и после пароля (`email:<адрес>`, docs/04 §4.2)
  const byEmail = claim.phone.startsWith('email:')
  const users = byEmail ? (await usersByEmail(claim.phone.slice(6))).filter(u => u.password_login_enabled && !u.is_blocked) : await usersByPhone(claim.phone)
  const user = onHostTenant(event, users as { tenant_id: string, user_id: string }[]).find(u => u.tenant_id === parsed.data.tenantId)
  if (!user) {
    return apiError(event, 404, 'not_found', 'Простір не знайдено')
  }

  const { token } = await createSession({
    tenantId: user.tenant_id,
    userId: user.user_id,
    userAgent: getHeader(event, 'user-agent'),
    ip: clientIp(event),
  })
  setSessionCookies(event, token)

  await logSecurity({
    tenantId: user.tenant_id,
    userId: user.user_id,
    event: 'login.success',
    meta: { method: byEmail ? 'password' : 'otp', tenantSelected: true },
    ip: clientIp(event),
    userAgent: getHeader(event, 'user-agent'),
  })

  return apiData({ ok: true })
})
