import { createHmac, randomInt } from 'node:crypto'
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { otpCodes } from '../db/schema'
import { hitRateLimit, isBlocked, setBlock } from './rateLimit'
import { deliverOtp } from './otpChannel'
import { usersByPhone } from './authLookup'

/**
 * OTP-вход (docs/01-roles.md §1.5):
 * 6 цифр, 5 минут, хеш argon2id; ≤3 отправок на номер за 15 минут,
 * ≤30 на IP в час, ≤5 попыток ввода, после 5 — блок номера на 30 минут.
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
  = | { ok: true, channel: 'telegram' | 'sms', devCode?: string }
    | { ok: false, code: 'rate_limited' }

export async function requestOtp(phone: string, ip: string): Promise<OtpRequestResult> {
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

  const channel = users.some(u => u.has_telegram) ? 'telegram' as const : 'sms' as const
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')

  await db.insert(otpCodes).values({
    phone,
    codeHash: await argonHash(pepper(code)),
    channel,
    expiresAt: new Date(Date.now() + OTP_TTL_SEC * 1000),
  })

  await deliverOtp(channel, phone, code)

  return {
    ok: true,
    channel,
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
