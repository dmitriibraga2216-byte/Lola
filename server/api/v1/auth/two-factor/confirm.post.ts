import { twoFactorConfirmSchema } from '../../../../../shared/schemas/twoFactor'
import { confirmSetup } from '../../../../services/twoFactor'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { setSessionCookies } from '../../../../utils/authCookies'
import { sessionAuth, twoFactorError } from '../../../../utils/sessionAuth'

/**
 * POST /auth/two-factor/confirm (docs/04 §4.2): первый код из приложения — фактор подключён.
 * В ответе десять резервных кодов: **единственный раз**, когда они видны (хранятся хешами).
 * На экране входа (промежуточная сессия `enroll`) заодно завершается вход — новый токен в cookie.
 */
export default defineEventHandler(async (event) => {
  const auth = sessionAuth(event, { allowPending: true })
  const p = twoFactorConfirmSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Код — шість цифр', { issues: p.error.issues })
  const r = await confirmSetup(auth, p.data.code)
  if (!r.ok) return twoFactorError(event, r.code, r.code === 'invalid' ? r.attemptsLeft : undefined)
  if (r.session) setSessionCookies(event, r.session.token)
  return apiData({ recoveryCodes: r.recoveryCodes, signedIn: r.session !== null })
})
