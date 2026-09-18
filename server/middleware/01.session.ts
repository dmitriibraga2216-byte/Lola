import { touchSession, validateSession } from '../services/session'

export const SESSION_COOKIE = 'lola_sid'
export const CSRF_COOKIE = 'lola_csrf'

/** Кладёт AuthContext в event.context.auth, если cookie валидна. */
export default defineEventHandler(async (event) => {
  if (!event.path.startsWith('/api/') && event.path !== '/ready') return

  const token = getCookie(event, SESSION_COOKIE)
  if (!token) return

  const auth = await validateSession(token)
  if (!auth) return

  event.context.auth = auth
  // Продление скользящее, не чаще раза в час — не блокируем ответ
  event.waitUntil(touchSession(auth).catch(() => {}))
})
