import { inviteInfo } from '../../../../services/platformOperators'
import { hitRateLimit } from '../../../../services/rateLimit'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { clientIp } from '../../../../utils/authCookies'

/** GET /platform/invite/:token — кого приглашают (экран «Задайте пароль»). Без сессии; ссылка — и есть доступ. */
export default defineEventHandler(async (event) => {
  if (!await hitRateLimit(`ops:invite:${clientIp(event)}`, 30, 900)) return apiError(event, 429, 'rate_limited', 'Забагато спроб — зачекайте 15 хвилин')
  const r = await inviteInfo(getRouterParam(event, 'token') ?? '')
  return r ? apiData(r) : apiError(event, 404, 'operator.invite_invalid', 'Посилання недійсне або застаріло. Попросіть власника платформи надіслати нове')
})
