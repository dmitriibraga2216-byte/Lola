import type { AiReviewHintAgreement } from '../enums'

/**
 * Правила подсказки проверяющему без базы и сети (`docs/v2/30-ai-interview.md` §3.6, §5.5, §7.13,
 * §12 п. 12; план `45` PR-29). Чистые функции: их проверяет `tests/unit/review-hint-rules.spec.ts`,
 * `server/services/reviewHints.ts` только применяет.
 *
 * **Подсказка — не ответ** (инвариант 18). Она умеет сказать ровно три вещи: «этот пункт ключа
 * прозвучал вот здесь», «этот пункт не прозвучал», «здесь сказано противоположное». Ни балла, ни
 * «зараховано», ни предзаполненных значений в форме ментора: решает человек.
 */

/** Пунктов ключа в одной подсказке — не больше 12: длинный ключ режется по порядку. */
export const HINT_KEY_POINTS_MAX = 12
/** Пояснение противоречия — до 300 знаков. */
export const HINT_WHY_MAX = 300
/** Сколько отказов подряд поднимают `ai_review_hint_failed` админу (`30` §8). */
export const HINT_FAILED_STREAK = 3
/** Пороги покрытия для сверки с решением ментора (`30` §7.13). */
export const HINT_COVERAGE = { high: 0.8, low: 0.4 } as const

export interface KeyPoint { id: string, text: string }

export interface HintMatched { keyPoint: string, quote: string, charFrom: number, charTo: number }
export interface HintMissing { keyPoint: string }
export interface HintContradiction { keyPoint: string, quote: string, why: string }

export interface HintLists {
  matched: HintMatched[]
  missing: HintMissing[]
  contradictions: HintContradiction[]
  /** Доля пунктов ключа, которые прозвучали: «Покриття ключа: 4 з 6» (`30` §5.5). */
  coverage: number
  confidence: number | null
}

const stripHtml = (s: string): string => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * Пункты контрольного ключа (`30` §7.13: «эталонный ответ и критерии из `12` §3.3 и `13` §3.1»):
 * критерии, а если их нет — предложения эталонного ответа. Текст пункта пишет методист, не
 * модель: модель только сопоставляет, поэтому формулировки пунктов в подсказке — человеческие.
 */
export function keyPointsOf(input: { criteria: readonly string[], reference: string | null }): KeyPoint[] {
  const fromCriteria = input.criteria.map(stripHtml).filter(Boolean)
  const texts = fromCriteria.length
    ? fromCriteria
    : stripHtml(input.reference ?? '').split(/(?<=[.!?;])\s+|\n+/).map(s => s.trim()).filter(s => s.length >= 3)
  return texts.slice(0, HINT_KEY_POINTS_MAX).map((text, i) => ({ id: `k${i + 1}`, text: text.slice(0, 300) }))
}

/**
 * Слова вердикта (`30` §7.13: «никаких "правильно", "невірно", "зарахувати"»). Модель, которая
 * написала «відповідь правильна» в пояснении, вынесла вердикт вместо сверки — ответ отклоняется.
 * Цитаты этой проверке не подлежат: цитата — слова самого человека, найденные в его ответе.
 */
const VERDICT_WORDS = /(?<!\p{L})(правильн\p{L}*|неправильн\p{L}*|невірн\p{L}*|вірн\p{L}*|зарахува\p{L}*|зарахован\p{L}*|незарахован\p{L}*|верн\p{L}*|неверн\p{L}*|засчита\p{L}*|засчитан\p{L}*|correct\p{L}*|incorrect\p{L}*|wrong|right answer|pass(?:ed)?|fail(?:ed)?|verdict)(?!\p{L})/iu

export function hasVerdictWords(text: string): boolean {
  return VERDICT_WORDS.test(text)
}

export interface RawHintItem { keyPointId?: unknown, status?: unknown, quote?: unknown, why?: unknown }

export type HintProblem = 'key_point_missing' | 'key_point_unknown' | 'key_point_duplicate' | 'status_invalid' | 'quote_not_found' | 'why_missing' | 'verdict_words'

export type HintValidation = { ok: true, lists: HintLists } | { ok: false, problems: { keyPointId: string | null, problem: HintProblem }[] }

/** Место цитаты в ответе: точное вхождение, иначе — без учёта регистра. */
function locate(answer: string, quote: string): { from: number, to: number } | null {
  let at = answer.indexOf(quote)
  if (at < 0) at = answer.toLowerCase().indexOf(quote.toLowerCase())
  return at < 0 ? null : { from: at, to: at + quote.length }
}

/**
 * Проверка ответа модели (`30` §3.6, §7.13): каждый пункт ключа — ровно один из трёх статусов;
 * «прозвучал» и «противоречит» — с цитатой, которая **дословно** есть в ответе человека (иначе это
 * не наблюдение, а выдумка модели); у противоречия — пояснение без слов вердикта. Ответ с
 * нарушением — повтор с усиленной инструкцией, затем подсказки нет (`failed`): лучше никакой
 * подсказки, чем уверенно неверная.
 */
export function validateHint(keyPoints: readonly KeyPoint[], answer: string, raw: readonly RawHintItem[], confidence?: unknown): HintValidation {
  const problems: { keyPointId: string | null, problem: HintProblem }[] = []
  const byId = new Map(keyPoints.map(k => [k.id, k]))
  const seen = new Set<string>()
  const matched: HintMatched[] = []
  const missing: HintMissing[] = []
  const contradictions: HintContradiction[] = []

  for (const r of raw) {
    const id = typeof r.keyPointId === 'string' ? r.keyPointId : null
    const kp = id ? byId.get(id) : undefined
    if (!id || !kp) { problems.push({ keyPointId: id, problem: 'key_point_unknown' }); continue }
    if (seen.has(id)) { problems.push({ keyPointId: id, problem: 'key_point_duplicate' }); continue }
    seen.add(id)
    const status = r.status
    if (status === 'missing') { missing.push({ keyPoint: kp.text }); continue }
    if (status !== 'matched' && status !== 'contradicts') { problems.push({ keyPointId: id, problem: 'status_invalid' }); continue }
    const quote = typeof r.quote === 'string' ? r.quote.trim() : ''
    const at = quote ? locate(answer, quote) : null
    if (!at) { problems.push({ keyPointId: id, problem: 'quote_not_found' }); continue }
    const exact = answer.slice(at.from, at.to)
    if (status === 'matched') { matched.push({ keyPoint: kp.text, quote: exact, charFrom: at.from, charTo: at.to }); continue }
    const why = typeof r.why === 'string' ? r.why.trim() : ''
    if (!why || why.length > HINT_WHY_MAX) { problems.push({ keyPointId: id, problem: 'why_missing' }); continue }
    if (hasVerdictWords(why)) { problems.push({ keyPointId: id, problem: 'verdict_words' }); continue }
    contradictions.push({ keyPoint: kp.text, quote: exact, why })
  }
  for (const k of keyPoints) if (!seen.has(k.id)) problems.push({ keyPointId: k.id, problem: 'key_point_missing' })
  if (problems.length) return { ok: false, problems }

  const c = typeof confidence === 'number' && Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : null
  return {
    ok: true,
    lists: {
      matched, missing, contradictions,
      coverage: keyPoints.length ? Math.round((matched.length / keyPoints.length) * 1000) / 1000 : 0,
      confidence: c === null ? null : Math.round(c * 1000) / 1000,
    },
  }
}

/**
 * Сверка решения ментора с подсказкой (`30` §7.13): зачёт при покрытии ≥ 0,8 или незачёт при
 * покрытии ≤ 0,4 — `match`; зачёт при ≤ 0,4 или незачёт при ≥ 0,8 — `major`; остальное — `minor`;
 * панель не раскрыта — `not_shown` (контрольная группа, §12 п. 12). «На доопрацювання» — не зачёт.
 */
export function hintAgreement(coverage: number | null, passed: boolean, shown: boolean): AiReviewHintAgreement {
  if (!shown) return 'not_shown'
  if (coverage === null) return 'minor'
  const high = coverage >= HINT_COVERAGE.high
  const low = coverage <= HINT_COVERAGE.low
  if ((passed && high) || (!passed && low)) return 'match'
  if ((passed && low) || (!passed && high)) return 'major'
  return 'minor'
}

/**
 * Заглушка подсказки (`docs/v2/44` §8): детерминированная и без сети. Пункт «прозвучал», если в
 * ответе есть слово пункта от пяти букв, — цитатой идёт само это слово, как оно написано в
 * ответе; иначе «не згадано». Противоречий заглушка не находит: для этого нужен смысл, а не слова.
 */
export function stubHint(keyPoints: readonly KeyPoint[], answer: string): RawHintItem[] {
  const lower = answer.toLowerCase()
  return keyPoints.map((k) => {
    const words = k.text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 5)
    for (const w of words) {
      const at = lower.indexOf(w)
      if (at >= 0) return { keyPointId: k.id, status: 'matched', quote: answer.slice(at, at + w.length) }
    }
    return { keyPointId: k.id, status: 'missing' }
  })
}
