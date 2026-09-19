import { sql } from 'drizzle-orm'
import {
  boolean, index, integer, jsonb, pgTable, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { users } from './people'

/**
 * Назначения (docs/15-assignments.md): центральная управляющая сущность —
 * кто, что, когда и по каким правилам. Три уровня автоматизации: ручное
 * назначение, профиль обучения должности, правила автоматизации.
 */

export const assignments = pgTable('assignments', {
  ...baseColumns,
  tenantId: tenantId(),
  title: text('title').notNull(),
  kind: text('kind').notNull().default('manual'), // manual | auto | catalog | trajectory | profile
  subjectType: text('subject_type').notNull().default('course'), // course | quiz
  subjectId: uuid('subject_id').notNull(),
  subjectVersionId: uuid('subject_version_id'), // зафиксированная версия или null = текущая
  audience: jsonb('audience').notNull(), // {rules: [...], match: 'any'|'all'} — docs/15 §3.2
  exclude: jsonb('exclude').notNull().default(sql`'{"rules":[]}'::jsonb`),
  startsAt: timestamp('starts_at', { withTimezone: true }),
  dueMode: text('due_mode').notNull().default('relative'), // none | absolute | relative
  dueAt: timestamp('due_at', { withTimezone: true }),
  dueDays: integer('due_days').default(14),
  isMandatory: boolean('is_mandatory').notNull().default(true),
  recurrence: jsonb('recurrence'), // {everyMonths: 12}
  params: jsonb('params').notNull().default(sql`'{}'::jsonb`), // параметры прохождения, docs/15 §3.3
  reminders: jsonb('reminders').notNull().default(sql`'{}'::jsonb`), // docs/15 §3.4
  autoSync: boolean('auto_sync').notNull().default(true),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  status: text('status').notNull().default('active'), // draft | active | paused | archived
  createdBy: uuid('created_by').references(() => users.id),
  profileId: uuid('profile_id'), // если создано профилем обучения
  stats: jsonb('stats').notNull().default(sql`'{}'::jsonb`), // {assigned, started, completed, overdue}
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
}, t => [
  index().on(t.tenantId, t.status),
  index().on(t.tenantId, t.subjectId),
])

/** Профиль обучения должности (docs/15 §3.5): позиция → набор курсов со сроками. */
export const learningProfiles = pgTable('learning_profiles', {
  ...baseColumns,
  tenantId: tenantId(),
  name: text('name').notNull(),
  scope: jsonb('scope').notNull(), // {positionIds, locationIds, orgUnitIds}
  items: jsonb('items').notNull(), // [{subjectType, subjectId, dueDays, isMandatory, order}]
  appliesToExisting: boolean('applies_to_existing').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  lastAppliedAt: timestamp('last_applied_at', { withTimezone: true }),
})

/** Правила автоматизации (docs/15 §3.6): триггер → условия → действия. */
export const automationRules = pgTable('automation_rules', {
  ...baseColumns,
  tenantId: tenantId(),
  name: text('name').notNull(),
  description: text('description'),
  trigger: text('trigger').notNull(), // user.activated (вперше активовані) | user.attributes_changed (отримали атрибути) | user.created | user.placement_changed | course.completed | …
  conditions: jsonb('conditions').notNull().default(sql`'{}'::jsonb`), // {cityIds, positionIds, orgUnitIds, tags, *Invert} — «Всі, окрім» (docs/15 §3.6)
  actions: jsonb('actions').notNull().default(sql`'[]'::jsonb`), // может быть пустым: что назначать — задаёт программа, ссылающаяся на правило
  assignDelayDays: integer('assign_delay_days').notNull().default(0), // «Призначення через N днів»
  isActive: boolean('is_active').notNull().default(true),
  runLimit: jsonb('run_limit').notNull().default(sql`'{"oncePerUser":true}'::jsonb`),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  stats: jsonb('stats').notNull().default(sql`'{}'::jsonb`),
})

export const automationRuns = pgTable('automation_runs', {
  ...baseColumns,
  tenantId: tenantId(),
  ruleId: uuid('rule_id').notNull().references(() => automationRules.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  triggerPayload: jsonb('trigger_payload').notNull().default(sql`'{}'::jsonb`),
  actionsResult: jsonb('actions_result').notNull().default(sql`'[]'::jsonb`),
  status: text('status').notNull().default('ok'), // ok | skipped | failed
  error: text('error'),
}, t => [
  index().on(t.tenantId, t.ruleId, t.createdAt.desc()),
  unique().on(t.tenantId, t.ruleId, t.userId), // oncePerUser
])

// ── Уведомления (docs/02 §2.9, docs/03 §3.10) ──────────────────────────

export const notificationTemplates = pgTable('notification_templates', {
  ...baseColumns,
  tenantId: tenantId(),
  code: text('code').notNull(), // assignment_created | due_soon | overdue | attempt_passed | review_needed | …
  channel: text('channel').notNull(), // telegram | sms | email
  locale: text('locale').notNull().default('uk'),
  subject: text('subject'),
  body: text('body').notNull(), // шаблон с {{переменными}}
  isEnabled: boolean('is_enabled').notNull().default(true),
}, t => [
  unique().on(t.tenantId, t.code, t.channel, t.locale),
])

export const notifications = pgTable('notifications', {
  ...baseColumns,
  tenantId: tenantId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  code: text('code').notNull(),
  channel: text('channel').notNull(),
  payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
  renderedText: text('rendered_text'),
  dedupKey: text('dedup_key'), // одно due_soon на курс в сутки и т.п.
  status: text('status').notNull().default('queued'), // queued | sent | failed | skipped
  error: text('error'),
  scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
}, t => [
  index().on(t.tenantId, t.status, t.scheduledFor),
  index().on(t.tenantId, t.userId, t.createdAt.desc()),
  unique().on(t.tenantId, t.dedupKey),
])

/** Одноразовые токены привязки Telegram и автологина (docs/04 §4.12). */
export const telegramTokens = pgTable('telegram_tokens', {
  ...baseColumns,
  tenantId: tenantId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), // link | login
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
})
