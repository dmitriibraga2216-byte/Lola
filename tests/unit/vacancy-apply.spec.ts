import { describe, expect, it } from 'vitest'
import {
  ENUMS, PUBLIC_APPLY_OUTCOMES, VACANCY_APPLICATION_STATES, VACANCY_APPLY_LIMITS,
  VACANCY_APPLY_REVIEW_SCORE, VACANCY_APPLY_SPAM_SCORE, VACANCY_APPLY_SPAM_SCORES,
  VACANCY_NONCE_MIN_SEC,
} from '../../shared/enums'
import { publicApplySchema } from '../../shared/schemas/publicApply'

process.env.SESSION_SECRET ??= 'test-session-secret'

const { readNonce, signNonce, spamOf, splitFullName, stateFor } = await import('../../server/services/publicApply')

/**
 * Правила публичного контура вакансии (docs/v2/29-vacancies.md §6.3, §7.2–§7.7),
 * план docs/v2/45-plan.md PR-16.
 *
 * Здесь — только то, что является **правилом**, а не запросом: подпись формы, слагаемые
 * `spam_score`, выбор состояния отклика, разбор имени и контракт формы. Всё, что касается
 * изоляции тенанта и транзакции §7.20, живёт в интеграционной спеке — там это проверяется
 * фактом в базе, а не мнением о коде.
 */

describe('form_nonce: подпись формы (§6.3, §7.6)', () => {
  it('подписанный nonce читается обратно с тем же id вакансии и моментом выдачи', () => {
    const at = Date.now() - 5000
    const nonce = signNonce('11111111-1111-1111-1111-111111111111', at)
    const read = readNonce(nonce)
    expect(read?.vacancyId).toBe('11111111-1111-1111-1111-111111111111')
    expect(read?.issuedAt).toBe(at)
  })

  it('подделанная подпись не читается — иначе бот выпишет себе любую давность формы', () => {
    const nonce = signNonce('11111111-1111-1111-1111-111111111111')
    const [body] = nonce.split('.')
    expect(readNonce(`${body}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`)).toBeNull()
  })

  it('подменённое тело при чужой подписи не читается', () => {
    const nonce = signNonce('11111111-1111-1111-1111-111111111111')
    const other = signNonce('22222222-2222-2222-2222-222222222222')
    expect(readNonce(`${other.split('.')[0]}.${nonce.split('.')[1]}`)).toBeNull()
  })

  it('мусор вместо nonce не роняет разбор', () => {
    expect(readNonce('')).toBeNull()
    expect(readNonce('no-dot')).toBeNull()
    expect(readNonce('....')).toBeNull()
  })
})

describe('spam_score: слагаемые §7.7', () => {
  const base = {
    website: null,
    comment: null,
    fullName: 'Олена Петренко',
    fillSeconds: 30,
    nonceReplay: false,
    ipMarkedSpam: false,
  }

  it('обычный отклик человека не набирает ничего', () => {
    expect(spamOf(base)).toEqual({ score: 0, reasons: [] })
  })

  it('honeypot — 60', () => {
    const v = spamOf({ ...base, website: 'https://spam.example' })
    expect(v.score).toBe(VACANCY_APPLY_SPAM_SCORES.honeypot)
    expect(v.reasons).toContain('honeypot')
  })

  it('отправка раньше четырёх секунд — 40 (критерий §13 к. 3)', () => {
    const v = spamOf({ ...base, fillSeconds: VACANCY_NONCE_MIN_SEC - 3 })
    expect(v.score).toBe(VACANCY_APPLY_SPAM_SCORES.fastSubmit)
    expect(v.reasons).toContain('fast_submit')
  })

  it('ровно четыре секунды — уже не быстрая отправка (граница §7.6)', () => {
    expect(spamOf({ ...base, fillSeconds: VACANCY_NONCE_MIN_SEC }).reasons).toEqual([])
  })

  it('повтор nonce — 100, то есть сразу немой отсев', () => {
    const v = spamOf({ ...base, nonceReplay: true })
    expect(v.score).toBe(VACANCY_APPLY_SPAM_SCORES.nonceReplay)
    expect(stateFor(v, false)).toBe('spam')
  })

  it('ссылка в комментарии — 30', () => {
    expect(spamOf({ ...base, comment: 'Дивіться http://my.site' }).reasons).toContain('comment_links')
    expect(spamOf({ ...base, comment: 'www.site.com' }).reasons).toContain('comment_links')
    expect(spamOf({ ...base, comment: 'Працював у кав’ярні два роки' }).reasons).toEqual([])
  })

  it('имя из одних латинских согласных — 20, живые имена не трогает', () => {
    expect(spamOf({ ...base, fullName: 'qwrtp zxcvb' }).reasons).toContain('consonant_name')
    expect(spamOf({ ...base, fullName: 'Ольга Іванова' }).reasons).toEqual([])
    expect(spamOf({ ...base, fullName: 'Ian Smith' }).reasons).toEqual([])
    // Согласных много, но гласная есть — это фамилия, а не генератор
    expect(spamOf({ ...base, fullName: 'Krzysztof Wojcik' }).reasons).toEqual([])
  })

  it('адрес, уже помеченный спамом, — 50', () => {
    expect(spamOf({ ...base, ipMarkedSpam: true }).score).toBe(VACANCY_APPLY_SPAM_SCORES.ipMarkedSpam)
  })

  it('слагаемые складываются: honeypot плюс быстрая отправка дают модерацию', () => {
    const v = spamOf({ ...base, website: 'x', fillSeconds: 1 })
    expect(v.score).toBe(VACANCY_APPLY_SPAM_SCORES.honeypot + VACANCY_APPLY_SPAM_SCORES.fastSubmit)
    expect(v.score).toBeGreaterThanOrEqual(VACANCY_APPLY_REVIEW_SCORE)
  })
})

describe('состояние отклика по итогам проверок (§7.7 плюс критерий §13 к. 3)', () => {
  it('чистый отклик ждёт подтверждения контакта', () => {
    expect(stateFor({ score: 0, reasons: [] }, false)).toBe('pending')
  })

  it('любая сработавшая причина уводит к человеку, даже ниже порога 50', () => {
    // Ровно это требует критерий §13 к. 3: быстрая отправка стоит 40, но отклик обязан
    // оказаться в `pending_review`, а не пройти дальше как чистый.
    expect(stateFor({ score: 40, reasons: ['fast_submit'] }, false)).toBe('pending_review')
  })

  it('сработавшее частотное правило тоже уводит к человеку (критерий §13 к. 5)', () => {
    expect(stateFor({ score: 0, reasons: [] }, true)).toBe('pending_review')
  })

  it('порог немого отсева — 100 (критерий §13 к. 4 допускает и pending_review, и spam)', () => {
    expect(stateFor({ score: VACANCY_APPLY_SPAM_SCORE, reasons: ['nonce_replay'] }, false)).toBe('spam')
    expect(stateFor({ score: VACANCY_APPLY_SPAM_SCORE - 1, reasons: ['honeypot'] }, false)).toBe('pending_review')
  })
})

describe('контракт публичной формы (§6.3)', () => {
  const ok = {
    fullName: 'Олена Петренко',
    phone: '+380671234567',
    consent: true as const,
    formNonce: signNonce('11111111-1111-1111-1111-111111111111'),
  }

  it('телефон или почта — достаточно одного', () => {
    expect(publicApplySchema.safeParse(ok).success).toBe(true)
    expect(publicApplySchema.safeParse({ ...ok, phone: undefined, email: 'a@b.com' }).success).toBe(true)
  })

  it('без контакта отклик не принимается', () => {
    const r = publicApplySchema.safeParse({ ...ok, phone: undefined })
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error?.issues)).toContain('contact_required')
  })

  it('без согласия отклик не принимается никогда (§7.23)', () => {
    expect(publicApplySchema.safeParse({ ...ok, consent: false }).success).toBe(false)
  })

  it('имя из одного слова не принимается — форма просит имя и фамилию', () => {
    expect(publicApplySchema.safeParse({ ...ok, fullName: 'Олена' }).success).toBe(false)
  })

  it('honeypot схемой не отвергается — иначе бот узнал бы о проверке по коду ответа', () => {
    expect(publicApplySchema.safeParse({ ...ok, website: 'https://spam.example' }).success).toBe(true)
  })

  it('комментарий длиннее 1000 знаков не принимается', () => {
    expect(publicApplySchema.safeParse({ ...ok, comment: 'я'.repeat(1001) }).success).toBe(false)
  })
})

describe('разбор «Ім’я та прізвище» одним полем (§6.3)', () => {
  it('первое слово — имя, остальное — фамилия', () => {
    expect(splitFullName('Олена Петренко')).toEqual({ firstName: 'Олена', lastName: 'Петренко' })
    expect(splitFullName('Марія Ткаченко-Коваль')).toEqual({ firstName: 'Марія', lastName: 'Ткаченко-Коваль' })
  })

  it('три слова: имя плюс всё остальное как фамилия — порядок за человека не переставляем', () => {
    expect(splitFullName('Олена Іванівна Петренко')).toEqual({ firstName: 'Олена', lastName: 'Іванівна Петренко' })
  })

  it('лишние пробелы не создают пустых частей', () => {
    expect(splitFullName('  Олена   Петренко ')).toEqual({ firstName: 'Олена', lastName: 'Петренко' })
  })
})

describe('перечисления публичного контура (CLAUDE.md п. 13)', () => {
  it('состояния отклика и исходы попытки объявлены в ENUMS', () => {
    expect(ENUMS.vacancy_application_state).toEqual(VACANCY_APPLICATION_STATES)
    expect(ENUMS.public_apply_outcome).toEqual(PUBLIC_APPLY_OUTCOMES)
  })

  it('частотные пороги §7.4 записаны ровно так, как в документе', () => {
    expect(VACANCY_APPLY_LIMITS).toEqual({ ipHour: 3, ipDay: 10, perVacancyDay: 1, viewPer10Min: 30 })
  })
})
