import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

/**
 * docs/28 «Вхід: код на e-mail» по HTTP (по образцу spec24-http.spec.ts): відповідь /auth/otp/request
 * (channel/maskedEmail), 422 no_channel, security_log 'otp.sent' з channel='email'.
 */
const BUILT = existsSync('.output/server/index.mjs')
const PORT = 3799
const BASE = `http://127.0.0.1:${PORT}`
const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

let server: ChildProcess | undefined
let tenantId: string
let adminId: string
let personId: string
let personPhone: string
let personEmail: string

const randPhone = () => `+38068${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
const otpRequest = (body: unknown) => fetch(`${BASE}/api/v1/auth/otp/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

describe.skipIf(!BUILT)('OTP на e-mail по HTTP', () => {
  beforeAll(async () => {
    const [t] = await admin`select id from tenants where slug = 'kappi'`
    tenantId = t!.id as string
    adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
    personPhone = randPhone()
    personEmail = `otp-http-${Date.now()}@example.test`
    const [u] = await admin`insert into users (tenant_id, phone, email, full_name, status) values (${tenantId}, ${personPhone}, ${personEmail}, 'Тест HTTP OTP', 'active') returning id`
    personId = u!.id as string
    await admin`delete from tenant_secrets where tenant_id = ${tenantId} and provider in ('smtp', 'sms')`
    await admin`update tenants set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{policies,session,otpChannels}', '["sms","email"]') where id = ${tenantId}`

    server = spawn('node', ['.output/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), NITRO_PORT: String(PORT), OTP_DEBUG: '1', NUXT_DATABASE_URL: process.env.DATABASE_URL }, stdio: 'ignore' })
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${BASE}/health`)).ok) return }
      catch { /* ещё поднимается */ }
      await new Promise(r => setTimeout(r, 500))
    }
    throw new Error('Собранное приложение не поднялось за 30 секунд')
  }, 90_000)

  afterEach(async () => { await admin`delete from rate_limits where key like ${`%${personPhone}%`}` })

  afterAll(async () => {
    server?.kill()
    await admin`delete from otp_codes where phone = ${personPhone}`
    await admin`delete from security_log where user_id = ${personId}`
    await admin`delete from users where id = ${personId}`
    await admin`delete from tenant_secrets where tenant_id = ${tenantId} and provider in ('smtp', 'sms')`
    await admin.end()
  })

  it('без SMTP тенанта явний вибір e-mail тихо падає назад на SMS — код не губиться', async () => {
    const res = await otpRequest({ phone: personPhone, channel: 'email' })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { channel: string, devCode?: string } }
    expect(body.data.channel).toBe('sms') // немає SMTP ні в тенанта, ні платформи — фолбек
    expect(body.data.devCode).toMatch(/^\d{6}$/)
  })

  it('з налаштованим SMTP (mailpit) — channel=email, maskedEmail, security_log з channel=email', async () => {
    // Секрети шифруються (AES-GCM) — простіше і надійніше пройти через сам сервіс, а не руками в БД
    const { setSecret, SECRET_KEYS } = await import('../../server/services/secrets')
    await setSecret({ tenantId, actorId: adminId }, 'smtp', SECRET_KEYS.smtp.HOST, 'localhost')
    await setSecret({ tenantId, actorId: adminId }, 'smtp', SECRET_KEYS.smtp.PORT, '1025')

    const res = await otpRequest({ phone: personPhone, channel: 'email' })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { channel: string, maskedEmail?: string, devCode?: string } }
    expect(body.data.channel).toBe('email')
    expect(body.data.maskedEmail).toMatch(/@example\.test$/)
    expect(body.data.devCode).toMatch(/^\d{6}$/)

    const [row] = await admin`select meta from security_log where tenant_id = ${tenantId} and user_id = ${personId} and event = 'otp.sent' order by created_at desc limit 1`
    expect(row).toBeDefined()
    expect((row!.meta as { channel?: string }).channel).toBe('email')
  })

  it('без e-mail-каналу в політиці і без пошти у людини — 422 no_channel', async () => {
    const noEmailPhone = randPhone()
    await admin`insert into users (tenant_id, phone, full_name, status) values (${tenantId}, ${noEmailPhone}, 'Тест Без Каналу HTTP', 'active')`
    await admin`update tenants set settings = jsonb_set(settings, '{policies,session,otpChannels}', '["email"]') where id = ${tenantId}`
    try {
      const res = await otpRequest({ phone: noEmailPhone })
      expect(res.status).toBe(422)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('no_channel')
    }
    finally {
      await admin`update tenants set settings = jsonb_set(settings, '{policies,session,otpChannels}', '["sms","email"]') where id = ${tenantId}`
      await admin`delete from otp_codes where phone = ${noEmailPhone}`
      await admin`delete from rate_limits where key like ${`%${noEmailPhone}%`}`
      await admin`delete from users where tenant_id = ${tenantId} and phone = ${noEmailPhone}`
    }
  })
})
