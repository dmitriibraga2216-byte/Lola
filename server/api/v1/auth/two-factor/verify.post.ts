import { twoFactorVerifySchema } from '../../../../../shared/schemas/twoFactor'
import { verifyAtLogin } from '../../../../services/twoFactor'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { setSessionCookies } from '../../../../utils/authCookies'
import { sessionAuth, twoFactorError } from '../../../../utils/sessionAuth'

/**
 * POST /auth/two-factor/verify (docs/04 §4.2): второй шаг входа — `{code}` из приложения или
 * `{recoveryCode}`. Верный код превращает промежуточную сессию в полную **с новым токеном**
 * (cookie переставляется); неверный — `401 two_factor_invalid` с остатком попыток, после лимита
 * `429 rate_limited` и промежуточные сессии человека закрываются.
 */
export default defineEventHandler(async (event) => {
  const auth = sessionAuth(event, { allowPending: true })
  const p = twoFactorVerifySchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Введіть шість цифр із застосунку або резервний код', { issues: p.error.issues })
  const r = await verifyAtLogin(auth, p.data)
  if (!r.ok) return twoFactorError(event, r.code, r.code === 'invalid' ? r.attemptsLeft : undefined)
  setSessionCookies(event, r.token)
  return apiData({ ok: true, proof: r.proof, recoveryCodesLeft: r.recoveryCodesLeft })
})
