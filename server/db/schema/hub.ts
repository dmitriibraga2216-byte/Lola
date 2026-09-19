import { sql } from 'drizzle-orm'
import {
  index, integer, jsonb, pgTable, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { users } from './people'

/**
 * Корпоративный хаб, R2-часть (docs/03 §3.22, §3.26): wiki с иерархией и историей правок,
 * конструктор сводных отчётов с расписанием. Объявления живут в `news` (kind=announcement),
 * события — в `meetups` (kind=event).
 */

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
