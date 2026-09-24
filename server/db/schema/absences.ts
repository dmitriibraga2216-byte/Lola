import { sql } from 'drizzle-orm'
import { check, index, integer, numeric, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
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
