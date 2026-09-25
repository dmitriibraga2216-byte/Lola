import { sql } from 'drizzle-orm'
import {
  boolean, check, foreignKey, index, integer, jsonb, numeric, pgTable, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { users } from './people'
import { automationRules } from './assignments'
import { libraryModuleVersions } from './library'

/**
 * Траектории (docs/17 §14.3, docs/02 «Программы и траектории»): маршрут из узлов.
 * Условия живут в узлах, не в рёбрах: `and`/`or` — логика, `delay`/`stop_delay` — время,
 * `branch` — «Розгалуження за результатом» (условие на исходящих рёбрах только у него),
 * `mentor` — «Призначити наставника». Программа (`programs`) остаётся линейным набором.
 */

export const trajectories = pgTable('trajectories', {
  ...baseColumns,
  tenantId: tenantId(),
  title: text('title').notNull(),
  description: text('description'),
  coverKey: text('cover_key'),
  status: text('status').notNull().default('draft'), // draft | published | archived
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  assignMode: text('assign_mode').notNull().default('manual'), // assign_mode (docs/02): manual | catalog_free | catalog_request | automation
  automationRuleId: uuid('automation_rule_id').references(() => automationRules.id, { onDelete: 'set null' }),
  stopAssignAfterFinish: boolean('stop_assign_after_finish').notNull().default(false), // «Не призначати завдання після завершення»
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id),
  updatedBy: uuid('updated_by').references(() => users.id),
}, t => [
  index().on(t.tenantId, t.status),
])

export const trajectoryNodes = pgTable('trajectory_nodes', {
  ...baseColumns,
  tenantId: tenantId(),
  trajectoryId: uuid('trajectory_id').notNull().references(() => trajectories.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), // trajectory_node_kind (docs/02)
  title: text('title'), // «Назва (підпис до блоку)» — обязательна у and/or/delay/stop_delay/branch/mentor
  contentType: text('content_type'), // content_type — для kind='task'
  contentId: uuid('content_id'),
  days: integer('days'), // delay «пропустити через N днів», stop_delay «закрити доступ через N днів»
  mentorId: uuid('mentor_id').references(() => users.id, { onDelete: 'set null' }), // mentor: явный наставник; null — керівник точки людини
  params: jsonb('params').notNull().default(sql`'{}'::jsonb`), // task: правила назначения, которое создаст узел (assignments.params по типу)
  /**
   * Узел-задание как место использования модуля библиотеки (docs/v2/31 §3.1, П-17; миграция
   * 0088): контент — материал-тело модуля (`content_type = 'resource'`), человек получает снимок
   * **этой** версии, а не последней (Р-31.2). Переключают только «Оновити до останньої версії»
   * и «Критичне виправлення» с `hotfix_auto` (§7.3, §7.4) — `libraryUsages.ts`.
   */
  libraryVersionId: uuid('library_version_id'),
  x: integer('x').notNull().default(0),
  y: integer('y').notNull().default(0),
}, t => [
  index().on(t.tenantId, t.trajectoryId),
  // Имя внешнего ключа явное: сгенерированное длиннее 63 символов (миграция 0088)
  foreignKey({ name: 'trajectory_nodes_library_version_fk', columns: [t.libraryVersionId], foreignColumns: [libraryModuleVersions.id] }).onDelete('restrict'),
  index('idx_trajectory_nodes_tenant_library').on(t.tenantId, t.libraryVersionId).where(sql`library_version_id is not null`),
  check('trajectory_nodes_library_ref_ck', sql`${t.libraryVersionId} is null or (${t.kind} = 'task' and ${t.contentType} = 'resource' and ${t.contentId} is not null)`),
])

export const trajectoryEdges = pgTable('trajectory_edges', {
  ...baseColumns,
  tenantId: tenantId(),
  trajectoryId: uuid('trajectory_id').notNull().references(() => trajectories.id, { onDelete: 'cascade' }),
  fromNodeId: uuid('from_node_id').notNull().references(() => trajectoryNodes.id, { onDelete: 'cascade' }),
  toNodeId: uuid('to_node_id').notNull().references(() => trajectoryNodes.id, { onDelete: 'cascade' }),
  condition: jsonb('condition'), // только у from.kind='branch': {op:'passed'} | {op:'failed'} | {op:'score_gte', value} | {op:'else'}
  sort: integer('sort').notNull().default(0),
}, t => [
  index().on(t.tenantId, t.trajectoryId),
  unique().on(t.fromNodeId, t.toNodeId),
])

/** Прохождение траектории человеком. */
export const trajectoryEnrollments = pgTable('trajectory_enrollments', {
  ...baseColumns,
  tenantId: tenantId(),
  trajectoryId: uuid('trajectory_id').notNull().references(() => trajectories.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('not_started'), // enrollment_status (docs/02, пять значений)
  source: text('source').notNull().default('manual'), // manual | catalog | automation
  ruleId: uuid('rule_id'),
  mentorId: uuid('mentor_id').references(() => users.id, { onDelete: 'set null' }), // назначен узлом mentor
  requestedAt: timestamp('requested_at', { withTimezone: true }), // catalog_request: заявка до решения — status not_assigned
  availableFrom: timestamp('available_from', { withTimezone: true }), // «Призначення через N днів» правила
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelReason: text('cancel_reason'),
  progressPct: numeric('progress_pct', { precision: 5, scale: 2 }).notNull().default('0'),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
}, t => [
  index().on(t.tenantId, t.userId, t.status),
  unique().on(t.trajectoryId, t.userId),
])

/** Состояние узла у человека: путь воспроизводим (docs/17 §7.4). */
export const trajectoryNodeStates = pgTable('trajectory_node_states', {
  ...baseColumns,
  tenantId: tenantId(),
  enrollmentId: uuid('enrollment_id').notNull().references(() => trajectoryEnrollments.id, { onDelete: 'cascade' }),
  nodeId: uuid('node_id').notNull().references(() => trajectoryNodes.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('locked'), // locked | available | in_progress | done | failed | skipped (docs/17 §4)
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  firesAt: timestamp('fires_at', { withTimezone: true }), // delay/stop_delay: когда сработает таймер
  score: numeric('score', { precision: 5, scale: 2 }),
  passed: boolean('passed'),
  assignmentId: uuid('assignment_id'), // task: созданное узлом назначение
  reason: text('reason'), // failed/skipped: access_closed | branch_not_taken | cancelled
  chosenEdgeId: uuid('chosen_edge_id'), // branch: какая ветка выбрана
}, t => [
  index().on(t.tenantId, t.enrollmentId),
  unique().on(t.enrollmentId, t.nodeId),
])
