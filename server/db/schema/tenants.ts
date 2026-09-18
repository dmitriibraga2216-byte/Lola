import { sql } from 'drizzle-orm'
import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { baseColumns } from './_common'

/** Платформенная таблица: без tenant_id и без RLS, доступ только платформенным модулям. */
export const tenants = pgTable('tenants', {
  ...baseColumns,
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  locale: text('locale').notNull().default('uk'),
  timezone: text('timezone').notNull().default('Europe/Kyiv'),
  status: text('status').notNull().default('active'), // active | suspended | archived
  plan: text('plan').notNull().default('trial'), // trial | point | network | custom
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
  branding: jsonb('branding').notNull().default(sql`'{}'::jsonb`),
  settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`),
})
