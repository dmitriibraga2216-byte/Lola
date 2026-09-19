import { randomBytes } from 'node:crypto'
import type { H3Event } from 'h3'
import { CSRF_COOKIE, SESSION_COOKIE } from '../middleware/01.session'

const THIRTY_DAYS_SEC = 30 * 24 * 60 * 60

/** Secure только по HTTPS: за Cloudflare/Caddy — X-Forwarded-Proto, локально по http — нет (docs/27 §27.6). */
export function isSecureRequest(event: H3Event): boolean {
  if (process.env.COOKIE_SECURE === '0') return false
  if (process.env.COOKIE_SECURE === '1') return true
  const forwarded = getHeader(event, 'x-forwarded-proto')?.split(',')[0]?.trim()
  if (forwarded) return forwarded === 'https'
  return Boolean((event.node.req.socket as { encrypted?: boolean }).encrypted)
}

export function setSessionCookies(event: H3Event, token: string): void {
  const secure = isSecureRequest(event)
  setCookie(event, SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    maxAge: THIRTY_DAYS_SEC,
    path: '/',
  })
  setCookie(event, CSRF_COOKIE, randomBytes(16).toString('base64url'), {
    httpOnly: false, // клиент читает и шлёт в X-CSRF-Token
    secure,
    sameSite: 'lax',
    maxAge: THIRTY_DAYS_SEC,
    path: '/',
  })
}

export function clearSessionCookies(event: H3Event): void {
  deleteCookie(event, SESSION_COOKIE, { path: '/' })
  deleteCookie(event, CSRF_COOKIE, { path: '/' })
}

export function clientIp(event: H3Event): string {
  return getHeader(event, 'cf-connecting-ip')
    || getHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim()
    || event.node.req.socket.remoteAddress
    || '0.0.0.0'
}
