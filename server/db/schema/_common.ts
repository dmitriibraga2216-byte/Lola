import { sql } from 'drizzle-orm'
import { customType, timestamp, uuid } from 'drizzle-orm/pg-core'

/** Материализованный путь дерева (расширение ltree). */
export const ltree = customType<{ data: string }>({
  dataType() {
    return 'ltree'
  },
})

/** Общие поля каждой доменной таблицы (см. docs/02-data-model.md, преамбула). */
export const baseColumns = {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}

/** tenant_id — на каждой таблице, изолируемой RLS. */
export const tenantId = () => uuid('tenant_id').notNull()
