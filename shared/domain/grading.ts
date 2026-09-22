/**
 * Автопроверка ответов (docs/12-tests-questions.md §3.3, §7.6).
 * Чистые функции без БД: работают по снапшоту вопроса, а не по текущей версии.
 */

import type { QuestionKind, ScoringMethod } from '../enums'

export type { QuestionKind, ScoringMethod }

/** Ручная проверка (docs/12 §15 Г-12.1): свободный ответ и файл всегда идут наставнику. */
export const MANUAL_KINDS: ReadonlySet<QuestionKind> = new Set(['free', 'file'])

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
  /** «Метод підрахунку балів» (docs/12 §14.6). У снимков до spec-12 поля нет — см. partialCredit. */
  scoringMethod?: ScoringMethod
  /** Снимки до spec-12: булев частичный балл. */
  partialCredit?: boolean
  negativeMarking: boolean
  requireExact?: boolean
  /** Группа вопросов теста, из которой вопрос попал в снимок (one_per_group). */
  groupId?: string | null
  /** Подсказка проверяющему (free): в снимке есть, ученику не отдаётся (stripAnswers). */
  graderHint?: string | null
  /** Можно ли прикрепить файлы к свободному ответу. */
  attachFiles?: boolean
}

/** Эффективный метод подсчёта: новое поле, для старых снимков — из partialCredit. */
export function scoringMethodOf(q: Pick<SnapshotQuestion, 'scoringMethod' | 'partialCredit' | 'requireExact'>): ScoringMethod {
  if (q.requireExact) return 'all_or_nothing'
  if (q.scoringMethod) return q.scoringMethod
  return q.partialCredit === false ? 'all_or_nothing' : 'formula'
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

/** Область на изображении: прямоугольник или круг, координаты — доли 0..1 от ширины/высоты. */
export type MapArea
  = | { id: string, shape: 'rect', x: number, y: number, w: number, h: number }
    | { id: string, shape: 'circle', cx: number, cy: number, r: number }

export function areaContains(area: MapArea, p: { x: number, y: number }): boolean {
  if (area.shape === 'rect') return p.x >= area.x && p.x <= area.x + area.w && p.y >= area.y && p.y <= area.y + area.h
  const dx = p.x - area.cx
  const dy = p.y - area.cy
  return Math.sqrt(dx * dx + dy * dy) <= area.r
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

    case 'multi': {
      const correct = new Set((q.answer as { correctIds: string[] }).correctIds)
      const given = new Set(((answer as { optionIds?: string[] }).optionIds ?? []))
      const right = [...given].filter(id => correct.has(id)).length
      const wrong = given.size - right
      const exact = right === correct.size && wrong === 0

      if (scoringMethodOf(q) === 'all_or_nothing') {
        return { isCorrect: exact, score: exact ? q.points : 0, auto: true }
      }
      // points × (верно − неверно) / всего верных, не меньше 0
      const raw = q.points * (right - (q.negativeMarking ? wrong : 0)) / correct.size
      const score = round2(Math.max(0, Math.min(q.points, raw)))
      return { isCorrect: exact, score, auto: true }
    }

    case 'ordering': {
      const correct = (q.answer as { order: string[] }).order
      const given = (answer as { order?: string[] }).order ?? []
      if (given.length !== correct.length) {
        return { isCorrect: false, score: 0, auto: true }
      }
      const exact = correct.every((id, i) => given[i] === id)
      if (scoringMethodOf(q) === 'all_or_nothing') return { isCorrect: exact, score: exact ? q.points : 0, auto: true }

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

    case 'comparison': {
      const correct = (q.answer as { pairs: { leftId: string, rightId: string }[] }).pairs
      const given = (answer as { pairs?: { leftId: string, rightId: string }[] }).pairs ?? []
      const givenMap = new Map(given.map(p => [p.leftId, p.rightId]))
      const right = correct.filter(p => givenMap.get(p.leftId) === p.rightId).length
      const exact = right === correct.length
      if (scoringMethodOf(q) === 'all_or_nothing') return { isCorrect: exact, score: exact ? q.points : 0, auto: true }
      return { isCorrect: exact, score: round2(q.points * right / correct.length), auto: true }
    }

    case 'classification': {
      // Разложить элементы по классам (docs/12 §3.3 п. 10, §14.6): частичный балл по числу верно разложенных
      const correct = (q.answer as { placements: { itemId: string, groupId: string }[] }).placements
      const given = (answer as { placements?: { itemId: string, groupId: string }[] }).placements ?? []
      const givenMap = new Map(given.map(p => [p.itemId, p.groupId]))
      const right = correct.filter(p => givenMap.get(p.itemId) === p.groupId).length
      const exact = right === correct.length
      if (scoringMethodOf(q) === 'all_or_nothing') return { isCorrect: exact, score: exact ? q.points : 0, auto: true }
      return { isCorrect: exact, score: correct.length === 0 ? 0 : round2(q.points * right / correct.length), auto: true }
    }

    case 'answer_by_map': {
      // Области в долях от размера изображения (docs/12 §15 Г-12.1 п. 2). Ответ — выбранные области
      // либо точки {x, y} в долях; точка попадает в первую область, которая её содержит.
      const areas = ((q.options as { areas?: MapArea[] } | null)?.areas ?? [])
      const correct = new Set((q.answer as { areaIds: string[] }).areaIds)
      const a = answer as { areaIds?: string[], points?: { x: number, y: number }[] }
      const hit = new Set<string>(a.areaIds ?? [])
      for (const p of a.points ?? []) {
        const area = areas.find(ar => areaContains(ar, p))
        if (area) hit.add(area.id)
      }
      const right = [...hit].filter(id => correct.has(id)).length
      const wrong = hit.size - right
      const exact = right === correct.size && wrong === 0
      if (scoringMethodOf(q) === 'all_or_nothing' || correct.size === 0) {
        return { isCorrect: exact, score: exact ? q.points : 0, auto: true }
      }
      const raw = q.points * (right - (q.negativeMarking ? wrong : 0)) / correct.size
      return { isCorrect: exact, score: round2(Math.max(0, Math.min(q.points, raw))), auto: true }
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

    case 'cloze': {
      // Пропуски в тексте (docs/12 §3.3 п. 11, докс/33 D-015): answer.gaps — по варіанту(ах)-еталону
      // на кожен `{{id}}` у stem; відповідь — values{gapId: text}. Порівняння — те саме, що text_short.
      const gaps = (q.answer as { gaps: { id: string, accepted: string[], caseSensitive?: boolean, trim?: boolean, normalizeSpaces?: boolean, allowTypos?: number }[] }).gaps
      const values = (answer as { values?: Record<string, string> }).values ?? {}
      let right = 0
      for (const gap of gaps) {
        const given = normalizeText(String(values[gap.id] ?? ''), gap)
        const typos = gap.allowTypos ?? 0
        const ok = gap.accepted.some((acc) => {
          const norm = normalizeText(acc, gap)
          return typos > 0 ? levenshtein(norm, given) <= typos : norm === given
        })
        if (ok) right++
      }
      const exact = gaps.length > 0 && right === gaps.length
      if (scoringMethodOf(q) === 'all_or_nothing' || gaps.length === 0) {
        return { isCorrect: exact, score: exact ? q.points : 0, auto: true }
      }
      return { isCorrect: exact, score: round2(q.points * right / gaps.length), auto: true }
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

/**
 * Эффективные параметры прохождения теста (docs/12 §3.5, docs/15 §14.3). Берутся из назначения
 * (assignments.params), никогда из теста; копия живёт в attempts.params.
 */
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
  questionsMode: 'all' | 'one_per_group' | 'limited'
  questionsCount: number | null
  trainingMode: boolean
  allowOtherPages: boolean
  showErrorProtocol: boolean
  hideCorrectInProtocol: boolean
  protocolAfterLastAttempt: boolean
  instantFeedback: boolean
  manualNext: boolean
  questionTimeLimit: boolean
  resultSource: 'last' | 'best'
  fixResult: boolean
  scaleId: string | null
  badgeId: string | null
  certificateId: string | null
  points: number
  bonuses: number
  allowComments: boolean
  notifyOnResult: boolean
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
  questionsMode: 'all',
  questionsCount: null,
  trainingMode: false,
  allowOtherPages: true,
  showErrorProtocol: true,
  hideCorrectInProtocol: false,
  protocolAfterLastAttempt: false,
  instantFeedback: false,
  manualNext: false,
  questionTimeLimit: false,
  resultSource: 'last',
  fixResult: true,
  scaleId: null,
  badgeId: null,
  certificateId: null,
  points: 0,
  bonuses: 0,
  allowComments: true,
  notifyOnResult: true,
}

/** Убирает эталоны, разбор и подсказку проверяющему из вопроса для выдачи ученику. */
export function stripAnswers(q: SnapshotQuestion): Omit<SnapshotQuestion, 'answer' | 'explanation' | 'graderHint'> {
  const { answer: _a, explanation: _e, graderHint: _g, ...safe } = q
  // Для comparison правая колонка перемешивается снапшотом, эталон в answer
  return safe
}
