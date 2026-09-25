import type { H3Event } from 'h3'
import { botLoginQuerySchema } from '../../../shared/schemas/auth'
import { SESSION_COOKIE } from '../../middleware/01.session'
import { CANDIDATE_ACCESS_EXPIRED_REDIRECT, CandidateAccessExpiredError } from '../../services/candidateAccess'
import { markReacted } from '../../services/notifications'
import { hitRateLimit } from '../../services/rateLimit'
import { validateSession } from '../../services/session'
import { BOT_LINK_EXPIRED_REDIRECT, consumeLoginToken, type BotLoginResult } from '../../services/telegram'
import { clientIp, hostTenantIdOf, setSessionCookies } from '../../utils/authCookies'

/**
 * Кнопка «Пройти» из бота (docs/23 §6 п. 7, docs/04 §4.19). Вход — только по одноразовому токену `t`,
 * который бот выпустил, отправляя сообщение этому человеку (`issueLoginToken`): 10 минут, один
 * переход, в базе — хеш. Никакой другой параметр адреса входа не даёт.
 *
 * Отказ один на все причины (неизвестный, просроченный, использованный, чужой токен) — экран входа
 * с текстом «Посилання застаріло, попросіть у бота нове»: свежую кнопку присылает `/menu`. Кто уже
 * вошёл в этом браузере, идёт сразу на страницу — вход ему не нужен.
 *
 * Частотное ограничение — как в публичном контуре (docs/27 §27.8.1 п. 3): 60 переходов с адреса
 * за 10 минут, дальше экран входа с просьбой подождать.
 */
const GO_LIMIT = 60
const GO_WINDOW_SEC = 600

/** Уже вошёл в этом браузере: полная сессия, действующая на этом хосте. */
async function signedInHere(event: H3Event): Promise<boolean> {
  const sid = getCookie(event, SESSION_COOKIE)
  const auth = sid ? await validateSession(sid) : null
  if (!auth || auth.twoFactorPending) return false
  const hostTenantId = hostTenantIdOf(event)
  return !hostTenantId || hostTenantId === auth.tenantId
}

/** Отказ самого входа (`createSession()`: пространство закрыто, форма входа скрыта, …) — не сбой. */
const isRefusal = (err: unknown) => {
  const status = (err as { statusCode?: unknown } | null)?.statusCode
  return typeof status === 'number' && status >= 400 && status < 500
}

export default defineEventHandler(async (event) => {
  // Ответ ставит cookie сессии: не кешировать и не отдавать адрес с токеном дальше
  setHeader(event, 'Cache-Control', 'no-store')
  setHeader(event, 'Referrer-Policy', 'no-referrer')
  const ip = clientIp(event)
  if (!await hitRateLimit(`tg:go:${ip}`, GO_LIMIT, GO_WINDOW_SEC)) return sendRedirect(event, '/login?error=tg_too_many')

  const q = botLoginQuerySchema.parse(getQuery(event))
  const target = q.to ?? '/'
  let r: BotLoginResult = { ok: false }
  if (q.t) {
    try {
      r = await consumeLoginToken(q.t, { userAgent: getHeader(event, 'user-agent'), ip, hostTenantId: hostTenantIdOf(event) })
    }
    catch (err) {
      // Токен был настоящим, но вход отклонён: кандидат с закрытым доступом (docs/v2/28 §7.7) —
      // экран входа с его текстом; прочие отказы (пространство закрыто, форма входа скрыта) —
      // экран входа, который сам объяснит, что делать
      if (err instanceof CandidateAccessExpiredError) return sendRedirect(event, CANDIDATE_ACCESS_EXPIRED_REDIRECT)
      if (isRefusal(err)) return sendRedirect(event, '/login')
      throw err
    }
  }
  if (!r.ok) return sendRedirect(event, await signedInHere(event) ? target : BOT_LINK_EXPIRED_REDIRECT)

  setSessionCookies(event, r.sessionToken)
  // Реакция на уведомление (docs/23 §6 п. 6): клик по «Пройти» — только по своему уведомлению
  if (q.n) await markReacted(r.tenantId, q.n, r.userId).catch(() => {})
  // Второй фактор (docs/24 §3.4): кнопка бота — первый фактор, дальше экран кода
  if (r.twoFactor) return sendRedirect(event, '/login?step=two-factor')
  return sendRedirect(event, target)
})
