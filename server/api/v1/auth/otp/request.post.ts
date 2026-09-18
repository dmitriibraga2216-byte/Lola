import { otpRequestSchema } from '../../../../../shared/schemas/auth'
import { requestOtp } from '../../../../services/otp'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { clientIp } from '../../../../utils/authCookies'

export default defineEventHandler(async (event) => {
  const parsed = otpRequestSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    return apiError(event, 400, 'validation_failed', 'Перевірте номер телефону', {
      issues: parsed.error.issues,
    })
  }

  const result = await requestOtp(parsed.data.phone, clientIp(event))
  if (!result.ok) {
    setHeader(event, 'Retry-After', 900)
    return apiError(event, 429, 'rate_limited', 'Забагато спроб. Спробуйте пізніше')
  }

  // Наличие номера не раскрываем: всегда 200
  return apiData({
    channel: result.channel,
    ...(result.devCode ? { devCode: result.devCode } : {}),
  })
})
