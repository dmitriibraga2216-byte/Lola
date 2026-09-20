import { createHmac, randomInt } from 'node:crypto'
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { otpCodes } from '../db/schema'
import { hitRateLimit, isBlocked, setBlock } from './rateLimit'
import { deliverOtp, maskEmail } from './otpChannel'
import { usersByPhone, type PhoneUser } from './authLookup'
import { hasSmsProvider } from './channels'
import { readSettings } from './settings'
import { withTenant } from '../utils/withTenant'

/**
 * OTP-вход (docs/01-roles.md §1.5):
 * 6 цифр, 5 минут, хеш argon2id; ≤3 отправок на номер за 15 минут,
 * ≤30 на IP в час, ≤5 попыток ввода, после 5 — блок номера на 30 минут.
 *
 * docs/28 «Вхід: код на e-mail» — другий канал доставки (рішення замовника 20.09.2026):
 * телефон лишається єдиним ідентифікатором (docs/01 §1.5 не допускає вхід за e-mail), пошта —
 * лише спосіб доставити той самий код. Вибір каналу — `pickChannel` нижче.
 */

const OTP_TTL_SEC = 5 * 60
const SEND_LIMIT = 3
const SEND_WINDOW_SEC = 15 * 60
const IP_LIMIT = 30
const IP_WINDOW_SEC = 60 * 60
const MAX_ATTEMPTS = 5
const BLOCK_SEC = 30 * 60

function pepper(code: string): string {
  const p = process.env.OTP_PEPPER || ''
  return createHmac('sha256', p).update(code).digest('hex')
}

export type OtpRequestResult
  = | { ok: true, channel: 'telegram' | 'sms' | 'email', devCode?: string, maskedEmail?: string }
    | { ok: false, code: 'rate_limited' | 'no_channel' }

/**
 * Канал доставки коду. «Первинний» тенант — перший активний збіг по телефону: як і раніше
 * (`has_telegram` — `.some()` по всіх тенантах), точна доставка (SMTP, політика) прив'язана
 * до конкретного тенанта, тож для листа й політики береться перший (docs/28, відкрите питання:
 * кілька тенантів з різною поштою на одному телефоні — рідкісний випадок, не розводимо).
 */
async function pickChannel(users: PhoneUser[], explicit?: 'sms' | 'email'): Promise<{ channel: 'telegram' | 'sms' | 'email', email?: string } | { channel: null }> {
  if (users.some(u => u.has_telegram)) return { channel: 'telegram' }

  const primary = users[0]!
  const settings = await withTenant(primary.tenant_id, null, tx => readSettings(tx, primary.tenant_id))
  const session = settings.policies.session
  const channels = new Set(session.otpChannels)
  const smsAllowed = channels.has('sms')
  const emailAllowed = channels.has('email') && !!primary.email

  if (explicit === 'email' && emailAllowed) return { channel: 'email', email: primary.email! }
  if (explicit === 'sms' && smsAllowed) return { channel: 'sms' }

  // Автоматичний вибір: SMS з реальним провайдером тенанта — за замовчуванням; немає провайдера
  // і дозволений фолбек — мовчки на пошту (докс/28 п.1); інакше лишається стаб SMS (не помилка —
  // канал технічно «є», просто ще без підключеного провайдера, докс/26 §26.6).
  const smsConfigured = smsAllowed && await hasSmsProvider(primary.tenant_id)
  if (smsAllowed && smsConfigured) return { channel: 'sms' }
  if (emailAllowed && session.otpFallbackToEmail) return { channel: 'email', email: primary.email! }
  if (smsAllowed) return { channel: 'sms' }
  if (emailAllowed) return { channel: 'email', email: primary.email! }
  return { channel: null }
}

export async function requestOtp(phone: string, ip: string, opts: { channel?: 'sms' | 'email' } = {}): Promise<OtpRequestResult> {
  if (await isBlocked(`otp:block:${phone}`)) return { ok: false, code: 'rate_limited' }
  if (!await hitRateLimit(`otp:send:${phone}`, SEND_LIMIT, SEND_WINDOW_SEC)) {
    return { ok: false, code: 'rate_limited' }
  }
  if (!await hitRateLimit(`otp:ip:${ip}`, IP_LIMIT, IP_WINDOW_SEC)) {
    return { ok: false, code: 'rate_limited' }
  }

  const users = await usersByPhone(phone)
  // Наличие номера не раскрываем: ответ одинаковый, но код шлём только существующим
  if (users.length === 0) return { ok: true, channel: 'sms' }

  const picked = await pickChannel(users, opts.channel)
  if (picked.channel === null) return { ok: false, code: 'no_channel' }
  const { channel } = picked

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')

  const [row] = await db.insert(otpCodes).values({
    phone,
    codeHash: await argonHash(pepper(code)),
    channel,
    expiresAt: new Date(Date.now() + OTP_TTL_SEC * 1000),
  }).returning({ id: otpCodes.id })

  let effectiveChannel: 'telegram' | 'sms' | 'email' = channel
  const target = channel === 'email' ? picked.email! : phone
  const delivered = await deliverOtp(channel, target, code, { tenantId: users[0]!.tenant_id, ttlMinutes: OTP_TTL_SEC / 60, locale: users[0]!.locale })
  if (!delivered.ok && channel === 'email') {
    // SMTP тенанта й платформи одночасно не налаштовані — код не повинен загубитись мовчки,
    // тихо підстраховуємось SMS-стабом (docs/28 «Вхід: код на e-mail»)
    effectiveChannel = 'sms'
    await db.update(otpCodes).set({ channel: effectiveChannel }).where(eq(otpCodes.id, row!.id))
    await deliverOtp(effectiveChannel, phone, code)
  }

  return {
    ok: true,
    channel: effectiveChannel,
    ...(effectiveChannel === 'email' ? { maskedEmail: maskEmail(picked.email!) } : {}),
    // Только для dev/CI: в проде переменная не задаётся
    ...(process.env.OTP_DEBUG === '1' ? { devCode: code } : {}),
  }
}

export type OtpVerifyResult
  = | { ok: true }
    | { ok: false, code: 'otp_invalid' | 'rate_limited', attemptsLeft?: number }

export async function verifyOtp(phone: string, code: string): Promise<OtpVerifyResult> {
  if (await isBlocked(`otp:block:${phone}`)) return { ok: false, code: 'rate_limited' }

  const [row] = await db.select().from(otpCodes)
    .where(and(
      eq(otpCodes.phone, phone),
      isNull(otpCodes.consumedAt),
      gt(otpCodes.expiresAt, new Date()),
    ))
    .orderBy(desc(otpCodes.createdAt))
    .limit(1)

  if (!row) return { ok: false, code: 'otp_invalid' }
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, code: 'rate_limited' }

  const valid = await argonVerify(row.codeHash, pepper(code))
  if (!valid) {
    const [updated] = await db.update(otpCodes)
      .set({ attempts: sql`${otpCodes.attempts} + 1` })
      .where(eq(otpCodes.id, row.id))
      .returning({ attempts: otpCodes.attempts })
    const attempts = updated?.attempts ?? row.attempts + 1
    if (attempts >= MAX_ATTEMPTS) {
      await setBlock(`otp:block:${phone}`, BLOCK_SEC)
      return { ok: false, code: 'rate_limited' }
    }
    return { ok: false, code: 'otp_invalid', attemptsLeft: MAX_ATTEMPTS - attempts }
  }

  await db.update(otpCodes).set({ consumedAt: new Date() }).where(eq(otpCodes.id, row.id))
  return { ok: true }
}
