import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { users } from './people'

/**
 * Журналы по эталону (docs/22 §13.4, docs/16 §14; Spec 22). Записи неизменяемы, технический контекст —
 * `request_context` одинаково с остальными журналами (CLAUDE.md п. 14). Протокол смены статусов
 * заданий живёт в `enrollment_events` (docs/02) — отдельной таблицы нет.
 */

/** «Звіт звернень до завдань»: каждое открытие или скачивание задания, а не первый вход. */
export const taskAccessLog = pgTable('task_access_log', {
  ...baseColumns,
  tenantId: tenantId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  contentType: text('content_type').notNull(), // content_type (docs/02)
  contentId: uuid('content_id').notNull(),
  title: text('title'), // название на момент обращения — журнал не пересчитывается задним числом
  assignmentId: uuid('assignment_id'),
  enrollmentId: uuid('enrollment_id'),
  action: text('action').notNull().default('open'), // open | download
  requestContext: jsonb('request_context'), // {ip, geo, user_agent, browser, os, device}
}, t => [
  index().on(t.tenantId, t.createdAt.desc()),
  index().on(t.tenantId, t.contentType, t.contentId, t.createdAt.desc()),
  index().on(t.tenantId, t.userId, t.createdAt.desc()),
])

/** «Протокол конфліктів в оргструктурі»: эталон не падает на конфликте, а пишет строку и продолжает (docs/16 §7, §14). */
export const orgConflicts = pgTable('org_conflicts', {
  ...baseColumns,
  tenantId: tenantId(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), // double_unit | placement_replaced | manager_self | manager_cycle
  source: text('source').notNull().default('manual'), // manual | import
  importJobId: uuid('import_job_id'),
  details: jsonb('details').notNull().default('{}'),
  actorId: uuid('actor_id'),
  requestContext: jsonb('request_context'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: uuid('resolved_by'),
}, t => [
  index().on(t.tenantId, t.createdAt.desc()),
  index().on(t.tenantId, t.userId),
])
