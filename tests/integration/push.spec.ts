import { generateKeyPairSync } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const { subscribe, unsubscribe, hasSubscription, sendPushToUser, setPushHttp } = await import('../../server/services/push')
const { enqueueNotification, dispatchNotifications } = await import('../../server/services/notifications')
const { withTenant } = await import('../../server/utils/withTenant')

/**
 * D-051 (докс/33): підписка браузера, канал `push` у диспетчері, доставка через VAPID
 * (без бібліотек — сам механізм ES256 перевірений у `tests/unit/push.spec.ts`).
 */
const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

let tenantId: string
let learnerId: string
const sentEndpoints: string[] = []

function toB64url(b: Buffer): string {
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  learnerId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380670000003'`)[0]!.id as string

  const kp = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = kp.privateKey.export({ format: 'jwk' }) as { x: string, y: string, d: string }
  process.env.VAPID_PUBLIC_KEY = toB64url(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]))
  process.env.VAPID_PRIVATE_KEY = jwk.d
})

afterEach(async () => {
  sentEndpoints.length = 0
  setPushHttp(null)
  await admin`delete from push_subscriptions where tenant_id = ${tenantId} and user_id = ${learnerId}`
  await admin`delete from notifications where tenant_id = ${tenantId} and user_id = ${learnerId} and code = 'manual'`
})

afterAll(async () => {
  delete process.env.VAPID_PUBLIC_KEY
  delete process.env.VAPID_PRIVATE_KEY
  await admin.end()
})

const ctx = () => ({ tenantId, actorId: learnerId })

describe('push_subscriptions: підписка/відписка (докс/33 D-051)', () => {
  it('subscribe → hasSubscription true; повторний subscribe того ж endpoint — upsert, не другий рядок', async () => {
    expect(await hasSubscription(ctx())).toBe(false)
    const input = { endpoint: 'https://fcm.googleapis.com/fcm/send/test-1', keys: { p256dh: 'p1', auth: 'a1' } }
    await subscribe(ctx(), input, 'UnitTest/1.0')
    await subscribe(ctx(), input, 'UnitTest/2.0')
    expect(await hasSubscription(ctx())).toBe(true)
    const rows = await admin`select count(*)::int as n, user_agent from push_subscriptions where endpoint = ${input.endpoint} group by user_agent`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.n).toBe(1)
    expect(rows[0]!.user_agent).toBe('UnitTest/2.0')
  })

  it('unsubscribe прибирає підписку', async () => {
    await subscribe(ctx(), { endpoint: 'https://fcm.googleapis.com/fcm/send/test-2', keys: { p256dh: 'p', auth: 'a' } })
    expect(await hasSubscription(ctx())).toBe(true)
    await unsubscribe(ctx(), 'https://fcm.googleapis.com/fcm/send/test-2')
    expect(await hasSubscription(ctx())).toBe(false)
  })
})

describe('sendPushToUser: доставка й чистка протухлих підписок', () => {
  it('немає підписки — skipped', async () => {
    const r = await sendPushToUser(tenantId, learnerId)
    expect(r).toEqual({ ok: false, skipped: true, error: 'no subscription' })
  })

  it('успішна доставка на всі підписки з коректним VAPID-заголовком', async () => {
    await subscribe(ctx(), { endpoint: 'https://fcm.googleapis.com/fcm/send/ok-1', keys: { p256dh: 'p', auth: 'a' } })
    await subscribe(ctx(), { endpoint: 'https://fcm.googleapis.com/fcm/send/ok-2', keys: { p256dh: 'p', auth: 'a' } })
    setPushHttp((async (url, init) => {
      sentEndpoints.push(String(url))
      const auth = (init?.headers as Record<string, string>).Authorization
      expect(auth).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/)
      return new Response(null, { status: 201 })
    }) as typeof fetch)
    const r = await sendPushToUser(tenantId, learnerId)
    expect(r).toEqual({ ok: true })
    expect(sentEndpoints.sort()).toEqual(['https://fcm.googleapis.com/fcm/send/ok-1', 'https://fcm.googleapis.com/fcm/send/ok-2'])
  })

  it('410 Gone — підписка видаляється з бази', async () => {
    await subscribe(ctx(), { endpoint: 'https://fcm.googleapis.com/fcm/send/gone-1', keys: { p256dh: 'p', auth: 'a' } })
    setPushHttp((async () => new Response(null, { status: 410 })) as typeof fetch)
    const r = await sendPushToUser(tenantId, learnerId)
    expect(r).toMatchObject({ ok: false, skipped: false })
    expect(await hasSubscription(ctx())).toBe(false)
  })
})

describe('канал push у диспетчері (docs/23 §4)', () => {
  it('enqueue з channel=push → dispatchNotifications шле реальний VAPID-запит і позначає sent', async () => {
    await subscribe(ctx(), { endpoint: 'https://fcm.googleapis.com/fcm/send/dispatch-1', keys: { p256dh: 'p', auth: 'a' } })
    setPushHttp((async (url) => { sentEndpoints.push(String(url)); return new Response(null, { status: 201 }) }) as typeof fetch)
    await withTenant(tenantId, learnerId, tx => enqueueNotification(tx, { tenantId, userId: learnerId, code: 'manual', channel: 'push', payload: { text: 'привіт' }, dedupKey: `push-test:${Date.now()}` }))
    await admin`update notifications set scheduled_for = now() - interval '1 minute' where tenant_id = ${tenantId} and user_id = ${learnerId} and code = 'manual'`
    const stats = await dispatchNotifications(tenantId, 10)
    expect(stats.sent).toBeGreaterThanOrEqual(1)
    expect(sentEndpoints).toContain('https://fcm.googleapis.com/fcm/send/dispatch-1')
    const [row] = await admin`select status, channel from notifications where tenant_id = ${tenantId} and user_id = ${learnerId} and code = 'manual' order by created_at desc limit 1`
    expect(row).toMatchObject({ status: 'sent', channel: 'push' })
  })
})
