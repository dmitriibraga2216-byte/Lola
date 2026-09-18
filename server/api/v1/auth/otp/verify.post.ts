import { otpVerifySchema } from '../../../../../shared/schemas/auth'
import { verifyOtp } from '../../../../services/otp'
import { usersByPhone } from '../../../../services/authLookup'
import { createSession, issueSelectToken } from '../../../../services/session'
import { logSecurity } from '../../../../services/securityLog'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { clientIp, setSessionCookies } from '../../../../utils/authCookies'

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
    if (result.code === 'rate_limited') {
      return apiError(event, 429, 'rate_limited', 'Забагато невірних спроб. Номер заблоковано на 30 хвилин')
    }
    return apiError(event, 401, 'otp_invalid', 'Код невірний', {
      ...(result.attemptsLeft !== undefined ? { attemptsLeft: result.attemptsLeft } : {}),
    })
  }

  const users = await usersByPhone(phone)
  if (users.length === 0) {
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
    event: 'login.otp',
    ip: clientIp(event),
    userAgent: getHeader(event, 'user-agent'),
  })

  return apiData({ requiresTenantSelect: false })
})
