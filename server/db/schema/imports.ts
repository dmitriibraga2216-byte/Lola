import { jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { users } from './people'

/**
 * Импорт людей (docs/06-infra.md §6.5): файл → валидация → предпросмотр →
 * применение → отчёт. Разобранные строки и построчные результаты — в jsonb.
 */
export const importJobs = pgTable('import_jobs', {
  ...baseColumns,
  tenantId: tenantId(),
  kind: text('kind').notNull().default('users'),
  fileName: text('file_name').notNull(),
  status: text('status').notNull().default('validating'), // validating | ready | applied | failed
  rows: jsonb('rows').notNull().default('[]'), // разобранные строки с результатом валидации
  stats: jsonb('stats').notNull().default('{}'), // {total, create, update, skip, errors}
  createdBy: uuid('created_by').references(() => users.id),
})
