import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { boolean, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
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

export const positions = pgTable('positions', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  code: text('code'),
  levelId: uuid('level_id').references(() => positionLevels.id), // рівень посади
  isActive: boolean('is_active').notNull().default(true), // элемент справочника не удаляется, если используется — деактивируется
}, t => [
  unique().on(t.tenantId, t.name),
])
