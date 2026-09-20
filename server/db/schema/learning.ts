import { sql } from 'drizzle-orm'
import {
  index, integer, jsonb, numeric, pgTable, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { users } from './people'
import { courses, courseVersions, lessons } from './content'

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
  source: text('source').notNull().default('assigned'), // assigned | self | repeat | import
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
}, t => [
  unique().on(t.tenantId, t.enrollmentId, t.lessonId),
  index().on(t.tenantId, t.enrollmentId),
])
