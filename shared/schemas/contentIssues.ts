import { z } from 'zod'
import {
  CONTENT_ISSUE_COMMENT_REQUIRED,
  CONTENT_ISSUE_TARGET_TYPES,
  CONTENT_ISSUE_TYPES,
  CONTENT_REPORT_SOURCES,
} from '../enums'

/**
 * Жалоба на материал (docs/v2/36-content-feedback.md §6.1, §10). Один источник для клиента
 * и сервера (CLAUDE.md п. 7).
 *
 * Форма — два поля: тип проблемы и «Що не так?». Всё остальное собирает система (§7.1):
 * клиент присылает то, что знает только он (позиция плеера, прокрутка, вьюпорт, время на
 * устройстве), сервер дописывает то, что знает только он (версия контента, версия вопроса
 * из снапшота попытки, `request_context`). Ни одно поле `context` не вводится руками.
 */

/** Контекст, который может дать только клиент (§7.1). Всё остальное дописывает сервер. */
export const contentIssueClientContextSchema = z.object({
  scrollPct: z.number().int().min(0).max(100).optional(),
  playerPositionSec: z.number().min(0).max(86_400).optional(),
  device: z.enum(['mobile', 'tablet', 'desktop']).optional(),
  viewport: z.string().max(20).optional(),
  locale: z.string().max(10).optional(),
  url: z.string().max(500).optional(),
  clientTs: z.string().datetime().optional(),
  /**
   * Сколько секунд форма была открыта. При `time_limit_sec` это время возвращается
   * человеку сдвигом `deadline_at` (§7.7 б) — сервер обрезает значение своими пределами
   * (`CONTENT_ISSUE_LIMITS`), поэтому завысить его клиент не может.
   */
  formSeconds: z.number().int().min(0).max(3600).optional(),
}).strict()
export type ContentIssueClientContext = z.infer<typeof contentIssueClientContextSchema>

export const contentReportSchema = z.object({
  targetType: z.enum(CONTENT_ISSUE_TARGET_TYPES),
  targetId: z.string().uuid(),
  /** Идентификатор блока в теле материала — строка редактора, не uuid (`36` §3.1, исправлено). */
  blockId: z.string().min(1).max(64).nullable().optional(),
  issueType: z.enum(CONTENT_ISSUE_TYPES),
  comment: z.string().trim().min(10).max(1000).nullable().optional(),
  screenshotMediaId: z.string().uuid().nullable().optional(),
  source: z.enum(CONTENT_REPORT_SOURCES).default('lesson'),
  enrollmentId: z.string().uuid().nullable().optional(),
  lessonId: z.string().uuid().nullable().optional(),
  attemptId: z.string().uuid().nullable().optional(),
  context: contentIssueClientContextSchema.default({}),
}).superRefine((v, ctx) => {
  // §3.1: у четырёх типов комментарий обязателен — без него автор не поймёт, что не так
  if (CONTENT_ISSUE_COMMENT_REQUIRED.includes(v.issueType) && !v.comment) {
    ctx.addIssue({ code: 'custom', path: ['comment'], message: 'Опишіть проблему хоча б одним реченням' })
  }
})
export type ContentReportInput = z.infer<typeof contentReportSchema>

/** Ответ подачи (§10): `merged` — жалоба приклеилась к открытой карточке, а не завела новую. */
export interface ContentReportResult {
  issueId: string
  reportId: string
  merged: boolean
  /** На сколько секунд сдвинут дедлайн попытки (§7.7 б); 0 — сдвигать было нечего. */
  deadlineShiftSec: number
  /** Сколько жалоб человек уже подал за сутки и предел — форма показывает остаток. */
  reportsToday: number
  limitPerDay: number
}
