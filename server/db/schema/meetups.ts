import { sql } from 'drizzle-orm'
import {
  boolean, index, integer, jsonb, numeric, pgTable, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { users } from './people'
import { locations } from './org'
import { courses } from './content'
import { surveys } from './knowledge'

/**
 * Очные занятия, вебинары, комплексные тесты (docs/18-meetups-webinars.md).
 * Вебинар — занятие с kind='webinar' и расширением в `webinars` (1:1): расписание,
 * запись и посещаемость общие, онлайн-поля — отдельно.
 */

export const meetups = pgTable('meetups', {
  ...baseColumns,
  tenantId: tenantId(),
  kind: text('kind').notNull().default('meetup'), // meetup | webinar | event (корпоративное событие хаба)
  title: text('title').notNull(),
  description: jsonb('description').notNull().default('[]'), // блоки
  courseId: uuid('course_id').references(() => courses.id),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  timezone: text('timezone').notNull().default('Europe/Kyiv'),
  locationId: uuid('location_id').references(() => locations.id),
  room: text('room'),
  address: text('address'),
  trainerIds: uuid('trainer_ids').array().notNull().default(sql`'{}'::uuid[]`),
  capacity: integer('capacity'),
  waitlistEnabled: boolean('waitlist_enabled').notNull().default(true),
  enrollDeadlineHours: integer('enroll_deadline_hours').notNull().default(2),
  cancelDeadlineHours: integer('cancel_deadline_hours').notNull().default(24),
  attendanceMode: text('attendance_mode').notNull().default('manual'), // manual | qr | both
  qrSecret: text('qr_secret').notNull(), // основа HMAC для 30-секундных QR-кодов
  requiresFeedback: boolean('requires_feedback').notNull().default(true),
  feedbackSurveyId: uuid('feedback_survey_id').references(() => surveys.id),
  materials: uuid('materials').array().notNull().default(sql`'{}'::uuid[]`),
  status: text('status').notNull().default('planned'), // draft | planned | ongoing | finished | cancelled
  cancelReason: text('cancel_reason'),
  createdBy: uuid('created_by').references(() => users.id),
}, t => [
  index().on(t.tenantId, t.startsAt),
  index().on(t.tenantId, t.status),
])

export const meetupRegistrations = pgTable('meetup_registrations', {
  ...baseColumns,
  tenantId: tenantId(),
  meetupId: uuid('meetup_id').notNull().references(() => meetups.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('registered'), // registered | waitlist | attended | missed | cancelled | excused
  registeredAt: timestamp('registered_at', { withTimezone: true }).notNull().defaultNow(),
  registeredBy: uuid('registered_by').references(() => users.id),
  waitlistPosition: integer('waitlist_position'),
  checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
  checkInMethod: text('check_in_method'), // manual | qr | auto
  checkedInBy: uuid('checked_in_by').references(() => users.id),
  cancelReason: text('cancel_reason'),
  feedbackGiven: boolean('feedback_given').notNull().default(false),
  enrollmentId: uuid('enrollment_id'),
  lessonId: uuid('lesson_id'),
}, t => [
  unique().on(t.meetupId, t.userId),
  index().on(t.tenantId, t.userId, t.status),
])

export const webinars = pgTable('webinars', {
  ...baseColumns,
  tenantId: tenantId(),
  meetupId: uuid('meetup_id').notNull().references(() => meetups.id, { onDelete: 'cascade' }).unique(),
  provider: text('provider').notNull().default('other'), // zoom | meet | other
  joinUrl: text('join_url'),
  hostUrl: text('host_url'),
  recordUrl: text('record_url'),
  recordAvailableUntil: timestamp('record_available_until', { withTimezone: true }),
  autoAttendance: boolean('auto_attendance').notNull().default(false),
  minMinutesForAttendance: integer('min_minutes_for_attendance'), // null = 70% длительности
})

export const webinarParticipations = pgTable('webinar_participations', {
  ...baseColumns,
  tenantId: tenantId(),
  webinarId: uuid('webinar_id').notNull().references(() => webinars.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  joinedAt: timestamp('joined_at', { withTimezone: true }),
  leftAt: timestamp('left_at', { withTimezone: true }),
  minutes: integer('minutes').notNull().default(0),
  attended: boolean('attended').notNull().default(false),
  source: text('source').notNull().default('manual'), // provider | manual
}, t => [
  unique().on(t.webinarId, t.userId),
])

export const complexTests = pgTable('complex_tests', {
  ...baseColumns,
  tenantId: tenantId(),
  title: text('title').notNull(),
  parts: jsonb('parts').notNull(), // [{quizId, weight, isRequired, minScore}]
  passScore: numeric('pass_score', { precision: 5, scale: 2 }).notNull().default('70'),
  timeLimitSec: integer('time_limit_sec'),
  sequential: boolean('sequential').notNull().default(true),
  attemptsAllowed: integer('attempts_allowed').notNull().default(1),
  showPartsResult: boolean('show_parts_result').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id),
})

export const complexTestAttempts = pgTable('complex_test_attempts', {
  ...baseColumns,
  tenantId: tenantId(),
  complexTestId: uuid('complex_test_id').notNull().references(() => complexTests.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  attemptNo: integer('attempt_no').notNull().default(1),
  partsState: jsonb('parts_state').notNull().default('[]'), // [{quizId, attemptId, score, status}]
  status: text('status').notNull().default('in_progress'), // in_progress | passed | failed | expired
  score: numeric('score', { precision: 5, scale: 2 }),
  passed: boolean('passed'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
}, t => [
  index().on(t.tenantId, t.userId, t.complexTestId),
])

