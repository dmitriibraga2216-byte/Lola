/**
 * Автопроверка ответов (docs/12-tests-questions.md §3.3, §7.6).
 * Чистые функции без БД: работают по снапшоту вопроса, а не по текущей версии.
 */

export type QuestionKind
  = 'single' | 'multiple' | 'order' | 'match' | 'number' | 'text_short' | 'text_long' | 'file'

export const MANUAL_KINDS: ReadonlySet<QuestionKind> = new Set(['text_long', 'file'])

export interface SnapshotQuestion {
  id: string
  version: number
  kind: QuestionKind
  stem: unknown
  options: unknown
  answer: unknown // эталон; null для ручных
  explanation: unknown
  points: number
  isCritical: boolean
  partialCredit: boolean
  negativeMarking: boolean
  requireExact?: boolean
}

export interface GradeResult {
  isCorrect: boolean | null // null — нужна ручная проверка
  score: number
  auto: boolean
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function normalizeText(s: string, opts: { caseSensitive?: boolean, trim?: boolean, normalizeSpaces?: boolean }): string {
  let out = s
  if (opts.trim !== false) out = out.trim()
  if (opts.normalizeSpaces !== false) out = out.replace(/\s+/g, ' ')
  if (!opts.caseSensitive) out = out.toLowerCase()
  return out
}

/** Расстояние Левенштейна для allow_typos. */
function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = cur
  }
  return prev[n]!
}

export function gradeAnswer(q: SnapshotQuestion, answer: unknown): GradeResult {
  if (MANUAL_KINDS.has(q.kind)) return { isCorrect: null, score: 0, auto: false }
  if (answer === null || answer === undefined) return { isCorrect: false, score: 0, auto: true }

  switch (q.kind) {
    case 'single': {
      const correct = (q.answer as { correctId: string }).correctId
      const given = (answer as { optionId?: string }).optionId
      const ok = given === correct
      return { isCorrect: ok, score: ok ? q.points : 0, auto: true }
    }

    case 'multiple': {
      const correct = new Set((q.answer as { correctIds: string[] }).correctIds)
      const given = new Set(((answer as { optionIds?: string[] }).optionIds ?? []))
      const right = [...given].filter(id => correct.has(id)).length
      const wrong = given.size - right
      const exact = right === correct.size && wrong === 0

      if (q.requireExact || !q.partialCredit) {
        return { isCorrect: exact, score: exact ? q.points : 0, auto: true }
      }
      // points × (верно − неверно) / всего верных, не меньше 0
      const raw = q.points * (right - (q.negativeMarking ? wrong : 0)) / correct.size
      const score = round2(Math.max(0, Math.min(q.points, raw)))
      return { isCorrect: exact, score, auto: true }
    }

    case 'order': {
      const correct = (q.answer as { order: string[] }).order
      const given = (answer as { order?: string[] }).order ?? []
      if (given.length !== correct.length) {
        return { isCorrect: false, score: 0, auto: true }
      }
      const exact = correct.every((id, i) => given[i] === id)
      if (!q.partialCredit) return { isCorrect: exact, score: exact ? q.points : 0, auto: true }

      // Доля пар в правильном относительном порядке
      const pos = new Map(given.map((id, i) => [id, i]))
      let goodPairs = 0
      let totalPairs = 0
      for (let i = 0; i < correct.length; i++) {
        for (let j = i + 1; j < correct.length; j++) {
          totalPairs++
          const pi = pos.get(correct[i]!)
          const pj = pos.get(correct[j]!)
          if (pi !== undefined && pj !== undefined && pi < pj) goodPairs++
        }
      }
      const score = totalPairs === 0 ? q.points : round2(q.points * goodPairs / totalPairs)
      return { isCorrect: exact, score, auto: true }
    }

    case 'match': {
      const correct = (q.answer as { pairs: { leftId: string, rightId: string }[] }).pairs
      const given = (answer as { pairs?: { leftId: string, rightId: string }[] }).pairs ?? []
      const givenMap = new Map(given.map(p => [p.leftId, p.rightId]))
      const right = correct.filter(p => givenMap.get(p.leftId) === p.rightId).length
      const exact = right === correct.length
      if (!q.partialCredit) return { isCorrect: exact, score: exact ? q.points : 0, auto: true }
      return { isCorrect: exact, score: round2(q.points * right / correct.length), auto: true }
    }

    case 'number': {
      const spec = q.answer as { value: number, tolerance: number, toleranceType?: 'abs' | 'pct' }
      const raw = (answer as { value?: number | string }).value
      const num = typeof raw === 'string' ? Number.parseFloat(raw.replace(',', '.')) : raw
      if (typeof num !== 'number' || Number.isNaN(num)) return { isCorrect: false, score: 0, auto: true }
      const tol = spec.toleranceType === 'pct' ? Math.abs(spec.value) * spec.tolerance / 100 : spec.tolerance
      const ok = Math.abs(num - spec.value) <= tol + 1e-9
      return { isCorrect: ok, score: ok ? q.points : 0, auto: true }
    }

    case 'text_short': {
      const spec = q.answer as {
        accepted: string[]
        caseSensitive?: boolean
        trim?: boolean
        normalizeSpaces?: boolean
        allowTypos?: number
      }
      const given = normalizeText(String((answer as { text?: string }).text ?? ''), spec)
      const typos = spec.allowTypos ?? 0
      const ok = spec.accepted.some((acc) => {
        const norm = normalizeText(acc, spec)
        return typos > 0 ? levenshtein(norm, given) <= typos : norm === given
      })
      return { isCorrect: ok, score: ok ? q.points : 0, auto: true }
    }

    default:
      return { isCorrect: null, score: 0, auto: false }
  }
}

export interface AttemptTotals {
  score: number // процент 0–100
  maxScore: number
  earned: number
  passed: boolean | null // null — есть непроверенные ручные
  criticalFailed: boolean
  pendingManual: number
}

/**
 * Итог попытки (docs/12 §7.5–7.6): score = Σ баллов / Σ весов × 100,
 * passed = score ≥ pass_score И нет ошибок в критических И все ручные зачтены.
 */
export function computeTotals(
  questions: SnapshotQuestion[],
  answers: Map<string, GradeResult>,
  passScore: number,
): AttemptTotals {
  let earned = 0
  let maxScore = 0
  let criticalFailed = false
  let pendingManual = 0

  for (const q of questions) {
    maxScore += q.points
    const g = answers.get(q.id)
    if (!g) {
      if (q.isCritical) criticalFailed = true
      if (MANUAL_KINDS.has(q.kind)) pendingManual++
      continue
    }
    if (g.isCorrect === null) {
      pendingManual++
      continue
    }
    earned += g.score
    if (q.isCritical && !g.isCorrect) criticalFailed = true
  }

  const score = maxScore === 0 ? 0 : round2(earned / maxScore * 100)
  const passed = pendingManual > 0 ? null : score >= passScore && !criticalFailed
  return { score, maxScore: round2(maxScore), earned: round2(earned), passed, criticalFailed, pendingManual }
}

/** Параметры прохождения по умолчанию (docs/12 §3.5). */
export interface QuizParams {
  passScore: number
  attemptsAllowed: number // 0 = без ограничения
  attemptCooldownMin: number
  timeLimitSec: number | null
  shuffleQuestions: boolean
  shuffleOptions: boolean
  showAnswers: 'never' | 'after_question' | 'after_attempt' | 'after_pass'
  showScore: boolean
  allowSkip: boolean
  allowBack: boolean
  requireAllAnswered: boolean
}

export const DEFAULT_QUIZ_PARAMS: QuizParams = {
  passScore: 80,
  attemptsAllowed: 3,
  attemptCooldownMin: 0,
  timeLimitSec: null,
  shuffleQuestions: true,
  shuffleOptions: true,
  showAnswers: 'after_attempt',
  showScore: true,
  allowSkip: true,
  allowBack: true,
  requireAllAnswered: false,
}

/** Убирает эталоны и разбор из вопроса для выдачи ученику до завершения. */
export function stripAnswers(q: SnapshotQuestion): Omit<SnapshotQuestion, 'answer' | 'explanation'> {
  const { answer: _a, explanation: _e, ...safe } = q
  // Для match правая колонка перемешивается снапшотом, эталон в answer
  return safe
}
