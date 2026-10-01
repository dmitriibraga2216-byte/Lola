/**
 * Заголовки безопасности на каждый ответ (security-sweep-4). Раньше их ставил только Caddy, а прод
 * ходит через Cloudflare Tunnel прямо в приложение — страница входа открывалась в чужом `<iframe>`
 * (кликджекинг), ответы без `nosniff`. Полный CSP не ставим: встраиваемые уроки и стили его требуют
 * отдельной настройки — здесь только запрет чужого фрейма.
 */
export default defineEventHandler((event) => {
  setHeader(event, 'X-Frame-Options', 'SAMEORIGIN')
  setHeader(event, 'Content-Security-Policy', "frame-ancestors 'self'")
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  setHeader(event, 'Referrer-Policy', 'strict-origin-when-cross-origin')
  // HSTS — только по HTTPS (за туннелем — по X-Forwarded-Proto), как Secure у cookie (`authCookies.ts`)
  const proto = getHeader(event, 'x-forwarded-proto')?.split(',')[0]?.trim()
  if (process.env.COOKIE_SECURE !== '0' && (proto === 'https' || process.env.COOKIE_SECURE === '1')) setHeader(event, 'Strict-Transport-Security', 'max-age=31536000')
})
