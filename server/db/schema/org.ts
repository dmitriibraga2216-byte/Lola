import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { boolean, index, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { baseColumns, ltree, tenantId } from './_common'
import { tenants } from './tenants'
import { users } from './people'
import { positionLevels } from './refs'

export const orgUnits = pgTable('org_units', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  parentId: uuid('parent_id').references((): AnyPgColumn => orgUnits.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  path: ltree('path').notNull(),
}, t => [
  unique().on(t.tenantId, t.path),
])

export const locations = pgTable('locations', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  orgUnitId: uuid('org_unit_id').notNull().references(() => orgUnits.id),
  name: text('name').notNull(),
  address: text('address'),
  cityId: uuid('city_id'),
  timezone: text('timezone').notNull().default('Europe/Kyiv'),
  managerId: uuid('manager_id').references((): AnyPgColumn => users.id),
  isActive: boolean('is_active').notNull().default(true),
}, t => [
  unique().on(t.tenantId, t.name),
])

/**
 * Группа должностей (docs/v2/39 П-24.5 [решение]): необязательная группировка справочника —
 * «кухня», «зал», «адміністрація». Нужна затем, чтобы назначать курсы по умолчанию не каждой
 * должности отдельно, а группе (правило автоматизации, привязанное к группе, П-24.3).
 * Одна таблица, четыре поля, ссылка из `positions.group_id`.
 */
export const positionGroups = pgTable('position_groups', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
}, t => [
  unique('uq_position_groups_name').on(t.tenantId, t.name),
  index('idx_position_groups_tenant').on(t.tenantId, t.sortOrder),
])

export const positions = pgTable('positions', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  code: text('code'),
  levelId: uuid('level_id').references(() => positionLevels.id), // рівень посади
  // Группа должностей (П-24.5): удаление группы должность не трогает, связь просто снимается
  groupId: uuid('group_id').references(() => positionGroups.id, { onDelete: 'set null' }),
  isActive: boolean('is_active').notNull().default(true), // элемент справочника не удаляется, если используется — деактивируется
}, t => [
  unique().on(t.tenantId, t.name),
  index('idx_positions_group').on(t.tenantId, t.groupId).where(sql`group_id is not null`),
])
