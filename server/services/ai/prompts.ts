import { z } from 'zod'
import type { AiPurpose } from '../../../shared/enums'
import { VACANCY_AI_CRITERIA_MAX, VACANCY_AI_CRITERIA_MIN, VACANCY_AI_TEXT_MAX_CHARS } from '../../../shared/enums'
import { sanitizeUserHtml } from '../sanitize'
import { stubVector } from '../embeddings'

/**
 * Промпты — артефакт реализации (`docs/v2/30` §1): версионируются парой `key` + `version`
 * (`ai_calls.prompt_key`, `prompt_version`), тексты в ТЗ не фиксируются. Смена текста промпта —
 * новая `version`: метрика качества по старой версии не смешивается с новой (`30` §7.16).
 *
 * Каждый промпт знает четыре вещи:
 * - `stub` — детерминированный ответ заглушки (`docs/v2/44` §8): тот же вход — тот же выход,
 *   без сети и ключа; им отвечает профиль с `driver = 'stub'`;
 * - `chat` — сообщения для OpenAI-совместимого `chat/completions` (только текстовые роли);
 * - `parse` — проверка ответа модели: невалидный ответ — `failed` с `bad_output`, а не мусор
 *   в форме человека;
 * - `journal` — что из ответа кладётся в `ai_calls.output` (у эмбеддинга — не сам вектор).
 */

export interface ChatMessage { role: 'system' | 'user', content: string }

export interface PromptDef<I, O> {
  key: string
  version: string
  purpose: AiPurpose
  stub: (input: I) => O
  chat?: (input: I) => ChatMessage[]
  parse?: (raw: unknown) => O
  /** Можно ли отдать сохранённый ответ повторному вызову с тем же ключом (`30` §7.18). */
  cacheable?: boolean
  journal?: (output: O) => unknown
  /**
   * Полный вход сохраняется в S3 (`ai_calls.input_ref`, `30` §3.2, §7.7): для разбора задним
   * числом «что именно видела модель». Вход, где есть ПД кандидата, — только так: в БД остаётся
   * дайджест, а сам вход живёт 90 дней файлом `origin = 'ai_artifact'` и стирается вместе с ПД.
   */
  storeInput?: boolean
  /**
   * Вход — уже существующий объект в S3 (аудио реплики для расшифровки): журнал ссылается на
   * него, а не кладёт копию голоса вторым файлом с другим сроком жизни.
   */
  inputRef?: (input: I) => string | null
  /** Вход — аудио из S3 (роль `transcribe`): сетевой драйвер шлёт файл, а не JSON. */
  audio?: (input: I) => { key: string, mime: string, lang: string }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPrompt = PromptDef<any, any>

// ── Вакансия: текст блока (`29` §7.10) ──────────────────────────────────────────────────

export interface VacancyTextInput {
  target: 'description' | 'requirements' | 'duties' | 'extra'
  tone: string | null
  title: string
  city: string | null
  employmentType: string | null
  workFormat: string | null
  experienceLevel: string | null
  educationLevel: string | null
  /** Уже заполненные соседние блоки — модель видит контекст, но не сочиняет вразрез с ним. */
  siblingBlocks: Record<string, string | null>
  language: 'uk' | 'en' | 'ru'
}

export interface VacancyTextOutput { html: string }

const TARGET_LABEL_UK: Record<VacancyTextInput['target'], string> = {
  description: 'Ми шукаємо людину на позицію',
  requirements: 'Ми очікуємо',
  duties: 'Основні обов’язки',
  extra: 'Додатково пропонуємо',
}

const LANGUAGE_NAME: Record<VacancyTextInput['language'], string> = { uk: 'Ukrainian', en: 'English', ru: 'Russian' }

const stripHtml = (html: string | null): string => (html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * Вход модели — только то, что разрешает `29` §7.10: без вилки, контактов, данных кандидатов,
 * названия курса и критериев оценки. Вызывающий (`vacancyAi.ts`) собирает вход из этих полей и
 * ничего больше; промпт повторяет запрет словами, чтобы модель не додумала контакты сама.
 */
export const VACANCY_TEXT_PROMPT: PromptDef<VacancyTextInput, VacancyTextOutput> = {
  key: 'vacancy.text',
  version: 'v1',
  purpose: 'generate',
  // Заглушка PR-17 без изменений: шаблон по полям вакансии (`46-progress.md`, PR-17)
  stub(input) {
    const head = `${TARGET_LABEL_UK[input.target]} «${input.title}»`
    const bits = [
      input.city ? `Місце роботи: ${input.city}.` : null,
      input.employmentType ? `Формат зайнятості: ${input.employmentType}.` : null,
      input.workFormat ? `Формат роботи: ${input.workFormat}.` : null,
      input.experienceLevel ? `Досвід: ${input.experienceLevel}.` : null,
      input.educationLevel ? `Освіта: ${input.educationLevel}.` : null,
      input.tone ? `Тон: ${input.tone}.` : null,
    ].filter(Boolean)
    const html = `<p>${head}.</p>${bits.length ? `<p>${bits.join(' ')}</p>` : ''}`
    return { html: html.slice(0, VACANCY_AI_TEXT_MAX_CHARS) }
  },
  chat: input => [
    {
      role: 'system',
      content: [
        'You write one block of a job vacancy page for a hospitality or retail company.',
        `Write in ${LANGUAGE_NAME[input.language]}. Keep the company tone if given.`,
        `Return JSON {"html": "..."} with at most ${VACANCY_AI_TEXT_MAX_CHARS} characters of HTML using only <p>, <ul>, <li>, <strong>, <em>.`,
        'Never mention salary, contacts, candidates, course names or evaluation criteria, and do not invent them.',
        'Do not contradict the blocks that are already filled in.',
      ].join(' '),
    },
    {
      role: 'user',
      content: JSON.stringify({
        block: input.target, title: input.title, city: input.city, employmentType: input.employmentType,
        workFormat: input.workFormat, experienceLevel: input.experienceLevel, educationLevel: input.educationLevel,
        tone: input.tone, filledBlocks: Object.fromEntries(Object.entries(input.siblingBlocks).map(([k, v]) => [k, stripHtml(v)])),
      }),
    },
  ],
  parse(raw) {
    const r = z.object({ html: z.string().min(1) }).parse(raw)
    const html = sanitizeUserHtml(r.html).slice(0, VACANCY_AI_TEXT_MAX_CHARS).trim()
    if (!stripHtml(html)) throw new Error('empty html')
    return { html }
  },
  cacheable: true,
}

// ── Вакансия: черновик критериев (`29` §7.11) ───────────────────────────────────────────

export interface VacancyCriteriaInput {
  title: string
  city: string | null
  employmentType: string | null
  requirementsHtml: string | null
  dutiesHtml: string | null
  language: 'uk' | 'en' | 'ru'
}

export interface VacancyCriterionDraft { name: string, description: string, weight: number }
export interface VacancyCriteriaOutput { criteria: VacancyCriterionDraft[] }

const criterionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(''),
  weight: z.number().gt(0).max(100),
})

export const VACANCY_CRITERIA_PROMPT: PromptDef<VacancyCriteriaInput, VacancyCriteriaOutput> = {
  key: 'vacancy.criteria',
  version: 'v1',
  purpose: 'generate',
  stub(input) {
    const req = stripHtml(input.requirementsHtml)
    const dut = stripHtml(input.dutiesHtml)
    const base: VacancyCriterionDraft[] = [
      { name: 'Відповідність вимогам вакансії', description: req ? req.slice(0, 200) : `Досвід і навички під позицію «${input.title}»`, weight: 3 },
      { name: 'Комунікація', description: 'Ясність і доброзичливість у спілкуванні на відборі', weight: 1 },
      { name: 'Готовність до обов’язків', description: dut ? dut.slice(0, 200) : 'Розуміння того, що доведеться робити щодня', weight: 2 },
    ]
    if (input.city) base.push({ name: 'Локація', description: `Готовність працювати у місті ${input.city}`, weight: 1 })
    // База — 3–4 пункта, что уже внутри диапазона §7.11 (3–8); слайс — предохранитель, а не рабочая логика.
    return { criteria: base.slice(0, VACANCY_AI_CRITERIA_MAX) }
  },
  chat: input => [
    {
      role: 'system',
      content: [
        'You propose evaluation criteria for candidates of a job vacancy. They are a draft for a human recruiter who decides.',
        `Write in ${LANGUAGE_NAME[input.language]}.`,
        `Return JSON {"criteria": [{"name": "...", "description": "...", "weight": 1}]} with ${VACANCY_AI_CRITERIA_MIN} to ${VACANCY_AI_CRITERIA_MAX} items, weight is an integer from 1 to 5.`,
        'Criteria must be about skills and behaviour needed for the job; never about age, gender, health, family, religion or origin.',
      ].join(' '),
    },
    {
      role: 'user',
      content: JSON.stringify({
        title: input.title, city: input.city, employmentType: input.employmentType,
        requirements: stripHtml(input.requirementsHtml), duties: stripHtml(input.dutiesHtml),
      }),
    },
  ],
  parse(raw) {
    const r = z.object({ criteria: z.array(criterionSchema).min(VACANCY_AI_CRITERIA_MIN) }).parse(raw)
    return { criteria: r.criteria.slice(0, VACANCY_AI_CRITERIA_MAX) }
  },
  cacheable: true,
}

// ── Эмбеддинги (`31` §7.8, `docs/03` §3.7) ──────────────────────────────────────────────

export interface EmbedInput { texts: string[], dims: number }
export type EmbedOutput = (number[] | null)[]

/** В журнал — не вектор (он в строке сущности), а сколько текстов ушло и сколько вернулось пустыми. */
const embedJournal = (out: EmbedOutput) => ({ count: out.length, empty: out.filter(v => !v).length })

function embedPrompt(key: string): PromptDef<EmbedInput, EmbedOutput> {
  return {
    key,
    version: 'v1',
    purpose: 'embed',
    stub: input => input.texts.map(t => stubVector(t, input.dims)),
    // Вектор не хранится в журнале — отдать «сохранённый ответ» нечем, и текст сущности меняется
    // под тем же `ref_id`: эмбеддинг всегда считается заново
    cacheable: false,
    journal: embedJournal,
  }
}

/** Тело последней версии модуля библиотеки и поисковый запрос палитры (`31` §7.8). */
export const LIBRARY_EMBEDDING_PROMPT = embedPrompt('library.embedding')
/** Статья базы знаний и поисковый запрос поиска по базе (`docs/03` §3.7, `docs/21` §5.2). */
export const KNOWLEDGE_EMBEDDING_PROMPT = embedPrompt('knowledge.embedding')

// ── Собеседование: расшифровка реплики (`30` §7.10, план `45` PR-28) ───────────────────

export interface TranscribeInput {
  mediaId: string
  /** Ключ объекта аудио в S3 — сетевой драйвер читает файл сам (`drivers.ts`). */
  audioKey: string
  mime: string
  /** Язык сценария: расшифровка идёт на нём, ответ на другом языке — флаг, а не отказ. */
  lang: 'uk' | 'en' | 'ru'
  durationMs: number | null
}

export interface TranscribeOutput {
  text: string
  language: string | null
  /** 0–1; `null` — провайдер уверенность не сообщил, расшифровка считается надёжной. */
  confidence: number | null
}

const STUB_TRANSCRIPT: Record<TranscribeInput['lang'], (sec: number) => string> = {
  uk: sec => `Відповідь кандидата записана голосом, тривалість ${sec} с. Це розшифровка заглушки, а не справжній текст.`,
  en: sec => `The candidate answered by voice for ${sec} s. This is a stub transcript, not the real text.`,
  ru: sec => `Ответ кандидата записан голосом, длительность ${sec} с. Это расшифровка заглушки, а не настоящий текст.`,
}

/** Среднее `exp(avg_logprob)` сегментов Whisper-совместимого ответа — уверенность 0–1. */
function segmentsConfidence(segments: unknown): number | null {
  if (!Array.isArray(segments) || !segments.length) return null
  const probs = segments
    .map(s => (s && typeof s === 'object' && typeof (s as { avg_logprob?: unknown }).avg_logprob === 'number') ? Math.exp((s as { avg_logprob: number }).avg_logprob) : null)
    .filter((p): p is number => p !== null && Number.isFinite(p))
  if (!probs.length) return null
  return Math.round(Math.min(1, Math.max(0, probs.reduce((a, b) => a + b, 0) / probs.length)) * 1000) / 1000
}

/**
 * Расшифровка голосового ответа. Вход — аудио реплики в S3: журнал ссылается на этот же
 * объект (`inputRef`), копии голоса нет. Ответ принимается в двух видах: Whisper-совместимый
 * `verbose_json` (`text`, `language`, `segments[].avg_logprob`) и простой
 * `{text, language?, confidence?}` — у `http_custom`.
 */
export const INTERVIEW_TRANSCRIBE_PROMPT: PromptDef<TranscribeInput, TranscribeOutput> = {
  key: 'interview.transcribe',
  version: 'v1',
  purpose: 'transcribe',
  stub: input => ({ text: STUB_TRANSCRIPT[input.lang](Math.max(1, Math.round((input.durationMs ?? 0) / 1000))), language: input.lang, confidence: 0.95 }),
  parse(raw) {
    const r = z.object({
      text: z.string(),
      language: z.string().nullable().optional(),
      confidence: z.number().min(0).max(1).nullable().optional(),
      segments: z.array(z.unknown()).optional(),
    }).passthrough().parse(raw)
    const lang = (r.language ?? '').toLowerCase()
    // Whisper называет язык словом («ukrainian»), остальные — кодом; в реплику кладётся код
    const code = ({ ukrainian: 'uk', english: 'en', russian: 'ru' } as Record<string, string>)[lang] ?? (lang.slice(0, 2) || null)
    return { text: r.text.trim(), language: code, confidence: r.confidence ?? segmentsConfidence(r.segments) }
  },
  cacheable: true,
  inputRef: input => input.audioKey,
  audio: input => ({ key: input.audioKey, mime: input.mime, lang: input.lang }),
}

// ── Собеседование: оценка сессии по критериям (`30` §7.2, §7.11, план `45` PR-28) ──────

export interface InterviewScoreInput {
  lang: 'uk' | 'en' | 'ru'
  /** Повтор с усиленной инструкцией после оценки без цитат (`30` §12 п. 5). */
  strict: boolean
  criteria: { id: string, name: string, description: string, scaleMax: number }[]
  /** Только надёжные реплики: ненадёжная расшифровка не бывает доказательством (`30` §7.10). */
  turns: { turnId: string, ordinal: number, question: string, answer: string }[]
}

export interface InterviewScoreOutput {
  criteria: { criterionId: string, value: number | null, confidence: number | null, rationale: string | null, evidence: { turnId: string | null, quote: string | null }[] }[]
}

const STUB_RATIONALE: Record<InterviewScoreInput['lang'], (name: string, ordinal: number) => string> = {
  uk: (name, ordinal) => `Оцінка заглушки: критерій «${name}» зіставлено з відповіддю на питання ${ordinal}. Це не висновок моделі.`,
  en: (name, ordinal) => `Stub assessment: criterion “${name}” matched against the answer to question ${ordinal}. This is not a model’s conclusion.`,
  ru: (name, ordinal) => `Оценка заглушки: критерий «${name}» сопоставлен с ответом на вопрос ${ordinal}. Это не вывод модели.`,
}

/** Короткая цитата — начало ответа до 80 знаков по границе слова. */
function stubQuote(answer: string): string {
  const t = answer.trim()
  if (t.length <= 80) return t
  const cut = t.slice(0, 80)
  const sp = cut.lastIndexOf(' ')
  return (sp > 20 ? cut.slice(0, sp) : cut).trim()
}

/** Детерминированный «балл» заглушки: хеш входа, а не смысл ответа. */
function stubValue(seed: string, scaleMax: number): number {
  let h = 0
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return Math.round((1 + (h % Math.max(1, Math.round(scaleMax * 100 - 100))) / 100) * 100) / 100
}

const LANGUAGE_WORD: Record<InterviewScoreInput['lang'], string> = { uk: 'Ukrainian', en: 'English', ru: 'Russian' }

/**
 * Оценка ответов кандидата по критериям сценария. **Модель не решает о людях** (инвариант 18):
 * промпт просит балл по каждому критерию, обоснование и цитаты из слов кандидата — и прямо
 * запрещает рекомендацию нанять или отказать. Разбор ответа намеренно мягкий: проверку
 * «у каждого критерия есть обоснование и дословная цитата» делает сервис-владелец
 * (`shared/domain/interview.ts#validateScores`), чтобы отличить балл без цитаты (повтор с
 * усиленной инструкцией, затем человек) от поломки провайдера.
 */
export const INTERVIEW_SCORE_PROMPT: PromptDef<InterviewScoreInput, InterviewScoreOutput> = {
  key: 'interview.score',
  version: 'v1',
  purpose: 'interview_score',
  stub(input) {
    return {
      criteria: input.criteria.map((c, i) => {
        const turn = input.turns.length ? input.turns[i % input.turns.length]! : null
        return {
          criterionId: c.id,
          value: turn ? stubValue(`${c.id}:${turn.answer}`, c.scaleMax) : null,
          confidence: 0.75,
          rationale: STUB_RATIONALE[input.lang](c.name, turn?.ordinal ?? 0),
          evidence: turn && turn.answer.trim() ? [{ turnId: turn.turnId, quote: stubQuote(turn.answer) }] : [],
        }
      }),
    }
  },
  chat: input => [
    {
      role: 'system',
      content: [
        'You assess answers of a job candidate given in an automated interview, criterion by criterion. A human makes every decision; your output is only an input for that human.',
        'Never recommend hiring or rejecting the person and never judge age, gender, health, family, religion, origin, accent or speech defects.',
        `For EVERY criterion return: value from 0 to its scaleMax, confidence from 0 to 1, rationale in ${LANGUAGE_WORD[input.lang]} of 20 to 600 characters, and evidence — one to three quotes copied VERBATIM from the candidate answers, each with the turnId it comes from.`,
        'A score without a verbatim quote is invalid. If the answers give nothing to quote for a criterion, still quote the closest fragment and lower the confidence.',
        ...(input.strict ? ['Your previous reply had criteria without rationale or without verbatim quotes. Every criterion MUST have both; quotes must be exact substrings of the answers.'] : []),
        'Return JSON {"criteria": [{"criterionId": "...", "value": 0, "confidence": 0.5, "rationale": "...", "evidence": [{"turnId": "...", "quote": "..."}]}]}.',
      ].join(' '),
    },
    {
      role: 'user',
      content: JSON.stringify({
        criteria: input.criteria.map(c => ({ criterionId: c.id, name: c.name, definition: c.description, scaleMax: c.scaleMax })),
        answers: input.turns.map(t => ({ turnId: t.turnId, question: t.question, answer: t.answer })),
      }),
    },
  ],
  parse(raw) {
    const r = z.object({
      criteria: z.array(z.object({
        criterionId: z.string(),
        value: z.number().nullable().optional(),
        confidence: z.number().nullable().optional(),
        rationale: z.string().nullable().optional(),
        evidence: z.array(z.object({ turnId: z.string().nullable().optional(), quote: z.string().nullable().optional() }).passthrough()).nullable().optional(),
      }).passthrough()).min(1),
    }).parse(raw)
    return {
      criteria: r.criteria.map(c => ({
        criterionId: c.criterionId,
        value: c.value ?? null,
        confidence: c.confidence ?? null,
        rationale: c.rationale ?? null,
        evidence: (c.evidence ?? []).map(e => ({ turnId: e.turnId ?? null, quote: e.quote ?? null })),
      })),
    }
  },
  cacheable: true,
  storeInput: true,
}
