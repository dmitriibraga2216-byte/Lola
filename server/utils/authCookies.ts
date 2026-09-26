import { randomBytes } from 'node:crypto'
import type { H3Event } from 'h3'
import { CSRF_COOKIE, PLATFORM_COOKIE, SESSION_COOKIE } from '../middleware/01.session'
import { opsHostOf } from '../services/opsHost'

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

/** Срок сессии оператора — 12 часов (docs/03 §3.12). */
export const PLATFORM_SESSION_SEC = 12 * 3600

/**
 * Cookie оператора (docs/25 §7 п. 6): без `Domain` — host-only, на поддомены тенантов не
 * уходит; `SameSite=Strict`; при отдельном хосте консоли (`OPS_HOST`) — всегда `Secure`
 * (консоль живёт только за HTTPS). Без `OPS_HOST` — как у тенантской cookie, по протоколу.
 */
export function setPlatformCookie(event: H3Event, token: string): void {
  const secure = process.env.COOKIE_SECURE === '0' ? false : (opsHostOf() ? true : isSecureRequest(event))
  setCookie(event, PLATFORM_COOKIE, token, { httpOnly: true, secure, sameSite: 'strict', maxAge: PLATFORM_SESSION_SEC, path: '/' })
}

export function clearPlatformCookie(event: H3Event): void {
  deleteCookie(event, PLATFORM_COOKIE, { path: '/' })
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

/**
 * Тенант из Host (middleware `01.host`, docs/25 §16.1): на хосте `<slug>.<base>` вход возможен только в этот тенант —
 * список пространств человека сужается до него, выбор пространства не предлагается.
 */
export function hostTenantIdOf(event: H3Event): string | null {
  return (event.context.hostTenant as { id: string } | undefined)?.id ?? null
}

export function onHostTenant<T extends { tenant_id: string }>(event: H3Event, users: T[]): T[] {
  const id = hostTenantIdOf(event)
  return id ? users.filter(u => u.tenant_id === id) : users
}
