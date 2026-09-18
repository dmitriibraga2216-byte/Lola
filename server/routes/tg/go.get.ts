import { createLoginToken, consumeLoginToken } from '../../services/telegram'
import { setSessionCookies, clientIp } from '../../utils/authCookies'

/** Кнопка «Пройти» из бота: автологин по chat_id → одноразовый токен → сессия → запись (docs/04 §4.12). */
export default defineEventHandler(async (event) => {
  const { e, c } = getQuery(event) as { e?: string, c?: string }
  if (!e || !c) return sendRedirect(event, '/login')
  const issued = await createLoginToken(BigInt(c)).catch(() => null)
  if (!issued) return sendRedirect(event, '/login')
  const session = await consumeLoginToken(issued.token, { userAgent: getHeader(event, 'user-agent'), ip: clientIp(event) })
  if (!session) return sendRedirect(event, '/login')
  setSessionCookies(event, session.sessionToken)
  return sendRedirect(event, `/learn/${e}`)
})
