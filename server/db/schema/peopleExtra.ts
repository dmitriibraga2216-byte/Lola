import { sql } from 'drizzle-orm'
import { boolean, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { users } from './people'

/** Группы и сегменты, функциональные руководители, заметки о человеке (docs/16 §3.4–3.5, §5.2). */

export const userGroups = pgTable('user_groups', {
  ...baseColumns,
  tenantId: tenantId(),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('static'), // static | dynamic
  members: uuid('members').array().notNull().default(sql`'{}'::uuid[]`),
  filter: jsonb('filter'), // как audience.segment (docs/15 §3.2)
  isActive: boolean('is_active').notNull().default(true),
  recalcAt: timestamp('recalc_at', { withTimezone: true }),
}, t => [
  unique().on(t.tenantId, t.name),
])

export const functionalChiefs = pgTable('functional_chiefs', {
  ...baseColumns,
  tenantId: tenantId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  chiefId: uuid('chief_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().default('functional'), // line | functional
  scope: text('scope'), // по точке, подразделению, направлению — текстом
}, t => [
  index().on(t.tenantId),
  unique().on(t.userId, t.chiefId, t.kind),
])

export const userNotes = pgTable('user_notes', {
  ...baseColumns,
  tenantId: tenantId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  authorId: uuid('author_id').references(() => users.id),
  body: text('body').notNull(),
}, t => [
  index().on(t.tenantId),
])
