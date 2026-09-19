import { sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import {
  boolean, numeric, index, integer, jsonb, pgTable, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
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

/** Материал — единица контента (статья из блоков; file/video/link — через media). */
export const resources = pgTable('resources', {
  ...baseColumns,
  tenantId: tenantId(),
  title: text('title').notNull(),
  slug: text('slug').notNull(),
  kind: text('kind').notNull().default('article'), // article | file | video | link
  summary: text('summary'),
  body: jsonb('body').notNull().default('[]'), // блоки, docs/11 §3.3
  plainText: text('plain_text').notNull().default(''), // извлечённый текст для FTS
  mediaId: uuid('media_id'),
  externalUrl: text('external_url'),
  categoryId: uuid('category_id').references(() => courseCategories.id),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  language: text('language').notNull().default('uk'),
  estimatedMinutes: integer('estimated_minutes'),
  coverKey: text('cover_key'),
  status: text('status').notNull().default('draft'), // draft | published | archived
  authorIds: uuid('author_ids').array().notNull().default(sql`'{}'::uuid[]`),
  version: integer('version').notNull().default(1),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, t => [
  unique().on(t.tenantId, t.slug),
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
  validityMonths: integer('validity_months'),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  // docs/19 §7.3: курс закрывает разрыв — оценка уровня ставится при завершении, если есть сданный итоговый тест
  competencyId: uuid('competency_id'),
  competencyLevel: integer('competency_level'),
  createdBy: uuid('created_by').references(() => users.id),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, t => [
  unique().on(t.tenantId, t.slug),
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
