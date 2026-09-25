import { z } from 'zod'
import { KEYSETS } from '../domain/keyset'
import { SUMMARY_POINT_MAX_CHARS, SUMMARY_POINTS_MAX } from '../domain/candidateSummary'
import { CANDIDATE_SUMMARY_CHANNELS, CANDIDATE_SUMMARY_SECTIONS, CANDIDATE_SUMMARY_STATES } from '../enums'
import { keysetCursorSchema } from './keyset'

/**
 * Контракты Підсумку кандидата (`docs/v2/30-ai-interview.md` §5.4, §7.14, §7.15, §10; план `45`
 * PR-29). Строки «Документ сформовано автоматично» в контрактах **нет** — ни поля, ни флага: её
 * ставит сервис, держит CHECK таблицы, и выключить её нечем (`30` §13 к. 14). Поле с таким
 * смыслом в теле запроса отклоняется `.strict()`.
 */

const sections = z.array(z.enum(CANDIDATE_SUMMARY_SECTIONS)).max(CANDIDATE_SUMMARY_SECTIONS.length)
  .transform(v => CANDIDATE_SUMMARY_SECTIONS.filter(s => v.includes(s)))

/** `GET /candidate-summaries` — список рекрутера: по кандидату и состоянию, ключевой курсор. */
export const candidateSummaryListSchema = z.object({
  candidateId: z.string().uuid().optional(),
  state: z.enum(CANDIDATE_SUMMARY_STATES).optional(),
  cursor: keysetCursorSchema(KEYSETS.candidateSummaries).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict()

export type CandidateSummaryListQuery = z.infer<typeof candidateSummaryListSchema>

/** `POST /candidate-summaries` — «Сформувати» / «Сформувати заново» (`30` §5.4): новая версия. */
export const candidateSummaryCreateSchema = z.object({
  candidateId: z.string().uuid('Оберіть кандидата'),
  sections: sections.optional(),
}).strict()

export type CandidateSummaryCreateInput = z.infer<typeof candidateSummaryCreateSchema>

const point = z.string().trim().min(1).max(SUMMARY_POINT_MAX_CHARS, `До ${SUMMARY_POINT_MAX_CHARS} символів`)

/**
 * `PATCH /candidate-summaries/:id` — «Редагувати» (`30` §5.4, §10 `{body, sections}`): включённые
 * секции и текст генеративной секции (сильные стороны и зоны риска). Остальные секции собраны из
 * данных — их правят в источнике (оценка, назначение), а не в документе.
 */
export const candidateSummaryPatchSchema = z.object({
  sections: sections.optional(),
  strengths: z.array(point).max(SUMMARY_POINTS_MAX).optional(),
  risks: z.array(point).max(SUMMARY_POINTS_MAX).optional(),
}).strict().refine(v => v.sections !== undefined || v.strengths !== undefined || v.risks !== undefined, { message: 'Немає змін' })

export type CandidateSummaryPatchInput = z.infer<typeof candidateSummaryPatchSchema>

/** `POST /candidate-summaries/:id/send` — «Надіслати кандидату» (`email`) или «Скопіювати посилання» (`link`). */
export const candidateSummarySendSchema = z.object({
  channel: z.enum(CANDIDATE_SUMMARY_CHANNELS).default('email'),
}).strict()

export type CandidateSummarySendInput = z.infer<typeof candidateSummarySendSchema>

/** `POST /candidate-summaries/:id/revoke` — «Відкликати доступ» (`30` §4, §10 `{reason}`). */
export const candidateSummaryRevokeSchema = z.object({
  reason: z.string().trim().min(3, 'Вкажіть причину').max(500, 'До 500 символів'),
}).strict()

export type CandidateSummaryRevokeInput = z.infer<typeof candidateSummaryRevokeSchema>
