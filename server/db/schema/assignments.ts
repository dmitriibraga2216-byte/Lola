import { sql } from 'drizzle-orm'
import {
  boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { users } from './people'
import { competencies } from './development'

/**
 * Назначения (docs/15-assignments.md): центральная управляющая сущность —
 * кто, что, когда и по каким правилам. Три уровня автоматизации: ручное
 * назначение, профиль обучения должности, правила автоматизации.
 */

export const assignments = pgTable('assignments', {
  ...baseColumns,
  tenantId: tenantId(),
  title: text('title').notNull(),
  kind: text('kind').notNull().default('manual'), // task_type (docs/02): manual | auto | catalog | trajectory | archive
  subjectType: text('subject_type').notNull().default('course'), // content_type (docs/02): course | training_program | resource | test | complex_test | workshop | poll | assessment | check_list | meetup | webinar
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
  // «Метод призначення» (docs/02 §2.7, docs/15 §14.3): три поля эталона
  viaCatalog: boolean('via_catalog').notNull().default(false), // «Доступ через каталог навчання»
  automationRuleId: uuid('automation_rule_id').references(() => automationRules.id, { onDelete: 'set null' }), // «Автоматизація → Правило автоматизації»
  useInDevPlans: boolean('use_in_dev_plans').notNull().default(false), // «Використовувати в планах розвитку» (Г-15.3)
  // Г-15.2: что делать, когда человек перестал отвечать условию аудитории — keep | cancel_unstarted | cancel_all
  onLeaveCondition: text('on_leave_condition').notNull().default('keep'),
  // §14.6: контент изменён после назначения — баннер «N завдань було змінено. Сповістити?»
  contentChangedAt: timestamp('content_changed_at', { withTimezone: true }),
  contentChangeNotifiedAt: timestamp('content_change_notified_at', { withTimezone: true }),
}, t => [
  index().on(t.tenantId, t.status),
  index().on(t.tenantId, t.subjectId),
])

/** Компетенции назначения (Г-15.3, «Обрати компетенції» в шапке карточки): многие-ко-многим. */
export const assignmentCompetencies = pgTable('assignment_competencies', {
  tenantId: tenantId(),
  assignmentId: uuid('assignment_id').notNull().references(() => assignments.id, { onDelete: 'cascade' }),
  competencyId: uuid('competency_id').notNull().references(() => competencies.id, { onDelete: 'cascade' }),
}, t => [
  primaryKey({ columns: [t.assignmentId, t.competencyId] }),
  index().on(t.tenantId),
])

/** «Додаткові параметри для завдань» (docs/15 §14.5, docs/02): справочник произвольных полей назначения тенанта. */
export const taskParameters = pgTable('task_parameters', {
  ...baseColumns,
  tenantId: tenantId(),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('text'), // text | select | number
  options: jsonb('options').notNull().default(sql`'[]'::jsonb`), // варианты для select: string[]
  isRequired: boolean('is_required').notNull().default(false),
}, t => [
  unique().on(t.tenantId, t.name),
  index().on(t.tenantId),
])

/** Значение доп. параметра у конкретного назначения. */
export const taskParameterValues = pgTable('task_parameter_values', {
  tenantId: tenantId(),
  taskId: uuid('task_id').notNull().references(() => assignments.id, { onDelete: 'cascade' }),
  parameterId: uuid('parameter_id').notNull().references(() => taskParameters.id, { onDelete: 'cascade' }),
  value: jsonb('value'),
}, t => [
  primaryKey({ columns: [t.taskId, t.parameterId] }),
  index().on(t.tenantId),
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
}, t => [
  index().on(t.tenantId),
])

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
  onLeaveCondition: text('on_leave_condition').notNull().default('keep'), // Г-15.2: keep | cancel_unstarted | cancel_all — копируется в назначения правила
  isActive: boolean('is_active').notNull().default(true),
  runLimit: jsonb('run_limit').notNull().default(sql`'{"oncePerUser":true}'::jsonb`),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  stats: jsonb('stats').notNull().default(sql`'{}'::jsonb`),
}, t => [
  index().on(t.tenantId),
])

export const automationRuns = pgTable('automation_runs', {
  ...baseColumns,
  tenantId: tenantId(),
  ruleId: uuid('rule_id').notNull().references(() => automationRules.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  triggerPayload: jsonb('trigger_payload').notNull().default(sql`'{}'::jsonb`),
  requestContext: jsonb('request_context'), // технический контекст события (CLAUDE.md п. 14): {ip, geo, user_agent, browser, os, device}
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
  // docs/23 §3.1
  buttons: jsonb('buttons').notNull().default('[]'), // [{text, action}] для Telegram
  isMandatory: boolean('is_mandatory').notNull().default(false), // человек не может отключить
  throttle: jsonb('throttle'), // {maxPerDay, perSubject}
  escalateAfterHours: integer('escalate_after_hours'), // §6.6: без реакции → руководителю
  ignoreQuietHours: boolean('ignore_quiet_hours').notNull().default(false),
  version: integer('version').notNull().default(1),
}, t => [
  unique().on(t.tenantId, t.code, t.channel, t.locale),
])

/** История версий шаблона (docs/23 §3.1 version): отправленное ссылается на свою версию. */
export const notificationTemplateVersions = pgTable('notification_template_versions', {
  ...baseColumns,
  tenantId: tenantId(),
  templateId: uuid('template_id').notNull().references(() => notificationTemplates.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  subject: text('subject'),
  body: text('body').notNull(),
  authorId: uuid('author_id').references(() => users.id),
}, t => [
  index().on(t.tenantId),
])

/** Настройки человека (docs/23 §3.3): по каждому коду — включено и канал; обязательные не отключаются. */
export const userNotificationPrefs = pgTable('user_notification_prefs', {
  ...baseColumns,
  tenantId: tenantId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  code: text('code').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  channel: text('channel'), // null = по умолчанию
}, t => [
  unique().on(t.tenantId, t.userId, t.code),
])

export const notifications = pgTable('notifications', {
  ...baseColumns,
  tenantId: tenantId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  code: text('code').notNull(),
  channel: text('channel').notNull(),
  payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
  requestContext: jsonb('request_context'), // технический контекст события (CLAUDE.md п. 14)
  renderedText: text('rendered_text'),
  dedupKey: text('dedup_key'), // одно due_soon на курс в сутки и т.п.
  status: text('status').notNull().default('queued'), // queued | sending | sent | failed | skipped | read
  error: text('error'),
  scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  // docs/23 §3.2
  skipReason: text('skip_reason'), // quiet_hours | unsubscribed | duplicate | no_channel | blocked | throttled
  attempt: integer('attempt').notNull().default(0),
  readAt: timestamp('read_at', { withTimezone: true }), // колокольчик
  reactedAt: timestamp('reacted_at', { withTimezone: true }), // открыл ссылку
  refType: text('ref_type'),
  refId: uuid('ref_id'),
  templateVersion: integer('template_version'),
  escalatedAt: timestamp('escalated_at', { withTimezone: true }),
  urgent: boolean('urgent').notNull().default(false),
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
}, t => [
  index().on(t.tenantId),
])
