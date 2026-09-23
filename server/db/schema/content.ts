import { sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import {
  boolean, numeric, index, integer, jsonb, pgTable, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { lifecycleStages } from './lifecycle'
import { users } from './people'

/**
 * Контент (docs/02-data-model.md §2.4, docs/11-content-lessons.md):
 * курсы → версии → модули → уроки. Урок ссылается на материал/тест,
 * собственного тела не имеет.
 */

export const courseCategories = pgTable('course_categories', {
  ...baseColumns,
  tenantId: tenantId(),
  parentId: uuid('parent_id').references((): AnyPgColumn => courseCategories.id),
  name: text('name').notNull(),
  sort: integer('sort').notNull().default(0),
}, t => [
  index().on(t.tenantId),
])

/** Справочник категорий ресурсов (docs/11 §14, docs/21 §14.1, docs/30): своё дерево с порядком, не категории каталога. */
export const resourceCategories = pgTable('resource_categories', {
  ...baseColumns,
  tenantId: tenantId(),
  parentId: uuid('parent_id').references((): AnyPgColumn => resourceCategories.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
}, t => [
  index().on(t.tenantId, t.sortOrder),
])

/**
 * Материал — единица контента (docs/11 §3.1, §14): страница из блоков, файл, видео или ссылка.
 * Строка хранит рабочую (черновую) редакцию; опубликованные снимки — resource_versions (Г-11.3).
 * Правил прохождения здесь нет (CLAUDE.md п. 11) — только материал, доступ и обложки.
 */
export const resources = pgTable('resources', {
  ...baseColumns,
  tenantId: tenantId(),
  title: text('title').notNull(),
  slug: text('slug').notNull(),
  kind: text('kind').notNull().default('article'), // article | file | video | link (CHECK; scorm — R3, Г-11.6)
  summary: text('summary'),
  body: jsonb('body').notNull().default('[]'), // блоки, docs/11 §3.3
  plainText: text('plain_text').notNull().default(''), // извлечённый текст для FTS
  mediaId: uuid('media_id'), // file | video
  externalUrl: text('external_url'), // link
  categoryIds: uuid('category_ids').array().notNull().default(sql`'{}'::uuid[]`), // «Категорії» — множественный выбор из resource_categories (docs/11 §14)
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  language: text('language').notNull().default('uk'),
  estimatedMinutes: integer('estimated_minutes'),
  coverKey: text('cover_key'), // «Обкладинка ресурсу», 16:9
  cardImageKey: text('card_image_key'), // «Зображення для картки завдання», 16:9
  allowPrint: boolean('allow_print').notNull().default(true), // «Дозволити друк»; политика «Вимкнути друк у ресурсах» сильнее
  status: text('status').notNull().default('draft'), // draft | published | archived
  authorIds: uuid('author_ids').array().notNull().default(sql`'{}'::uuid[]`),
  version: integer('version').notNull().default(1), // номер текущей (последней опубликованной) версии; черновик — version + 1
  publishedVersionId: uuid('published_version_id'), // → resource_versions.id
  viewsCount: integer('views_count').notNull().default(0), // «Переглядів: N» (docs/21 §14.1)
  // Каталог навчання (docs/10 §5.2, борг «28» Spec 10 відк. (1) / docs/33 D-060): за замовчуванням
  // ресурс у каталозі не показується; коли показується — той самий словник assign_mode, що й у
  // курсів (`catalog_free` | `catalog_request`, узгоджено з docs/10 §14.1). Доступ до самого перегляду
  // ресурсу — це окремий тумблер бази знань (`canAccessResource`), тут лише видимість картки каталогу.
  isCatalogVisible: boolean('is_catalog_visible').notNull().default(false),
  assignMode: text('assign_mode').notNull().default('catalog_free'), // catalog_free | catalog_request
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, t => [
  unique().on(t.tenantId, t.slug),
  index().on(t.tenantId, t.status),
])

/** Опубликованный снимок ресурса (Г-11.3): ученик доучивается на той версии, что начал; курс и назначение ссылаются на версию. */
export const resourceVersions = pgTable('resource_versions', {
  ...baseColumns,
  tenantId: tenantId(),
  resourceId: uuid('resource_id').notNull().references(() => resources.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  title: text('title').notNull(),
  kind: text('kind').notNull(),
  body: jsonb('body').notNull().default('[]'),
  plainText: text('plain_text').notNull().default(''),
  mediaId: uuid('media_id'),
  externalUrl: text('external_url'),
  changelog: text('changelog'),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  publishedBy: uuid('published_by').references(() => users.id),
}, t => [
  unique().on(t.tenantId, t.resourceId, t.version),
])

/** Группы доступа базы знаний и каталога (docs/02, docs/21 §14.1): ресурс без групп открыт всем. */
export const accessGroups = pgTable('access_groups', {
  ...baseColumns,
  tenantId: tenantId(),
  name: text('name').notNull(),
  description: text('description'),
  appliesTo: text('applies_to').notNull().default('knowledge'), // knowledge | catalog
}, t => [
  unique().on(t.tenantId, t.name, t.appliesTo),
])

export const accessGroupMembers = pgTable('access_group_members', {
  ...baseColumns,
  tenantId: tenantId(),
  groupId: uuid('group_id').notNull().references(() => accessGroups.id, { onDelete: 'cascade' }),
  subjectType: text('subject_type').notNull(), // position | org_unit | user | role (CHECK)
  subjectId: uuid('subject_id').notNull(),
}, t => [
  unique().on(t.tenantId, t.groupId, t.subjectType, t.subjectId),
])

export const contentAccessGroups = pgTable('content_access_groups', {
  ...baseColumns,
  tenantId: tenantId(),
  contentType: text('content_type').notNull(), // content_type из docs/02
  contentId: uuid('content_id').notNull(),
  groupId: uuid('group_id').notNull().references(() => accessGroups.id, { onDelete: 'cascade' }),
}, t => [
  unique().on(t.tenantId, t.contentType, t.contentId, t.groupId),
])

/**
 * Единая лента комментариев (docs/02, docs/10 §14.2): комментарий к контенту или прохождению
 * с маршрутизацией автору матеріалу [решение Lola] — иначе жалоба на розбіжність матеріалу
 * не доходить до того, хто може її виправити.
 */
export const comments = pgTable('comments', {
  ...baseColumns,
  tenantId: tenantId(),
  authorId: uuid('author_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  body: text('body').notNull(),
  sourceType: text('source_type').notNull(), // task | course | program | knowledge | notice
  sourceId: uuid('source_id').notNull(),
  isRead: boolean('is_read').notNull().default(false),
  readBy: uuid('read_by').references(() => users.id),
  readAt: timestamp('read_at', { withTimezone: true }),
  routedTo: uuid('routed_to').references(() => users.id), // автор матеріалу / керівник / адміністратор
  replyToId: uuid('reply_to_id').references((): AnyPgColumn => comments.id, { onDelete: 'cascade' }),
}, t => [
  index().on(t.tenantId, t.sourceType, t.sourceId),
  index().on(t.tenantId, t.isRead),
])

export const courses = pgTable('courses', {
  ...baseColumns,
  tenantId: tenantId(),
  title: text('title').notNull(),
  slug: text('slug').notNull(),
  summary: text('summary'),
  coverKey: text('cover_key'),
  categoryId: uuid('category_id').references(() => courseCategories.id),
  language: text('language').notNull().default('uk'),
  status: text('status').notNull().default('draft'), // draft | published | archived
  publishedVersionId: uuid('published_version_id'),
  estimatedMinutes: integer('estimated_minutes'),
  strictOrder: boolean('strict_order').notNull().default(true),
  isCatalogVisible: boolean('is_catalog_visible').notNull().default(false),
  // Режим доступу каталогу (docs/10 §14.1, узгоджено з assign_mode траєкторій, docs/17 §14.1):
  // діє тільки коли isCatalogVisible; ручне призначення це поле не використовує.
  assignMode: text('assign_mode').notNull().default('catalog_free'), // catalog_free | catalog_request
  validityMonths: integer('validity_months'),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  // Карточка курса по эталону (docs/11 §14.1, docs/02 §2.4)
  code: text('code'), // «Код»
  iconKey: text('icon_key'), // «Іконка»
  durationDays: integer('duration_days'), // «Тривалість навчання», днів
  workload: text('workload'), // «Оцінка зайнятості»
  resultMode: text('result_mode').notNull().default('pct'), // pct | avg_score | final_test (CHECK); порог всё равно перекрывает назначение
  // docs/19 §7.3: курс закрывает разрыв — оценка уровня ставится при завершении, если есть сданный итоговый тест
  competencyId: uuid('competency_id'),
  competencyLevel: integer('competency_level'),
  createdBy: uuid('created_by').references(() => users.id),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  // Этап жизненного цикла (docs/v2/33 §3.4) — необязателен: курс без этапа работает с полным
  // набором возможностей, как обычный курс каталога базового ТЗ (`33` §7.3).
  lifecycleStageId: uuid('lifecycle_stage_id').references(() => lifecycleStages.id),
  // Запрещает смену этапа: выставляется после первого завершённого прохождения (`33` §7.4),
  // снимается оператором. Смена этапа при `true` — `409 course.stage_locked`.
  stageLocked: boolean('stage_locked').notNull().default(false),
}, t => [
  unique().on(t.tenantId, t.slug),
  index().on(t.tenantId, t.lifecycleStageId),
  // 0058 (PR-06): соединение со стороны справочника этапов, где tenant_id в условии не ведущий
  index().on(t.lifecycleStageId).where(sql`lifecycle_stage_id is not null`),
])

export const courseVersions = pgTable('course_versions', {
  ...baseColumns,
  tenantId: tenantId(),
  courseId: uuid('course_id').notNull().references(() => courses.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  status: text('status').notNull().default('draft'), // draft | published | retired
  changelog: text('changelog'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  publishedBy: uuid('published_by').references(() => users.id),
}, t => [
  unique().on(t.tenantId, t.courseId, t.version),
])

export const modules = pgTable('modules', {
  ...baseColumns,
  tenantId: tenantId(),
  courseVersionId: uuid('course_version_id').notNull().references(() => courseVersions.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  sort: integer('sort').notNull(),
}, t => [
  index().on(t.tenantId),
])

export const lessons = pgTable('lessons', {
  ...baseColumns,
  tenantId: tenantId(),
  moduleId: uuid('module_id').notNull().references(() => modules.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  sort: integer('sort').notNull(),
  itemType: text('item_type').notNull().default('resource'), // resource | quiz | workshop | survey
  itemId: uuid('item_id').notNull(),
  isRequired: boolean('is_required').notNull().default(true),
  minSeconds: integer('min_seconds'),
  videoThresholdPct: integer('video_threshold_pct').notNull().default(90),
  availableFrom: timestamp('available_from', { withTimezone: true }),
  passScorePct: numeric('pass_score_pct', { precision: 5, scale: 2 }), // «Поріг проходження, %» у теста в плане курса (docs/11 §14.1); назначение перекрывает
  resourceVersionId: uuid('resource_version_id').references(() => resourceVersions.id, { onDelete: 'set null' }), // снимок ресурса, закреплённый публикацией курса (Г-11.3)
}, t => [
  index().on(t.tenantId, t.moduleId, t.sort),
])

export const mediaAssets = pgTable('media_assets', {
  ...baseColumns,
  tenantId: tenantId(),
  key: text('key').notNull(), // t/<tenant>/<yyyy>/<mm>/<uuid>.<ext>
  originalName: text('original_name').notNull(),
  kind: text('kind').notNull(), // image | video | audio | file
  mime: text('mime').notNull(),
  bytes: integer('bytes').notNull(),
  width: integer('width'),
  height: integer('height'),
  durationSec: integer('duration_sec'),
  posterKey: text('poster_key'),
  variants: jsonb('variants').notNull().default('{}'), // {"320": key, "768": key, "1600": key}
  checksum: text('checksum'),
  status: text('status').notNull().default('uploading'), // uploading | processing | ready | failed
  error: text('error'),
  uploadedBy: uuid('uploaded_by').references(() => users.id),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, t => [
  unique().on(t.tenantId, t.key),
])
