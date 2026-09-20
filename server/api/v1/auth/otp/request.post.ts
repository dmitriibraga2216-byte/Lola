import { otpRequestSchema } from '../../../../../shared/schemas/auth'
import { requestOtp } from '../../../../services/otp'
import { usersByPhone, usersByPhoneAll } from '../../../../services/authLookup'
import { logSecurity } from '../../../../services/securityLog'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { clientIp, onHostTenant } from '../../../../utils/authCookies'

export default defineEventHandler(async (event) => {
  const parsed = otpRequestSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    return apiError(event, 400, 'validation_failed', 'Перевірте номер телефону', {
      issues: parsed.error.issues,
    })
  }

  // docs/25 §8, §14 п. 10: номер только в приостановленных пространствах — код не шлём, отвечаем понятно
  const all = onHostTenant(event, await usersByPhoneAll(parsed.data.phone))
  if (all.length > 0 && all.every(u => u.tenant_status !== 'active')) {
    return apiError(event, 403, 'tenant_suspended', 'Простір призупинено оператором платформи. Зверніться до підтримки Lola')
  }
  const result = await requestOtp(parsed.data.phone, clientIp(event))
  if (!result.ok) {
    setHeader(event, 'Retry-After', 900)
    return apiError(event, 429, 'rate_limited', 'Забагато спроб. Спробуйте пізніше')
  }

  // docs/16 §15: отправка кода — событие журнала безопасности в каждом тенанте номера (наружу наличие номера не раскрывается)
  for (const u of await usersByPhone(parsed.data.phone)) {
    await logSecurity({ tenantId: u.tenant_id, userId: u.user_id, event: 'otp.sent', meta: { channel: result.channel } })
  }

  // Наличие номера не раскрываем: всегда 200
  return apiData({
    channel: result.channel,
    ...(result.devCode ? { devCode: result.devCode } : {}),
  })
})
