import {
  bigserial, index, inet, integer, jsonb, pgTable, text, timestamp, uuid,
} from 'drizzle-orm/pg-core'
import { tenantId } from './_common'

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
