import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
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
  source: text('source').notNull().default('csv'), // csv | api | hrm | ad | azure_ad | google
  fileName: text('file_name').notNull(),
  mapping: jsonb('mapping'), // {колонка файла → поле}
  options: jsonb('options').notNull().default('{}'), // {createRefs, archiveMissing, sendInvites}
  reportKey: text('report_key'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  status: text('status').notNull().default('validating'), // validating | ready | applied | failed
  rows: jsonb('rows').notNull().default('[]'), // разобранные строки с результатом валидации
  stats: jsonb('stats').notNull().default('{}'), // {total, create, update, skip, errors}
  createdBy: uuid('created_by').references(() => users.id),
})
