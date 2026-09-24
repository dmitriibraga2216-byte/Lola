import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

/**
 * TOTP (RFC 6238 поверх HOTP RFC 4226) — чистые функции, без БД и без внешних зависимостей:
 * алгоритм занимает полсотни строк на `node:crypto`, а библиотека ради него — лишняя
 * зависимость в модуле входа (CLAUDE.md «Не добавлять зависимости без причины»).
 *
 * Параметры — те, что понимает любое приложение-аутентификатор (Google Authenticator,
 * Microsoft Authenticator, 1Password): SHA-1, 6 цифр, шаг 30 секунд. Секрет — 20 случайных
 * байт (160 бит, рекомендация RFC 4226 §4), наружу — в Base32 без выравнивания.
 */

export const TOTP_DIGITS = 6
export const TOTP_PERIOD_SEC = 30
/** Допуск на расхождение часов телефона и сервера: соседний шаг в обе стороны (±30 с). */
export const TOTP_WINDOW = 1
const SECRET_BYTES = 20

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

/** Base32 → байты; пробелы, дефисы и регистр прощаются (человек мог переписать секрет руками). */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = B32.indexOf(ch)
    if (idx === -1) throw new Error('base32: недопустимый символ')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function generateSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES))
}

/** HOTP (RFC 4226 §5.3): динамическое усечение HMAC-SHA-1 от 8-байтного счётчика. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac('sha1', secret).update(msg).digest()
  const offset = mac[mac.length - 1]! & 0x0F
  const bin = ((mac[offset]! & 0x7F) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!
  return String(bin % 10 ** digits).padStart(digits, '0')
}

export function stepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SEC)
}

export function totpAt(secretB32: string, nowMs: number): string {
  return hotp(base32Decode(secretB32), stepAt(nowMs))
}

/**
 * Проверка кода: номер принятого шага или null. Шаг обязан быть **строго больше**
 * `lastUsedStep` — один и тот же код не проходит дважды, даже в пределах своих 30 секунд
 * (перехваченный код нельзя повторить). Сравнение — за постоянное время.
 */
export function verifyTotp(secretB32: string, code: string, nowMs: number, lastUsedStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null
  const key = base32Decode(secretB32)
  const current = stepAt(nowMs)
  const given = Buffer.from(code)
  let matched: number | null = null
  // Перебираем все шаги окна без раннего выхода — время ответа не зависит от того, какой подошёл
  for (let d = -TOTP_WINDOW; d <= TOTP_WINDOW; d++) {
    const step = current + d
    if (step < 0) continue
    const expected = Buffer.from(hotp(key, step))
    if (timingSafeEqual(expected, given) && (lastUsedStep === null || step > lastUsedStep) && matched === null) matched = step
  }
  return matched
}

/**
 * Ссылка `otpauth://` (формат Key Uri Google Authenticator): её же кодирует QR на экране
 * подключения. Метка — «Lola (простір): людина», чтобы в приложении было видно, от чего код.
 */
export function otpauthUri(secretB32: string, issuer: string, account: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const params = new URLSearchParams({ secret: secretB32, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD_SEC) })
  return `otpauth://totp/${label}?${params.toString()}`
}

// ── Резервные коды ───────────────────────────────────────────────────────────────────────

export const RECOVERY_CODES_COUNT = 10
/** Без 0/O, 1/l/I — код переписывают с листа бумаги. */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

/** Десять кодов вида `xxxxx-xxxxx` (10 символов из 31 — ~49 бит каждый). */
export function generateRecoveryCodes(n = RECOVERY_CODES_COUNT): string[] {
  const one = () => Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('')
  return Array.from({ length: n }, () => {
    const c = one()
    return `${c.slice(0, 5)}-${c.slice(5)}`
  })
}

/** Приведение введённого кода к хешируемому виду: регистр, пробелы и дефис не важны. */
export function normalizeRecoveryCode(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '')
}
