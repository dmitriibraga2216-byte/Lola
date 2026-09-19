import { touchSession, validateSession } from '../services/session'

export const SESSION_COOKIE = 'lola_sid'
export const CSRF_COOKIE = 'lola_csrf'
export const PLATFORM_COOKIE = 'lola_ops'

/**
 * Кладёт AuthContext в event.context.auth: из cookie сессии, либо из Bearer
 * (API-токен тенанта, docs/04 §4.1 — скоупы те же, actor = создатель токена).
 * Панель оператора — отдельная cookie и отдельный контекст.
 */
export default defineEventHandler(async (event) => {
  if (!event.path.startsWith('/api/') && event.path !== '/ready') return

  if (event.path.startsWith('/api/v1/platform/')) {
    const ops = getCookie(event, PLATFORM_COOKIE)
    if (ops) {
      const { validatePlatformSession } = await import('../services/platform')
      event.context.platform = await validatePlatformSession(ops)
    }
    return
  }

  const bearer = getHeader(event, 'authorization')
  if (bearer?.startsWith('Bearer ')) {
    const { validateBearer } = await import('../services/apiTokens')
    const r = await validateBearer(bearer.slice(7).trim())
    if (!r.ok) {
      throw createError({ statusCode: r.code === 'rate_limited' ? 429 : 401, data: { code: r.code === 'rate_limited' ? 'rate_limited' : 'auth_required', message: r.code === 'rate_limited' ? 'Ліміт 60 запитів на хвилину' : 'Невірний токен' } })
    }
    event.context.auth = { sessionId: `token:${r.auth.tokenId}`, tenantId: r.auth.tenantId, userId: r.auth.actorId ?? '', impersonatedBy: null }
    event.context.tokenScopes = r.auth.scopes
    return
  }

  const token = getCookie(event, SESSION_COOKIE)
  if (!token) return

  const auth = await validateSession(token)
  if (!auth) return

  event.context.auth = auth
  // Продление скользящее, не чаще раза в час — не блокируем ответ
  event.waitUntil(touchSession(auth).catch(() => {}))
})
