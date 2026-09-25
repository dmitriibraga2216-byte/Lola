import { sql } from 'drizzle-orm'
import { check, date, index, integer, numeric, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { tenants } from './tenants'
import { users } from './people'

/**
 * Нормы отсутствий (docs/v2/38 §3.6, §7.12–7.14; блок «Кількість днів відпустки» настроек
 * компании — docs/v2/39 П-24.1, docs/24 §3.1.1). Справочная величина, а не кадровый учёт
 * (§7.12): Lola не начисляет и не списывает дни, она показывает норму и не ставит дедлайн
 * обязательного обучения на дни отсутствия.
 *
 * Строка — норма одного уровня на календарный год: компания (`scope_id is null`), точка или
 * человек. `vacation_days` и `sick_days` **раздельно nullable**: `null` — «наследую с уровня
 * выше», так точка переопределяет только больничный, а отпуск берёт у компании (§7.13).
 * Уровень компании и точки заводит PR-39 (настройки), индивидуальную корректировку с причиной
 * и факты отсутствий (`absence_records`) — PR-33.
 */
export const absenceNorms = pgTable('absence_norms', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  scopeType: text('scope_type').notNull(), // absence_norm_scope (docs/02): tenant | location | user
  // Мягкая полиморфная ссылка (точка или человек, docs/v2/44 В-11): существование и тенант
  // проверяет сервис под RLS; у компании — null
  scopeId: uuid('scope_id'),
  year: integer('year').notNull(),
  vacationDays: numeric('vacation_days', { precision: 4, scale: 1 }),
  sickDays: numeric('sick_days', { precision: 4, scale: 1 }),
  reason: text('reason'), // обязательна для уровня человека (§6.3)
  setBy: uuid('set_by').references(() => users.id, { onDelete: 'set null' }),
}, t => [
  // `nulls not distinct`: строка компании (scope_id null) на год — ровно одна
  unique('uq_absence_norms_scope_year').on(t.tenantId, t.scopeType, t.scopeId, t.year).nullsNotDistinct(),
  index('idx_absence_norms_tenant').on(t.tenantId, t.year, t.scopeType),
  check('absence_norms_scope_chk', sql`${t.scopeType} in ('tenant', 'location', 'user')`),
])

/**
 * Факты отсутствий человека (docs/v2/38 §3.6, §4, §7.13–7.14; PR-33, миграция `v2_absences`).
 * Справочная запись, а не кадровый документ (§7.12): в остаток нормы входит только `approved`,
 * дедлайн обязательного назначения и напоминания блокируют `planned` и `approved`.
 *
 * Не путать с `reviewer_absences` (docs/v2/37 §3.4): там отсутствие проверяющего с заместителем и
 * перебросом очереди, здесь — отпуск и больничный для карточки и планирования (`41` §8.3.4).
 *
 * `days_count` — календарные дни диапазона (CHECK держит его равным `date_to − date_from + 1`),
 * запись не длиннее 366 дней. Пересечение действующих записей одного человека запрещает сервис
 * под advisory-lock на человека (`409 absence_overlap`) — исключающего ограничения нет: оно
 * требует `btree_gist`, а расширение в миграции — лишнее право у роли миграций.
 */
export const absenceRecords = pgTable('absence_records', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), // absence_kind (docs/02): vacation | sick | unpaid | other
  dateFrom: date('date_from').notNull(),
  dateTo: date('date_to').notNull(),
  daysCount: numeric('days_count', { precision: 4, scale: 1 }).notNull(),
  status: text('status').notNull().default('approved'), // absence_status: planned | approved | cancelled
  source: text('source').notNull().default('manual'), // absence_source: manual | import | api
  comment: text('comment'),
  // Кто внёс: как у прочих «кто правил» — стирание человека по GDPR не упирается в запись
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
}, t => [
  index('idx_absence_records_tenant').on(t.tenantId, t.userId, t.dateFrom),
  index('idx_absence_records_tenant_range').on(t.tenantId, t.dateFrom, t.dateTo).where(sql`${t.status} in ('planned', 'approved')`),
  check('absence_records_kind_chk', sql`${t.kind} in ('vacation', 'sick', 'unpaid', 'other')`),
  check('absence_records_status_chk', sql`${t.status} in ('planned', 'approved', 'cancelled')`),
  check('absence_records_source_chk', sql`${t.source} in ('manual', 'import', 'api')`),
  check('absence_records_range_chk', sql`${t.dateTo} >= ${t.dateFrom} and ${t.dateTo} - ${t.dateFrom} < 366`),
  check('absence_records_days_chk', sql`${t.daysCount} = (${t.dateTo} - ${t.dateFrom} + 1)`),
  check('absence_records_comment_chk', sql`${t.comment} is null or char_length(${t.comment}) <= 300`),
])
