import { sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { boolean, customType, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { baseColumns, ltree, tenantId } from './_common'
import { tenants } from './tenants'
import { users, userPlacements } from './people'
import { locations, orgUnits, positions } from './org'

/**
 * Дерево подчинения (docs/v2/32-org-structure.md §3, миграция 0074_v2_org_structure).
 *
 * Три разные вещи, которые нельзя смешивать (`32` §3.1): `org_units` — «до якого шматка
 * компанії належить», `positions` — «як називається робота», `org_nodes` — «хто кому
 * підпорядкований». Первые две существуют с нулевой миграции и этим модулем не трогаются.
 *
 * Единственный вход для вопроса «кто руководитель человека X» — `resolveManager()`
 * (`server/services/orgManager.ts`, патч П-16.4). Читать `locations.manager_id` напрямую
 * запрещено: проверка 8 в `scripts/v2-crosschecks.sh`.
 */

/** `uuid[]` — цепочка руководителей снизу вверх; Drizzle своего типа для массива uuid не даёт. */
const uuidArray = customType<{ data: string[], driverData: string }>({
  dataType() {
    return 'uuid[]'
  },
  fromDriver(value) {
    return Array.isArray(value) ? value as unknown as string[] : []
  },
})

/** Узел дерева: штатная точка (`position`) либо именная (`employee`), `32` §3.2. */
export const orgNodes = pgTable('org_nodes', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  parentId: uuid('parent_id').references((): AnyPgColumn => orgNodes.id, { onDelete: 'restrict' }),
  path: ltree('path').notNull(),
  depth: integer('depth').notNull().default(1), // = nlevel(path), держит триггер org_nodes_guard
  sort: integer('sort').notNull().default(0), // порядок среди сиблингов
  type: text('type').notNull().default('position'), // ORG_NODE_TYPES
  title: text('title').notNull(),
  externalKey: text('external_key'), // ключ идемпотентности импорта (PR-31)
  note: text('note'), // в витрине не видна
  positionId: uuid('position_id').references(() => positions.id, { onDelete: 'restrict' }),
  orgUnitId: uuid('org_unit_id').references(() => orgUnits.id, { onDelete: 'restrict' }),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'restrict' }),
  holderUserId: uuid('holder_user_id').references(() => users.id, { onDelete: 'set null' }), // кэш держателя именного узла
  headcountPlanned: integer('headcount_planned').notNull().default(1),
  isManagerPoint: boolean('is_manager_point').notNull().default(false), // даёт ли узел руководителя ветке ниже
  state: text('state').notNull().default('vacant'), // ORG_NODE_STATES
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, t => [
  unique().on(t.tenantId, t.path),
  unique().on(t.tenantId, t.externalKey),
  index('idx_org_nodes_parent').on(t.tenantId, t.parentId, t.sort),
])

/** Кто занимает узел — источник истины по держателям (`32` §3.3). История не удаляется. */
export const orgNodeAssignments = pgTable('org_node_assignments', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  nodeId: uuid('node_id').notNull().references(() => orgNodes.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  placementId: uuid('placement_id').references(() => userPlacements.id, { onDelete: 'set null' }),
  isPrimary: boolean('is_primary').notNull().default(true), // основная точка подчинения; ровно одна активная на человека
  roleInNode: text('role_in_node').notNull().default('holder'), // ORG_ASSIGNMENT_ROLES
  startedAt: date('started_at').notNull().default(sql`current_date`),
  endedAt: date('ended_at'),
  endedReason: text('ended_reason'), // ORG_ASSIGNMENT_END_REASONS
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
}, t => [
  index('idx_org_node_assignments_tenant').on(t.tenantId, t.userId),
])

/**
 * Проекция «человек → руководитель». Пишет только `rebuildManagerMap()`; вопрос
 * «кто руководитель X» задаётся функции `resolveManager()`, а не этой таблице —
 * иначе источников истины снова станет два (`32` §7.8, П-16.4).
 */
export const orgManagerMap = pgTable('org_manager_map', {
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  managerUserId: uuid('manager_user_id').references(() => users.id, { onDelete: 'set null' }),
  source: text('source').notNull().default('none'), // ORG_MANAGER_SOURCES
  nodeId: uuid('node_id').references(() => orgNodes.id, { onDelete: 'set null' }),
  chain: uuidArray('chain').notNull().default(sql`'{}'`),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ name: 'org_manager_map_pkey', columns: [t.tenantId, t.userId] }),
  index('idx_org_manager_map_manager').on(t.tenantId, t.managerUserId),
])

/**
 * Снимок дерева. Таблица заведена здесь, снимок «руками» и перед массовым перемещением
 * работает; **импорт, откат и сравнение снимков — PR-31** (`docs/v2/45-plan.md`).
 */
export const orgStructureSnapshots = pgTable('org_structure_snapshots', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  kind: text('kind').notNull().default('manual'), // ORG_SNAPSHOT_KINDS
  tree: jsonb('tree').notNull(), // узлы и активные держатели на момент снимка
  nodeCount: integer('node_count').notNull().default(0),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
}, t => [
  index('idx_org_structure_snapshots_tenant').on(t.tenantId, t.createdAt.desc()),
])
