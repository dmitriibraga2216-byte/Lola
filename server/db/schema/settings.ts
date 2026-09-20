import { bigint, boolean, index, integer, numeric, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { users } from './people'

/**
 * Настройки простору (docs/24): шкалы, переводы, потребление. Сами настройки и модули —
 * в `tenants.settings jsonb` (schema `tenantSettingsSchema`), роли — в `roles`.
 */

/** Шкалы (docs/24 Г-24.4, docs/02): `range` — диапазон процентов → название, `levels` — перечень уровней. */
export const scales = pgTable('scales', {
  ...baseColumns,
  tenantId: tenantId(),
  name: text('name').notNull(),
  description: text('description'),
  kind: text('kind').notNull(), // range | levels
  displayAs: text('display_as'), // label | value — только для levels
}, t => [
  unique().on(t.tenantId, t.name),
])

export const scaleLevels = pgTable('scale_levels', {
  ...baseColumns,
  tenantId: tenantId(),
  scaleId: uuid('scale_id').notNull().references(() => scales.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  value: numeric('value', { precision: 8, scale: 2 }),
  rangeFrom: numeric('range_from', { precision: 5, scale: 2 }), // только kind='range'
  rangeTo: numeric('range_to', { precision: 5, scale: 2 }),
  characteristic: text('characteristic'), // «Характеристика оцінки»
  showInReports: boolean('show_in_reports').notNull().default(true), // «Відображати у звітах»
  sortOrder: integer('sort_order').notNull().default(0),
}, t => [
  index().on(t.tenantId, t.scaleId, t.sortOrder),
])

/** Переопределения строк интерфейса тенантом (docs/24 §3.6, §7.4): отдельно от словаря, обновление системы не затирает. */
export const translations = pgTable('translations', {
  ...baseColumns,
  tenantId: tenantId(),
  locale: text('locale').notNull(), // uk | en
  key: text('key').notNull(),
  value: text('value').notNull(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
}, t => [
  unique().on(t.tenantId, t.locale, t.key),
])

/** Потребление тенанта (docs/24 §4.4.1, docs/30): собирается раз в сутки задачей `usage.collect`, строка на сбор. */
export const tenantUsage = pgTable('tenant_usage', {
  ...baseColumns,
  tenantId: tenantId(),
  collectedAt: timestamp('collected_at', { withTimezone: true }).notNull().defaultNow(),
  activeUsers: integer('active_users').notNull().default(0), // лимит считается по ним
  blockedUsers: integer('blocked_users').notNull().default(0),
  archivedUsers: integer('archived_users').notNull().default(0),
  storageBytes: bigint('storage_bytes', { mode: 'number' }).notNull().default(0),
  smsMonth: integer('sms_month').notNull().default(0), // отправлено SMS с начала месяца
  coursesCount: integer('courses_count').notNull().default(0),
  assignmentsCount: integer('assignments_count').notNull().default(0),
  attemptsMonth: integer('attempts_month').notNull().default(0),
}, t => [
  index().on(t.tenantId, t.collectedAt.desc()),
])
