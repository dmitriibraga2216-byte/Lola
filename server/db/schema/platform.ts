import { sql } from 'drizzle-orm'
import {
  boolean, customType, index, integer, jsonb, pgTable, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { users } from './people'

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

/** Тарифы и лимиты (docs/02 §2.1 plan; docs/03 §3.12). Платформенная таблица. */
export const plans = pgTable('plans', {
  code: text('code').primaryKey(), // trial | point | network | custom
  name: text('name').notNull(),
  maxUsers: integer('max_users'), // null = без лимита
  maxStorageGb: integer('max_storage_gb'),
  maxSmsPerMonth: integer('max_sms_per_month'),
  features: jsonb('features').notNull().default(sql`'{}'::jsonb`), // {knowledge, workshops, surveys, api, webhooks}
  priceUah: integer('price_uah'),
  sort: integer('sort').notNull().default(0),
})

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
})

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
})

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
  unique().on(t.stateHash),
])
