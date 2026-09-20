import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * docs/28 «Вхід: код на e-mail» (рішення замовника 20.09.2026): другий канал доставки OTP.
 * Телефон лишається ідентифікатором (docs/01 §1.5) — перевіряємо тільки вибір каналу й доставку.
 */
process.env.OTP_DEBUG = '1'

const Otp = await import('../../server/services/otp')
const Secrets = await import('../../server/services/secrets')
const Settings = await import('../../server/services/settings')
const OtpChannel = await import('../../server/services/otpChannel')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

const randPhone = () => `+38067${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
const MAILPIT = 'http://localhost:8025'

let tenantId: string
let adminId: string
let withEmailId: string
let withEmailPhone: string
let withEmailAddr: string
let noEmailId: string
let noEmailPhone: string

async function messagesTo(address: string): Promise<{ ID: string, Snippet: string }[]> {
  const res = await fetch(`${MAILPIT}/api/v1/messages?limit=50`)
  const body = await res.json() as { messages: { ID: string, To: { Address: string }[], Snippet: string }[] }
  return body.messages.filter(m => m.To.some(t => t.Address === address))
}
async function messageText(id: string): Promise<string> {
  const res = await fetch(`${MAILPIT}/api/v1/message/${id}`)
  const body = await res.json() as { Text: string }
  return body.Text
}

beforeAll(async () => {
  const [t] = await admin`select id from tenants where slug = 'kappi'`
  tenantId = t!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string

  withEmailPhone = randPhone()
  withEmailAddr = `otp-email-test-${Date.now()}@example.test`
  const [u1] = await admin`insert into users (tenant_id, phone, email, full_name, status) values (${tenantId}, ${withEmailPhone}, ${withEmailAddr}, 'Тест Пошта OTP', 'active') returning id`
  withEmailId = u1!.id as string

  noEmailPhone = randPhone()
  const [u2] = await admin`insert into users (tenant_id, phone, full_name, status) values (${tenantId}, ${noEmailPhone}, 'Тест Без Пошти OTP', 'active') returning id`
  noEmailId = u2!.id as string

  // На випадок залишків від інших прогонів — тенант «kappi» без SMS-провайдера за замовчуванням
  await admin`delete from tenant_secrets where tenant_id = ${tenantId} and provider in ('sms', 'smtp')`
})

afterAll(async () => {
  await admin`delete from rate_limits where key like ${`%${withEmailPhone}%`} or key like ${`%${noEmailPhone}%`} or key like 'otp:ip:10.1.0.%'`
  await admin`delete from otp_codes where phone in (${withEmailPhone}, ${noEmailPhone})`
  await admin`delete from users where id in (${withEmailId}, ${noEmailId})`
  await admin`delete from tenant_secrets where tenant_id = ${tenantId} and provider in ('sms', 'smtp')`
  // Політику каналів повертаємо до дефолту, щоб не зачепити інші тести цього тенанта
  await Settings.updatePolicies({ tenantId, actorId: adminId }, { session: { otpChannels: ['sms', 'email'], otpFallbackToEmail: true } })
  await admin.end()
})

describe('OTP на e-mail: маска адреси', () => {
  it('маскує ім\'я користувача, лишає домен', () => {
    expect(OtpChannel.maskEmail('dmytro@gmail.com')).toBe('d*****@gmail.com')
    expect(OtpChannel.maskEmail('a@x.io')).toBe('a@x.io') // однобуквене ім'я — маскувати нема чим
  })
})

describe('OTP на e-mail: явний вибір каналу', () => {
  it('людина тисне «Надіслати код на пошту» → лист реально приходить (mailpit)', async () => {
    await Secrets.setSecret({ tenantId, actorId: adminId }, 'smtp', Secrets.SECRET_KEYS.smtp.HOST, 'localhost')
    await Secrets.setSecret({ tenantId, actorId: adminId }, 'smtp', Secrets.SECRET_KEYS.smtp.PORT, '1025')

    const res = await Otp.requestOtp(withEmailPhone, '10.1.0.1', { channel: 'email' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.channel).toBe('email')
    expect(res.maskedEmail).toMatch(/^.+\*+@example\.test$/)
    expect(res.devCode).toMatch(/^\d{6}$/)

    const msgs = await messagesTo(withEmailAddr)
    expect(msgs.length).toBeGreaterThan(0)
    const text = await messageText(msgs.at(-1)!.ID)
    expect(text).toContain(res.devCode)
    // security_log 'otp.sent' з channel='email' пише API-обробник (не сервіс) — перевірено в otp-email-http.spec.ts
  })
})

describe('OTP на e-mail: автоматичний фолбек без SMS-провайдера', () => {
  it('немає провайдера SMS у тенанта, пошта є, otpFallbackToEmail=true → канал email без явного вибору', async () => {
    await admin`delete from tenant_secrets where tenant_id = ${tenantId} and provider = 'sms'`
    const res = await Otp.requestOtp(withEmailPhone, '10.1.0.2')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.channel).toBe('email')
  })

  it('провайдер SMS налаштований → канал лишається sms, навіть якщо є пошта', async () => {
    await Secrets.setSecret({ tenantId, actorId: adminId }, 'sms', Secrets.SECRET_KEYS.sms.PROVIDER, 'log')
    await Secrets.setSecret({ tenantId, actorId: adminId }, 'sms', Secrets.SECRET_KEYS.sms.API_KEY, 'test-key')
    const res = await Otp.requestOtp(withEmailPhone, '10.1.0.3')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.channel).toBe('sms')
    await admin`delete from tenant_secrets where tenant_id = ${tenantId} and provider = 'sms'`
  })
})

describe('OTP на e-mail: немає жодного каналу', () => {
  it('без e-mail у людини і без дозволеного SMS у тенанта → зрозуміла помилка', async () => {
    await Settings.updatePolicies({ tenantId, actorId: adminId }, { session: { otpChannels: ['email'] } })
    const res = await Otp.requestOtp(noEmailPhone, '10.1.0.4')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('no_channel')
    await Settings.updatePolicies({ tenantId, actorId: adminId }, { session: { otpChannels: ['sms', 'email'] } })
  })

  it('та сама людина без пошти й з дозволеним SMS отримує звичайний стаб-канал', async () => {
    const res = await Otp.requestOtp(noEmailPhone, '10.1.0.5')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.channel).toBe('sms')
  })
})

describe('OTP на e-mail: ліміти спільні для обох каналів', () => {
  it('лічильник відправок один на номер, незалежно від каналу', async () => {
    const phone = randPhone()
    await admin`insert into users (tenant_id, phone, email, full_name, status) values (${tenantId}, ${phone}, ${`limit-${Date.now()}@example.test`}, 'Тест Лімітів', 'active')`
    try {
      await Otp.requestOtp(phone, '10.1.0.6', { channel: 'sms' })
      await Otp.requestOtp(phone, '10.1.0.6', { channel: 'email' })
      await Otp.requestOtp(phone, '10.1.0.6')
      const fourth = await Otp.requestOtp(phone, '10.1.0.6', { channel: 'email' })
      expect(fourth.ok).toBe(false)
    }
    finally {
      await admin`delete from otp_codes where phone = ${phone}`
      await admin`delete from rate_limits where key like ${`%${phone}%`}`
      await admin`delete from users where tenant_id = ${tenantId} and phone = ${phone}`
    }
  })
})
