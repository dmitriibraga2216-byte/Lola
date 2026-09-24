import { twoFactorSetupSchema } from '../../../../../shared/schemas/twoFactor'
import { startSetup } from '../../../../services/twoFactor'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { sessionAuth, twoFactorError } from '../../../../utils/sessionAuth'

/**
 * POST /auth/two-factor/setup (docs/04 §4.2): новый ключ для приложения-аутентификатора —
 * `otpauthUrl` (его кодирует QR на экране) и сам ключ для ручного ввода. Работает и в
 * промежуточной сессии `enroll` (подключение на экране входа). Замена уже подключённого
 * фактора — только с текущим кодом `{code}`; действующий фактор остаётся до подтверждения нового.
 */
export default defineEventHandler(async (event) => {
  const auth = sessionAuth(event, { allowPending: true })
  const p = twoFactorSetupSchema.safeParse(await readBody(event) ?? {})
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Код — шість цифр', { issues: p.error.issues })
  const r = await startSetup(auth, p.data)
  if (!r.ok) return twoFactorError(event, r.code, r.code === 'invalid' ? r.attemptsLeft : undefined)
  return apiData({ secret: r.secret, otpauthUrl: r.otpauthUrl, expiresAt: r.expiresAt })
})
