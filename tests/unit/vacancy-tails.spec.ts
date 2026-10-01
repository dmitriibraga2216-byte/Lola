import { describe, expect, it } from 'vitest'
import { VACANCY_APPLY_SPAM_SCORE, VACANCY_APPLY_SPAM_SCORES, VACANCY_STATS_ROLLUP_DAYS } from '../../shared/enums'
import { blocklistCreateSchema } from '../../shared/schemas/vacancies'
import { publicSubscribeSchema } from '../../shared/schemas/publicApply'

process.env.SESSION_SECRET ??= 'test-session-secret'

const { spamOf, stateFor } = await import('../../server/services/publicApply')
const { contactHash, maskContact, normalizeContact } = await import('../../server/services/contactBlocklist')

/**
 * Правила хвостов вакансий (docs/v2/29 §7.7, §5.6, §11; `v2/44` Р-VT.3, Р-VT.4) — без базы.
 */

const clean = { fullName: 'Олена Петренко', fillSeconds: 30, nonceReplay: false, ipMarkedSpam: false }

describe('слагаемое «контакт в чёрном списке тенанта» (§7.7)', () => {
  it('стоит 100 и одно уводит отклик в spam — немой отсев без модерации', () => {
    const v = spamOf({ ...clean, contactBlocked: true })
    expect(VACANCY_APPLY_SPAM_SCORES.contactBlocked).toBe(100)
    expect(v.score).toBe(VACANCY_APPLY_SPAM_SCORES.contactBlocked)
    expect(v.reasons).toEqual(['contact_blocked'])
    expect(stateFor(v, false)).toBe('spam')
    expect(v.score).toBeGreaterThanOrEqual(VACANCY_APPLY_SPAM_SCORE)
  })

  it('без совпадения слагаемого нет', () => {
    expect(spamOf({ ...clean, contactBlocked: false })).toEqual({ score: 0, reasons: [] })
    expect(spamOf(clean)).toEqual({ score: 0, reasons: [] })
  })
})

describe('нормализация и отпечаток контакта (Р-VT.4)', () => {
  it('телефон в любой записи сводится к +380XXXXXXXXX', () => {
    expect(normalizeContact('067 123 45 67')).toBe('+380671234567')
    expect(normalizeContact('+38 (067) 123-45-67')).toBe('+380671234567')
    expect(normalizeContact('380671234567')).toBe('+380671234567')
  })

  it('почта — нижний регистр без пробелов; мусор — null', () => {
    expect(normalizeContact('  Anna@Example.COM ')).toBe('anna@example.com')
    expect(normalizeContact('anna@')).toBeNull()
    expect(normalizeContact('12345')).toBeNull()
    expect(normalizeContact('   ')).toBeNull()
  })

  it('отпечаток одинаков для одной записи и различен у разных тенантов', () => {
    const a = contactHash('t1', '+380671234567')
    expect(contactHash('t1', normalizeContact('067 123 45 67')!)).toBe(a)
    expect(contactHash('t2', '+380671234567')).not.toBe(a)
    expect(a).not.toContain('671234567')
  })

  it('маска не выдаёт контакт целиком', () => {
    expect(maskContact('+380671234567')).toBe('+380** *** ** 67')
    expect(maskContact('anna@example.com')).toBe('a****@example.com')
  })
})

describe('контракты форм', () => {
  it('чёрный список: контакт одной строкой, причина до 500', () => {
    expect(blocklistCreateSchema.safeParse({ contact: '0671234567' }).success).toBe(true)
    expect(blocklistCreateSchema.safeParse({ contact: 'ab' }).success).toBe(false)
    expect(blocklistCreateSchema.safeParse({ contact: '0671234567', reason: 'x'.repeat(501) }).success).toBe(false)
    expect(blocklistCreateSchema.safeParse({ contact: '0671234567', extra: 1 }).success).toBe(false)
  })

  it('подписка: только корректная почта', () => {
    expect(publicSubscribeSchema.safeParse({ email: 'a@b.ua' }).success).toBe(true)
    expect(publicSubscribeSchema.safeParse({ email: 'nope' }).success).toBe(false)
    expect(publicSubscribeSchema.safeParse({ email: 'a@b.ua', phone: '1' }).success).toBe(false)
  })
})

describe('окно свёртки публичной страницы (Р-VT.3)', () => {
  it('на сутки короче 30-дневного журнала попыток', () => {
    expect(VACANCY_STATS_ROLLUP_DAYS).toBe(29)
  })
})
