import type { CandidateScoreKind, CandidateSummarySection, CandidateSummaryState } from '../enums'
import { CANDIDATE_SUMMARY_SECTIONS } from '../enums'
import type { Locale } from './dateFormat'

/**
 * Правила Підсумку кандидата без базы и сети (`docs/v2/30-ai-interview.md` §3.5, §4, §5.4, §7.14,
 * §7.15; план `45` PR-29). Чистые функции: их проверяет `tests/unit/candidate-summary-rules.spec.ts`,
 * а `server/services/candidateSummaries.ts` только применяет.
 */

// ── Сроки (`30` §6.5, §7.15) ──────────────────────────────────────────────────────────

/** Ссылка на отправленный Підсумок живёт 30 дней (`30` §7.15). */
export const SUMMARY_SHARE_DAYS = 30
/** Задержка авто-отправки: 1–168 часов, по умолчанию 24 (`30` §6.5); нулевой не бывает (§7.15 [решение]). */
export const SUMMARY_AUTO_SEND_DELAY = { min: 1, max: 168, default: 24 } as const
/** Ни один критерий не перепроверен человеком и уверенность ниже этой — авто-отправки нет (`30` §7.15). */
export const SUMMARY_UNVERIFIED_CONFIDENCE = 0.6
/** Сильных сторон и зон риска — не больше пяти пунктов по 300 знаков (генеративная секция §7.14 п. 5). */
export const SUMMARY_POINTS_MAX = 5
export const SUMMARY_POINT_MAX_CHARS = 300

// ── Неснимаемая строка (`30` §5.4, §7.14, §13 к. 14) ──────────────────────────────────

/**
 * «Документ сформовано автоматично…» на языке документа. Строка входит в `body` и держится
 * CHECK'ом `candidate_summaries_disclaimer_chk` (миграция `0096`): начало каждого текста ниже
 * повторено в регулярном выражении CHECK'а. Поменять формулировку — значит поменять и CHECK
 * миграцией; выключить её не может ни настройка тенанта, ни правка текста, ни выбор секций.
 */
export const SUMMARY_DISCLAIMER: Record<Locale, string> = {
  uk: 'Документ сформовано автоматично на основі відповідей кандидата.',
  en: 'The document was generated automatically from the candidate’s answers.',
  ru: 'Документ сформирован автоматически на основе ответов кандидата.',
}

const HUMAN_CHECKED: Record<Locale, (yes: boolean) => string> = {
  uk: yes => `Оцінки програми перевірено людиною: ${yes ? 'так' : 'ні'}.`,
  en: yes => `The program’s scores were checked by a person: ${yes ? 'yes' : 'no'}.`,
  ru: yes => `Оценки программы проверены человеком: ${yes ? 'да' : 'нет'}.`,
}

/** Оговорка генеративной секции (`30` §7.14 п. 5: «всегда с оговоркой»). */
export const SUMMARY_CAVEAT: Record<Locale, string> = {
  uk: 'Цей розділ сформувала програма. Це не висновок про людину і не підстава для рішення — рішення ухвалює людина.',
  en: 'This section was written by the program. It is not a conclusion about the person and not a basis for a decision — a person decides.',
  ru: 'Этот раздел сформировала программа. Это не вывод о человеке и не основание для решения — решение принимает человек.',
}

export interface SummaryDisclaimer {
  text: string
  humanChecked: boolean
  humanCheckedText: string
}

export function summaryDisclaimer(lang: Locale, humanChecked: boolean): SummaryDisclaimer {
  return { text: SUMMARY_DISCLAIMER[lang] ?? SUMMARY_DISCLAIMER.uk, humanChecked, humanCheckedText: (HUMAN_CHECKED[lang] ?? HUMAN_CHECKED.uk)(humanChecked) }
}

/** Вся строка подвала одной строкой — так её видит кандидат и рекрутер (§5.4). */
export function disclaimerLine(d: SummaryDisclaimer): string {
  return `${d.text} ${d.humanCheckedText}`
}

// ── Тело документа (`30` §7.14) ────────────────────────────────────────────────────────

export interface SummaryProgressItem {
  title: string
  /** `course` | `test` | `workshop` | … — вид назначения (`task_type`). */
  kind: string
  /** Один из пяти статусов прохождения (`enrollment_status`, CLAUDE.md п. 12). */
  status: string
  score: number | null
  finishedAt: string | null
}

export interface SummaryScoreItem {
  kind: CandidateScoreKind
  value: number | null
  /** Автор оценки — **ПД третьего лица**: в документе для кандидата не показывается (`41` §2.3). */
  authorName: string | null
  at: string
  aiStub: boolean
}

export interface SummaryCriterion {
  name: string
  value: number | null
  scaleMax: number
  humanValue: number | null
  rationale: string | null
  quote: string | null
}

export interface SummaryInterview {
  scenarioName: string
  finishedAt: string | null
  aiScore: number | null
  confidenceWord: 'high' | 'medium' | 'low' | null
  aiStub: boolean
  /** Оценки нет — решение за человеком (`30` §4 `needs_human`): документ так и говорит. */
  needsHuman: boolean
  criteria: SummaryCriterion[]
}

export interface SummaryStrengthsRisks {
  /** `unavailable` — модель не ответила, ИИ не действует или отказалась без обоснований: секция пустая, документ собран. */
  status: 'ready' | 'unavailable'
  strengths: string[]
  risks: string[]
  caveat: string
  aiStub: boolean
}

export interface SummaryPassport {
  generatedAt: string
  model: string | null
  promptVersion: string | null
  humanChecked: boolean
  aiStub: boolean
}

export interface SummaryBody {
  candidate: { fullName: string, vacancyTitle: string | null }
  progress: { items: SummaryProgressItem[] }
  scores: { items: SummaryScoreItem[] }
  interview: SummaryInterview | null
  strengthsRisks: SummaryStrengthsRisks
  incomplete: { items: { title: string, status: string }[] }
  passport: SummaryPassport
  disclaimer: SummaryDisclaimer
}

/** Ключ тела для каждой секции §7.14. */
export const SECTION_KEY: Record<CandidateSummarySection, keyof SummaryBody> = {
  candidate: 'candidate',
  progress: 'progress',
  scores: 'scores',
  interview: 'interview',
  strengths_risks: 'strengthsRisks',
  incomplete: 'incomplete',
  passport: 'passport',
}

/** Секции, включённые по умолчанию: все, кроме «что не пройдено» у полного прохождения. */
export function defaultSections(completeness: 'full' | 'partial'): CandidateSummarySection[] {
  return CANDIDATE_SUMMARY_SECTIONS.filter(s => s !== 'incomplete' || completeness === 'partial')
}

/** Статус, при котором пункт назначения считается пройденным (`enrollment_status`). */
const DONE_STATUSES = new Set(['done'])

/**
 * Полнота (`30` §5.4): `full` — всё назначенное пройдено и оценено, `partial` — что-то осталось
 * (бейдж «Неповне проходження», секция 6). Пустой список назначений — `partial`: документ
 * собран не по итогам отбора, а раньше.
 */
export function summaryCompleteness(items: readonly { status: string }[]): 'full' | 'partial' {
  return items.length && items.every(i => DONE_STATUSES.has(i.status)) ? 'full' : 'partial'
}

export function incompleteItems(items: readonly SummaryProgressItem[]): { title: string, status: string }[] {
  return items.filter(i => !DONE_STATUSES.has(i.status)).map(i => ({ title: i.title, status: i.status }))
}

/**
 * Документ для кандидата (`GET /public/candidate-summaries/:token`, `30` §10, `41` §8.3.2): только
 * включённые секции и **без ПД третьих лиц** — имя автора оценки убирается. Строка
 * «Документ сформовано автоматично» — всегда, независимо от секций (§13 к. 14).
 */
export function candidateView(body: SummaryBody, sections: readonly string[]): Partial<SummaryBody> & { disclaimer: SummaryDisclaimer } {
  const on = new Set(sections)
  const out: Partial<SummaryBody> = {}
  for (const s of CANDIDATE_SUMMARY_SECTIONS) {
    if (!on.has(s)) continue
    const key = SECTION_KEY[s]
    if (key === 'scores') out.scores = { items: body.scores.items.map(i => ({ ...i, authorName: null })) }
    else (out as Record<string, unknown>)[key] = body[key]
  }
  return { ...out, disclaimer: body.disclaimer }
}

// ── Авто-отправка (`30` §6.5, §7.15) ──────────────────────────────────────────────────

export interface AutoSendRule {
  enabled: boolean
  scoreKind: CandidateScoreKind
  minScore: number | null
  delayHours: number
  skipRejected: boolean
}

/** Достигла ли оценка порога: сравнивается балл; оценка только уровнем шкалы порога не достигает. */
export function meetsThreshold(value: number | null | undefined, minScore: number | null): boolean {
  return value !== null && value !== undefined && minScore !== null && Number.isFinite(value) && value >= minScore
}

export type AutoSendBlock
  = | 'disabled' | 'not_ready' | 'not_latest' | 'cancelled' | 'not_candidate' | 'rejected'
    | 'consent_withdrawn' | 'unverified_low_confidence' | 'below_threshold' | 'no_contact'

export interface AutoSendFacts {
  rule: AutoSendRule
  state: CandidateSummaryState
  isLatest: boolean
  cancelled: boolean
  /** `users.kind` — нанятый кандидат Підсумок больше не получает (`30` §12 п. 8). */
  kind: 'candidate' | 'employee'
  rejected: boolean
  consentWithdrawn: boolean
  /** Хоть один критерий собеседования перепроверен человеком (`human_value`). */
  humanChecked: boolean
  /** Уверенность ИИ последней сессии; `null` — собеседования с оценкой нет. */
  aiConfidence: number | null
  /** Текущая оценка выбранного вида. */
  scoreValue: number | null
  hasEmail: boolean
}

/**
 * Можно ли отправить Підсумок автоматически — сейчас (`30` §7.15). Проверяется дважды: когда
 * назначается срок (`auto_send_due_at`) и когда он наступил, — за сутки задержки кандидата могли
 * отклонить, он мог отозвать согласие, а рекрутер — перепроверить оценки. Первая причина отказа
 * возвращается как есть: её видит рекрутер в журнале.
 */
export function autoSendBlock(f: AutoSendFacts): AutoSendBlock | null {
  if (!f.rule.enabled) return 'disabled'
  if (f.state !== 'ready') return 'not_ready'
  if (!f.isLatest) return 'not_latest'
  if (f.cancelled) return 'cancelled'
  if (f.kind !== 'candidate') return 'not_candidate'
  if (f.rejected && f.rule.skipRejected) return 'rejected'
  if (f.consentWithdrawn) return 'consent_withdrawn'
  if (!f.humanChecked && f.aiConfidence !== null && f.aiConfidence < SUMMARY_UNVERIFIED_CONFIDENCE) return 'unverified_low_confidence'
  if (!meetsThreshold(f.scoreValue, f.rule.minScore)) return 'below_threshold'
  if (!f.hasEmail) return 'no_contact'
  return null
}

/** Когда уйдёт Підсумок, назначенный сейчас: задержка отсчитывается от момента, когда рекрутер узнал о ней. */
export function autoSendDueAt(now: Date, delayHours: number): Date {
  const h = Math.min(SUMMARY_AUTO_SEND_DELAY.max, Math.max(SUMMARY_AUTO_SEND_DELAY.min, Math.round(delayHours)))
  return new Date(now.getTime() + h * 3_600_000)
}

// ── Генеративная секция (`30` §7.14 п. 5) ─────────────────────────────────────────────

/**
 * Слова решения о человеке: генеративная секция их не содержит (инвариант 18, `30` §7.1). Модель,
 * которая написала «рекомендую найняти» или «відмовити», ответила не на тот вопрос — ответ
 * отклоняется, секция остаётся пустой, документ собирается без неё.
 */
const DECISION_WORDS = /(?<!\p{L})(найняти|наймати|найміть|взяти на роботу|прийняти на роботу|відмовити|відхилити|рекомендую|рекомендуємо|нанять|нанимать|принять на работу|отказать|отклонить|рекомендуем|hire|hiring|reject|rejecting|recommend|recommended)(?!\p{L})/iu

export function hasDecisionWords(text: string): boolean {
  return DECISION_WORDS.test(text)
}

export type PointsCheck = { ok: true, strengths: string[], risks: string[] } | { ok: false, problem: 'shape' | 'too_long' | 'decision_words' }

/** Проверка ответа модели для секции 5: списки строк, не длиннее предела, без слов решения. */
export function checkPoints(raw: { strengths?: unknown, risks?: unknown }): PointsCheck {
  const list = (v: unknown): string[] | null => (Array.isArray(v) && v.every(x => typeof x === 'string') ? (v as string[]).map(s => s.trim()).filter(Boolean) : null)
  const strengths = list(raw.strengths)
  const risks = list(raw.risks)
  if (!strengths || !risks || strengths.length > SUMMARY_POINTS_MAX || risks.length > SUMMARY_POINTS_MAX) return { ok: false, problem: 'shape' }
  if ([...strengths, ...risks].some(s => s.length > SUMMARY_POINT_MAX_CHARS)) return { ok: false, problem: 'too_long' }
  if ([...strengths, ...risks].some(hasDecisionWords)) return { ok: false, problem: 'decision_words' }
  return { ok: true, strengths, risks }
}
