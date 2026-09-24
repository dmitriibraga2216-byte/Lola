import { sql } from 'drizzle-orm'
import {
  bigint, bigserial, boolean, char, customType, date, index, integer, jsonb, pgTable, primaryKey,
  smallint, text, timestamp, unique, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { users } from './people'
import { tenants } from './tenants'

const bytea = customType<{ data: Buffer }>({ dataType() { return 'bytea' } })

/**
 * Операторы платформы (docs/03 §3.12, docs/01 §1.2 platform_admin): вне тенантов,
 * вход по e-mail+пароль. Таблица без tenant_id и без RLS.
 */
export const platformAdmins = pgTable('platform_admins', {
  ...baseColumns,
  email: text('email').notNull().unique(),
  fullName: text('full_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
})

export const platformSessions = pgTable('platform_sessions', {
  ...baseColumns,
  adminId: uuid('admin_id').notNull().references(() => platformAdmins.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
})

/**
 * Тарифы и лимиты (docs/02 §2.1 plan; docs/03 §3.12; docs/v2/35 §3.1). Платформенная таблица.
 * PK по `code` — колонки `id` у тарифа нет и не заводится (docs/v2/44 В-5): на `code` уже
 * ссылается `tenants.plan`, а второй идентификатор означал бы два способа сослаться на тариф.
 */
export const plans = pgTable('plans', {
  code: text('code').primaryKey(), // trial | point | network | custom
  name: text('name').notNull(),
  titleUk: text('title_uk'), // витрина тарифной сетки (docs/v2/35 §5.2)
  tier: smallint('tier').notNull().default(0), // 9 тиров сетки (docs/v2/35 §3.4)
  maxUsers: integer('max_users'), // ось users_active; null = без лимита
  maxStorageGb: integer('max_storage_gb'), // ось storage_bytes: лимит в ГБ, потребление в байтах (В-5)
  maxSmsPerMonth: integer('max_sms_per_month'), // ось sms_out
  // Пять новых осей тарифа (docs/v2/44 В-5): явные колонки рядом с прежними max_*.
  maxCandidates: integer('max_candidates'), // ось candidates_active
  maxAiGenerateOps: integer('max_ai_generate_ops'),
  maxAiReviewOps: integer('max_ai_review_ops'),
  maxAiInterviewOps: integer('max_ai_interview_ops'),
  maxExportRows: integer('max_export_rows'),
  aiIncluded: boolean('ai_included').notNull().default(true), // ИИ входит в план, а не продаётся подпиской (§7.7 п. 1)
  aiTermDays: integer('ai_term_days'), // собственный срок ИИ от даты подключения (§7.7 п. 2)
  addonsAllowed: text('addons_allowed').array().notNull().default(sql`'{}'`), // коды plan_addons, доступные на тарифе (§6.2)
  isActive: boolean('is_active').notNull().default(true),
  validFrom: date('valid_from').notNull().default(sql`current_date`),
  validTo: date('valid_to'),
  features: jsonb('features').notNull().default(sql`'{}'::jsonb`), // {knowledge, workshops, surveys, api, webhooks}
  // Замок модуля по тарифу (docs/24 §3.2, §4.4; докс/33 D-053): null — без обмежень (усі модулі),
  // масив — лише перелічені `ModuleCode` доступні на цьому тарифі, решта — 403 `module.plan_locked`.
  modules: text('modules').array(),
  priceUah: integer('price_uah'),
  sort: integer('sort').notNull().default(0),
})

/**
 * Цена тарифа за месяц (docs/v2/35 §3.4); за год списывается ×12 по строке с `billing_period='year'`.
 * Платформенная таблица, вне RLS. FK — на `plan_code`, а не `plan_id uuid` (docs/v2/44 В-5).
 */
export const planPrices = pgTable('plan_prices', {
  ...baseColumns,
  planCode: text('plan_code').notNull().references(() => plans.code, { onDelete: 'cascade', onUpdate: 'cascade' }),
  billingPeriod: text('billing_period').notNull(), // month | year
  currency: char('currency', { length: 3 }).notNull().default('EUR'),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(), // деньги целым числом
  validFrom: date('valid_from').notNull().default(sql`current_date`),
  validTo: date('valid_to'),
}, t => [
  unique().on(t.planCode, t.billingPeriod, t.currency, t.validFrom),
  index().on(t.planCode, t.validFrom.desc()),
])

/**
 * Каталог докупаемых опций (docs/v2/35 §3.4). Платформенная таблица, вне RLS.
 * `unit_step` — в единице своей оси: байты для `storage_bytes`, операции для ИИ-осей,
 * дни для служебной `ai_term` (у неё растёт срок ИИ, а не ось лимита — §7.7 п. 6).
 */
export const planAddons = pgTable('plan_addons', {
  code: text('code').primaryKey(), // storage_pack | ai_ops_pack | sms_pack | candidates_pack | ai_term
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  name: text('name').notNull(),
  axis: text('axis').notNull(), // LimitAxis | 'ai_term'
  unitStep: bigint('unit_step', { mode: 'number' }).notNull(),
  term: text('term').notNull(), // period | perpetual
  isPublic: boolean('is_public').notNull().default(true),
  sort: integer('sort').notNull().default(0),
})

/**
 * Докупленные опции тенанта (docs/v2/35 §3.5): `unit_step` — снимок на момент покупки, чтобы
 * пересмотр каталога не переписывал задним числом уже оплаченное. Тенантная таблица под RLS.
 */
export const tenantAddons = pgTable('tenant_addons', {
  ...baseColumns,
  tenantId: tenantId(),
  addonCode: text('addon_code').notNull().references(() => planAddons.code, { onDelete: 'restrict', onUpdate: 'cascade' }),
  qty: integer('qty').notNull(),
  unitStep: bigint('unit_step', { mode: 'number' }).notNull(),
  validFrom: date('valid_from').notNull().default(sql`current_date`),
  validUntil: date('valid_until'), // null = до отключения оператором
  source: text('source').notNull().default('purchase'), // purchase | grant | compensation
  // FK на tenant_payments заведён миграцией PR-10 (0073_v2_billing_payments) — таблица
  // `tenant_payments` определена ниже в этом же файле, forward-ссылка безопасна (drizzle
  // резолвит `references()` лениво, не в момент объявления модуля).
  paymentId: uuid('payment_id').references(() => tenantPayments.id, { onDelete: 'set null' }),
  createdBy: uuid('created_by'),
}, t => [
  index().on(t.tenantId, t.addonCode, t.validUntil),
])

/**
 * Счётчик потребления за биллинговый период (docs/v2/35 §3.5, §7.5). Реальное время: строка
 * пополняется в той же точке, где ось проверяется на лимит, — второй формулы квоты нет
 * (docs/v2/44 В-5; лимит считает только `effectiveLimits()` из `tenantLimits.ts`).
 *
 * `limitSnapshot` — снимок эффективного лимита на момент **открытия** периода (§7.3): смена
 * тарифа в середине месяца не переписывает задним числом уже потраченное; `null` = «без
 * обмежень». Моментальные оси (люди, кандидаты, хранилище, интеграции) держат в `used`
 * текущий факт и сходятся пересчётом, накопительные (ИИ, SMS, Telegram, выгрузки) — сумму
 * расхода за период.
 */
export const usageCounters = pgTable('usage_counters', {
  tenantId: tenantId(),
  axis: text('axis').notNull(), // LimitAxis (docs/v2/35 §7.1)
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  used: bigint('used', { mode: 'number' }).notNull().default(0),
  limitSnapshot: bigint('limit_snapshot', { mode: 'number' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.tenantId, t.axis, t.periodStart] }),
  index('usage_counters_axis_idx').on(t.tenantId, t.axis, t.periodEnd.desc()),
])

/**
 * Журнал расхода (docs/v2/35 §3.5, §9 «Журнал ШІ-операцій»; хранение 400 дней, задача
 * `usage.prune`). Пишется только измеряемыми операциями — шесть `ref_kind` документа;
 * моментальные оси строки расхода не создают, их счётчик сходится пересчётом (§7.1, §7.5).
 * `request_context` — сверх §3.5, по правилу CLAUDE.md п. 14 «все журналы пишут одинаково».
 */
export const usageEvents = pgTable('usage_events', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  tenantId: tenantId(),
  axis: text('axis').notNull(),
  delta: bigint('delta', { mode: 'number' }).notNull(),
  refKind: text('ref_kind').notNull(), // ai_generation | ai_review | ai_interview | sms | upload | export
  refId: uuid('ref_id'),
  actorUserId: uuid('actor_user_id'),
  meta: jsonb('meta').notNull().default(sql`'{}'::jsonb`),
  requestContext: jsonb('request_context'), // CLAUDE.md п. 14
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('usage_events_axis_idx').on(t.tenantId, t.axis, t.occurredAt.desc()),
])

/**
 * Открытое предупреждение по оси (docs/v2/35 §3.5, §7.9): состояние баннера, а не журнал.
 * Частичный уникальный индекс держит инвариант «одно открытое предупреждение на ось и
 * уровень»; `resolvedAt` закрывает запись, когда потребление вернулось ниже порога.
 */
export const limitNotices = pgTable('limit_notices', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  tenantId: tenantId(),
  axis: text('axis').notNull(),
  level: text('level').notNull(), // warn | exceeded
  valueAtRaise: bigint('value_at_raise', { mode: 'number' }).notNull(),
  limitAtRaise: bigint('limit_at_raise', { mode: 'number' }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  dismissedBy: uuid('dismissed_by'),
  dismissedUntil: timestamp('dismissed_until', { withTimezone: true }),
  raisedAt: timestamp('raised_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('limit_notices_open_uidx').on(t.tenantId, t.axis, t.level).where(sql`resolved_at is null`),
  index().on(t.tenantId, t.raisedAt.desc()),
])

/**
 * Состояние подписки тенанта и переопределение лимитов (docs/24 §4.4, docs/25 §10,
 * docs/v2/35 §3.2): в колонках лимита null — значение берётся из тарифа `plans`.
 * Одиннадцать осей (docs/v2/35 §7.1) — **явными колонками** (docs/v2/44 В-5): шесть прежних
 * под своими именами плюс пять новых; `telegram_out` колонки не получает, это мягкая ось.
 * `active_jobs` — квота задач тенанта на круг round-robin (docs/25 §5), ось вне пакета.
 */
export const tenantLimits = pgTable('tenant_limits', {
  ...baseColumns,
  tenantId: tenantId(),
  users: integer('users'), // ось users_active (считается по status = 'active', kind = 'employee')
  storageGb: integer('storage_gb'), // ось storage_bytes, лимит в ГБ
  smsPerMonth: integer('sms_per_month'), // ось sms_out
  apiPerMinute: integer('api_per_minute'), // ось api_rate_rpm
  webhooks: integer('webhooks'), // ось integrations_active: вебхуки и коннекторы
  activeJobs: integer('active_jobs'), // ось вне пакета (docs/25 §5)
  candidates: integer('candidates'), // ось candidates_active
  aiGenerateOps: integer('ai_generate_ops'),
  aiReviewOps: integer('ai_review_ops'),
  aiInterviewOps: integer('ai_interview_ops'),
  exportRows: integer('export_rows'),
  // Подписка (docs/v2/35 §3.2, §4): таймер ИИ не зависит от таймера тарифа
  billingPeriod: text('billing_period').notNull().default('month'), // month | year
  status: text('status').notNull().default('trial'), // trial | active | grace | readonly | suspended
  paidUntil: date('paid_until'),
  graceUntil: date('grace_until'),
  aiUntil: date('ai_until'),
  autorenew: boolean('autorenew').notNull().default(true),
  currency: char('currency', { length: 3 }).notNull().default('EUR'),
  aiStatus: text('ai_status').notNull().default('active'), // active | expired | off
  updatedBy: uuid('updated_by').references(() => platformAdmins.id, { onDelete: 'set null' }),
}, t => [
  index().on(t.tenantId),
  unique().on(t.tenantId),
])

/**
 * История платежей тенанта (docs/v2/35 §3.5, §9, §10): приём денег провайдером не подключён
 * (`44` §8, `HANDOFF` §6) — платёж принимает оператор платформы вручную,
 * `POST /platform/tenants/:id/payments` (PR-10). `planCode`, а не `plan_id uuid` (то же
 * исправление, что у `plan_prices` и `tenant_usage.plan_code`, В-5): у `plans` нет колонки `id`.
 * Тенантная таблица под RLS — история своего тенанта видна только `owner` (`billing.payments.view`).
 */
export const tenantPayments = pgTable('tenant_payments', {
  ...baseColumns,
  tenantId: tenantId(),
  kind: text('kind').notNull(), // subscription | addon | adjustment
  planCode: text('plan_code').references(() => plans.code, { onDelete: 'set null', onUpdate: 'cascade' }),
  addonCode: text('addon_code').references(() => planAddons.code, { onDelete: 'set null', onUpdate: 'cascade' }),
  billingPeriod: text('billing_period'), // month | year — только для kind='subscription'
  periodFrom: date('period_from'),
  periodTo: date('period_to'),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(), // деньги целым числом (§3.4)
  currency: char('currency', { length: 3 }).notNull().default('EUR'),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  status: text('status').notNull().default('pending'), // pending | paid | failed | refunded | written_off
  method: text('method'), // bank_transfer | card | manual
  invoiceNumber: text('invoice_number'),
  invoiceMediaId: uuid('invoice_media_id'),
  comment: text('comment'),
  createdBy: uuid('created_by'), // platformAdmins.id — оператор, принявший платёж вручную
}, t => [
  index().on(t.tenantId, t.createdAt.desc()),
  unique().on(t.tenantId, t.invoiceNumber),
])

/**
 * Заявка на смену тарифа (docs/v2/35 §3.5, §4, §7.6). `fromPlanCode`/`toPlanCode`, а не
 * `*_plan_id uuid` (то же исправление В-5, что у `tenant_payments.planCode` выше): `plans`
 * не имеет колонки `id`. `blockers` — снимок превышений на момент последнего пересчёта:
 * `[{axis, current, newLimit, excess}]` (§6.1).
 */
export const planChangeRequests = pgTable('plan_change_requests', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  tenantId: tenantId(),
  fromPlanCode: text('from_plan_code').references(() => plans.code, { onDelete: 'set null', onUpdate: 'cascade' }),
  toPlanCode: text('to_plan_code').notNull().references(() => plans.code, { onDelete: 'restrict', onUpdate: 'cascade' }),
  billingPeriod: text('billing_period').notNull(), // month | year
  status: text('status').notNull().default('preflight'), // preflight | blocked | scheduled | applied | cancelled
  blockers: jsonb('blockers').notNull().default(sql`'[]'::jsonb`),
  effectiveAt: date('effective_at'),
  requestedBy: uuid('requested_by'),
  decidedBy: uuid('decided_by'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
}, t => [
  index().on(t.tenantId, t.status),
])

/**
 * Журнал действий оператора платформы (docs/25 §7 п. 5, §3.1): кто, что, по какому тенанту.
 * Платформенная таблица без tenant_id и без RLS; тенант — `subject_tenant_id` (set null после purge, slug остаётся в `after`).
 */
export const platformAudit = pgTable('platform_audit', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  adminId: uuid('admin_id').references(() => platformAdmins.id, { onDelete: 'set null' }),
  adminEmail: text('admin_email').notNull(),
  action: text('action').notNull(), // tenant.suspend | tenant.resume | tenant.purge_schedule | tenant.purge_cancel | tenant.purged | tenant.limits | tenant.update | tenant.create | platform.request
  subjectTenantId: uuid('subject_tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
  entity: text('entity').notNull(),
  entityId: text('entity_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  requestContext: jsonb('request_context'), // CLAUDE.md п. 14: {ip, geo, user_agent, browser, os, device}
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index().on(t.subjectTenantId, t.createdAt.desc()),
  index().on(t.createdAt.desc()),
])

/** Секреты тенанта (docs/09 §9.4): AES-GCM, ключ из окружения, наружу — только account_label и статус. */
export const tenantSecrets = pgTable('tenant_secrets', {
  ...baseColumns,
  tenantId: tenantId(),
  provider: text('provider').notNull(), // telegram | sms | smtp | s3 | google | zoom
  key: text('key').notNull(), // константа из модуля ключей
  valueEncrypted: bytea('value_encrypted').notNull(),
  nonce: bytea('nonce').notNull(),
  accountLabel: text('account_label'),
  status: text('status').notNull().default('active'), // active | revoked | failing
  lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdBy: uuid('created_by').references(() => users.id),
}, t => [
  unique().on(t.tenantId, t.provider, t.key),
])

/** Вебхуки наружу (docs/04 §4.11, docs/09 §9.5). */
export const webhookEndpoints = pgTable('webhook_endpoints', {
  ...baseColumns,
  tenantId: tenantId(),
  url: text('url').notNull(),
  secretEncrypted: bytea('secret_encrypted').notNull(),
  nonce: bytea('nonce').notNull(),
  events: text('events').array().notNull(),
  isActive: boolean('is_active').notNull().default(true),
  description: text('description'),
  createdBy: uuid('created_by').references(() => users.id),
}, t => [
  index().on(t.tenantId),
])

export const webhookDeliveries = pgTable('webhook_deliveries', {
  ...baseColumns,
  tenantId: tenantId(),
  endpointId: uuid('endpoint_id').notNull().references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
  event: text('event').notNull(),
  payload: jsonb('payload').notNull(),
  attempt: integer('attempt').notNull().default(0),
  status: text('status').notNull().default('pending'), // pending | delivered | failed
  statusCode: integer('status_code'),
  responseBody: text('response_body'),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
}, t => [
  index().on(t.tenantId, t.status, t.nextAttemptAt),
])

/** API-токены тенанта (docs/04 §4.1, docs/09 §9.6): показываются один раз при создании. */
export const apiTokens = pgTable('api_tokens', {
  ...baseColumns,
  tenantId: tenantId(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  prefix: text('prefix').notNull(), // первые 8 символов для опознания в UI
  scopes: text('scopes').array().notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id),
}, t => [
  index().on(t.tenantId),
])

/** Учёт SMS на тенанта (docs/06 §6.4: счётчик отправок, лимит в настройках). */
export const smsUsage = pgTable('sms_usage', {
  tenantId: tenantId(),
  month: text('month').notNull(), // YYYY-MM
  count: integer('count').notNull().default(0),
}, t => [
  unique().on(t.tenantId, t.month),
])

/** Одноразовые state для OAuth (docs/09 §9.2): в БД, а не в памяти — переживает рестарт и второй воркер. */
export const oauthStates = pgTable('oauth_states', {
  ...baseColumns,
  tenantId: tenantId(),
  provider: text('provider').notNull(),
  stateHash: text('state_hash').notNull(),
  purpose: text('purpose').notNull().default('connect'), // connect | signin
  createdBy: uuid('created_by'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
}, t => [
  index().on(t.tenantId),
  unique().on(t.stateHash),
])
