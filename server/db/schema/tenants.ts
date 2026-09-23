import { sql } from 'drizzle-orm'
import { boolean, check, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { baseColumns } from './_common'

/** Статусы тенанта (docs/02 §2.1, docs/25 §8): suspended — вход закрыт, задачи стоят; archived — ждёт tenant.purge. */
export const TENANT_STATUSES = ['active', 'suspended', 'archived'] as const
export type TenantStatus = typeof TENANT_STATUSES[number]

/**
 * Платформенная таблица: без tenant_id и без RLS, доступ только платформенным модулям.
 * Любой `update tenants` из приложения — только с `where id = tenantId` (docs/25 §3.3).
 */
export const tenants = pgTable('tenants', {
  ...baseColumns,
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  // Собственный домен клиента (docs/25 §16.1, докс/33 D-059): резолв `01.host` — сперва по нему, потом по
  // `<slug>.<TENANT_HOST_BASE>`. Проверка владения (CNAME/сертификат) — вручную оператором, вне кода (докс/27).
  customDomain: text('custom_domain').unique(),
  locale: text('locale').notNull().default('uk'),
  timezone: text('timezone').notNull().default('Europe/Kyiv'),
  status: text('status').notNull().default('active'), // TENANT_STATUSES
  plan: text('plan').notNull().default('trial'), // trial | point | network | custom
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
  // Рекрутинг выключен, пока тенант его не включил (docs/v2/28 §3, docs/v2/44 В-14): пока флаг
  // false, кандидатов в тенанте нет ни одного, и откат users.kind сводится к выключению флага.
  candidatesEnabled: boolean('candidates_enabled').notNull().default(false),
  branding: jsonb('branding').notNull().default(sql`'{}'::jsonb`),
  settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`),
  archivedAt: timestamp('archived_at', { withTimezone: true }), // docs/25 §8: мягкое удаление, tenant.purge через 30 дней
}, t => [
  index().on(t.status), // резолв по Host и выборки воркера читают только id/slug/status
  check('tenants_status_check', sql`${t.status} in ('active', 'suspended', 'archived')`),
])
