import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { tenants } from './tenants'
import { users } from './people'
import { lessons, mediaAssets } from './content'
import { enrollments } from './learning'
import { attempts } from './quizzes'
import {
  CONTENT_ISSUE_EVENT_KINDS,
  CONTENT_ISSUE_RESCORE_STATES,
  CONTENT_ISSUE_RESOLUTIONS,
  CONTENT_ISSUE_SEVERITIES,
  CONTENT_ISSUE_STATUSES,
  CONTENT_ISSUE_TARGET_TYPES,
  CONTENT_ISSUE_TYPES,
  CONTENT_REPORT_SOURCES,
} from '../../../shared/enums'

/**
 * Обратная связь по контенту (docs/v2/36-content-feedback.md §3, миграция
 * `0069_v2_content_issues`). Четыре таблицы разводят четыре разные сущности, которые
 * на эталоне слиты в одну «заявку» и потому не считаются:
 *
 * - `contentIssues` — **дефект**: один на материал + тип проблемы + версию. Сорок жалоб
 *   на одно битое видео дают одну карточку с `reportsCount = 40` (§12);
 * - `contentReports` — **обращение** человека со своим контекстом и скриншотом;
 * - `contentIssueEvents` — журнал карточки, включая факт компенсации времени попытки (§7.7 б);
 * - `contentReporterStats` — репутация заявителя: лимиты и `mutedUntil` (§7.11).
 *
 * Перечни значений — в `shared/enums.ts` и в `docs/02` «Перечисления»; CHECK-констрейнты
 * строятся из тех же массивов, чтобы третьей копии списка не возникло.
 */

/** `col in ('a','b',…)` из перечня shared/enums — вместо литералов в тексте схемы. */
function inList(column: unknown, values: readonly string[]) {
  return sql`${column} in (${sql.join(values.map(v => sql`${v}`), sql`, `)})`
}

/**
 * Карточка дефекта (§3.2). `dedupeKey` — `target_type:target_id:block_id|-:issue_type:content_version`
 * (§7.2); уникален среди незакрытых карточек, поэтому склейка обеспечена индексом, а не кодом.
 * `dueAt` — срок починки по SLA автора (§7.6), а не правило прохождения: таблица не входит
 * в список контента `schema-parity.spec.ts` и входить не будет (CLAUDE.md п. 11).
 */
export const contentIssues = pgTable('content_issues', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  /** Одно из `CONTENT_ISSUE_TARGET_TYPES`. */
  targetType: text('target_type').notNull(),
  targetId: uuid('target_id').notNull(),
  /**
   * Блок внутри материала (`11` §3.3) — чтобы автор понял, какой абзац. `text`, а не `uuid`:
   * идентификатор блока в `resources.body` — короткая строка редактора, а не uuid
   * (`shared/schemas/content.ts`, `blockBase.id`); DDL документа исправлен пометкой.
   */
  blockId: text('block_id'),
  contentVersion: integer('content_version').notNull().default(1),
  /** Одно из `CONTENT_ISSUE_TYPES` — он же фильтр «Тип» очереди (§7.3). */
  issueType: text('issue_type').notNull(),
  title: text('title').notNull(),
  status: text('status').notNull().default('new'),
  resolution: text('resolution'),
  resolutionComment: text('resolution_comment'),
  reportsCount: integer('reports_count').notNull().default(1),
  firstReportedAt: timestamp('first_reported_at', { withTimezone: true }).notNull().defaultNow(),
  lastReportedAt: timestamp('last_reported_at', { withTimezone: true }).notNull().defaultNow(),
  assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
  assignedAt: timestamp('assigned_at', { withTimezone: true }),
  /** Считает система, не человек (§7.4). */
  severity: text('severity').notNull().default('normal'),
  affectsScoring: boolean('affects_scoring').notNull().default(false),
  /** Ключевое поле модуля (§7.8): одно из `CONTENT_ISSUE_RESCORE_STATES`. */
  rescoreState: text('rescore_state').notNull().default('none'),
  rescoredAttempts: integer('rescored_attempts').notNull().default(0),
  dedupeKey: text('dedupe_key').notNull(),
  courseIds: uuid('course_ids').array().notNull().default(sql`'{}'::uuid[]`),
  dueAt: timestamp('due_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
}, t => [
  index('idx_content_issues_tenant').on(t.tenantId),
  uniqueIndex('uq_content_issues_open_dedupe').on(t.tenantId, t.dedupeKey).where(sql`status <> 'closed'`),
  index('idx_content_issues_queue').on(t.tenantId, t.status, t.lastReportedAt.desc()),
  index('idx_content_issues_target').on(t.tenantId, t.targetType, t.targetId),
  index('idx_content_issues_rescore').on(t.tenantId, t.rescoreState).where(sql`rescore_state = 'needed'`),
  check('content_issues_target_type_chk', inList(sql`target_type`, CONTENT_ISSUE_TARGET_TYPES)),
  check('content_issues_issue_type_chk', inList(sql`issue_type`, CONTENT_ISSUE_TYPES)),
  check('content_issues_status_chk', inList(sql`status`, CONTENT_ISSUE_STATUSES)),
  check('content_issues_resolution_chk', sql`resolution is null or ${inList(sql`resolution`, CONTENT_ISSUE_RESOLUTIONS)}`),
  check('content_issues_severity_chk', inList(sql`severity`, CONTENT_ISSUE_SEVERITIES)),
  check('content_issues_rescore_state_chk', inList(sql`rescore_state`, CONTENT_ISSUE_RESCORE_STATES)),
  check('content_issues_content_version_chk', sql`content_version >= 1`),
  check('content_issues_reports_count_chk', sql`reports_count >= 1`),
  check('content_issues_title_chk', sql`char_length(title) between 3 and 200`),
  check('content_issues_resolution_comment_chk', sql`resolution_comment is null or char_length(resolution_comment) <= 1000`),
])

/**
 * Обращение человека (§3.2). `context` собирается системой (§7.1): ни одно его поле
 * не вводится руками и не показывается формой — только строкой-подтверждением «Ми вже
 * бачимо, де ти зараз». Туда же сервер кладёт `request_context` (CLAUDE.md п. 14).
 * `uq_content_reports_once` — один человек, один голос за карточку (§7.2).
 */
export const contentReports = pgTable('content_reports', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  issueId: uuid('issue_id').notNull().references(() => contentIssues.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Единственное, что человек печатает; обязателен для `other`, `wrong_fact`, `bad_question`, `wrong_key`. */
  comment: text('comment'),
  context: jsonb('context').notNull().default(sql`'{}'::jsonb`),
  screenshotMediaId: uuid('screenshot_media_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
  enrollmentId: uuid('enrollment_id').references(() => enrollments.id, { onDelete: 'set null' }),
  lessonId: uuid('lesson_id').references(() => lessons.id, { onDelete: 'set null' }),
  attemptId: uuid('attempt_id').references(() => attempts.id, { onDelete: 'set null' }),
  /** Версия вопроса из снапшота попытки — её ставит сервер, не клиент. */
  questionVersion: integer('question_version'),
  /** Одно из `CONTENT_REPORT_SOURCES` — точка входа заявителя. */
  source: text('source').notNull().default('lesson'),
  notifiedAt: timestamp('notified_at', { withTimezone: true }),
}, t => [
  index('idx_content_reports_tenant').on(t.tenantId),
  index('idx_content_reports_issue').on(t.tenantId, t.issueId, t.createdAt.desc()),
  index('idx_content_reports_attempt').on(t.tenantId, t.attemptId).where(sql`attempt_id is not null`),
  uniqueIndex('uq_content_reports_once').on(t.tenantId, t.issueId, t.userId),
  index('idx_content_reports_user_created').on(t.tenantId, t.userId, t.createdAt.desc()),
  check('content_reports_source_chk', inList(sql`source`, CONTENT_REPORT_SOURCES)),
  check('content_reports_comment_chk', sql`comment is null or char_length(comment) <= 1000`),
])

/**
 * Журнал карточки (§3). `created` и `merged` пишутся при подаче, остальные — при разборе
 * (PR-24). `payload` события `merged`/`created` во время попытки несёт `attempt_id` и
 * `deadline_shift_sec` — доказательство компенсации времени (§7.7 б).
 */
export const contentIssueEvents = pgTable('content_issue_events', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  issueId: uuid('issue_id').notNull().references(() => contentIssues.id, { onDelete: 'cascade' }),
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  /** Одно из `CONTENT_ISSUE_EVENT_KINDS`. */
  kind: text('kind').notNull(),
  fromStatus: text('from_status'),
  toStatus: text('to_status'),
  comment: text('comment'),
  payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
  /** Внутренняя заметка, заявителю не видна. */
  isInternal: boolean('is_internal').notNull().default(false),
  requestContext: jsonb('request_context'),
}, t => [
  index('idx_content_issue_events_tenant').on(t.tenantId),
  index('idx_content_issue_events_issue').on(t.tenantId, t.issueId, t.createdAt),
  check('content_issue_events_kind_chk', inList(sql`kind`, CONTENT_ISSUE_EVENT_KINDS)),
  check('content_issue_events_comment_chk', sql`comment is null or char_length(comment) <= 2000`),
])

/**
 * Репутация заявителя (§3.2, §7.11). Три жалобы подряд, закрытые как `spam`, дают
 * `mutedUntil = now() + 14 дней`; любая подтверждённая обнуляет `consecutiveSpam`.
 * За отклонённые баллы не снимаются — иначе люди перестанут жаловаться, а модуль ровно
 * это и предотвращает (§7.12).
 */
export const contentReporterStats = pgTable('content_reporter_stats', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  reportsTotal: integer('reports_total').notNull().default(0),
  confirmedCount: integer('confirmed_count').notNull().default(0),
  rejectedCount: integer('rejected_count').notNull().default(0),
  spamCount: integer('spam_count').notNull().default(0),
  consecutiveSpam: integer('consecutive_spam').notNull().default(0),
  mutedUntil: timestamp('muted_until', { withTimezone: true }),
  mutedBy: uuid('muted_by').references(() => users.id, { onDelete: 'set null' }),
  muteReason: text('mute_reason'),
  lastReportAt: timestamp('last_report_at', { withTimezone: true }),
}, t => [
  unique('content_reporter_stats_tenant_id_user_id_unique').on(t.tenantId, t.userId),
  index('idx_content_reporter_stats_tenant').on(t.tenantId),
  check('content_reporter_stats_mute_reason_chk', sql`mute_reason is null or char_length(mute_reason) <= 300`),
])
