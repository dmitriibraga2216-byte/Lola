import { createLoginToken, consumeLoginToken } from '../../services/telegram'
import { CANDIDATE_ACCESS_EXPIRED_REDIRECT, CandidateAccessExpiredError } from '../../services/candidateAccess'
import { setSessionCookies, clientIp } from '../../utils/authCookies'

/** Кнопка «Пройти» из бота: автологин по chat_id → одноразовый токен → сессия → запись (docs/04 §4.12). */
export default defineEventHandler(async (event) => {
  const { e, c, to, n } = getQuery(event) as { e?: string, c?: string, to?: string, n?: string }
  const target = to && to.startsWith('/') ? to : e ? `/learn/${e}` : null
  if (!target || !c) return sendRedirect(event, '/login')
  const issued = await createLoginToken(BigInt(c)).catch(() => null)
  if (!issued) return sendRedirect(event, '/login')
  let session: Awaited<ReturnType<typeof consumeLoginToken>>
  try {
    session = await consumeLoginToken(issued.token, { userAgent: getHeader(event, 'user-agent'), ip: clientIp(event) })
  }
  catch (err) {
    // Кандидат с закрытым доступом (docs/v2/28 §7.7): кнопка в старом сообщении бота ведёт на экран
    // входа с понятным текстом, а не на страницу ошибки
    if (err instanceof CandidateAccessExpiredError) return sendRedirect(event, CANDIDATE_ACCESS_EXPIRED_REDIRECT)
    throw err
  }
  if (!session) return sendRedirect(event, '/login')
  setSessionCookies(event, session.sessionToken)
  // Реакция на уведомление (docs/23 §8): клик по «Пройти»
  if (n) { const { markReacted } = await import('../../services/notifications'); await markReacted(issued.tenantId, n).catch(() => {}) }
  // Второй фактор (docs/24 §3.4): кнопка бота — первый фактор, дальше экран кода
  if (session.twoFactor) return sendRedirect(event, '/login?step=two-factor')
  return sendRedirect(event, target)
})
