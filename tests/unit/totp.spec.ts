import { describe, expect, it } from 'vitest'
import {
  TOTP_PERIOD_SEC, base32Decode, base32Encode, generateRecoveryCodes, generateSecret, hotp, normalizeRecoveryCode,
  otpauthUri, stepAt, totpAt, verifyTotp,
} from '../../server/services/totp'
import { SCOPES, SCOPE_FLAGS, SESSION_ONLY_SCOPES, SYSTEM_ROLES, isSessionOnlyScope } from '../../shared/domain/roles'

/**
 * Второй фактор входа (docs/24 §3.4, PR-39): TOTP собран на `node:crypto` без библиотеки,
 * поэтому сверяется с опубликованными векторами RFC 4226 (HOTP) и RFC 6238 (TOTP, SHA-1) —
 * расхождение в одном байте усечения дало бы коды, которых не показывает ни одно приложение.
 */

/** Ключ векторов RFC: ASCII «12345678901234567890». */
const RFC_KEY = Buffer.from('12345678901234567890', 'ascii')
const RFC_KEY_B32 = base32Encode(RFC_KEY)

describe('Base32 (RFC 4648)', () => {
  it('ключ RFC кодируется так, как его показывают приложения', () => {
    expect(RFC_KEY_B32).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  })

  it('туда и обратно — без потерь; регистр, пробелы и дефисы прощаются', () => {
    const secret = generateSecret()
    expect(secret).toMatch(/^[A-Z2-7]{32}$/) // 20 байт = 160 бит = 32 символа
    expect(base32Encode(base32Decode(secret))).toBe(secret)
    expect(base32Decode('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq').equals(RFC_KEY)).toBe(true)
  })

  it('чужой символ — ошибка, а не молча испорченный ключ', () => {
    expect(() => base32Decode('GEZD1')).toThrow()
  })
})

describe('HOTP (RFC 4226, приложение D)', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489']
  it.each(expected.map((code, counter) => ({ counter, code })))('счётчик $counter → $code', ({ counter, code }) => {
    expect(hotp(RFC_KEY, counter)).toBe(code)
  })
})

describe('TOTP (RFC 6238, приложение B, SHA-1, 8 цифр)', () => {
  const vectors: [number, string][] = [
    [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
    [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
  ]
  it.each(vectors.map(([t, code]) => ({ t, code })))('T=$t → $code', ({ t, code }) => {
    expect(hotp(RFC_KEY, stepAt(t * 1000), 8)).toBe(code)
    // Шесть цифр приложения — младшие шесть того же числа
    expect(totpAt(RFC_KEY_B32, t * 1000)).toBe(code.slice(2))
  })
})

describe('проверка кода', () => {
  const now = 1_790_000_000_000
  const secret = generateSecret()
  const at = (dSteps: number) => totpAt(secret, now + dSteps * TOTP_PERIOD_SEC * 1000)

  it('текущий шаг и соседние (часы телефона ±30 с) принимаются, дальние — нет', () => {
    expect(verifyTotp(secret, at(0), now, null)).toBe(stepAt(now))
    expect(verifyTotp(secret, at(-1), now, null)).toBe(stepAt(now) - 1)
    expect(verifyTotp(secret, at(1), now, null)).toBe(stepAt(now) + 1)
    // Совпадение кода соседнего шага с кодом дальнего — 1 на миллион; сравниваем именно шаг
    expect(verifyTotp(secret, at(-2), now, null)).not.toBe(stepAt(now) - 2)
    expect(verifyTotp(secret, at(3), now, null)).not.toBe(stepAt(now) + 3)
  })

  it('принятый код повторно не проходит — даже в свои 30 секунд (защита от перехвата)', () => {
    const step = verifyTotp(secret, at(0), now, null)!
    expect(verifyTotp(secret, at(0), now, step)).toBeNull()
    // И более ранний шаг после принятого — тоже нет
    expect(verifyTotp(secret, at(-1), now, step)).toBeNull()
    // А следующий шаг — да
    expect(verifyTotp(secret, at(1), now, step)).toBe(step + 1)
  })

  it('не шесть цифр — отказ без вычислений', () => {
    expect(verifyTotp(secret, '12345', now, null)).toBeNull()
    expect(verifyTotp(secret, '12345a', now, null)).toBeNull()
    expect(verifyTotp(secret, ' 123456', now, null)).toBeNull()
  })
})

describe('otpauth-ссылка (формат Key Uri)', () => {
  it('издатель, метка и параметры, которые понимают приложения', () => {
    const uri = otpauthUri('GEZDGNBVGY3TQOJQ', 'Lola', 'admin@kappi.ua (Каппі)')
    expect(uri.startsWith('otpauth://totp/Lola%3Aadmin%40kappi.ua%20(%D0%9A')).toBe(true)
    const q = new URL(uri.replace('otpauth://', 'https://x/')).searchParams
    expect(q.get('secret')).toBe('GEZDGNBVGY3TQOJQ')
    expect(q.get('issuer')).toBe('Lola')
    expect(q.get('algorithm')).toBe('SHA1')
    expect(q.get('digits')).toBe('6')
    expect(q.get('period')).toBe('30')
  })
})

describe('резервные коды', () => {
  it('десять разных кодов вида xxxxx-xxxxx без путаемых символов', () => {
    const codes = generateRecoveryCodes()
    expect(codes).toHaveLength(10)
    expect(new Set(codes).size).toBe(10)
    for (const c of codes) expect(c).toMatch(/^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/)
  })

  it('регистр, пробелы и дефис при вводе не важны', () => {
    expect(normalizeRecoveryCode(' AbCdE-fGhJk ')).toBe('abcdefghjk')
    expect(normalizeRecoveryCode('abcde fghjk')).toBe('abcdefghjk')
  })
})

describe('флаг sessionOnly на скоупе (docs/v2/44 В-20)', () => {
  it('каждый помеченный скоуп существует в реестре — опечатка не должна тихо снять защиту', () => {
    for (const s of Object.keys(SCOPE_FLAGS)) expect(SCOPES as readonly string[]).toContain(s)
  })

  it('состав: пять из решения (с именем person.note.read из реестра) и два добавленных PR-39', () => {
    expect([...SESSION_ONLY_SCOPES].sort()).toEqual([
      'candidate.decide', 'candidate.hire', 'interview.listen', 'people.password', 'person.note.read', 'person.note.write', 'tenant.transfer',
    ])
  })

  it('флаг ограничивает токен, а не человека: у ролей эти права остаются', () => {
    expect(isSessionOnlyScope('person.note.read')).toBe(true)
    expect(isSessionOnlyScope('people.view')).toBe(false)
    expect(isSessionOnlyScope('нет-такого')).toBe(false)
    expect(SYSTEM_ROLES.admin!.scopes).toContain('people.password')
    expect(SYSTEM_ROLES.owner!.scopes).toContain('tenant.transfer')
  })
})
