import { twoFactorConfirmSchema } from '../../../../../shared/schemas/twoFactor'
import { confirmSetup } from '../../../../services/platformTwoFactor'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { setPlatformCookie } from '../../../../utils/authCookies'
import { requirePlatformSession } from '../../../../utils/platformGuard'
import { opsTwoFactorError } from './_errors'

/**
 * POST /platform/two-factor/confirm — первый код из приложения: фактор подключён, десять резервных
 * кодов показываются один раз. На экране входа вход завершается — cookie с новым токеном.
 */
export default defineEventHandler(async (event) => {
  const s = requirePlatformSession(event)
  const p = twoFactorConfirmSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Код — шість цифр')
  const r = await confirmSetup(s, p.data.code)
  if (!r.ok) return opsTwoFactorError(event, r)
  if (r.token) setPlatformCookie(event, r.token)
  return apiData({ recoveryCodes: r.recoveryCodes, signedIn: !!r.token })
})
