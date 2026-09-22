import { createPrivateKey, sign as cryptoSign } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { pushSubscriptions } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { PushSubscribeInput } from '../../shared/schemas/push'

/**
 * Push-уведомления PWA (docs/23 §4, докс/33 D-051): подписка браузера + отправка через
 * Web Push Protocol (RFC 8030) с авторизацией VAPID (RFC 8292), без сторонних библиотек
 * (`node:crypto` целиком закрывает подпись ES256 и base64url).
 *
 * **Решение [решение, докс/33 D-051].** Полезная нагрузка не шифруется (RFC 8291 aes128gcm
 * пока не реализован — заметный объём криптографии ради personalіzированного текста в самом
 * пуші). Пуш идёт «пустым» (без тіла) — валидный сценарий Web Push: сервис-воркер получает
 * событие `push` без `event.data` и показывает загальне сповіщення з посиланням на
 * `/learn/notifications`, де вже лежить справжній текст (той самий рядок `notifications`,
 * що й у дзвіночка). Це свідомий проміжний стан, не заглушка: доставка реальна, VAPID-підпис
 * реальний, немає лише персоналізованого тексту в самому пуші.
 */

function b64urlToBuffer(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}
function bufferToB64url(b: Uint8Array): string {
  return Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function base64urlJson(v: unknown): string {
  return bufferToB64url(Buffer.from(JSON.stringify(v)))
}

interface VapidKeys { publicKeyB64: string, privateKey: ReturnType<typeof createPrivateKey> }

/** Читает пару VAPID из окружения (raw base64url: публичный — 65 байт несжатой точки P-256). */
function vapidKeys(): VapidKeys | null {
  const pub = process.env.VAPID_PUBLIC_KEY
  const priv = process.env.VAPID_PRIVATE_KEY
  if (!pub || !priv) return null
  try {
    const pubBuf = b64urlToBuffer(pub)
    if (pubBuf.length !== 65 || pubBuf[0] !== 4) return null
    const jwk = { kty: 'EC', crv: 'P-256', x: bufferToB64url(pubBuf.subarray(1, 33)), y: bufferToB64url(pubBuf.subarray(33, 65)), d: priv.replace(/=+$/, '') }
    const privateKey = createPrivateKey({ key: jwk, format: 'jwk' })
    return { publicKeyB64: pub, privateKey }
  }
  catch {
    return null
  }
}

export function pushConfigured(): boolean {
  return !!vapidKeys()
}

/** JWT ES256, подписанный приватным ключом VAPID, плюс заголовок Authorization целиком (RFC 8292 §4). */
export function vapidAuthHeader(endpoint: string): string | null {
  const keys = vapidKeys()
  if (!keys) return null
  let aud: string
  try { aud = new URL(endpoint).origin }
  catch { return null }
  const subject = process.env.VAPID_SUBJECT || 'mailto:support@lola.app'
  const signingInput = `${base64urlJson({ typ: 'JWT', alg: 'ES256' })}.${base64urlJson({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })}`
  const sig = cryptoSign('sha256', Buffer.from(signingInput), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${signingInput}.${bufferToB64url(sig)}, k=${keys.publicKeyB64}`
}

export type PushSendResult = { ok: true } | { ok: false, gone: boolean, error: string }

/** Подмена HTTP для тестов (см. `telegram.ts#setTelegramHttp`) — реальный push-сервис не поднять в CI. */
let http: typeof fetch = (...args) => fetch(...args)
export function setPushHttp(f: typeof fetch | null): void { http = f ?? ((...args) => fetch(...args)) }

/** Один HTTP POST в push-сервис браузера (FCM/Mozilla/…), без тіла — див. решение вище. */
export async function sendPush(endpoint: string, ttlSec = 3600): Promise<PushSendResult> {
  const auth = vapidAuthHeader(endpoint)
  if (!auth) return { ok: false, gone: false, error: 'push not configured' }
  try {
    const res = await http(endpoint, {
      method: 'POST',
      headers: { Authorization: auth, TTL: String(ttlSec), 'Content-Length': '0' },
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) return { ok: true }
    if (res.status === 404 || res.status === 410) return { ok: false, gone: true, error: `push ${res.status}` }
    return { ok: false, gone: false, error: `push ${res.status}` }
  }
  catch (err) {
    return { ok: false, gone: false, error: String(err).slice(0, 200) }
  }
}

/** Канал `push` в диспетчере уведомлений (docs/23 §4): шлёт на все подписки человека, чистит протухшие. */
export async function sendPushToUser(tenantId: string, userId: string): Promise<{ ok: true } | { ok: false, skipped: boolean, error: string }> {
  if (!pushConfigured()) return { ok: false, skipped: true, error: 'push not configured' }
  const subs = await withTenant(tenantId, null, tx => tx.select({ id: pushSubscriptions.id, endpoint: pushSubscriptions.endpoint })
    .from(pushSubscriptions).where(and(eq(pushSubscriptions.tenantId, tenantId), eq(pushSubscriptions.userId, userId))))
  if (!subs.length) return { ok: false, skipped: true, error: 'no subscription' }

  let sent = false
  const gone: string[] = []
  for (const s of subs) {
    const r = await sendPush(s.endpoint)
    if (r.ok) sent = true
    else if (r.gone) gone.push(s.id)
  }
  if (gone.length) await withTenant(tenantId, null, tx => tx.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, gone)))
  return sent ? { ok: true } : { ok: false, skipped: false, error: 'delivery failed' }
}

interface Ctx { tenantId: string, actorId: string }

/** Подписка/переподписка (endpoint уникален глобально — повторный `subscribe()` того же браузера правит свою). */
export async function subscribe(ctx: Ctx, input: PushSubscribeInput, userAgent?: string): Promise<void> {
  await withTenant(ctx.tenantId, ctx.actorId, tx => tx.insert(pushSubscriptions).values({
    tenantId: ctx.tenantId, userId: ctx.actorId, endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent: userAgent ?? null,
  }).onConflictDoUpdate({
    target: pushSubscriptions.endpoint,
    set: { userId: ctx.actorId, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent: userAgent ?? null, lastSeenAt: new Date(), updatedAt: new Date() },
  }))
}

export async function unsubscribe(ctx: Ctx, endpoint: string): Promise<void> {
  await withTenant(ctx.tenantId, ctx.actorId, tx => tx.delete(pushSubscriptions).where(and(eq(pushSubscriptions.tenantId, ctx.tenantId), eq(pushSubscriptions.userId, ctx.actorId), eq(pushSubscriptions.endpoint, endpoint))))
}

export async function hasSubscription(ctx: Ctx): Promise<boolean> {
  const rows = await withTenant(ctx.tenantId, ctx.actorId, tx => tx.select({ id: pushSubscriptions.id }).from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.tenantId, ctx.tenantId), eq(pushSubscriptions.userId, ctx.actorId))).limit(1))
  return rows.length > 0
}
