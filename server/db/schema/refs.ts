import { boolean, integer, pgTable, text, unique } from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'

/**
 * Справочники (docs/08-reference-inventory.md §8.4): міста, рівні посад, мітки.
 * Посади и підрозділи уже есть (positions, org_units).
 */

export const cities = pgTable('cities', {
  ...baseColumns,
  tenantId: tenantId(),
  name: text('name').notNull(),
  isActive: boolean('is_active').notNull().default(true),
}, t => [
  unique().on(t.tenantId, t.name),
])

export const positionLevels = pgTable('position_levels', {
  ...baseColumns,
  tenantId: tenantId(),
  name: text('name').notNull(), // стажер | базовий | старший …
  sort: integer('sort').notNull().default(0), // rank: влияет на профили обучения
}, t => [
  unique().on(t.tenantId, t.name),
])

export const tags = pgTable('tags', {
  ...baseColumns,
  tenantId: tenantId(),
  name: text('name').notNull(),
  color: text('color'), // sun | teal | coral | muted
  kind: text('kind').notNull().default('any'), // any | people | content | assignment
}, t => [
  unique().on(t.tenantId, t.name),
])
