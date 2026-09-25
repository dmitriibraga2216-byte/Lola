import type { InterviewSessionState } from '../enums'
import { formatDate, pluralCategory, type Locale } from './dateFormat'

/**
 * Правила ИИ-собеседования без базы и сети (`docs/v2/30-ai-interview.md` §3.3–§3.5, §4, §5.1,
 * §7.2, §7.4, §7.7, §7.11, §7.12; план `45` PR-28). Чистые функции: их проверяет unit-тест
 * `tests/unit/interview-rules.spec.ts`, а сервисы `server/services/interview/` только применяют.
 */

// ── Сроки и числа (`30` §7.7, §7.10, §7.12, §10) ───────────────────────────────────────

/** Аудио реплики живёт 90 дней от конца сессии, но не дольше согласия на обработку ПД (`30` §7.7). */
export const INTERVIEW_AUDIO_KEEP_DAYS = 90
/** Сутки без активности — сессия `abandoned` (`30` §7.12, `interview.reap`). */
export const INTERVIEW_REAP_HOURS = 24
/** Автосохранение и биение сессии — каждые 5 секунд (`30` §7.12). */
export const INTERVIEW_HEARTBEAT_SEC = 5
/**
 * Молчание канала дольше этого — обрыв связи (`30` §7.12): вкладка не прислала ни одного биения
 * за шесть интервалов. Сессия отмечается `paused` задним числом при первом же запросе после
 * возврата: сам обрыв сервер увидеть не может — связи в этот момент как раз нет.
 */
export const INTERVIEW_DISCONNECT_GAP_SEC = 30
/** Аудиоответ — до 25 МБ (`30` §10 `POST …/turns/:ordinal/upload`, `413 media.too_big`). */
export const INTERVIEW_AUDIO_MAX_MB = 25
/** Письменный ответ на реплику — до 5000 знаков (сверх документа: у формы нужен предел, Р-28.8). */
export const INTERVIEW_TEXT_ANSWER_MAX = 5000
/** Провайдер оценки недоступен: три повтора через 1, 5 и 30 минут, затем человек (`30` §7.12). */
export const INTERVIEW_SCORE_RETRY_MINUTES = [1, 5, 30] as const
/** Расшифровка не удалась: два повтора через 5 и 30 минут, затем `failed` (`30` §7.10). */
export const INTERVIEW_TRANSCRIBE_RETRY_MINUTES = [5, 30] as const
/** Подсказки «Не чути вас» при молчании — на 15, 30 и 45 секунде (`30` §7.12). */
export const INTERVIEW_SILENCE_PROMPTS_SEC = [15, 30, 45] as const
/** Цитат у критерия показывается от одной до трёх (`30` §5.3). */
export const INTERVIEW_EVIDENCE_MAX = 3

/** Состояния, в которых кандидат ещё отвечает: к ним возвращаются после обрыва (`30` §4). */
export const INTERVIEW_LIVE_STATES: readonly InterviewSessionState[] = ['in_progress', 'paused']
/** Оценка ИИ формируется или сформирована — сессия уже не принимает ответов. */
export const INTERVIEW_DONE_STATES: readonly InterviewSessionState[] = ['submitted', 'transcribing', 'scoring', 'scored', 'needs_human']

// ── Текст согласия (`30` §5.1, §7.4) ───────────────────────────────────────────────────

/**
 * Редакция текста согласия. Меняется вместе с текстом: `interview_consents.text_version` и
 * `text_hash` доказывают через год, **что именно** прочитал человек (`30` §3.3).
 */
export const INTERVIEW_CONSENT_TEXT_VERSION = 'interview-consent-v1'

export interface ConsentParams {
  /** Будет ли запись голоса: у сценария только с текстовыми ответами строки про аудио другие. */
  voice: boolean
  audioDays: number
  /** До какой даты живёт текст — срок согласия на обработку ПД кандидата; `null` — до обезличивания. */
  textUntil: string | Date | null
}

export interface ConsentDocument {
  title: string
  /** Шесть строк экрана `30` §5.1 — то, что человек видит до кнопок. */
  lines: string[]
  /** «Повний текст згоди»: те же строки и три пояснения. Хешируется целиком. */
  full: string[]
}

type Texts = {
  title: string
  program: string
  recorded: string
  recordedText: string
  whoSees: string
  whoSeesText: string
  keep: (days: string, until: string | null) => string
  keepText: (until: string | null) => string
  human: string
  refuse: string
  extra: string[]
  days: (n: number, locale: Locale) => string
}

const TEXTS: Record<Locale, Texts> = {
  uk: {
    title: 'Електронна співбесіда',
    program: 'Співбесіду проводить програма, а не людина.',
    recorded: 'Ваші відповіді буде записано (аудіо) та розшифровано в текст.',
    recordedText: 'Ваші письмові відповіді буде збережено й оброблено програмою.',
    whoSees: 'Запис і розшифровку побачать рекрутер і керівник, який ухвалює рішення. Більше ніхто.',
    whoSeesText: 'Відповіді побачать рекрутер і керівник, який ухвалює рішення. Більше ніхто.',
    keep: (days, until) => `Аудіо зберігається ${days}, текст — ${until ? `до ${until}` : 'до знеособлення ваших даних'}.`,
    keepText: until => `Відповіді зберігаються ${until ? `до ${until}` : 'до знеособлення ваших даних'}.`,
    human: 'Оцінку програми перевіряє людина. Сама програма нікого не відхиляє.',
    refuse: 'Ви можете відмовитись — це не закриває для вас відбір.',
    extra: [
      'Під час співбесіди можна будь-коли натиснути «Припинити співбесіду» й відкликати згоду: записи й розшифровки буде видалено, а проходження не вважатиметься проваленим.',
      'Програма лише зіставляє відповіді з критеріями співбесіди й пояснює кожну оцінку цитатою з ваших слів. Рішення про відбір ухвалює людина.',
      'Ця згода стосується лише запису й обробки відповідей на співбесіді та не замінює згоди на обробку анкети.',
    ],
    days: (n, locale) => `${n} ${({ one: 'день', few: 'дні', many: 'днів', other: 'дня' } as Record<string, string>)[pluralCategory(n, locale)] ?? 'днів'}`,
  },
  en: {
    title: 'Online interview',
    program: 'The interview is conducted by a program, not a person.',
    recorded: 'Your answers will be recorded (audio) and transcribed into text.',
    recordedText: 'Your written answers will be stored and processed by a program.',
    whoSees: 'The recording and the transcript will be seen by the recruiter and the manager who makes the decision. No one else.',
    whoSeesText: 'Your answers will be seen by the recruiter and the manager who makes the decision. No one else.',
    keep: (days, until) => `Audio is kept for ${days}, text — ${until ? `until ${until}` : 'until your data is anonymised'}.`,
    keepText: until => `Answers are kept ${until ? `until ${until}` : 'until your data is anonymised'}.`,
    human: 'A person reviews the program’s assessment. The program itself rejects no one.',
    refuse: 'You may decline — this does not close the selection for you.',
    extra: [
      'During the interview you can press “Stop the interview” at any time and withdraw consent: recordings and transcripts will be deleted, and the attempt will not count as failed.',
      'The program only matches your answers against the interview criteria and explains every score with a quote from your own words. A person makes the selection decision.',
      'This consent covers only recording and processing of your interview answers and does not replace your consent to processing of the application form.',
    ],
    days: n => `${n} ${n === 1 ? 'day' : 'days'}`,
  },
  ru: {
    title: 'Электронное собеседование',
    program: 'Собеседование проводит программа, а не человек.',
    recorded: 'Ваши ответы будут записаны (аудио) и расшифрованы в текст.',
    recordedText: 'Ваши письменные ответы будут сохранены и обработаны программой.',
    whoSees: 'Запись и расшифровку увидят рекрутер и руководитель, который принимает решение. Больше никто.',
    whoSeesText: 'Ответы увидят рекрутер и руководитель, который принимает решение. Больше никто.',
    keep: (days, until) => `Аудио хранится ${days}, текст — ${until ? `до ${until}` : 'до обезличивания ваших данных'}.`,
    keepText: until => `Ответы хранятся ${until ? `до ${until}` : 'до обезличивания ваших данных'}.`,
    human: 'Оценку программы проверяет человек. Сама программа никому не отказывает.',
    refuse: 'Вы можете отказаться — это не закрывает для вас отбор.',
    extra: [
      'Во время собеседования можно в любой момент нажать «Прекратить собеседование» и отозвать согласие: записи и расшифровки будут удалены, а прохождение не будет считаться проваленным.',
      'Программа только сопоставляет ответы с критериями собеседования и объясняет каждую оценку цитатой из ваших слов. Решение об отборе принимает человек.',
      'Это согласие касается только записи и обработки ответов на собеседовании и не заменяет согласия на обработку анкеты.',
    ],
    days: (n, locale) => `${n} ${({ one: 'день', few: 'дня', many: 'дней', other: 'дня' } as Record<string, string>)[pluralCategory(n, locale)] ?? 'дней'}`,
  },
}

/**
 * Текст согласия на языке человека (`30` §7.4: «на языке `users.comm_language`»). Это не строка
 * интерфейса, а версия юридического текста: сервер отдаёт её экрану как есть и хеширует ровно
 * то, что отдал, — иначе хеш доказывал бы не то, что человек прочитал.
 */
export function consentDocument(lang: Locale, p: ConsentParams): ConsentDocument {
  const tx = TEXTS[lang] ?? TEXTS.uk
  const until = p.textUntil ? formatDate(p.textUntil, lang) : null
  const lines = p.voice
    ? [tx.program, tx.recorded, tx.whoSees, tx.keep(tx.days(p.audioDays, lang), until), tx.human, tx.refuse]
    : [tx.program, tx.recordedText, tx.whoSeesText, tx.keepText(until), tx.human, tx.refuse]
  return { title: tx.title, lines, full: [tx.title, ...lines, ...tx.extra] }
}

// ── Уверенность и итог сессии (`30` §7.2 в, §7.11) ─────────────────────────────────────

export type ConfidenceWord = 'high' | 'medium' | 'low'

/** Уверенность словом (`30` §7.2 в): «висока» ≥ 0.8, «середня» 0.6–0.8, «низька» < 0.6. */
export function confidenceWord(c: number | null | undefined): ConfidenceWord | null {
  if (c === null || c === undefined || !Number.isFinite(c)) return null
  if (c >= 0.8) return 'high'
  if (c >= 0.6) return 'medium'
  return 'low'
}

export interface WeightedItem { value: number, scaleMax: number, weight: number }

/**
 * Итог сессии (`30` §7.11): взвешенное среднее по `weight`, нормированное к 100. Каждый балл
 * сначала приводится к доле своей шкалы — критерии с разным максимумом сравниваются честно.
 */
export function weightedScore(items: readonly WeightedItem[]): number | null {
  const valid = items.filter(i => i.weight > 0 && i.scaleMax > 0)
  const w = valid.reduce((s, i) => s + i.weight, 0)
  if (!valid.length || w <= 0) return null
  const raw = valid.reduce((s, i) => s + i.weight * Math.min(1, Math.max(0, i.value / i.scaleMax)), 0) / w
  return Math.round(raw * 10000) / 100
}

/**
 * Уверенность сессии — **минимум** по критериям, не среднее (`30` §7.11): сессия настолько
 * надёжна, насколько ненадёжен худший критерий.
 */
export function sessionConfidence(confidences: readonly number[]): number | null {
  return confidences.length ? Math.min(...confidences) : null
}

// ── Проверка вывода модели (`30` §3.5, §7.2, §12 п. 5) ─────────────────────────────────

export interface ScoreCriterionInput { id: string, name: string, scaleMax: number }
export interface ScoreTurnInput { turnId: string, ordinal: number, answer: string }

export interface RawEvidence { turnId?: unknown, quote?: unknown }
export interface RawCriterionScore { criterionId?: unknown, value?: unknown, confidence?: unknown, rationale?: unknown, evidence?: unknown }

export interface EvidenceItem {
  turnId: string
  ordinal: number
  quote: string
  charFrom: number
  charTo: number
  /** Секунда аудио, где звучит цитата; у расшифровки без таймкодов слов — `null`. */
  msFrom: number | null
}

export interface ValidScore {
  criterionId: string
  value: number
  confidence: number
  rationale: string
  evidence: EvidenceItem[]
}

export type ScoreProblem
  = | 'criterion_missing' | 'criterion_unknown' | 'criterion_duplicate' | 'value_invalid' | 'confidence_invalid'
    | 'rationale_missing' | 'evidence_missing' | 'quote_not_found' | 'turn_unknown'

export type ScoreValidation
  = | { ok: true, scores: ValidScore[] }
    | { ok: false, problems: { criterionId: string | null, problem: ScoreProblem }[] }

const RATIONALE_MIN = 20
const RATIONALE_MAX = 2000

/** Место цитаты в ответе: точное вхождение, иначе — без учёта регистра. */
function locate(answer: string, quote: string): { from: number, to: number } | null {
  let at = answer.indexOf(quote)
  if (at < 0) at = answer.toLowerCase().indexOf(quote.toLowerCase())
  return at < 0 ? null : { from: at, to: at + quote.length }
}

/**
 * Проверка ответа модели по сценарию (`30` §7.2): у **каждого** критерия — балл в шкале,
 * уверенность 0–1, обоснование 20–2000 знаков и минимум одна цитата, которая дословно есть в
 * ответе кандидата на названную реплику (только из надёжных реплик: ненадёжная расшифровка
 * исключается из `evidence`, `30` §7.10). Цитата, которой нет в словах человека, — не
 * доказательство, а выдумка модели; балл с ней — такой же необъяснённый, как без цитаты.
 */
export function validateScores(criteria: readonly ScoreCriterionInput[], turns: readonly ScoreTurnInput[], raw: readonly RawCriterionScore[]): ScoreValidation {
  const problems: { criterionId: string | null, problem: ScoreProblem }[] = []
  const byId = new Map(criteria.map(c => [c.id, c]))
  const turnById = new Map(turns.map(t => [t.turnId, t]))
  const seen = new Set<string>()
  const scores: ValidScore[] = []

  for (const r of raw) {
    const id = typeof r.criterionId === 'string' ? r.criterionId : null
    const c = id ? byId.get(id) : undefined
    if (!id || !c) { problems.push({ criterionId: id, problem: 'criterion_unknown' }); continue }
    if (seen.has(id)) { problems.push({ criterionId: id, problem: 'criterion_duplicate' }); continue }
    seen.add(id)

    const value = typeof r.value === 'number' ? r.value : Number.NaN
    if (!Number.isFinite(value) || value < 0 || value > c.scaleMax) problems.push({ criterionId: id, problem: 'value_invalid' })
    const confidence = typeof r.confidence === 'number' ? r.confidence : Number.NaN
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) problems.push({ criterionId: id, problem: 'confidence_invalid' })
    const rationale = typeof r.rationale === 'string' ? r.rationale.trim() : ''
    if (rationale.length < RATIONALE_MIN || rationale.length > RATIONALE_MAX) problems.push({ criterionId: id, problem: 'rationale_missing' })

    const evidence: EvidenceItem[] = []
    const rawEvidence = Array.isArray(r.evidence) ? r.evidence as RawEvidence[] : []
    for (const e of rawEvidence) {
      const quote = typeof e?.quote === 'string' ? e.quote.trim() : ''
      const turn = typeof e?.turnId === 'string' ? turnById.get(e.turnId) : undefined
      if (!quote) continue
      if (!turn) { problems.push({ criterionId: id, problem: 'turn_unknown' }); continue }
      const at = locate(turn.answer, quote)
      if (!at) { problems.push({ criterionId: id, problem: 'quote_not_found' }); continue }
      if (evidence.length < INTERVIEW_EVIDENCE_MAX) {
        evidence.push({ turnId: turn.turnId, ordinal: turn.ordinal, quote: turn.answer.slice(at.from, at.to), charFrom: at.from, charTo: at.to, msFrom: null })
      }
    }
    if (!evidence.length) problems.push({ criterionId: id, problem: 'evidence_missing' })
    scores.push({ criterionId: id, value: Math.round(value * 100) / 100, confidence: Math.round(confidence * 1000) / 1000, rationale, evidence })
  }
  for (const c of criteria) if (!seen.has(c.id)) problems.push({ criterionId: c.id, problem: 'criterion_missing' })

  return problems.length ? { ok: false, problems } : { ok: true, scores }
}

// ── Несогласие с оценкой ИИ (`30` §6.4, §7.3; план `45` PR-29) ─────────────────────────

export type CriterionAgreement = 'match' | 'minor' | 'major'

/**
 * Расхождение человека с моделью по критерию (`30` §7.3): `|human − ai| ≤ 10 %` шкалы — `match`,
 * `≤ 30 %` — `minor`, иначе `major`. Сравнение в долях шкалы: критерии с максимумом 5 и 100
 * меряются одной мерой. Граница включительно — «≤» документа; сравнение в сотых, чтобы 0,1 × 5 не
 * превратилось в 0,5000000001 и не перевело точное попадание в `minor`.
 */
export function criterionAgreement(ai: number, human: number, scaleMax: number): CriterionAgreement {
  const diff = Math.round(Math.abs(human - ai) * 10000)
  const scale = Math.round(scaleMax * 10000)
  if (diff * 10 <= scale) return 'match'
  if (diff * 10 <= scale * 3) return 'minor'
  return 'major'
}

/**
 * Итог сессии с поправкой человека (`30` §7.3): по оспоренным критериям — балл человека, по
 * остальным — модели, свёртка та же, что у оценки ИИ (`weightedScore`). Это число ложится в
 * карточку новой строкой `candidate_scores.kind = 'manual'` авторства человека; строка `kind = 'ai'`
 * не переписывается никогда — иначе теряется материал для метрики качества (§7.16).
 */
export function humanAdjustedScore(items: readonly { value: number | null, humanValue: number | null, scaleMax: number, weight: number }[]): number | null {
  const used = items
    .map(i => ({ value: i.humanValue ?? i.value, scaleMax: i.scaleMax, weight: i.weight }))
    .filter((i): i is WeightedItem => i.value !== null)
  return weightedScore(used)
}

// ── Сроки сессии ───────────────────────────────────────────────────────────────────────

/**
 * Когда стирается аудио сессии (`30` §7.7): `finished_at + 90 дней`, но не позже срока
 * согласия на обработку ПД кандидата. Сотрудник срока согласия не имеет — только 90 дней.
 */
export function audioPurgeAfter(finishedAt: Date, consentExpiresAt: string | null, days = INTERVIEW_AUDIO_KEEP_DAYS): Date {
  const byPolicy = new Date(finishedAt.getTime() + days * 86_400_000)
  if (!consentExpiresAt) return byPolicy
  const byConsent = new Date(`${consentExpiresAt}T23:59:59Z`)
  return byConsent < byPolicy ? byConsent : byPolicy
}

/** Был ли обрыв связи: последнее биение старше порога (`30` §7.12). */
export function isDisconnectGap(lastActivityAt: Date | null, now: Date, gapSec = INTERVIEW_DISCONNECT_GAP_SEC): boolean {
  return !!lastActivityAt && now.getTime() - lastActivityAt.getTime() > gapSec * 1000
}

// ── Факты для человека (`30` §7.17) ────────────────────────────────────────────────────

/** Флаг антифрода: только измеримые факты; ни один не влияет на балл и не виден кандидату. */
export type InterviewFlag = 'ip_changed' | 'device_changed' | 'tab_switches' | 'too_fast' | 'lang_mismatch' | 'read_aloud'

/** Слова текста в нижнем регистре — для шинглового сходства (`30` §7.17 `read_aloud`). */
function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

/** Доля трёхсловных шинглов ответа, которые есть в тексте-источнике (0–1). */
export function shingleSimilarity(answer: string, source: string, size = 3): number {
  const a = words(answer)
  const b = words(source)
  if (a.length < size || b.length < size) return 0
  const set = new Set<string>()
  for (let i = 0; i + size <= b.length; i++) set.add(b.slice(i, i + size).join(' '))
  let hit = 0
  let total = 0
  for (let i = 0; i + size <= a.length; i++) {
    total++
    if (set.has(a.slice(i, i + size).join(' '))) hit++
  }
  return total ? hit / total : 0
}

export interface TurnFacts { answer: string | null, prompt: string | null, firstSoundDelayMs: number | null, lang: string | null }

/**
 * Флаги реплик (`30` §7.17): `too_fast` — ответ начат раньше 1,5 с после вопроса при длине
 * больше 200 знаков; `read_aloud` — ответ совпадает с текстом вопроса больше чем на 70 %;
 * `lang_mismatch` — язык расшифровки не тот, что в сценарии. Сессионные (`ip_changed`,
 * `device_changed`, `tab_switches > 5`) считает сессия по своим счётчикам.
 */
export function turnFlags(t: TurnFacts, scenarioLang: string): InterviewFlag[] {
  const out: InterviewFlag[] = []
  const answer = t.answer ?? ''
  if (t.firstSoundDelayMs !== null && t.firstSoundDelayMs < 1500 && answer.length > 200) out.push('too_fast')
  if (t.prompt && answer && shingleSimilarity(answer, t.prompt) > 0.7) out.push('read_aloud')
  if (t.lang && t.lang !== scenarioLang) out.push('lang_mismatch')
  return out
}
