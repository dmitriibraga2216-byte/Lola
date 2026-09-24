import { twoFactorProofSchema } from '../../../../../shared/schemas/twoFactor'
import { regenerateRecoveryCodes } from '../../../../services/twoFactor'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { sessionAuth, twoFactorError } from '../../../../utils/sessionAuth'

/** POST /auth/two-factor/recovery-codes (docs/04 §4.2): перевыпуск десяти резервных кодов — с кодом; старые гаснут. */
export default defineEventHandler(async (event) => {
  const auth = sessionAuth(event)
  const p = twoFactorProofSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Введіть шість цифр із застосунку або резервний код', { issues: p.error.issues })
  const r = await regenerateRecoveryCodes(auth, p.data)
  if (!r.ok) return twoFactorError(event, r.code, r.code === 'invalid' ? r.attemptsLeft : undefined)
  return apiData({ recoveryCodes: r.recoveryCodes })
})
