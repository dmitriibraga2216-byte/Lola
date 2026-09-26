import { twoFactorSetupSchema } from '../../../../../shared/schemas/twoFactor'
import { startSetup } from '../../../../services/platformTwoFactor'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { requirePlatformSession } from '../../../../utils/platformGuard'
import { opsTwoFactorError } from './_errors'

/** POST /platform/two-factor/setup — новый ключ для приложения-аутентификатора (QR и текстом). */
export default defineEventHandler(async (event) => {
  const s = requirePlatformSession(event)
  const p = twoFactorSetupSchema.safeParse((await readBody(event)) ?? {})
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Код — шість цифр')
  const r = await startSetup(s, p.data)
  if (!r.ok) return opsTwoFactorError(event, r)
  return apiData({ secret: r.secret, otpauthUrl: r.otpauthUrl, expiresAt: r.expiresAt.toISOString() })
})
