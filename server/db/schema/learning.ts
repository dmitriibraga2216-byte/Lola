import { sql } from 'drizzle-orm'
import {
  check, index, integer, jsonb, numeric, pgTable, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { tenants } from './tenants'
import { users } from './people'
import { courses, courseVersions, lessons, resources, resourceVersions } from './content'
import { assignments } from './assignments'

/**
 * Прохождение (docs/10-catalog-learning.md): enrollment — запись человека
 * на версию курса, её прогресс, срок и статус. Журнал изменений — отдельно.
 */

export const enrollments = pgTable('enrollments', {
  ...baseColumns,
  tenantId: tenantId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  subjectType: text('subject_type').notNull().default('course'), // course | program
  subjectId: uuid('subject_id').notNull().references(() => courses.id),
  versionId: uuid('version_id').notNull().references(() => courseVersions.id),
  assignmentId: uuid('assignment_id'), // null при самозаписи (назначения — этап 4)
  source: text('source').notNull().default('assigned'), // assigned | self | repeat | import | catalog
  requestedAt: timestamp('requested_at', { withTimezone: true }), // заявка через каталог (catalog_request): status = not_assigned до рішення
  // enrollment_status (docs/02, пять значений): not_assigned | not_started | in_progress | done | failed.
  // «Заплановано» = starts_at > now(); «протерміновано» = due_at < now() при незавершённом;
  // автозакрытие по сроку = failed + expired_at; снятие назначения = cancelled_at (статус остаётся).
  status: text('status').notNull().default('not_started'),
  progressPct: numeric('progress_pct', { precision: 5, scale: 2 }).notNull().default('0'),
  requiredTotal: integer('required_total').notNull().default(0),
  requiredDone: integer('required_done').notNull().default(0),
  startsAt: timestamp('starts_at', { withTimezone: true }),
  dueAt: timestamp('due_at', { withTimezone: true }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  expiredAt: timestamp('expired_at', { withTimezone: true }),
  validUntil: timestamp('valid_until', { withTimezone: true }),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
  score: numeric('score', { precision: 5, scale: 2 }),
  timeSpentSec: integer('time_spent_sec').notNull().default(0),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelledBy: uuid('cancelled_by').references(() => users.id),
  cancelReason: text('cancel_reason'),
  // deadline_shift_reason (docs/02): почему срок не тот, что дало назначение — `absence`, дедлайн
  // обязательного назначения сдвинут с дней отсутствия (docs/v2/38 §7.14, PR-33). Ручное продление
  // причину снимает: действующий срок поставил человек, а не правило.
  deadlineShiftedReason: text('deadline_shifted_reason'),
}, t => [
  unique().on(t.tenantId, t.userId, t.subjectId, t.versionId, t.assignmentId),
  index().on(t.tenantId, t.userId, t.status),
  index().on(t.tenantId, t.dueAt).where(sql`${t.status} in ('not_started', 'in_progress') and ${t.cancelledAt} is null`),
  index().on(t.tenantId, t.subjectId, t.status),
])

export const enrollmentEvents = pgTable('enrollment_events', {
  ...baseColumns,
  tenantId: tenantId(),
  enrollmentId: uuid('enrollment_id').notNull().references(() => enrollments.id, { onDelete: 'cascade' }),
  event: text('event').notNull(),
  // created | started | progress | completed | failed | expired | extended | cancelled | reset
  payload: jsonb('payload').notNull().default('{}'),
  actorId: uuid('actor_id'), // null — системное событие
  requestContext: jsonb('request_context'), // технический контекст события (CLAUDE.md п. 14): {ip, geo, user_agent, browser, os, device}
}, t => [
  index().on(t.tenantId),
])

export const lessonProgress = pgTable('lesson_progress', {
  ...baseColumns,
  tenantId: tenantId(),
  enrollmentId: uuid('enrollment_id').notNull().references(() => enrollments.id, { onDelete: 'cascade' }),
  lessonId: uuid('lesson_id').notNull().references(() => lessons.id),
  status: text('status').notNull().default('opened'), // opened | completed
  secondsSpent: integer('seconds_spent').notNull().default(0),
  blocksState: jsonb('blocks_state').notNull().default('{}'), // чек-листы, видео
  videoPct: integer('video_pct').notNull().default(0), // максимум просмотра
  scrollPct: integer('scroll_pct').notNull().default(0), // докуда доскроллил (страница, документ) — Г-11.5
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }), // «Я ознайомився» для ссылки
  downloadedAt: timestamp('downloaded_at', { withTimezone: true }), // документ скачан
  lastTickAt: timestamp('last_tick_at', { withTimezone: true }),
  firstOpenedAt: timestamp('first_opened_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  device: text('device'), // mobile | desktop
  // Учёт времени биениями (docs/v2/37 §3.7, PR-21): пишет только свёртка `time.rollup`.
  // `seconds_spent` выше остаётся «сырой» величиной тиков и правилом зачёта урока (min_seconds);
  // эти три колонки — учёт и ни в одно правило не входят.
  contentSeconds: integer('content_seconds').notNull().default(0),
  discardedSeconds: integer('discarded_seconds').notNull().default(0),
  sessionsCount: integer('sessions_count').notNull().default(0),
}, t => [
  unique().on(t.tenantId, t.enrollmentId, t.lessonId),
  index().on(t.tenantId, t.enrollmentId),
])

/**
 * Прохождение ресурса **как задания** — вне курса (docs/11 Г-11.5, миграция `0092_fix_resource_node`):
 * узел траектории «Завдання» с материалом, элемент программы, прямое назначение ресурса. Те же факты,
 * что у `lesson_progress` (время тиками, прокрутка, видео, «Я ознайомився», скачивание), но ключ —
 * человек × ресурс × назначение; у элемента программы назначения нет (`assignment_id` пуст).
 * Решение о зачёте принимает сервер по типу материала (`lessonRules.ts`); пишет только
 * `server/services/resourcePass.ts`.
 */
export const resourceProgress = pgTable('resource_progress', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  resourceId: uuid('resource_id').notNull().references(() => resources.id, { onDelete: 'cascade' }),
  /** Назначение (узел траектории, прямое); пусто — элемент программы. Снятое назначение уносит запись. */
  assignmentId: uuid('assignment_id').references(() => assignments.id, { onDelete: 'cascade' }),
  /** Снимок, открытый человеком: по нему считается время чтения и страницы документа. */
  resourceVersionId: uuid('resource_version_id').references(() => resourceVersions.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('opened'), // opened | completed
  secondsSpent: integer('seconds_spent').notNull().default(0),
  blocksState: jsonb('blocks_state').notNull().default('{}'), // чек-листы страницы
  videoPct: integer('video_pct').notNull().default(0),
  scrollPct: integer('scroll_pct').notNull().default(0),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }), // «Я ознайомився» для ссылки
  downloadedAt: timestamp('downloaded_at', { withTimezone: true }), // документ скачан
  lastTickAt: timestamp('last_tick_at', { withTimezone: true }),
  firstOpenedAt: timestamp('first_opened_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  device: text('device'), // mobile | desktop
}, t => [
  unique('uq_resource_progress_key').on(t.tenantId, t.userId, t.resourceId, t.assignmentId).nullsNotDistinct(),
  index('idx_resource_progress_resource').on(t.tenantId, t.resourceId, t.status),
  index('idx_resource_progress_assignment').on(t.tenantId, t.assignmentId).where(sql`${t.assignmentId} is not null`),
  check('resource_progress_status_chk', sql`${t.status} in ('opened', 'completed')`),
  check('resource_progress_facts_chk', sql`${t.secondsSpent} >= 0 and ${t.videoPct} between 0 and 100 and ${t.scrollPct} between 0 and 100`),
  check('resource_progress_device_chk', sql`${t.device} is null or ${t.device} in ('mobile', 'desktop')`),
  check('resource_progress_completed_chk', sql`(${t.status} = 'completed') = (${t.completedAt} is not null)`),
])
