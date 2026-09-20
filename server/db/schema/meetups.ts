import { sql } from 'drizzle-orm'
import {
  boolean, index, integer, jsonb, numeric, pgTable, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { users } from './people'
import { locations } from './org'
import { courses } from './content'
import { surveys } from './knowledge'
import { assignments } from './assignments'

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
  coverKey: text('cover_key'), // обложка события (docs/21 §3.4)
  registrationRequired: boolean('registration_required').notNull().default(true), // событие без регистрации — просто в афише
  audience: jsonb('audience'), // кого запрошено на событие (docs/02 events.audience; null = все активные)
  description: jsonb('description').notNull().default('[]'), // блоки
  // «Анонс» (docs/18 §14, сверено с эталоном): текст, який людина читає ДО запису — обов'язковий
  // для kind meetup|webinar; для kind=event не використовується (у події своя картка, Spec 21).
  announcement: jsonb('announcement').notNull().default('[]'),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
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
  externalEventId: text('external_event_id'), // событие в Google Calendar тенанта (docs/09 §9.1)
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
  guestsCount: integer('guests_count').notNull().default(0), // «+гости» на событие (docs/21 §3.4)
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
  externalMeetingId: text('external_meeting_id'), // id встречи у провайдера (Zoom / Meet)
  autoAttendance: boolean('auto_attendance').notNull().default(false),
  minMinutesForAttendance: integer('min_minutes_for_attendance'), // null = 70% длительности
}, t => [
  index().on(t.tenantId),
])

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
  index().on(t.tenantId),
  unique().on(t.webinarId, t.userId),
])

/**
 * Сесії (docs/18 §14.1, docs/02 «Комплексные тесты, очные занятия, вебинары»: `sessions`).
 * Назва таблиці — `meetup_sessions`, бо `sessions` вже зайнята автентифікацією (parity-4).
 * Сесія належить НАЗНАЧЕННЮ (`task_id`), а не картці: одне заняття/вебінар (`meetups`) може
 * мати кілька сесій за датою/місцем, кожна зі своєю вмістимістю, чергою і відміткою.
 * `task_id` — nullable: сесію можна створити і без формального призначення (як і раніше
 * підтримується прямий запис через `meetupRegistrations` для kind=event, Spec 21).
 */
export const meetupSessions = pgTable('meetup_sessions', {
  ...baseColumns,
  tenantId: tenantId(),
  meetupId: uuid('meetup_id').notNull().references(() => meetups.id, { onDelete: 'cascade' }),
  taskId: uuid('task_id').references(() => assignments.id, { onDelete: 'set null' }),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  timezone: text('timezone').notNull().default('Europe/Kyiv'),
  locationId: uuid('location_id').references(() => locations.id),
  room: text('room'),
  address: text('address'),
  trainerIds: uuid('trainer_ids').array().notNull().default(sql`'{}'::uuid[]`),
  // Вебінар: посилання можуть відрізнятись від типових на картці — перевизначення на рівні сесії
  joinUrl: text('join_url'),
  hostUrl: text('host_url'),
  recordUrl: text('record_url'),
  provider: text('provider'), // zoom | meet | other; null = взяти з картки вебінару
  capacity: integer('capacity'),
  waitlistEnabled: boolean('waitlist_enabled').notNull().default(true),
  enrollDeadlineHours: integer('enroll_deadline_hours').notNull().default(2),
  cancelDeadlineHours: integer('cancel_deadline_hours').notNull().default(24),
  attendanceMode: text('attendance_mode').notNull().default('manual'), // manual | qr | both
  qrSecret: text('qr_secret').notNull(),
  status: text('status').notNull().default('planned'), // planned | ongoing | finished | cancelled
  cancelReason: text('cancel_reason'),
  createdBy: uuid('created_by').references(() => users.id),
}, t => [
  index().on(t.tenantId, t.startsAt),
  index().on(t.tenantId, t.meetupId),
  index().on(t.tenantId, t.taskId),
])

export const meetupSessionRegistrations = pgTable('meetup_session_registrations', {
  ...baseColumns,
  tenantId: tenantId(),
  sessionId: uuid('session_id').notNull().references(() => meetupSessions.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('registered'), // registered | waitlist | attended | missed | cancelled | excused
  registeredAt: timestamp('registered_at', { withTimezone: true }).notNull().defaultNow(),
  registeredBy: uuid('registered_by').references(() => users.id),
  waitlistPosition: integer('waitlist_position'),
  checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
  checkInMethod: text('check_in_method'), // manual | qr | auto
  checkedInBy: uuid('checked_in_by').references(() => users.id),
  cancelReason: text('cancel_reason'),
  guestsCount: integer('guests_count').notNull().default(0),
  enrollmentId: uuid('enrollment_id'), // занятие як урок курсу (docs/29 Б.3): звідки прийшов запис
  lessonId: uuid('lesson_id'),
  // Вебінар: облік перегляду (docs/18 Г-18.2) — тіки з клієнта, зачёт по `webinarMinWatchPct`
  secondsWatched: integer('seconds_watched').notNull().default(0),
  watchPct: numeric('watch_pct', { precision: 5, scale: 2 }),
  lastTickAt: timestamp('last_tick_at', { withTimezone: true }),
  // Відмітка присутності заднім числом (Г-18.1): тільки з причиною, ≤7 днів після сесії, в аудит
  markedRetroactively: boolean('marked_retroactively').notNull().default(false),
  retroactiveReason: text('retroactive_reason'),
}, t => [
  unique().on(t.sessionId, t.userId),
  index().on(t.tenantId, t.userId, t.status),
  index().on(t.tenantId, t.sessionId),
])

export const complexTests = pgTable('complex_tests', {
  ...baseColumns,
  tenantId: tenantId(),
  title: text('title').notNull(),
  parts: jsonb('parts').notNull(), // [{quizId, weight, isRequired, minScore}]
  // Порог, лимит времени и попытки — в назначении (assignments.params, docs/15 §14.3), не в контенте.
  sequential: boolean('sequential').notNull().default(true),
  showPartsResult: boolean('show_parts_result').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id),
}, t => [
  index().on(t.tenantId),
])

export const complexTestAttempts = pgTable('complex_test_attempts', {
  ...baseColumns,
  tenantId: tenantId(),
  complexTestId: uuid('complex_test_id').notNull().references(() => complexTests.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  attemptNo: integer('attempt_no').notNull().default(1),
  assignmentId: uuid('assignment_id'), // назначение, из которого взяты params
  params: jsonb('params').notNull().default(sql`'{}'::jsonb`), // копия параметров назначения на момент старта (passScore, timeLimitSec, attemptsAllowed)
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

