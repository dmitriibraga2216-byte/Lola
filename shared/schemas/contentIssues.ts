import { z } from 'zod'
import {
  CONTENT_ISSUE_COMMENT_REQUIRED,
  CONTENT_ISSUE_RESOLUTIONS,
  CONTENT_ISSUE_STATUSES,
  CONTENT_ISSUE_TARGET_TYPES,
  CONTENT_ISSUE_TYPES,
  CONTENT_REPORT_SOURCES,
} from '../enums'
import type {
  ContentIssueEventKind, ContentIssueRescoreState, ContentIssueResolution, ContentIssueSeverity,
  ContentIssueStatus, ContentIssueTargetType, ContentIssueType, ContentReportSource,
} from '../enums'
import type { ContentIssueAction } from '../domain/contentIssues'
import { KEYSETS } from '../domain/keyset'
import { keysetCursorSchema } from './keyset'

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

// ── Разбор жалобы (PR-24): очередь, карточка, переходы, пересчёт, маршрутизация, отчёт ─────

/** Вкладки очереди «Звіт про помилки» (§5.3); «Відкладені» живут во вкладке «В роботі». */
export const CONTENT_ISSUE_QUEUE_TABS = ['new', 'in_progress', 'fixed', 'rejected', 'all'] as const
export type ContentIssueQueueTab = typeof CONTENT_ISSUE_QUEUE_TABS[number]

/** Размер страницы очереди (§5.3: 10/25/50/100). */
export const CONTENT_ISSUE_PAGE_SIZES = [10, 25, 50, 100] as const

/** Булев параметр строки запроса: `?affectsScoring=true`. */
const queryBool = z.union([z.boolean(), z.enum(['true', 'false', '1', '0'])]).transform(v => v === true || v === 'true' || v === '1')

export const contentIssueQueueSchema = z.object({
  tab: z.enum(CONTENT_ISSUE_QUEUE_TABS).default('new'),
  /** Фильтр «Тип» — первым, как на эталоне (§14). */
  issueType: z.enum(CONTENT_ISSUE_TYPES).optional(),
  targetType: z.enum(CONTENT_ISSUE_TARGET_TYPES).optional(),
  courseId: z.string().uuid().optional(),
  authorId: z.string().uuid().optional(),
  assigneeId: z.string().uuid().optional(),
  /** «Точка заявника»: хотя бы один заявитель карточки работает на этой точке. */
  locationId: z.string().uuid().optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  /** «Тільки ті, що впливають на бали». */
  affectsScoring: queryBool.optional(),
  /** Ключевой курсор следующей страницы (docs/04 §4.1): его отдаёт сервер, клиент не строит. */
  cursor: keysetCursorSchema(KEYSETS.contentIssues).optional(),
  limit: z.coerce.number().int()
    .refine(v => (CONTENT_ISSUE_PAGE_SIZES as readonly number[]).includes(v), 'Розмір сторінки: 10, 25, 50 або 100')
    .default(25),
})
export type ContentIssueQueueQuery = z.infer<typeof contentIssueQueueSchema>

/**
 * `PATCH /content-issues/:id` (§10, форма разбора §6.2). Важности (`severity`) здесь нет:
 * её считает система, а не человек (§3.1, §7.4). Срок — дата «Термін» из формы «Відкласти».
 */
export const contentIssuePatchSchema = z.object({
  status: z.enum(CONTENT_ISSUE_STATUSES).optional(),
  resolution: z.enum(CONTENT_ISSUE_RESOLUTIONS).optional(),
  /** «Коментар для заявника» — виден заявителям (§3.1). */
  resolutionComment: z.string().trim().max(1000).optional(),
  dueAt: z.string().date().optional(),
  /** «Впливає на бали» — только у теста и вопроса (§6.2). */
  affectsScoring: z.boolean().optional(),
  /** «Внутрішня нотатка» — заявителю не видна (§6.2). */
  internalNote: z.string().trim().min(1).max(2000).optional(),
}).strict().refine(v => Object.values(v).some(x => x !== undefined), { message: 'Немає змін' })
export type ContentIssuePatch = z.infer<typeof contentIssuePatchSchema>

export const contentIssueAssignSchema = z.object({ userId: z.string().uuid() }).strict()
export const contentIssueCommentSchema = z.object({
  comment: z.string().trim().min(1).max(2000),
  isInternal: z.boolean().default(false),
}).strict()

/**
 * Режим пересчёта (§7.8, §10): `recalc` — по новому ключу (`question_fixed`), `void` — вопрос
 * исключён из знаменателя (`question_void`), `skip` — «не перераховувати» с комментарием,
 * видимым заявителям. Без `mode` берётся из резолюции карточки.
 */
export const CONTENT_ISSUE_RESCORE_MODES = ['recalc', 'void', 'skip'] as const
export type ContentIssueRescoreMode = typeof CONTENT_ISSUE_RESCORE_MODES[number]
export const contentIssueRescoreSchema = z.object({
  mode: z.enum(CONTENT_ISSUE_RESCORE_MODES).optional(),
  reason: z.string().trim().min(10, 'Вкажіть причину хоча б одним реченням').max(1000),
}).strict()

const ruleFields = {
  sort: z.number().int().min(0).max(10_000),
  targetType: z.enum(CONTENT_ISSUE_TARGET_TYPES).nullable(),
  issueType: z.enum(CONTENT_ISSUE_TYPES).nullable(),
  categoryId: z.string().uuid().nullable(),
  assigneeUserId: z.string().uuid().nullable(),
  assigneeRoleId: z.string().uuid().nullable(),
  fallback: z.boolean(),
  isActive: z.boolean(),
}

/** Правило маршрутизации (§6.3): «Призначити на» — людина или роль, хотя бы одно. */
export const routingRuleSchema = z.object({
  sort: ruleFields.sort.default(100),
  targetType: ruleFields.targetType.default(null),
  issueType: ruleFields.issueType.default(null),
  categoryId: ruleFields.categoryId.default(null),
  assigneeUserId: ruleFields.assigneeUserId.default(null),
  assigneeRoleId: ruleFields.assigneeRoleId.default(null),
  fallback: ruleFields.fallback.default(false),
  isActive: ruleFields.isActive.default(true),
}).strict().refine(v => !!v.assigneeUserId || !!v.assigneeRoleId, { message: 'Оберіть людину або роль', path: ['assigneeUserId'] })
export type RoutingRuleInput = z.infer<typeof routingRuleSchema>

export const routingRulePatchSchema = z.object({
  sort: ruleFields.sort.optional(),
  targetType: ruleFields.targetType.optional(),
  issueType: ruleFields.issueType.optional(),
  categoryId: ruleFields.categoryId.optional(),
  assigneeUserId: ruleFields.assigneeUserId.optional(),
  assigneeRoleId: ruleFields.assigneeRoleId.optional(),
  fallback: ruleFields.fallback.optional(),
  isActive: ruleFields.isActive.optional(),
}).strict().refine(v => Object.values(v).some(x => x !== undefined), { message: 'Немає змін' })
export type RoutingRulePatch = z.infer<typeof routingRulePatchSchema>

/** `POST /content-reporters/:userId/mute` (§7.11, §10): до какой даты и почему. */
export const reporterMuteSchema = z.object({
  until: z.string().date(),
  reason: z.string().trim().min(3).max(300),
}).strict()

/** Отчёт «Якість контенту» (§9): фильтры — период, категория, автор, тип проблемы, тип элемента, точка. */
export const contentQualityQuerySchema = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  categoryId: z.string().uuid().optional(),
  authorId: z.string().uuid().optional(),
  issueType: z.enum(CONTENT_ISSUE_TYPES).optional(),
  targetType: z.enum(CONTENT_ISSUE_TARGET_TYPES).optional(),
  locationId: z.string().uuid().optional(),
  /** «Враховувати архівованих» (docs/22 §7.5): по умолчанию каркас их исключает. */
  includeArchived: queryBool.optional(),
  /** Строки: элементы контента (§9) или треки — сумма по курсу (критерий 9 говорит о курсах). */
  groupBy: z.enum(['element', 'course']).default('element'),
  /** Детализация строки (docs/22 §3 п. 4): заявители элемента или курса — единым каркасом колонок. */
  drillKey: z.string().max(200).optional(),
  format: z.enum(['json', 'xlsx']).default('json'),
})
export type ContentQualityQuery = z.infer<typeof contentQualityQuerySchema>

// ── Ответы API ──────────────────────────────────────────────────────────────────────────

export interface IssuePerson { id: string, fullName: string, active: boolean }
export interface IssueTrack { id: string, title: string }

export interface ContentIssueQueueRow {
  id: string
  issueType: ContentIssueType
  targetType: ContentIssueTargetType
  title: string
  tracks: IssueTrack[]
  reportsCount: number
  status: ContentIssueStatus
  severity: ContentIssueSeverity
  affectsScoring: boolean
  rescoreState: ContentIssueRescoreState
  assignee: IssuePerson | null
  lastReportedAt: string
  dueAt: string | null
  /** Срок прошёл, а карточка всё ещё у ответственного — строка коралловая (§5.3). */
  overdue: boolean
  /** Среди заявителей есть «надійний» (§7.11) — при равном числе жалоб карточка выше. */
  trusted: boolean
}

/** Страница очереди: `nextCursor` — следующая страница, `null` — это последняя; `total` — всего по фильтрам. */
export interface ContentIssueQueue { items: ContentIssueQueueRow[], total: number, limit: number, nextCursor: string | null }

export interface ContentIssueEventRow {
  id: string
  kind: ContentIssueEventKind
  fromStatus: ContentIssueStatus | null
  toStatus: ContentIssueStatus | null
  comment: string | null
  isInternal: boolean
  payload: Record<string, unknown>
  actor: { id: string, fullName: string } | null
  /** Кому назначена карточка — у события `assigned` (имя из `payload.to`). */
  subjectName: string | null
  createdAt: string
}

export interface ContentIssueReporterRow {
  reportId: string
  user: IssuePerson
  comment: string | null
  screenshotMediaId: string | null
  source: ContentReportSource
  createdAt: string
  attemptId: string | null
  questionVersion: number | null
  /** То, что видел человек, — строкой-подтверждением, а не формой (§7.1). */
  context: { playerPositionSec?: number, scrollPct?: number, device?: string, viewport?: string, url?: string }
}

export interface ContentIssueCard {
  id: string
  issueType: ContentIssueType
  targetType: ContentIssueTargetType
  targetId: string
  blockId: string | null
  title: string
  contentVersion: number
  status: ContentIssueStatus
  resolution: ContentIssueResolution | null
  resolutionComment: string | null
  severity: ContentIssueSeverity
  affectsScoring: boolean
  rescoreState: ContentIssueRescoreState
  rescoredAttempts: number
  reportsCount: number
  firstReportedAt: string
  lastReportedAt: string
  dueAt: string | null
  closedAt: string | null
  overdue: boolean
  assignee: IssuePerson | null
  tracks: IssueTrack[]
  /** Где элемент правится; `currentVersion` — действующая версия для сравнения с `contentVersion`. */
  target: { editUrl: string | null, currentVersion: number | null, missing: boolean }
  reporters: ContentIssueReporterRow[]
  events: ContentIssueEventRow[]
  /** «Вплив на результати» (§5.4) — только у вопроса. */
  impact: { attemptsTotal: number, failedOnQuestion: number } | null
  actions: ContentIssueAction[]
}

/** Предпросмотр пересчёта (§7.8, §10): «Зміниться 37 спроб із 214, з них 12 стануть „ВИКОНАНО“…». */
export interface RescorePreview {
  mode: 'recalc' | 'void'
  attemptsTotal: number
  attemptsChanged: number
  toPassed: number
  /** Стали бы «ПРОВАЛЕНО» — не применяются никогда (§7.8). */
  toFailedSkipped: number
  /** Все ухудшения, включая падение балла без смены статуса. */
  worseSkipped: number
  /** Средний прирост балла у меняющихся попыток, п. п.; null — меняться нечему. */
  avgDelta: number | null
}

export interface RescoreWorseRow {
  attemptId: string
  userId: string
  fullName: string
  scoreBefore: number | null
  scoreAfter: number
  passedBefore: boolean | null
  passedAfter: boolean | null
}

export interface RescoreResult {
  mode: ContentIssueRescoreMode
  attemptsTotal: number
  rescoredAttempts: number
  toPassed: number
  unchanged: number
  /** Попытки с ухудшением: остались как есть и перечислены отдельным списком (критерий 4). */
  worse: RescoreWorseRow[]
}

export interface RoutingRuleRow {
  id: string
  sort: number
  targetType: ContentIssueTargetType | null
  issueType: ContentIssueType | null
  categoryId: string | null
  categoryName: string | null
  assigneeUserId: string | null
  assigneeName: string | null
  /** null — правило адресовано роли; false — человек уволен или заблокирован. */
  assigneeActive: boolean | null
  assigneeRoleId: string | null
  roleName: string | null
  fallback: boolean
  isActive: boolean
}

export interface ContentQualityRow {
  key: string
  targetType: ContentIssueTargetType | 'course'
  targetId: string
  title: string
  tracks: IssueTrack[]
  authors: string[]
  passes: number
  complaints: number
  /** «Скарг на 100 проходжень» — ключ сортировки (§9, критерий 9). */
  per100: number | null
  confirmed: number
  rejected: number
  /** «Середній час до виправлення», дней. */
  avgDaysToFix: number | null
  openNow: number
}

export interface ContentQualityReport {
  rows: ContentQualityRow[]
  summary: { complaints: number, passes: number, per100: number | null, openNow: number }
  /** Детализация строки единым каркасом колонок (docs/22 §13.3): кто пожаловался. */
  people: Record<string, unknown>[] | null
}
