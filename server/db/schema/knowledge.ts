import { sql } from 'drizzle-orm'
import {
  boolean, customType, date, index, integer, jsonb, numeric, pgTable, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { users } from './people'
import { courseCategories, lessons } from './content'
import { enrollments } from './learning'

const tsvector = customType<{ data: string }>({ dataType() { return 'tsvector' } })
const vector1536 = customType<{ data: number[] }>({
  dataType() { return 'vector(1536)' },
  toDriver(v: number[]) { return `[${v.join(',')}]` },
})

/**
 * База знаний (docs/03 §3.7, docs/02 §2.8): статьи из тех же блоков, что уроки;
 * FTS (ukrainian) + семантика по embedding; привязка к урокам и позициям.
 */
export const knowledgeArticles = pgTable('knowledge_articles', {
  ...baseColumns,
  tenantId: tenantId(),
  title: text('title').notNull(),
  slug: text('slug').notNull(),
  summary: text('summary'),
  body: jsonb('body').notNull().default('[]'),
  plainText: text('plain_text').notNull().default(''), // извлечённый текст для FTS/embedding
  categoryId: uuid('category_id').references(() => courseCategories.id),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  status: text('status').notNull().default('draft'), // draft | published | archived
  visibility: jsonb('visibility').notNull().default(sql`'{"scope":"tenant"}'::jsonb`), // tenant | positions | locations
  searchTsv: tsvector('search_tsv'),
  embedding: vector1536('embedding'),
  version: integer('version').notNull().default(1),
  updatedBy: uuid('updated_by').references(() => users.id),
  viewCount: integer('view_count').notNull().default(0),
  // docs/21 §3.1: обратная связь, актуальность, владелец, связи
  helpfulCount: integer('helpful_count').notNull().default(0),
  notHelpfulCount: integer('not_helpful_count').notNull().default(0),
  reviewAt: date('review_at'), // когда перечитать и подтвердить актуальность
  reviewConfirmedAt: timestamp('review_confirmed_at', { withTimezone: true }),
  ownerId: uuid('owner_id').references(() => users.id), // кто отвечает за актуальность
  relatedCourses: uuid('related_courses').array().notNull().default(sql`'{}'::uuid[]`),
  relatedArticles: uuid('related_articles').array().notNull().default(sql`'{}'::uuid[]`),
  attachments: jsonb('attachments').notNull().default('[]'), // [{mediaId, name}]
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, t => [
  unique().on(t.tenantId, t.slug),
  index().on(t.tenantId, t.status),
])

/** «Чи було корисно?» (docs/21 §5.2): один голос на человека, с комментарием. */
export const knowledgeFeedback = pgTable('knowledge_feedback', {
  ...baseColumns,
  tenantId: tenantId(),
  articleId: uuid('article_id').notNull().references(() => knowledgeArticles.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  helpful: boolean('helpful').notNull(),
  comment: text('comment'),
}, t => [
  unique().on(t.tenantId, t.articleId, t.userId),
])

/** Журнал поисковых запросов (docs/21 §9, §13.6): запросы без результата — заявки на новые статьи. */
export const searchQueries = pgTable('search_queries', {
  ...baseColumns,
  tenantId: tenantId(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  query: text('query').notNull(),
  results: integer('results').notNull().default(0),
}, t => [
  index().on(t.tenantId, t.results, t.createdAt.desc()),
])

export const knowledgeRevisions = pgTable('knowledge_revisions', {
  ...baseColumns,
  tenantId: tenantId(),
  articleId: uuid('article_id').notNull().references(() => knowledgeArticles.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  title: text('title').notNull(),
  body: jsonb('body').notNull(),
  authorId: uuid('author_id').references(() => users.id),
  comment: text('comment'),
}, t => [
  index().on(t.tenantId),
])

/** Привязка статьи к уроку («читати далі») и к позиции (подборка для роли). */
export const knowledgeLinks = pgTable('knowledge_links', {
  ...baseColumns,
  tenantId: tenantId(),
  articleId: uuid('article_id').notNull().references(() => knowledgeArticles.id, { onDelete: 'cascade' }),
  targetType: text('target_type').notNull(), // lesson | position
  targetId: uuid('target_id').notNull(),
}, t => [
  unique().on(t.tenantId, t.articleId, t.targetType, t.targetId),
])

// ── Опросы (docs/03 §3.8; docs/20 §14.5, §14.7 — Spec 20) ──────────────────

/**
 * Опрос: четыре типа вопроса (`poll_question_kind`: single | multi | free | scale), «свій варіант»,
 * режим `poll_mode` (linear | conditional — следующий вопрос зависит от ответа, граф знает только сервер).
 * «Конфіденційно» — ответы с именами видит только владелец; «Анонімне» — автор не хранится вовсе
 * (`survey_responses.user_id` null, связи с `survey_participations` нет). `is_locked` — после первого ответа.
 */
export const surveys = pgTable('surveys', {
  ...baseColumns,
  tenantId: tenantId(),
  title: text('title').notNull(),
  description: text('description'),
  kind: text('kind').notNull().default('survey'), // survey | course_feedback | poll
  // [{id, type, text, options?: [{id, text}], allowOwnOption?, allowFiles?, scaleId?, required?, next?: [{optionId?, goTo}]}]
  questions: jsonb('questions').notNull(),
  mode: text('mode').notNull().default('linear'), // poll_mode: linear | conditional
  isAnonymous: boolean('is_anonymous').notNull().default(false),
  isConfidential: boolean('is_confidential').notNull().default(false),
  showResults: boolean('show_results').notNull().default(false), // «Дозволити перегляд підсумкових результатів»
  isLocked: boolean('is_locked').notNull().default(false),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  status: text('status').notNull().default('draft'), // draft | active | closed
  opensAt: timestamp('opens_at', { withTimezone: true }),
  closesAt: timestamp('closes_at', { withTimezone: true }),
  triggerCourseId: uuid('trigger_course_id'), // course_feedback: автозапуск после курса
  createdBy: uuid('created_by').references(() => users.id),
}, t => [
  index().on(t.tenantId),
])

/** Ответ. У анонимного опроса `user_id` пуст и никакой колонки, ведущей к человеку, нет. */
export const surveyResponses = pgTable('survey_responses', {
  ...baseColumns,
  tenantId: tenantId(),
  surveyId: uuid('survey_id').notNull().references(() => surveys.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }), // null если анонимно
  enrollmentId: uuid('enrollment_id').references(() => enrollments.id, { onDelete: 'set null' }),
  answers: jsonb('answers').notNull(),
  path: jsonb('path').notNull().default('[]'), // порядок показанных вопросов (режим з умовами)
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index().on(t.tenantId, t.surveyId),
])

/**
 * Участие: «этот человек проходит/прошёл опрос» — для дедупа и черновика по ходу заполнения.
 * После отправки черновик стирается; связи с `survey_responses` нет — у анонимного опроса
 * восстановить автора ответа нельзя.
 */
export const surveyParticipations = pgTable('survey_participations', {
  ...baseColumns,
  tenantId: tenantId(),
  surveyId: uuid('survey_id').notNull().references(() => surveys.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('in_progress'), // in_progress | submitted
  draft: jsonb('draft').notNull().default('{}'), // {answers, path}
  enrollmentId: uuid('enrollment_id'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
}, t => [
  unique().on(t.tenantId, t.surveyId, t.userId),
  index().on(t.tenantId, t.userId),
])

// ── Новости (docs/03 §3.22, R1). Объявления — `notices` в hub.ts (Spec 21) ──

export const news = pgTable('news', {
  ...baseColumns,
  tenantId: tenantId(),
  title: text('title').notNull(),
  body: jsonb('body').notNull().default('[]'),
  coverKey: text('cover_key'),
  categoryId: uuid('category_id').references(() => courseCategories.id),
  isPinned: boolean('is_pinned').notNull().default(false),
  requiresAck: boolean('requires_ack').notNull().default(false), // «Обовʼязкове ознайомлення» (docs/21 §6.2); срок — только у объявления, назначением (Spec 21)
  viewsCount: integer('views_count').notNull().default(0), // «Переглядів» (docs/21 §3.2): раз на человека в день
  // docs/21 §3.2–3.3
  lead: text('lead'), // анонс ≤300
  publishAt: timestamp('publish_at', { withTimezone: true }), // отложенная публикация (news.publish_scan)
  unpublishAt: timestamp('unpublish_at', { withTimezone: true }), // снятие
  commentsEnabled: boolean('comments_enabled').notNull().default(false),
  audience: jsonb('audience'), // null = все; иначе конструктор аудитории
  status: text('status').notNull().default('draft'), // draft | published | archived
  publishedAt: timestamp('published_at', { withTimezone: true }),
  authorId: uuid('author_id').references(() => users.id),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, t => [
  index().on(t.tenantId, t.status, t.publishedAt.desc()),
])

export const newsViews = pgTable('news_views', {
  ...baseColumns,
  tenantId: tenantId(),
  newsId: uuid('news_id').notNull().references(() => news.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  viewedAt: timestamp('viewed_at', { withTimezone: true }).notNull().defaultNow(),
  ackedAt: timestamp('acked_at', { withTimezone: true }),
  secondsSpent: integer('seconds_spent').notNull().default(0), // подтверждение засчитывается после 10 с и прокрутки (Б.5)
  scrolledToEnd: boolean('scrolled_to_end').notNull().default(false),
}, t => [
  unique().on(t.tenantId, t.newsId, t.userId),
])

// ── Практикумы (docs/13) ───────────────────────────────────────────────

export const workshops = pgTable('workshops', {
  ...baseColumns,
  tenantId: tenantId(),
  title: text('title').notNull(),
  description: jsonb('description').notNull(),
  instructionMedia: uuid('instruction_media').array().notNull().default(sql`'{}'::uuid[]`),
  submissionKinds: text('submission_kinds').array().notNull().default(sql`'{text,photo}'::text[]`),
  minTextLength: integer('min_text_length'),
  maxFiles: integer('max_files').notNull().default(3),
  maxFileMb: integer('max_file_mb').notNull().default(50),
  allowCameraOnly: boolean('allow_camera_only').notNull().default(false),
  criteria: jsonb('criteria').notNull(), // [{id, text, weight, isCritical}]
  passRule: jsonb('pass_rule').notNull().default(sql`'{"type":"all_criteria"}'::jsonb`),
  reviewerRule: text('reviewer_rule').notNull().default('location_mentor'), // location_mentor | author | specific | any_mentor
  reviewerIds: uuid('reviewer_ids').array().notNull().default(sql`'{}'::uuid[]`),
  allowRework: boolean('allow_rework').notNull().default(true),
  maxReworks: integer('max_reworks').notNull().default(2),
  slaHours: integer('sla_hours').notNull().default(48),
  status: text('status').notNull().default('draft'),
  authorIds: uuid('author_ids').array().notNull().default(sql`'{}'::uuid[]`),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, t => [
  index().on(t.tenantId),
])

export const workshopSubmissions = pgTable('workshop_submissions', {
  ...baseColumns,
  tenantId: tenantId(),
  workshopId: uuid('workshop_id').notNull().references(() => workshops.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  enrollmentId: uuid('enrollment_id').references(() => enrollments.id, { onDelete: 'set null' }),
  lessonId: uuid('lesson_id').references(() => lessons.id, { onDelete: 'set null' }),
  attemptNo: integer('attempt_no').notNull().default(1),
  body: jsonb('body').notNull().default('{}'), // {text}
  files: jsonb('files').notNull().default('[]'), // [{mediaId, name, kind, bytes}]
  criteriaSnapshot: jsonb('criteria_snapshot').notNull(), // критерии на момент сдачи
  status: text('status').notNull().default('draft'),
  // draft | submitted | in_review | rework | accepted | rejected | expired | annulled
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  reviewerId: uuid('reviewer_id').references(() => users.id),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  criteriaResults: jsonb('criteria_results'), // [{criterionId, passed, comment}]
  score: numeric('score', { precision: 5, scale: 2 }),
  passed: boolean('passed'),
  reviewComment: text('review_comment'),
  reworkCount: integer('rework_count').notNull().default(0),
  mentorRating: integer('mentor_rating'), // оценка наставника учеником 1–5 после проверки (docs/22 §4.5, Б.7)
  slaDueAt: timestamp('sla_due_at', { withTimezone: true }),
  device: text('device'),
}, t => [
  index().on(t.tenantId, t.status),
  index().on(t.tenantId, t.userId, t.workshopId),
])

export const workshopComments = pgTable('workshop_comments', {
  ...baseColumns,
  tenantId: tenantId(),
  submissionId: uuid('submission_id').notNull().references(() => workshopSubmissions.id, { onDelete: 'cascade' }),
  authorId: uuid('author_id').notNull().references(() => users.id),
  body: text('body').notNull(),
  isInternal: boolean('is_internal').notNull().default(false),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, t => [
  index().on(t.tenantId),
])
