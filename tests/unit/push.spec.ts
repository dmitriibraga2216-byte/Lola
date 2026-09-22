import { generateKeyPairSync, verify as cryptoVerify } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * VAPID (RFC 8292) без сторонних библиотек, докс/33 D-051: подпись ES256 через node:crypto
 * (`dsaEncoding: 'ieee-p1363'` — сразу «сырой» r||s, без ручного разбора DER).
 * Ключи генерируются на лету — сам механизм подписи проверяется независимо от .env.
 */
function toB64url(b: Buffer): string {
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

beforeAll(() => {
  const kp = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = kp.privateKey.export({ format: 'jwk' }) as { x: string, y: string, d: string }
  const pubPoint = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])
  process.env.VAPID_PUBLIC_KEY = toB64url(pubPoint)
  process.env.VAPID_PRIVATE_KEY = jwk.d
  process.env.VAPID_SUBJECT = 'mailto:test@lola.app'
})

describe('push: VAPID JWT (докс/33 D-051)', () => {
  it('pushConfigured видит пару ключей из окружения', async () => {
    const { pushConfigured } = await import('../../server/services/push')
    expect(pushConfigured()).toBe(true)
  })

  it('vapidAuthHeader — валидный заголовок "vapid t=<jwt>, k=<publicKey>", подпись верифицируется публичным ключом', async () => {
    const { vapidAuthHeader } = await import('../../server/services/push')
    const header = vapidAuthHeader('https://fcm.googleapis.com/fcm/send/abc123')
    expect(header).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/)

    const m = header!.match(/^vapid t=([\w-]+\.[\w-]+)\.([\w-]+), k=([\w-]+)$/)!
    const [, signingInput, sigB64, pubB64] = m
    const sig = Buffer.from(sigB64!, 'base64url')
    const pubPoint = Buffer.from(pubB64!, 'base64url')
    const pubJwk = { kty: 'EC', crv: 'P-256', x: pubPoint.subarray(1, 33).toString('base64url'), y: pubPoint.subarray(33, 65).toString('base64url') }
    const { createPublicKey } = await import('node:crypto')
    const pubKey = createPublicKey({ key: pubJwk, format: 'jwk' })
    expect(cryptoVerify('sha256', Buffer.from(signingInput!), { key: pubKey, dsaEncoding: 'ieee-p1363' }, sig)).toBe(true)

    const [headerB64, payloadB64] = signingInput!.split('.')
    const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf8'))
    expect(JSON.parse(Buffer.from(headerB64!, 'base64url').toString('utf8'))).toEqual({ typ: 'JWT', alg: 'ES256' })
    expect(payload.aud).toBe('https://fcm.googleapis.com')
    expect(payload.sub).toBe('mailto:test@lola.app')
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  it('без ключей в окружении — null/false, не бросает', async () => {
    const savedPub = process.env.VAPID_PUBLIC_KEY
    const savedPriv = process.env.VAPID_PRIVATE_KEY
    delete process.env.VAPID_PUBLIC_KEY
    delete process.env.VAPID_PRIVATE_KEY
    const { pushConfigured, vapidAuthHeader } = await import('../../server/services/push')
    expect(pushConfigured()).toBe(false)
    expect(vapidAuthHeader('https://fcm.googleapis.com/fcm/send/abc')).toBeNull()
    process.env.VAPID_PUBLIC_KEY = savedPub
    process.env.VAPID_PRIVATE_KEY = savedPriv
  })
})
