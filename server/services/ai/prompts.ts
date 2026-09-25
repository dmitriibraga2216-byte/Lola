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
