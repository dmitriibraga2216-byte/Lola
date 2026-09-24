import { otpVerifySchema } from '../../../../../shared/schemas/auth'
import { verifyOtp } from '../../../../services/otp'
import { usersByPhone, usersByPhoneAll } from '../../../../services/authLookup'
import { createSession, issueSelectToken } from '../../../../services/session'
import { logSecurity } from '../../../../services/securityLog'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { clientIp, onHostTenant, setSessionCookies } from '../../../../utils/authCookies'

export default defineEventHandler(async (event) => {
  const parsed = otpVerifySchema.safeParse(await readBody(event))
  if (!parsed.success) {
    return apiError(event, 400, 'validation_failed', 'Перевірте номер і код', {
      issues: parsed.error.issues,
    })
  }
  const { phone, code } = parsed.data

  const result = await verifyOtp(phone, code)
  if (!result.ok) {
    // Журнал безопасности (docs/16 §15): неверный код — otp.failed (warning), блокировка по попыткам — login.blocked (warning); пишется в каждый тенант номера
    const blocked = result.code === 'rate_limited'
    for (const u of await usersByPhone(phone)) {
      await logSecurity({ tenantId: u.tenant_id, userId: u.user_id, event: blocked ? 'login.blocked' : 'otp.failed', meta: blocked ? { reason: 'attempts', method: 'otp' } : { attemptsLeft: result.attemptsLeft ?? null } })
    }
    if (blocked) {
      return apiError(event, 429, 'rate_limited', 'Забагато невірних спроб. Номер заблоковано на 30 хвилин')
    }
    return apiError(event, 401, 'otp_invalid', 'Код невірний', {
      ...(result.attemptsLeft !== undefined ? { attemptsLeft: result.attemptsLeft } : {}),
    })
  }

  const all = onHostTenant(event, await usersByPhoneAll(phone))
  const users = all.filter(u => u.tenant_status === 'active')
  if (users.length === 0) {
    // docs/25 §8: простір призупинено — пояснюємо, а не ховаємо за «код невірний»
    if (all.length > 0) return apiError(event, 403, 'tenant_suspended', 'Простір призупинено оператором платформи. Зверніться до підтримки Lola')
    // Код верный, но номера в системе нет — не раскрываем
    return apiError(event, 401, 'otp_invalid', 'Код невірний')
  }

  if (users.length > 1) {
    return apiData({
      requiresTenantSelect: true,
      selectToken: issueSelectToken(phone),
      tenants: users.map(u => ({
        tenantId: u.tenant_id,
        slug: u.tenant_slug,
        name: u.tenant_name,
      })),
    })
  }

  const user = users[0]!
  const { token, twoFactor } = await createSession({
    tenantId: user.tenant_id,
    userId: user.user_id,
    userAgent: getHeader(event, 'user-agent'),
    ip: clientIp(event),
    loginMethod: `otp_${result.channel}`,
  })
  setSessionCookies(event, token)

  // Второй фактор (docs/24 §3.4): сессия промежуточная, `login.success` — после кода приложения
  if (twoFactor) return apiData({ requiresTenantSelect: false, twoFactor })

  await logSecurity({
    tenantId: user.tenant_id,
    userId: user.user_id,
    event: 'login.success',
    meta: { method: 'otp' },
    ip: clientIp(event),
    userAgent: getHeader(event, 'user-agent'),
  })

  return apiData({ requiresTenantSelect: false, twoFactor: null })
})
