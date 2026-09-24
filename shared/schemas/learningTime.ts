import { z } from 'zod'
import { LEARNING_TIME_KINDS, LEARNING_TIME_SUBJECT_TYPES } from '../enums'
import type { LearningTimeSubjectType, ReviewTimeConfidence } from '../enums'
import { LEARNING_TIME_RULES } from '../domain/learningTime'

/**
 * Контракты учёта времени биениями (docs/v2/37 §10, docs/v2/41 §2.10, §5.5). Один источник
 * для экрана прохождения и сервера (CLAUDE.md п. 7).
 *
 * Клиент сообщает факты — сколько был активен и видна ли вкладка; сколько из этого зачесть,
 * решает сервер по своим часам (CLAUDE.md п. 3). `clientTs` нужен только для порядка и
 * офлайн-догрузки: в онлайн-зачёт клиентское время не входит (`37` §7.11).
 *
 * Сверх полей `37` §10 (решения PR-21, `46-progress.md`): `enrollmentId` — без него время
 * урока не к чему отнести (урок входит в несколько курсов, `lesson_progress` — по записи);
 * `device`; `resume` — «Продовжити» после «Ви ще тут?» (Р-21.12); `end` — последнее биение
 * экрана; у пакета — `sentAt`, время отправки по часам клиента, чтобы исправить сдвиг его
 * часов (Р-21.13).
 */
export const beatSchema = z.object({
  sessionKey: z.string().uuid(),
  seq: z.number().int().min(1).max(10_000_000),
  kind: z.enum(LEARNING_TIME_KINDS),
  subjectType: z.enum(LEARNING_TIME_SUBJECT_TYPES),
  subjectId: z.string().uuid(),
  enrollmentId: z.string().uuid().nullish(),
  /** Миллисекунды активности за интервал; сервер зачтёт не больше 30 с за биение. */
  activeMs: z.number().int().min(0).max(600_000),
  visible: z.boolean(),
  clientTs: z.string().datetime({ offset: true }),
  device: z.enum(['mobile', 'desktop']).optional(),
  resume: z.boolean().optional(),
  end: z.boolean().optional(),
}).strict()
export type BeatInput = z.infer<typeof beatSchema>

export const beatsBatchSchema = z.object({
  beats: z.array(beatSchema).min(1).max(LEARNING_TIME_RULES.offlineBufferMax),
  sentAt: z.string().datetime({ offset: true }).optional(),
}).strict()
export type BeatsBatchInput = z.infer<typeof beatsBatchSchema>

/** Ответ на биение (`37` §10 `{credited, dailyLeft}` плюс состояние сегмента для экрана). */
export interface BeatResult {
  credited: number
  dailyLeft: number
  segmentNo: number
  capped: 'segment' | 'daily' | null
  /** Показать «Ви ще тут?»: время стоит, следующее биение — с `resume: true`. */
  stillHere: boolean
  duplicate: boolean
}

export interface BeatsBatchResult {
  credited: number
  discarded: number
  accepted: number
  duplicates: number
  /** Биения несуществующего или чужого элемента — отброшены поштучно, остальные приняты. */
  rejected: number
  stillHere: boolean
}

export const timeTotalsQuerySchema = z.object({
  userId: z.string().uuid().optional(),
  subjectType: z.enum(LEARNING_TIME_SUBJECT_TYPES).optional(),
  subjectId: z.string().uuid().optional(),
  enrollmentId: z.string().uuid().optional(),
}).strict()
export type TimeTotalsQuery = z.infer<typeof timeTotalsQuerySchema>

export interface TimeTotalsRow {
  userId: string
  enrollmentId: string | null
  subjectType: LearningTimeSubjectType
  subjectId: string
  contentSeconds: number
  attemptSeconds: number
  discardedSeconds: number
  sessionsCount: number
  confidence: ReviewTimeConfidence
  firstStartedAt: string | null
  lastActivityAt: string | null
}
