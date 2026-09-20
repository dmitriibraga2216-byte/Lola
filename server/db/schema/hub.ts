import { sql } from 'drizzle-orm'
import {
  boolean, index, integer, jsonb, pgTable, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { users } from './people'

/**
 * Корпоративный хаб, R2-часть (docs/03 §3.22, §3.26): wiki с иерархией и историей правок,
 * конструктор сводных отчётов с расписанием, объявления (Spec 21). События — в `meetups` (kind=event).
 */

/**
 * Объявление (docs/02 «Корпоративный хаб», docs/21 §3.3, §14.5) — назначаемая сущность, не лента:
 * контент типа `notice` назначается через `assignments` (аудитория, срок, напоминания — там,
 * CLAUDE.md п. 11), подтверждение «Ознайомлений» — строка в `notice_acks`.
 * `starts_at/ends_at` — «Термін оголошення», период показа, а не срок подтверждения.
 */
export const notices = pgTable('notices', {
  ...baseColumns,
  tenantId: tenantId(),
  title: text('title').notNull(),
  body: jsonb('body').notNull().default('[]'),
  attachments: jsonb('attachments').notNull().default('[]'), // [{mediaId, name, bytes}]
  kind: text('kind').notNull().default('acknowledge'), // notice_kind (docs/02): acknowledge | event | notification
  startsAt: timestamp('starts_at', { withTimezone: true }),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  // docs/21 §3.3, §5.4: как показывать
  showMode: text('show_mode').notNull().default('modal'), // modal | banner | both
  priority: text('priority').notNull().default('normal'), // normal | important | critical
  blockUntilAck: boolean('block_until_ack').notNull().default(false), // нельзя работать, пока не подтвердил (docs/21 §7.4)
  ackText: text('ack_text'), // текст кнопки, по умолчанию «Ознайомився»
  status: text('status').notNull().default('draft'), // draft | published | archived; scheduled/active/expired — признаки по starts_at/ends_at (docs/32 В.4)
  publishedAt: timestamp('published_at', { withTimezone: true }),
  viewsCount: integer('views_count').notNull().default(0), // раз на человека в день
  authorId: uuid('author_id').references(() => users.id),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, t => [
  index().on(t.tenantId, t.status, t.publishedAt.desc()),
])

/** «Ознайомлений N (всього M)» — подтверждение одного человека; охват считается по аудитории назначений. */
export const noticeAcks = pgTable('notice_acks', {
  ...baseColumns,
  tenantId: tenantId(),
  noticeId: uuid('notice_id').notNull().references(() => notices.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  ackedAt: timestamp('acked_at', { withTimezone: true }).notNull().defaultNow(),
  requestContext: jsonb('request_context'), // {ip, geo, user_agent, browser, os, device} — отметка «с датой и устройством» (docs/21 §3.3 device)
}, t => [
  unique().on(t.tenantId, t.noticeId, t.userId),
])

/** «Прості оголошення» (docs/21 §14.5, docs/02): без назначения и подтверждения — просто плашка. */
export const simpleNotices = pgTable('simple_notices', {
  ...baseColumns,
  tenantId: tenantId(),
  title: text('title').notNull(),
  body: jsonb('body').notNull().default('[]'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  endsAt: timestamp('ends_at', { withTimezone: true }), // «Діє до»
  status: text('status').notNull().default('draft'), // draft | published | archived
  viewsCount: integer('views_count').notNull().default(0), // «Реакцій» в мокапе — просмотры
  authorId: uuid('author_id').references(() => users.id),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, t => [
  index().on(t.tenantId, t.status),
])

/** «Мої закладки» (docs/21 §14.1, docs/04 §4.13): закладка человека на ресурс, новость или объявление. */
export const bookmarks = pgTable('bookmarks', {
  ...baseColumns,
  tenantId: tenantId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  contentType: text('content_type').notNull(), // resource | article | news | notice (источники поиска)
  contentId: uuid('content_id').notNull(),
}, t => [
  unique().on(t.tenantId, t.userId, t.contentType, t.contentId),
])

export const wikiPages = pgTable('wiki_pages', {
  ...baseColumns,
  tenantId: tenantId(),
  parentId: uuid('parent_id'),
  title: text('title').notNull(),
  slug: text('slug').notNull(),
  body: jsonb('body').notNull().default('[]'),
  plainText: text('plain_text').notNull().default(''),
  sort: integer('sort').notNull().default(0),
  viewRoles: text('view_roles').array().notNull().default(sql`'{}'::text[]`), // пусто = наследует ветку / все
  editRoles: text('edit_roles').array().notNull().default(sql`'{}'::text[]`), // пусто = наследует ветку / wiki.edit
  status: text('status').notNull().default('published'), // draft | published | archived
  version: integer('version').notNull().default(1),
  updatedBy: uuid('updated_by').references(() => users.id),
  // Блокировка на время правки (docs/21 §5.5): 15 минут, продлевается при сохранении
  lockedBy: uuid('locked_by').references(() => users.id),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, t => [
  unique().on(t.tenantId, t.slug),
  index().on(t.tenantId, t.parentId, t.sort),
])

export const wikiRevisions = pgTable('wiki_revisions', {
  ...baseColumns,
  tenantId: tenantId(),
  pageId: uuid('page_id').notNull().references(() => wikiPages.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  title: text('title').notNull(),
  body: jsonb('body').notNull(),
  authorId: uuid('author_id').references(() => users.id),
  comment: text('comment'),
}, t => [
  index().on(t.tenantId),
  unique().on(t.pageId, t.version),
])

export const savedReports = pgTable('saved_reports', {
  ...baseColumns,
  tenantId: tenantId(),
  name: text('name').notNull(),
  entity: text('entity').notNull(), // people | enrollments | attempts
  fields: text('fields').array().notNull(),
  filters: jsonb('filters').notNull().default('{}'),
  groupBy: text('group_by'),
  schedule: jsonb('schedule'), // {every: daily|weekly, hour, weekday, channel: telegram|email, recipients: uuid[]}
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  format: text('format').notNull().default('xlsx'), // xlsx | csv (docs/22 §6)
  sort: text('sort'), // поле сортировки
  createdBy: uuid('created_by').references(() => users.id),
}, t => [
  index().on(t.tenantId),
])

/** Фоновые выгрузки (docs/22 §7.3, §13.3): > 5000 строк — задача, ссылка уведомлением, живёт 24 часа. */
export const reportExports = pgTable('report_exports', {
  ...baseColumns,
  tenantId: tenantId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  activeRoleId: uuid('active_role_id'), // роль, активная в момент запроса — область выгрузки считается по ней, а не по роли по умолчанию (docs/01 §1.9.2)
  report: text('report').notNull(), // имя отчёта или saved:<id>
  filters: jsonb('filters').notNull().default('{}'),
  format: text('format').notNull().default('xlsx'),
  status: text('status').notNull().default('queued'), // queued | running | ready | failed
  rows: integer('rows'),
  fileKey: text('file_key'),
  error: text('error'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, t => [
  index().on(t.tenantId, t.userId, t.createdAt.desc()),
])
