import { sql } from 'drizzle-orm'
import { bigint, boolean, index, integer, jsonb, numeric, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { users } from './people'
import { plans } from './platform'

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

/**
 * Потребление тенанта (docs/24 §4.4.1, docs/v2/35 §3.3): суточный срез, строка на сбор задачей
 * `usage.collect`. Срез — для графиков и панели оператора; жёсткие лимиты проверяются в момент
 * операции по счётчику реального времени (`usage_counters`, docs/v2/35 §7.5), а не по нему.
 *
 * Восемь колонок пакета (PR-09): `plan_code` (а не `plan_id` — у `plans` нет колонки `id`,
 * решение docs/v2/44 В-5), `candidates_active`, `storage_by_category`, `ai_ops`, `sms_out`,
 * `telegram_out`, `integrations_active` и `axes` — расширение без миграции для нетарифной оси.
 */
export const tenantUsage = pgTable('tenant_usage', {
  ...baseColumns,
  tenantId: tenantId(),
  collectedAt: timestamp('collected_at', { withTimezone: true }).notNull().defaultNow(),
  activeUsers: integer('active_users').notNull().default(0), // ось users_active: сотрудники, kind = employee
  blockedUsers: integer('blocked_users').notNull().default(0),
  archivedUsers: integer('archived_users').notNull().default(0),
  storageBytes: bigint('storage_bytes', { mode: 'number' }).notNull().default(0),
  smsMonth: integer('sms_month').notNull().default(0), // отправлено SMS с начала календарного месяца (docs/24 §4.4.1)
  coursesCount: integer('courses_count').notNull().default(0),
  assignmentsCount: integer('assignments_count').notNull().default(0),
  attemptsMonth: integer('attempts_month').notNull().default(0),
  planCode: text('plan_code').references(() => plans.code, { onDelete: 'set null', onUpdate: 'cascade' }),
  candidatesActive: integer('candidates_active').notNull().default(0), // ось candidates_active
  storageByCategory: jsonb('storage_by_category').notNull().default(sql`'{}'::jsonb`), // 9 ключей: 8 кодов этапов + other (docs/v2/44 В-10), наполняет storage.counter_reconcile
  aiOps: jsonb('ai_ops').notNull().default(sql`'{}'::jsonb`), // {ai_generate_ops, ai_review_ops, ai_interview_ops}
  smsOut: integer('sms_out').notNull().default(0), // ось sms_out за биллинговый период
  telegramOut: integer('telegram_out').notNull().default(0), // мягкая ось: только наблюдение
  integrationsActive: integer('integrations_active').notNull().default(0),
  axes: jsonb('axes').notNull().default(sql`'{}'::jsonb`), // нетарифные оси без своей колонки (docs/v2/35 §3.3)
}, t => [
  index().on(t.tenantId, t.collectedAt.desc()),
])
