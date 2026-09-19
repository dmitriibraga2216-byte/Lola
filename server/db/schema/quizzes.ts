import { sql } from 'drizzle-orm'
import {
  boolean, index, inet, integer, jsonb, numeric, pgTable, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { users } from './people'
import { courseCategories, courses } from './content'
import { enrollments } from './learning'

/**
 * Тесты (docs/12-tests-questions.md): банк вопросов, тест как состав,
 * параметры прохождения — только в назначении (docs/15 §14.3), попытка со снапшотом
 * и копией параметров.
 */

export const questionBanks = pgTable('question_banks', {
  ...baseColumns,
  tenantId: tenantId(),
  name: text('name').notNull(),
  categoryId: uuid('category_id').references(() => courseCategories.id),
  description: text('description'),
  isShared: boolean('is_shared').notNull().default(true),
}, t => [
  index().on(t.tenantId),
])

export const questions = pgTable('questions', {
  ...baseColumns,
  tenantId: tenantId(),
  bankId: uuid('bank_id').notNull().references(() => questionBanks.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().default('single'),
  // single | multiple | order | match | number | text_short | text_long | file
  stem: jsonb('stem').notNull(), // блоки: text, image
  options: jsonb('options'),
  answer: jsonb('answer'), // null для ручных типов
  explanation: jsonb('explanation'),
  hint: text('hint'),
  isCritical: boolean('is_critical').notNull().default(false),
  difficulty: integer('difficulty').notNull().default(3),
  points: numeric('points', { precision: 5, scale: 2 }).notNull().default('1'),
  partialCredit: boolean('partial_credit').notNull().default(true),
  negativeMarking: boolean('negative_marking').notNull().default(false),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  timeLimitSec: integer('time_limit_sec'),
  status: text('status').notNull().default('active'), // active | archived
  version: integer('version').notNull().default(1),
  stats: jsonb('stats').notNull().default('{}'),
}, t => [
  index().on(t.tenantId, t.bankId, t.status),
])

export const quizzes = pgTable('quizzes', {
  ...baseColumns,
  tenantId: tenantId(),
  title: text('title').notNull(),
  description: jsonb('description'),
  coverKey: text('cover_key'),
  kind: text('kind').notNull().default('quiz'), // quiz | certification
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  authorIds: uuid('author_ids').array().notNull().default(sql`'{}'::uuid[]`),
  selectionMode: text('selection_mode').notNull().default('fixed'), // fixed | random
  randomRules: jsonb('random_rules'), // [{bankId, tags?, difficulty?, count}]
  // Правил прохождения здесь нет (CLAUDE.md п. 11): попытки, порог, таймер — в assignments.params,
  // порог теста внутри плана курса — lessons.pass_score_pct.
  requiresOfflineConfirm: boolean('requires_offline_confirm').notNull().default(false),
  status: text('status').notNull().default('draft'), // draft | published | archived
  totalPoints: numeric('total_points', { precision: 7, scale: 2 }).notNull().default('0'),
  questionCount: integer('question_count').notNull().default(0),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, t => [
  index().on(t.tenantId),
])

export const quizQuestions = pgTable('quiz_questions', {
  ...baseColumns,
  tenantId: tenantId(),
  quizId: uuid('quiz_id').notNull().references(() => quizzes.id, { onDelete: 'cascade' }),
  questionId: uuid('question_id').notNull().references(() => questions.id),
  sort: integer('sort').notNull(),
  pointsOverride: numeric('points_override', { precision: 5, scale: 2 }),
  isCriticalOverride: boolean('is_critical_override'),
}, t => [
  unique().on(t.tenantId, t.quizId, t.questionId),
])

export const attempts = pgTable('attempts', {
  ...baseColumns,
  tenantId: tenantId(),
  quizId: uuid('quiz_id').notNull().references(() => quizzes.id),
  enrollmentId: uuid('enrollment_id').references(() => enrollments.id, { onDelete: 'cascade' }),
  lessonId: uuid('lesson_id'),
  assignmentId: uuid('assignment_id'), // назначение, из которого взяты params (null — умолчания тенанта)
  userId: uuid('user_id').notNull().references(() => users.id),
  attemptNo: integer('attempt_no').notNull(),
  snapshot: jsonb('snapshot').notNull(), // вопросы + эталоны на момент старта, не меняется
  params: jsonb('params').notNull(), // копия параметров назначения на момент старта, не меняется
  status: text('status').notNull().default('in_progress'),
  // in_progress | submitted | review | passed | failed | expired | annulled
  score: numeric('score', { precision: 5, scale: 2 }),
  maxScore: numeric('max_score', { precision: 7, scale: 2 }),
  passed: boolean('passed'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  deadlineAt: timestamp('deadline_at', { withTimezone: true }),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  gradedAt: timestamp('graded_at', { withTimezone: true }),
  timeSpentSec: integer('time_spent_sec').notNull().default(0),
  ip: inet('ip'),
  device: text('device'),
  annulledBy: uuid('annulled_by').references(() => users.id),
  annulReason: text('annul_reason'),
}, t => [
  index().on(t.tenantId, t.userId, t.quizId, t.attemptNo),
  index().on(t.tenantId, t.status),
])

export const attemptAnswers = pgTable('attempt_answers', {
  ...baseColumns,
  tenantId: tenantId(),
  attemptId: uuid('attempt_id').notNull().references(() => attempts.id, { onDelete: 'cascade' }),
  questionId: uuid('question_id').notNull(),
  questionVersion: integer('question_version').notNull(),
  answer: jsonb('answer'),
  isCorrect: boolean('is_correct'), // null пока не проверено вручную
  score: numeric('score', { precision: 5, scale: 2 }),
  autoGraded: boolean('auto_graded').notNull().default(false),
  reviewedBy: uuid('reviewed_by').references(() => users.id),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewComment: text('review_comment'),
  answeredAt: timestamp('answered_at', { withTimezone: true }),
}, t => [
  unique().on(t.tenantId, t.attemptId, t.questionId),
])

export const certificates = pgTable('certificates', {
  ...baseColumns,
  tenantId: tenantId(),
  userId: uuid('user_id').notNull().references(() => users.id),
  courseId: uuid('course_id').references(() => courses.id),
  enrollmentId: uuid('enrollment_id').references(() => enrollments.id),
  attemptId: uuid('attempt_id').references(() => attempts.id),
  number: text('number').notNull(), // LO-2026-000421
  score: numeric('score', { precision: 5, scale: 2 }),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  validUntil: timestamp('valid_until', { withTimezone: true }),
  pdfKey: text('pdf_key'),
  publicToken: text('public_token').notNull().unique(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: uuid('revoked_by').references(() => users.id),
  revokeReason: text('revoke_reason'),
}, t => [
  unique().on(t.tenantId, t.number),
  // Идемпотентность выдачи (docs/14 §7.3): один сертификат на запись+попытку
  unique().on(t.tenantId, t.enrollmentId, t.attemptId),
  index().on(t.tenantId, t.userId, t.issuedAt.desc()),
])

/** Последовательность номеров сертификатов на тенант и год без пропусков. */
export const certificateCounters = pgTable('certificate_counters', {
  tenantId: tenantId(),
  year: integer('year').notNull(),
  last: integer('last').notNull().default(0),
}, t => [
  unique().on(t.tenantId, t.year),
])
