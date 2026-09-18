import { CSRF_COOKIE } from './01.session'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Double submit cookie (docs/04-api.md §4.1): мутации с сессией требуют
 * X-CSRF-Token, совпадающий с cookie. Bearer-запросы — без CSRF (нет ambient-сессии).
 */
export default defineEventHandler((event) => {
  if (!event.path.startsWith('/api/')) return
  if (SAFE_METHODS.has(event.method)) return
  if (!event.context.auth) return // до входа CSRF-риска нет: нет ambient identity
  if (getHeader(event, 'authorization')?.startsWith('Bearer ')) return

  const cookie = getCookie(event, CSRF_COOKIE)
  const header = getHeader(event, 'x-csrf-token')
  if (!cookie || !header || cookie !== header) {
    throw createError({ statusCode: 403, data: { code: 'csrf_failed', message: 'Оновіть сторінку і спробуйте ще раз' } })
  }
})
