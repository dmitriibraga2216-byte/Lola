import { twoFactorVerifySchema } from '../../../../../shared/schemas/twoFactor'
import { verify } from '../../../../services/platformTwoFactor'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { setPlatformCookie } from '../../../../utils/authCookies'
import { requirePlatformSession } from '../../../../utils/platformGuard'
import { opsTwoFactorError } from './_errors'

/** POST /platform/two-factor/verify — код приложения или резервный код завершает вход оператора. */
export default defineEventHandler(async (event) => {
  const s = requirePlatformSession(event)
  const p = twoFactorVerifySchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Введіть шість цифр із застосунку або резервний код')
  const r = await verify(s, p.data)
  if (!r.ok) return opsTwoFactorError(event, r)
  setPlatformCookie(event, r.token)
  return apiData({ ok: true, proof: r.proof, recoveryCodesLeft: r.recoveryCodesLeft })
})
