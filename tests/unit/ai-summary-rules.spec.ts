import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { criterionAgreement, humanAdjustedScore } from '../../shared/domain/interview'
import { HINT_KEY_POINTS_MAX, hasVerdictWords, hintAgreement, keyPointsOf, stubHint, validateHint } from '../../shared/domain/reviewHint'
import {
  SUMMARY_DISCLAIMER, autoSendBlock, autoSendDueAt, candidateView, checkPoints, defaultSections, disclaimerLine, hasDecisionWords,
  meetsThreshold, summaryCompleteness, summaryDisclaimer, type AutoSendFacts, type SummaryBody,
} from '../../shared/domain/candidateSummary'

/**
 * Правила PR-29 без базы (`docs/v2/30-ai-interview.md` §6.4, §7.3, §7.13–§7.15; план `45` PR-29):
 * расхождение человека с моделью, подсказка проверяющему без вердикта, Підсумок и его авто-отправка.
 */

describe('несогласие с оценкой ИИ (30 §7.3)', () => {
  it('|human − ai| ≤ 10 % шкалы — match, ≤ 30 % — minor, иначе major; границы включительно', () => {
    expect(criterionAgreement(4, 2, 5)).toBe('major') // к. 6: 4 из 5 → 2
    expect(criterionAgreement(4, 3.5, 5)).toBe('match')
    expect(criterionAgreement(4, 2.5, 5)).toBe('minor')
    expect(criterionAgreement(4, 4, 5)).toBe('match')
    expect(criterionAgreement(60, 90, 100)).toBe('minor')
    expect(criterionAgreement(60, 91, 100)).toBe('major')
  })

  it('итог с поправкой человека: оспоренный критерий — балл человека, остальные — модели', () => {
    expect(humanAdjustedScore([
      { value: 4, humanValue: 2, scaleMax: 5, weight: 1 },
      { value: 3, humanValue: null, scaleMax: 5, weight: 1 },
    ])).toBe(50)
    expect(humanAdjustedScore([{ value: null, humanValue: null, scaleMax: 5, weight: 1 }])).toBeNull()
  })
})

describe('подсказка проверяющему — не ответ (30 §3.6, §7.13)', () => {
  const keys = keyPointsOf({ criteria: ['температура зберігання', '<b>термін</b> придатності'], reference: null })

  it('пункты ключа — критерии методиста, без разметки; без критериев — предложения эталона', () => {
    expect(keys).toEqual([{ id: 'k1', text: 'температура зберігання' }, { id: 'k2', text: 'термін придатності' }])
    expect(keyPointsOf({ criteria: [], reference: 'Температура 0…+4. Термін на етикетці!' }).map(k => k.text)).toEqual(['Температура 0…+4.', 'Термін на етикетці!'])
    expect(keyPointsOf({ criteria: Array.from({ length: 20 }, (_, i) => `пункт ${i}`), reference: null })).toHaveLength(HINT_KEY_POINTS_MAX)
  })

  it('три списка и покрытие; цитата — только дословно из ответа', () => {
    const answer = 'Перевіряю зберігання щоранку.'
    const ok = validateHint(keys, answer, [
      { keyPointId: 'k1', status: 'matched', quote: 'зберігання' },
      { keyPointId: 'k2', status: 'missing' },
    ], 0.7)
    expect(ok).toEqual({ ok: true, lists: { matched: [{ keyPoint: 'температура зберігання', quote: 'зберігання', charFrom: 10, charTo: 20 }], missing: [{ keyPoint: 'термін придатності' }], contradictions: [], coverage: 0.5, confidence: 0.7 } })
    const invented = validateHint(keys, answer, [{ keyPointId: 'k1', status: 'matched', quote: 'температура +4' }, { keyPointId: 'k2', status: 'missing' }])
    expect(invented).toMatchObject({ ok: false, problems: [{ keyPointId: 'k1', problem: 'quote_not_found' }] })
    const partial = validateHint(keys, answer, [{ keyPointId: 'k1', status: 'missing' }])
    expect(partial).toMatchObject({ ok: false, problems: [{ keyPointId: 'k2', problem: 'key_point_missing' }] })
  })

  it('пояснение противоречия со словами вердикта отклоняется (30 §7.13: никаких «правильно», «невірно», «зарахувати»)', () => {
    const answer = 'Зберігаю при кімнатній температурі.'
    const verdict = validateHint(keys, answer, [
      { keyPointId: 'k1', status: 'contradicts', quote: 'при кімнатній температурі', why: 'Це невірно: потрібен холодильник' },
      { keyPointId: 'k2', status: 'missing' },
    ])
    expect(verdict).toMatchObject({ ok: false, problems: [{ keyPointId: 'k1', problem: 'verdict_words' }] })
    const neutral = validateHint(keys, answer, [
      { keyPointId: 'k1', status: 'contradicts', quote: 'при кімнатній температурі', why: 'У ключі — зберігання в холоді від 0 до +4' },
      { keyPointId: 'k2', status: 'missing' },
    ])
    expect(neutral.ok).toBe(true)
    for (const w of ['правильно', 'Невірно', 'зарахувати', 'незараховано', 'correct', 'Wrong', 'неверно']) expect(hasVerdictWords(`Відповідь ${w}.`), w).toBe(true)
    for (const w of ['У ключі — холодильник', 'Не згадано термін', 'Збіглося з ключем', 'Суперечить ключу']) expect(hasVerdictWords(w), w).toBe(false)
  })

  it('сверка с решением ментора по покрытию (30 §7.13); панель не раскрыта — not_shown', () => {
    expect(hintAgreement(0.8, true, true)).toBe('match')
    expect(hintAgreement(0.4, false, true)).toBe('match')
    expect(hintAgreement(0.4, true, true)).toBe('major')
    expect(hintAgreement(0.9, false, true)).toBe('major')
    expect(hintAgreement(0.5, true, true)).toBe('minor')
    expect(hintAgreement(0.9, true, false)).toBe('not_shown')
  })

  it('заглушка детерминирована: слово пункта от пяти букв в ответе — «прозвучал» с этим словом цитатой', () => {
    const a = stubHint(keys, 'Зберігання продуктів перевіряю.')
    expect(a).toEqual([{ keyPointId: 'k1', status: 'matched', quote: 'Зберігання' }, { keyPointId: 'k2', status: 'missing' }])
    expect(stubHint(keys, 'Зберігання продуктів перевіряю.')).toEqual(a)
    expect(validateHint(keys, 'Зберігання продуктів перевіряю.', a).ok).toBe(true)
  })

  it('подписи панели в трёх языках не выносят вердикта', () => {
    for (const lang of ['uk', 'en', 'ru']) {
      const dict = JSON.parse(readFileSync(resolve(__dirname, `../../i18n/locales/${lang}.json`), 'utf8')) as { reviewHint: Record<string, string> }
      for (const [key, text] of Object.entries(dict.reviewHint)) expect(hasVerdictWords(text), `${lang}.reviewHint.${key}: ${text}`).toBe(false)
    }
  })
})

describe('Підсумок кандидата (30 §7.14, §13 к. 14)', () => {
  it('подпись «Документ сформовано автоматично» на трёх языках проходит CHECK таблицы', () => {
    const sql = readFileSync(resolve(__dirname, '../../server/db/migrations/0096_v2_ai_summary.sql'), 'utf8')
    const m = /candidate_summaries_disclaimer_chk.*?~ '([^']+)'/.exec(sql)
    expect(m).toBeTruthy()
    const re = new RegExp(m![1]!)
    for (const lang of ['uk', 'en', 'ru'] as const) {
      expect(summaryDisclaimer(lang, false).text).toMatch(re)
      expect(SUMMARY_DISCLAIMER[lang]).toMatch(re)
    }
    expect(disclaimerLine(summaryDisclaimer('uk', true))).toBe('Документ сформовано автоматично на основі відповідей кандидата. Оцінки програми перевірено людиною: так.')
  })

  const body = {
    candidate: { fullName: 'Олена Коваль', vacancyTitle: 'Бариста' },
    progress: { items: [{ title: 'Стандарти сервісу', kind: 'course', status: 'done', score: 90, finishedAt: null }, { title: 'Каса', kind: 'test', status: 'in_progress', score: null, finishedAt: null }] },
    scores: { items: [{ kind: 'recruiter', value: 70, authorName: 'Рекрутер Іванова', at: '2026-09-25T10:00:00.000Z', aiStub: false }] },
    interview: null,
    strengthsRisks: { status: 'ready', strengths: ['Спокійно пояснює'], risks: [], caveat: 'оговорка', aiStub: false },
    incomplete: { items: [{ title: 'Каса', status: 'in_progress' }] },
    passport: { generatedAt: '2026-09-25T10:00:00.000Z', model: null, promptVersion: null, humanChecked: false, aiStub: false },
    disclaimer: summaryDisclaimer('uk', false),
  } as SummaryBody

  it('документ кандидату: только включённые секции, без ПД третьих лиц, подпись — всегда', () => {
    const v = candidateView(body, ['scores', 'strengths_risks'])
    expect(Object.keys(v).sort()).toEqual(['disclaimer', 'scores', 'strengthsRisks'])
    expect(v.scores!.items[0]!.authorName).toBeNull()
    expect(body.scores.items[0]!.authorName).toBe('Рекрутер Іванова')
    expect(candidateView(body, [])).toEqual({ disclaimer: body.disclaimer })
  })

  it('полнота и секции по умолчанию', () => {
    expect(summaryCompleteness(body.progress.items)).toBe('partial')
    expect(summaryCompleteness([{ status: 'done' }])).toBe('full')
    expect(summaryCompleteness([])).toBe('partial')
    expect(defaultSections('full')).not.toContain('incomplete')
    expect(defaultSections('partial')).toContain('incomplete')
  })

  it('генеративная секция без слов решения о человеке (инвариант 18)', () => {
    expect(checkPoints({ strengths: ['Спокійно пояснює гостю'], risks: ['Мало конкретних прикладів'] })).toMatchObject({ ok: true })
    expect(checkPoints({ strengths: ['Рекомендую найняти'], risks: [] })).toEqual({ ok: false, problem: 'decision_words' })
    expect(checkPoints({ strengths: [], risks: ['Варто відмовити'] })).toEqual({ ok: false, problem: 'decision_words' })
    expect(checkPoints({ strengths: 'текст', risks: [] })).toEqual({ ok: false, problem: 'shape' })
    expect(checkPoints({ strengths: ['x'.repeat(301)], risks: [] })).toEqual({ ok: false, problem: 'too_long' })
    expect(hasDecisionWords('We recommend hiring')).toBe(true)
    expect(hasDecisionWords('Відмовився відповідати на питання 3')).toBe(false)
  })
})

describe('авто-отправка Підсумку (30 §6.5, §7.15, §13 к. 13)', () => {
  const rule = { enabled: true, scoreKind: 'recruiter' as const, minScore: 60, delayHours: 24, skipRejected: true }
  const facts = (over: Partial<AutoSendFacts> = {}): AutoSendFacts => ({
    rule, state: 'ready', isLatest: true, cancelled: false, kind: 'candidate', rejected: false, consentWithdrawn: false,
    humanChecked: false, aiConfidence: 0.9, scoreValue: 61, hasEmail: true, ...over,
  })

  it('порог по выбранной оценке: 58 — нет, 61 — да; без балла — нет', () => {
    expect(meetsThreshold(58, 60)).toBe(false)
    expect(meetsThreshold(61, 60)).toBe(true)
    expect(meetsThreshold(60, 60)).toBe(true)
    expect(meetsThreshold(null, 60)).toBe(false)
    expect(autoSendBlock(facts({ scoreValue: 58 }))).toBe('below_threshold')
    expect(autoSendBlock(facts())).toBeNull()
  })

  it('не отправляется: выключено, не готов, не последняя версия, отменено, нанят, отклонён, отозвал согласие, непроверенная низкая уверенность, нет e-mail', () => {
    expect(autoSendBlock(facts({ rule: { ...rule, enabled: false } }))).toBe('disabled')
    expect(autoSendBlock(facts({ state: 'sent' }))).toBe('not_ready')
    expect(autoSendBlock(facts({ isLatest: false }))).toBe('not_latest')
    expect(autoSendBlock(facts({ cancelled: true }))).toBe('cancelled')
    expect(autoSendBlock(facts({ kind: 'employee' }))).toBe('not_candidate')
    expect(autoSendBlock(facts({ rejected: true }))).toBe('rejected')
    expect(autoSendBlock(facts({ rejected: true, rule: { ...rule, skipRejected: false } }))).toBeNull()
    expect(autoSendBlock(facts({ consentWithdrawn: true }))).toBe('consent_withdrawn')
    expect(autoSendBlock(facts({ aiConfidence: 0.5 }))).toBe('unverified_low_confidence')
    expect(autoSendBlock(facts({ aiConfidence: 0.5, humanChecked: true }))).toBeNull()
    expect(autoSendBlock(facts({ aiConfidence: null }))).toBeNull()
    expect(autoSendBlock(facts({ hasEmail: false }))).toBe('no_contact')
  })

  it('задержка не нулевая и не больше недели: отсчитывается от момента назначения', () => {
    const now = new Date('2026-09-25T10:00:00.000Z')
    expect(autoSendDueAt(now, 24).toISOString()).toBe('2026-09-26T10:00:00.000Z')
    expect(autoSendDueAt(now, 0).toISOString()).toBe('2026-09-25T11:00:00.000Z')
    expect(autoSendDueAt(now, 1000).toISOString()).toBe('2026-10-02T10:00:00.000Z')
  })
})
