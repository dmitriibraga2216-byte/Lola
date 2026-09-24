import { z } from 'zod'
import { CONTENT_TIME_DEVIATION_FLAGS, LEARNING_TIME_SUBJECT_TYPES } from '../enums'
import type { ContentTimeDeviationFlag, ContentTimeNormSource, LearningTimeSubjectType } from '../enums'

/**
 * Контракты норм времени и отчёта «План і факт часу» (docs/v2/37 §6.3, §9.3, §10; PR-22).
 * Один источник для экрана и сервера (CLAUDE.md п. 7).
 *
 * **Отчёт обезличен** (§2, §7.14 в): в ответе нет ни одного человека — ни имени, ни
 * идентификатора, ни детализации «кто составил цифру». Строка — элемент контента.
 */

const queryBool = z.union([z.boolean(), z.enum(['true', 'false', '1', '0'])]).transform(v => v === true || v === 'true' || v === '1')

/** `/content/time-norms/:subjectType/:subjectId` — элемент, чья это норма. */
export const timeNormSubjectSchema = z.object({
  subjectType: z.enum(LEARNING_TIME_SUBJECT_TYPES),
  subjectId: z.string().uuid(),
})
export type TimeNormSubject = z.infer<typeof timeNormSubjectSchema>

/**
 * Форма «Норма часу елемента» (§6.3): источник и, при «Автор», число. Секунды — целые;
 * границы (1 минута … 60 часов) проверяет сервер ответом `422 norm.value_range`
 * (`authorSecondsValid()`), а не схема: код ошибки задан документом (§10).
 * `observed` — то же, что «Застосувати»: `422 norm.sample_too_small` при выборке меньше 20.
 */
export const timeNormPutSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('author'), authorSeconds: z.number().int() }),
  z.object({ source: z.literal('auto') }),
  z.object({ source: z.literal('observed') }),
])
export type TimeNormPut = z.infer<typeof timeNormPutSchema>

/** Норма элемента (ответ GET/PUT/apply-observed). */
export interface TimeNorm {
  subjectType: LearningTimeSubjectType
  subjectId: string
  title: string
  /** Строки ещё нет — норма показана по умолчанию: число автора материала или авторасчёт. */
  persisted: boolean
  source: ContentTimeNormSource
  /** «Розрахунковий час» — действующая норма, секунды; `null` — нормы нет («—»). */
  plannedSeconds: number | null
  authorSeconds: number | null
  autoSeconds: number | null
  /** Медиана, p25, p75 — только с 10 достоверных прохождений (Р-22.4), иначе `null`. */
  observedSeconds: number | null
  observedP25: number | null
  observedP75: number | null
  observedSample: number
  deviationFlag: ContentTimeDeviationFlag
  /** «Застосувати» доступно: выборка ≥ 20 и медиана посчитана (§6.3). */
  canApplyObserved: boolean
  recalculatedAt: string | null
  updatedAt: string | null
}

/** Фильтры отчёта §9.3 плюс общие фильтры каркаса отчётов (docs/22 §3). */
export const timePlanFactQuerySchema = z.object({
  subjectType: z.enum(LEARNING_TIME_SUBJECT_TYPES).optional(),
  subjectId: z.string().uuid().optional(),
  /** «Трек» — курс или траектория, в которой стоит элемент. */
  trackId: z.string().uuid().optional(),
  deviation: z.enum(CONTENT_TIME_DEVIATION_FLAGS).optional(),
  /** «Мінімальний розмір вибірки» — строки с меньшим числом достоверных прохождений скрываются. */
  minSample: z.coerce.number().int().min(0).max(100_000).optional(),
  /** Период — по дате завершения прохождения; без периода — всё время, как у нормы. */
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  locationId: z.string().uuid().optional(),
  /** «Враховувати архівованих» (docs/22 §7.5): по умолчанию каркас их исключает. */
  includeArchived: queryBool.optional(),
  format: z.enum(['json', 'xlsx']).default('json'),
})
export type TimePlanFactQuery = z.infer<typeof timePlanFactQuerySchema>

export interface TimePlanFactTrack { id: string, title: string }

export interface TimePlanFactRow {
  key: string
  subjectType: LearningTimeSubjectType
  subjectId: string
  title: string
  tracks: TimePlanFactTrack[]
  plannedSeconds: number | null
  source: ContentTimeNormSource
  /** Медиана, p25, p75 факта — `null` при выборке меньше 10 (Р-22.4). */
  medianSeconds: number | null
  p25Seconds: number | null
  p75Seconds: number | null
  /** «Вибірка» — достоверные завершённые прохождения. */
  sample: number
  /** «Факт / план»; `null`, если флаг `no_data`. */
  factor: number | null
  deviation: ContentTimeDeviationFlag
  /** «Частка недостовірних вимірів», 0…1; `null` при менее чем 10 прохождениях всего. */
  unreliableShare: number | null
}

export interface TimePlanFactReport {
  rows: TimePlanFactRow[]
  summary: { elements: number, tooSlow: number, tooFast: number, noData: number }
  /** Отчёт считается сразу при запросе (docs/22 §7.7 «Розраховано зараз»). */
  computedAt: string
}
