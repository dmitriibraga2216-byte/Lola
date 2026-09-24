import { twoFactorProofSchema } from '../../../../../shared/schemas/twoFactor'
import { disableOwn } from '../../../../services/twoFactor'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { sessionAuth, twoFactorError } from '../../../../utils/sessionAuth'

/**
 * DELETE /auth/two-factor (docs/04 §4.2): отключить свой второй фактор — с кодом. Если политика
 * пространства требует его от этого человека — `409 two_factor.required_by_policy`.
 */
export default defineEventHandler(async (event) => {
  const auth = sessionAuth(event)
  const p = twoFactorProofSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Введіть шість цифр із застосунку або резервний код', { issues: p.error.issues })
  const r = await disableOwn(auth, p.data)
  if (!r.ok) return twoFactorError(event, r.code, r.code === 'invalid' ? r.attemptsLeft : undefined)
  return apiData({ ok: true })
})
