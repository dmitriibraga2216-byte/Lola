import { passwordLoginSchema } from '../../../../../shared/schemas/auth'
import { loginWithPassword } from '../../../../services/password'
import { createSession, issueSelectToken } from '../../../../services/session'
import { logSecurity } from '../../../../services/securityLog'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { clientIp, onHostTenant, setSessionCookies } from '../../../../utils/authCookies'

/**
 * POST /auth/password/login (docs/04 §4.2): `{email, password}` — резервный вход для методистов и администраторов,
 * включается политикой тенанта «Вход по паролю» (docs/24 §3.4). Ответ на неверную пару всегда одинаковый.
 */
export default defineEventHandler(async (event) => {
  const parsed = passwordLoginSchema.safeParse(await readBody(event))
  if (!parsed.success) return apiError(event, 400, 'validation_failed', 'Перевірте пошту і пароль', { issues: parsed.error.issues })

  const r = await loginWithPassword(parsed.data.email, parsed.data.password)
  if (!r.ok) {
    if (r.code === 'blocked') {
      setHeader(event, 'Retry-After', r.retryAfterSec ?? 1800)
      return apiError(event, 429, 'rate_limited', 'Забагато невдалих спроб. Вхід тимчасово заблоковано')
    }
    if (r.code === 'disabled') return apiError(event, 403, 'password_login_disabled', 'Вхід за паролем вимкнено. Увійдіть за кодом з телефону')
    return apiError(event, 401, 'password_invalid', 'Невірна пошта або пароль')
  }

  const users = onHostTenant(event, r.users)
  if (users.length === 0) return apiError(event, 401, 'password_invalid', 'Невірна пошта або пароль')
  if (users.length > 1) {
    return apiData({
      requiresTenantSelect: true,
      selectToken: issueSelectToken(`email:${parsed.data.email.toLowerCase()}`),
      tenants: users.map(u => ({ tenantId: u.tenant_id, slug: u.tenant_slug, name: u.tenant_name })),
    })
  }

  const user = users[0]!
  const { token, twoFactor } = await createSession({ tenantId: user.tenant_id, userId: user.user_id, userAgent: getHeader(event, 'user-agent'), ip: clientIp(event), loginMethod: 'password' })
  setSessionCookies(event, token)
  // Второй фактор (docs/24 §3.4): «пароль + код» — `login.success` пишет подтверждение кода
  if (!twoFactor) await logSecurity({ tenantId: user.tenant_id, userId: user.user_id, event: 'login.success', meta: { method: 'password' }, ip: clientIp(event), userAgent: getHeader(event, 'user-agent') })
  return apiData({ requiresTenantSelect: false, mustChangePassword: user.mustChangePassword, twoFactor })
})
