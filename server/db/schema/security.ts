import {
  bigint, bigserial, customType, index, inet, integer, jsonb, pgTable, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { tenants } from './tenants'
import { users } from './people'

const bytea = customType<{ data: Buffer }>({ dataType() { return 'bytea' } })

/**
 * Счётчики rate limiting (docs/01-roles.md §1.5: «счётчики — в БД, не в памяти процесса»).
 * Без tenant_id: лимиты действуют до аутентификации (телефон, IP), RLS не применяется.
 */
export const rateLimits = pgTable('rate_limits', {
  key: text('key').primaryKey(), // otp:send:+380…, otp:ip:1.2.3.4, otp:fail:+380…
  count: integer('count').notNull().default(0),
  resetAt: timestamp('reset_at', { withTimezone: true }).notNull(),
})

/** Журнал безопасности (docs/06-infra.md §6.6): входы, смены ролей, выгрузки, impersonation. */
export const securityLog = pgTable('security_log', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  tenantId: tenantId(),
  userId: uuid('user_id'),
  event: text('event').notNull(), // security_event (docs/02, docs/16 §15): login.success | login.failed | session.revoked | roles.changed | …
  severity: text('severity').notNull().default('info'), // security_severity (docs/02): info | warning | critical — «Рівень» в журнале, по нему настраивается рассылка на почту (docs/22 §13.4)
  meta: jsonb('meta').notNull().default('{}'),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  requestContext: jsonb('request_context'), // технический контекст события (CLAUDE.md п. 14, docs/02): {ip, geo, user_agent, browser, os, device}
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index().on(t.tenantId, t.createdAt.desc()),
  index().on(t.tenantId, t.userId, t.createdAt.desc()),
])

/**
 * Второй фактор входа — TOTP (docs/24 §3.4 «Двухфакторность для админов», docs/v2/39 П-24.1).
 *
 * Секрет — **только зашифрованным**, тем же механизмом, что токены интеграций
 * (`server/services/crypto.ts`: AES-256-GCM, ключ `ENCRYPTION_KEY`, nonce рядом с шифротекстом).
 * Действующий секрет и новый (ещё не подтверждённый кодом) хранятся раздельно: замена
 * устройства не снимает защиту, пока новое приложение не прислало верный код.
 * `last_used_step` — номер 30-секундного шага последнего принятого кода: тот же код повторно
 * не принимается (защита от перехвата и повтора).
 */
export const userTotp = pgTable('user_totp', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  secretEncrypted: bytea('secret_encrypted'),
  secretNonce: bytea('secret_nonce'),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  pendingSecretEncrypted: bytea('pending_secret_encrypted'),
  pendingNonce: bytea('pending_nonce'),
  pendingCreatedAt: timestamp('pending_created_at', { withTimezone: true }),
  lastUsedStep: bigint('last_used_step', { mode: 'number' }),
}, t => [
  unique('uq_user_totp_user').on(t.tenantId, t.userId),
])

/**
 * Резервные коды второго фактора (десять, одноразовые): **только хешами** argon2id — сам код
 * показывается человеку один раз при подключении или перевыпуске и больше нигде не хранится.
 * Использованный код не удаляется, а получает `used_at`: журнал безопасности ссылается на факт.
 */
export const userTotpRecoveryCodes = pgTable('user_totp_recovery_codes', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  codeHash: text('code_hash').notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
}, t => [
  index('idx_user_totp_recovery_codes_tenant').on(t.tenantId, t.userId),
])
