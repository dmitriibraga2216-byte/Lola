import { createLoginToken, consumeLoginToken } from '../../services/telegram'
import { setSessionCookies, clientIp } from '../../utils/authCookies'

/** Кнопка «Пройти» из бота: автологин по chat_id → одноразовый токен → сессия → запись (docs/04 §4.12). */
export default defineEventHandler(async (event) => {
  const { e, c, to, n } = getQuery(event) as { e?: string, c?: string, to?: string, n?: string }
  const target = to && to.startsWith('/') ? to : e ? `/learn/${e}` : null
  if (!target || !c) return sendRedirect(event, '/login')
  const issued = await createLoginToken(BigInt(c)).catch(() => null)
  if (!issued) return sendRedirect(event, '/login')
  const session = await consumeLoginToken(issued.token, { userAgent: getHeader(event, 'user-agent'), ip: clientIp(event) })
  if (!session) return sendRedirect(event, '/login')
  setSessionCookies(event, session.sessionToken)
  // Реакция на уведомление (docs/23 §8): клик по «Пройти»
  if (n) { const { markReacted } = await import('../../services/notifications'); await markReacted(issued.tenantId, n).catch(() => {}) }
  return sendRedirect(event, target)
})
