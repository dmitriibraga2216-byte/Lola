import { sql } from 'drizzle-orm'
import {
  boolean, index, integer, jsonb, numeric, pgTable, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { users } from './people'
import { automationRules } from './assignments'

/**
 * Программы и траектории (docs/17): одна сущность с режимами linear (программа)
 * и graph (траектория). Узлы — Start/элементы/Finish, рёбра — переходы с условиями.
 */

export const programs = pgTable('programs', {
  ...baseColumns,
  tenantId: tenantId(),
  title: text('title').notNull(),
  description: text('description'),
  mode: text('mode').notNull().default('linear'), // linear | graph
  coverKey: text('cover_key'),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  status: text('status').notNull().default('draft'), // draft | published | archived
  assignmentMode: text('assignment_mode').array().notNull().default(sql`'{manual}'::text[]`), // manual | catalog_free | catalog_request | automation
  automationRuleId: uuid('automation_rule_id').references(() => automationRules.id, { onDelete: 'set null' }),
  noAssignAfterFinish: boolean('no_assign_after_finish').notNull().default(false),
  countPriorResults: boolean('count_prior_results').notNull().default(true), // «Зараховувати попередні результати» (§7.7)
  certificateTemplateId: uuid('certificate_template_id'),
  validityMonths: integer('validity_months'),
  dueDays: integer('due_days'), // общий срок программы от назначения
  authorIds: uuid('author_ids').array().notNull().default(sql`'{}'::uuid[]`),
  version: integer('version').notNull().default(1),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  updatedBy: uuid('updated_by').references(() => users.id),
}, t => [
  index().on(t.tenantId, t.status),
])

export const programNodes = pgTable('program_nodes', {
  ...baseColumns,
  tenantId: tenantId(),
  programId: uuid('program_id').notNull().references(() => programs.id, { onDelete: 'cascade' }),
  nodeType: text('node_type').notNull().default('item'), // start | item | condition | finish
  itemType: text('item_type'), // course | resource | quiz | workshop | survey | meetup | webinar
  itemId: uuid('item_id'),
  titleOverride: text('title_override'),
  sort: integer('sort').notNull().default(0),
  position: jsonb('position').notNull().default('{"x":0,"y":0}'),
  isRequired: boolean('is_required').notNull().default(true),
  dueDays: integer('due_days'),
  unlockAfter: uuid('unlock_after').array().notNull().default(sql`'{}'::uuid[]`),
  unlockRule: jsonb('unlock_rule').notNull().default('{"type":"all"}'), // all | any | {type:score,min}
}, t => [
  index().on(t.tenantId, t.programId, t.sort),
])

export const programEdges = pgTable('program_edges', {
  ...baseColumns,
  tenantId: tenantId(),
  programId: uuid('program_id').notNull().references(() => programs.id, { onDelete: 'cascade' }),
  fromNodeId: uuid('from_node_id').notNull().references(() => programNodes.id, { onDelete: 'cascade' }),
  toNodeId: uuid('to_node_id').notNull().references(() => programNodes.id, { onDelete: 'cascade' }),
  condition: jsonb('condition').notNull().default('{"type":"always"}'), // always | passed | failed | score_gte | position_is
  sort: integer('sort').notNull().default(0),
}, t => [
  index().on(t.tenantId),
  unique().on(t.fromNodeId, t.toNodeId),
])

export const programEnrollments = pgTable('program_enrollments', {
  ...baseColumns,
  tenantId: tenantId(),
  programId: uuid('program_id').notNull().references(() => programs.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  programVersion: integer('program_version').notNull().default(1),
  status: text('status').notNull().default('not_started'), // enrollment_status (docs/02): not_started | in_progress | done | failed; снятие — cancelled_at
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelReason: text('cancel_reason'), // причина зняття / відмови у заявці (spec-10)
  requestedAt: timestamp('requested_at', { withTimezone: true }), // заявка через каталог: status = not_assigned до решения
  currentNodeId: uuid('current_node_id'),
  nodesState: jsonb('nodes_state').notNull().default('{}'), // {nodeId: {status, at, score, enrollmentId, via}}
  progressPct: numeric('progress_pct', { precision: 5, scale: 2 }).notNull().default('0'),
  source: text('source').notNull().default('manual'), // manual | catalog | automation | assignment
  assignmentId: uuid('assignment_id'),
  ruleId: uuid('rule_id'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  dueAt: timestamp('due_at', { withTimezone: true }),
  availableFrom: timestamp('available_from', { withTimezone: true }), // «Призначення через N днів» правила — открывается сканером
  certificateId: uuid('certificate_id'),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
}, t => [
  unique().on(t.programId, t.userId, t.programVersion),
  index().on(t.tenantId, t.userId, t.status),
])
