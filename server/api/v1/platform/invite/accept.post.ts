import { inviteAcceptSchema } from '../../../../../shared/schemas/platformOperators'
import { acceptInvite } from '../../../../services/platformOperators'
import { hitRateLimit } from '../../../../services/rateLimit'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { clientIp } from '../../../../utils/authCookies'

/** POST /platform/invite/accept {token, password} — пароль по приглашению; дальше вход и подключение 2FA. */
export default defineEventHandler(async (event) => {
  if (!await hitRateLimit(`ops:invite:${clientIp(event)}`, 30, 900)) return apiError(event, 429, 'rate_limited', 'Забагато спроб — зачекайте 15 хвилин')
  const p = inviteAcceptSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте пароль', { issues: p.error.issues })
  const r = await acceptInvite(p.data.token, p.data.password)
  return r.ok ? apiData({ email: r.email }) : apiError(event, 404, 'operator.invite_invalid', 'Посилання недійсне або застаріло. Попросіть власника платформи надіслати нове')
})
