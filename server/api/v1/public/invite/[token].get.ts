import { previewInvitation } from '../../../../services/people'
import { hitRateLimit } from '../../../../services/rateLimit'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { clientIp } from '../../../../utils/authCookies'

/**
 * GET /public/invite/:token — превью приглашения перед входом (страница `/invite`, docs/16 §8
 * `user_invited`, docs/01 §1.5): только название пространства, без входа и без побочных
 * эффектов. Тот же код `invite_invalid`, что у `POST /auth/invite/accept` — неизвестный,
 * протухший и уже принятый токен неразличимы (docs/v2/44 В-9, публичный контур).
 */
const VIEW_LIMIT = 30
const VIEW_WINDOW_SEC = 600

export default defineEventHandler(async (event) => {
  if (!await hitRateLimit(`invite:preview:${clientIp(event)}`, VIEW_LIMIT, VIEW_WINDOW_SEC)) {
    setResponseHeader(event, 'Retry-After', VIEW_WINDOW_SEC)
    return apiError(event, 429, 'rate.too_many', 'Забагато запитів. Спробуйте за кілька хвилин')
  }
  const preview = await previewInvitation(getRouterParam(event, 'token') ?? '')
  if (!preview) return apiError(event, 401, 'invite_invalid', 'Запрошення недійсне або протухло')
  return apiData(preview)
})
