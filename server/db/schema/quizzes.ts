import { sql } from 'drizzle-orm'
import {
  boolean, check, index, inet, integer, jsonb, numeric, pgTable, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
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
  // «Вибрати групу» (docs/12 §14.3): группа внутри теста, по ней работает «Одне питання від кожної групи»
  questionGroupId: uuid('question_group_id').references((): AnyPgColumn => questionGroups.id, { onDelete: 'set null' }),
  kind: text('kind').notNull().default('single'),
  // Коды docs/02 (эталон): single | multi | free | ordering | classification | comparison | answer_by_map
  // Lola сверх эталона: number | text_short | file | cloze (докс/33 D-015, CHECK — миграция 0053)
  stem: jsonb('stem').notNull(), // блоки: text, image
  options: jsonb('options'),
  answer: jsonb('answer'), // null для ручных типов
  explanation: jsonb('explanation'),
  hint: text('hint'),
  graderHint: text('grader_hint'), // «Підказка для перевіряючого» (docs/12 §14.6): видит наставник, не ученик
  attachFiles: boolean('attach_files').notNull().default(false), // «Дозволити прикріпляти файли до відповіді» (free)
  isCritical: boolean('is_critical').notNull().default(false),
  difficulty: integer('difficulty').notNull().default(3),
  points: numeric('points', { precision: 5, scale: 2 }).notNull().default('1'),
  // «Метод підрахунку балів» (docs/12 §14.6): formula — частка вірних елементів, all_or_nothing — всё или ничего
  scoringMethod: text('scoring_method').notNull().default('formula'),
  negativeMarking: boolean('negative_marking').notNull().default(false),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  timeLimitSec: integer('time_limit_sec'),
  status: text('status').notNull().default('active'), // active | archived
  version: integer('version').notNull().default(1),
  stats: jsonb('stats').notNull().default('{}'),
}, t => [
  index().on(t.tenantId, t.bankId, t.status),
])

/** Группа вопросов внутри теста (docs/02, docs/12 §14.3). */
export const questionGroups = pgTable('question_groups', {
  ...baseColumns,
  tenantId: tenantId(),
  quizId: uuid('quiz_id').notNull().references((): AnyPgColumn => quizzes.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
}, t => [
  index().on(t.tenantId, t.quizId),
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
  // Чистое время попытки по биениям и выброшенный простой (docs/v2/37 §3.7, PR-21). Это учёт,
  // а не правило прохождения: срок попытки — только `deadline_at` и `params.timeLimitSec`,
  // снапшот эти колонки не трогают (правило 4). Пишет только свёртка `time.rollup`.
  netSeconds: integer('net_seconds').notNull().default(0),
  discardedSeconds: integer('discarded_seconds').notNull().default(0),
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
  /**
   * Способ ввода ответа — `ANSWER_INPUT_MODES` (docs/v2/30 §3.7, решение docs/v2/44 В-12): голос —
   * не тип вопроса, а способ ответа. Ставит сервер при сохранении: вопрос-файл — `file`, иначе
   * `text`; `voice` и `video` приходят с ИИ-собеседованием (PR-28).
   */
  inputMode: text('input_mode').notNull().default('text'),
}, t => [
  unique().on(t.tenantId, t.attemptId, t.questionId),
  check('attempt_answers_input_mode_chk', sql`${t.inputMode} in ('text', 'voice', 'video', 'file')`),
])

/**
 * История результатов попытки (docs/22 §13.7, docs/04 §4.6): первый подсчёт, итог ручной проверки
 * и каждое «Перерахувати». Снимок попытки не меняется — меняется только запись результата.
 */
export const attemptResults = pgTable('attempt_results', {
  ...baseColumns,
  tenantId: tenantId(),
  attemptId: uuid('attempt_id').notNull().references(() => attempts.id, { onDelete: 'cascade' }),
  reason: text('reason').notNull(), // submit | review | recalculate
  status: text('status').notNull(),
  score: numeric('score', { precision: 5, scale: 2 }),
  maxScore: numeric('max_score', { precision: 7, scale: 2 }),
  passed: boolean('passed'),
  createdBy: uuid('created_by').references(() => users.id),
  comment: text('comment'),
  // Пересчёт по жалобе (docs/v2/36 §7.8, П-12.4): карточка, из которой запущено «Перерахувати».
  // FK на content_issues — в миграции 0077 (здесь без .references(): схема жалоб импортирует attempts)
  issueId: uuid('issue_id'),
}, t => [
  index().on(t.tenantId, t.attemptId),
  index('idx_attempt_results_issue').on(t.tenantId, t.issueId).where(sql`issue_id is not null`),
])

/**
 * Запрос дополнительной попытки (docs/12 §14.5, §6.3): попытки из назначения кончились,
 * человек просит ещё одну, решение принимает наставник/руководитель. Одобренный запрос
 * добавляет одну попытку сверх лимита назначения — само назначение не меняется.
 */
export const attemptRequests = pgTable('attempt_requests', {
  ...baseColumns,
  tenantId: tenantId(),
  quizId: uuid('quiz_id').notNull().references(() => quizzes.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  enrollmentId: uuid('enrollment_id').references(() => enrollments.id, { onDelete: 'cascade' }),
  assignmentId: uuid('assignment_id'),
  reason: text('reason').notNull(),
  attemptsUsed: integer('attempts_used').notNull(),
  attemptsAllowed: integer('attempts_allowed').notNull(),
  status: text('status').notNull().default('pending'), // pending | approved | rejected
  decidedBy: uuid('decided_by').references(() => users.id),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionComment: text('decision_comment'),
  requestContext: jsonb('request_context'), // CLAUDE.md п. 14
}, t => [
  index().on(t.tenantId, t.status, t.createdAt),
  index().on(t.tenantId, t.userId, t.quizId),
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
