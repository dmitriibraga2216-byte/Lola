import { sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import {
  boolean, check, customType, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { tenants } from './tenants'
import { users } from './people'
import { courseCategories, lessons } from './content'
import {
  LIBRARY_CONTAINER_TYPES, LIBRARY_HOLDER_TYPES, LIBRARY_MODULE_STATUSES, LIBRARY_PIN_MODES,
  LIBRARY_PROPOSAL_STATUSES, LIBRARY_VERSION_STATUSES,
} from '../../../shared/enums'
import { RESOURCE_KINDS } from '../../../shared/schemas/resources'

/**
 * Библиотека переиспользуемых модулей (`docs/v2/31-module-library.md` §3, миграция
 * `0081_v2_library`, PR-25 плана `docs/v2/45`).
 *
 * **Третьей сущности контента нет** (Р-31.1). Тело модуля — обычная запись `lessons`, у
 * которой вместо раздела курса владелец — модуль (`lessons.library_module_id`, констрейнт
 * `lessons_owner_ck`: ровно одно владение). В репозитории у урока своего `body` нет — урок
 * ссылается на материал (`docs/11` §3.2), — поэтому блоки модуля живут там же, где у любого
 * урока: черновик — в рабочей редакции `resources`, версия — в неизменяемом снимке
 * `resource_versions`, на который указывает `lessons.resource_version_id` урока версии.
 * Один редактор, один санитайзер, один плеер (`31` §3.1 в редакции PR-25).
 *
 * Места использования (`library_module_usages`) — реестр «де використовується»: урок курса
 * хранит ссылку сам (`lessons.library_version_id`), узел траектории получит её в PR-26
 * (`trajectory_nodes.library_version_id`), а до того место узла живёт только здесь.
 */

/** `col in ('a','b',…)` из перечня shared/enums — CHECK строится из того же массива, третьей копии нет. */
function inList(column: unknown, values: readonly string[]) {
  return sql`${column} in (${sql.join(values.map(v => sql`${v}`), sql`, `)})`
}

const tsvector = customType<{ data: string }>({ dataType() { return 'tsvector' } })

/** pgvector, 768 измерений (`31` §3.6): тело последней версии, считает `library.embedding_refresh`. */
export const vector768 = customType<{ data: number[], driverData: string }>({
  dataType() { return 'vector(768)' },
  toDriver(v: number[]) { return `[${v.join(',')}]` },
  fromDriver(v: string) { return v.slice(1, -1).split(',').filter(Boolean).map(Number) },
})

/**
 * Карточка модуля (§3.2). `usageCount` — активные места, считается в транзакции attach/detach
 * и сверяется ночью (`library.usage_recalc`). `searchTsv` ведёт триггер (как у `resources` и
 * `knowledge_articles`, 0008): `array_to_string` не IMMUTABLE, и `generated always` из DDL
 * `31` §3.6 Postgres не принимает. `embeddingModel` — какой моделью посчитан вектор: векторы
 * разных моделей несравнимы, и смена провайдера должна находить устаревшие строки.
 */
export const libraryModules = pgTable('library_modules', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  slug: text('slug').notNull(),
  /** Перечень `resources.kind` (Р-31.5): тело модуля и есть материал. */
  contentKind: text('content_kind').notNull().default('article'),
  categoryId: uuid('category_id').references(() => courseCategories.id, { onDelete: 'set null' }),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  language: text('language').notNull().default('uk'),
  summary: text('summary'),
  estimatedMinutes: integer('estimated_minutes'),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  authorIds: uuid('author_ids').array().notNull().default(sql`'{}'::uuid[]`),
  /** Редактируемое тело: урок модуля, ссылающийся на рабочую редакцию материала. */
  draftLessonId: uuid('draft_lesson_id').references((): AnyPgColumn => lessons.id, { onDelete: 'set null' }),
  /** Последняя опубликованная версия; FK ставится после создания версий (цикл, `40` §5). */
  currentVersionId: uuid('current_version_id').references((): AnyPgColumn => libraryModuleVersions.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('draft'),
  usageCount: integer('usage_count').notNull().default(0),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  archivedBy: uuid('archived_by').references(() => users.id, { onDelete: 'set null' }),
  archiveReason: text('archive_reason'),
  searchTsv: tsvector('search_tsv'),
  embedding: vector768('embedding'),
  embeddingModel: text('embedding_model'),
  createdBy: uuid('created_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
}, t => [
  unique('library_modules_tenant_slug_uq').on(t.tenantId, t.slug),
  index('idx_library_modules_tenant').on(t.tenantId, t.status, t.updatedAt.desc()),
  index('idx_library_modules_tenant_kind').on(t.tenantId, t.contentKind),
  index('idx_library_modules_tenant_category').on(t.tenantId, t.categoryId),
  check('library_modules_status_chk', inList(t.status, LIBRARY_MODULE_STATUSES)),
  check('library_modules_content_kind_chk', inList(t.contentKind, RESOURCE_KINDS)),
  check('library_modules_archived_chk', sql`${t.status} <> 'archived' or (${t.archivedAt} is not null and ${t.archiveReason} is not null)`),
  check('library_modules_authors_chk', sql`cardinality(${t.authorIds}) between 1 and 10`),
  check('library_modules_tags_chk', sql`cardinality(${t.tags}) <= 20`),
  check('library_modules_title_chk', sql`char_length(${t.title}) between 3 and 200`),
  check('library_modules_slug_chk', sql`${t.slug} ~ '^[a-z0-9-]{3,80}$'`),
  check('library_modules_summary_chk', sql`${t.summary} is null or char_length(${t.summary}) <= 300`),
  check('library_modules_minutes_chk', sql`${t.estimatedMinutes} is null or ${t.estimatedMinutes} between 1 and 600`),
  check('library_modules_reason_chk', sql`${t.archiveReason} is null or char_length(${t.archiveReason}) between 5 and 500`),
  check('library_modules_usage_count_chk', sql`${t.usageCount} >= 0`),
])

/**
 * Опубликованная версия (§3.3). Нумерация своя, осознанная (Р-31.8): автосохранение черновика
 * версию не создаёт. `lessonId` — урок-снимок, чей `resource_version_id` указывает на
 * неизменяемое тело; `diff` — поблочная разница с предыдущей версией по `block.id`.
 */
export const libraryModuleVersions = pgTable('library_module_versions', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  libraryModuleId: uuid('library_module_id').notNull().references((): AnyPgColumn => libraryModules.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  lessonId: uuid('lesson_id').notNull().references((): AnyPgColumn => lessons.id, { onDelete: 'restrict' }),
  title: text('title').notNull(),
  contentKind: text('content_kind').notNull(),
  estimatedMinutes: integer('estimated_minutes'),
  changelog: text('changelog').notNull(),
  diff: jsonb('diff').notNull().default(sql`'{}'::jsonb`),
  isHotfix: boolean('is_hotfix').notNull().default(false),
  mediaIds: uuid('media_ids').array().notNull().default(sql`'{}'::uuid[]`),
  status: text('status').notNull().default('published'),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  publishedBy: uuid('published_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
}, t => [
  unique('library_module_versions_tenant_module_version_uq').on(t.tenantId, t.libraryModuleId, t.version),
  index('idx_library_module_versions_tenant').on(t.tenantId, t.libraryModuleId, t.version.desc()),
  index('idx_library_module_versions_lesson').on(t.tenantId, t.lessonId),
  check('library_module_versions_version_chk', sql`${t.version} >= 1`),
  check('library_module_versions_status_chk', inList(t.status, LIBRARY_VERSION_STATUSES)),
  check('library_module_versions_changelog_chk', sql`char_length(${t.changelog}) between 5 and 500`),
])

/**
 * Место использования (§3.4): кто держит ссылку, на какой версии, в каком контейнере.
 * `holderId`/`containerId` — мягкие ссылки (решение `44` В-11): цель бывает узлом графа
 * без строки урока, поэтому рядом лежат снимки названий `containerTitle` и `holderTitle` —
 * строка переживает удаление цели. Строка не удаляется никогда: `detachedAt` конечен (§4).
 */
export const libraryModuleUsages = pgTable('library_module_usages', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  libraryModuleId: uuid('library_module_id').notNull().references(() => libraryModules.id, { onDelete: 'restrict' }),
  versionId: uuid('version_id').notNull().references(() => libraryModuleVersions.id, { onDelete: 'restrict' }),
  holderType: text('holder_type').notNull(),
  holderId: uuid('holder_id').notNull(),
  holderTitle: text('holder_title'),
  containerType: text('container_type').notNull(),
  containerId: uuid('container_id').notNull(),
  containerTitle: text('container_title').notNull(),
  pinMode: text('pin_mode').notNull().default('hotfix_auto'),
  isStale: boolean('is_stale').notNull().default(false),
  latestVersionSeen: integer('latest_version_seen'),
  attachedBy: uuid('attached_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  attachedAt: timestamp('attached_at', { withTimezone: true }).notNull().defaultNow(),
  detachedAt: timestamp('detached_at', { withTimezone: true }),
}, t => [
  index('idx_library_module_usages_tenant').on(t.tenantId, t.libraryModuleId).where(sql`detached_at is null`),
  index('idx_library_module_usages_container').on(t.tenantId, t.containerType, t.containerId),
  index('idx_library_module_usages_module_all').on(t.tenantId, t.libraryModuleId, t.attachedAt.desc()),
  index('idx_library_module_usages_stale').on(t.tenantId, t.isStale).where(sql`detached_at is null and is_stale`),
  uniqueIndex('idx_library_module_usages_holder').on(t.tenantId, t.holderType, t.holderId).where(sql`detached_at is null`),
  check('library_module_usages_holder_type_chk', inList(t.holderType, LIBRARY_HOLDER_TYPES)),
  check('library_module_usages_container_type_chk', inList(t.containerType, LIBRARY_CONTAINER_TYPES)),
  check('library_module_usages_pin_mode_chk', inList(t.pinMode, LIBRARY_PIN_MODES)),
  check('library_module_usages_holder_container_chk', sql`(${t.holderType} = 'trajectory_node') = (${t.containerType} = 'trajectory')`),
])

/**
 * Предложение урока в библиотеку (§3.5). Носитель `library.use` без `library.publish` кладёт
 * не модуль, а предложение; модуль появляется только при `accepted` (Р-31.6, критерий 5).
 */
export const libraryModuleProposals = pgTable('library_module_proposals', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  sourceLessonId: uuid('source_lesson_id').notNull().references(() => lessons.id, { onDelete: 'cascade' }),
  sourceContainerType: text('source_container_type').notNull(),
  sourceContainerId: uuid('source_container_id').notNull(),
  proposedTitle: text('proposed_title').notNull(),
  proposedCategoryId: uuid('proposed_category_id').references(() => courseCategories.id, { onDelete: 'set null' }),
  comment: text('comment').notNull(),
  status: text('status').notNull().default('pending'),
  proposedBy: uuid('proposed_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionComment: text('decision_comment'),
  libraryModuleId: uuid('library_module_id').references(() => libraryModules.id, { onDelete: 'set null' }),
}, t => [
  index('idx_library_module_proposals_tenant').on(t.tenantId, t.status, t.createdAt.desc()),
  uniqueIndex('idx_library_module_proposals_pending').on(t.tenantId, t.sourceLessonId).where(sql`status = 'pending'`),
  check('library_module_proposals_status_chk', inList(t.status, LIBRARY_PROPOSAL_STATUSES)),
  check('library_module_proposals_container_type_chk', inList(t.sourceContainerType, LIBRARY_CONTAINER_TYPES)),
  check('library_module_proposals_rejected_chk', sql`${t.status} <> 'rejected' or ${t.decisionComment} is not null`),
  check('library_module_proposals_title_chk', sql`char_length(${t.proposedTitle}) between 3 and 200`),
  check('library_module_proposals_comment_chk', sql`char_length(${t.comment}) between 1 and 500`),
  check('library_module_proposals_decision_chk', sql`${t.decisionComment} is null or char_length(${t.decisionComment}) between 5 and 500`),
])
