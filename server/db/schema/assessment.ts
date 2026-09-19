import { sql } from 'drizzle-orm'
import {
  boolean, date, index, integer, jsonb, numeric, pgTable, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { users } from './people'
import { locations } from './org'
import { competencies } from './development'

/**
 * Оценка персонала и чек-листы (docs/20-assessment.md): шкалы, группы критериев,
 * анкеты, циклы 360°, задачи оценщиков с ответами, чек-листы наблюдения и их прогоны.
 */

export const ratingScales = pgTable('rating_scales', {
  ...baseColumns,
  tenantId: tenantId(),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('ordinal'), // binary | ordinal | percent | letters
  options: jsonb('options').notNull(), // [{value, label, color}]
  passThreshold: numeric('pass_threshold', { precision: 6, scale: 2 }),
  allowNa: boolean('allow_na').notNull().default(true),
}, t => [
  unique().on(t.tenantId, t.name),
])

export const criteriaGroups = pgTable('criteria_groups', {
  ...baseColumns,
  tenantId: tenantId(),
  name: text('name').notNull(),
  description: text('description'),
  sort: integer('sort').notNull().default(0),
  weight: numeric('weight', { precision: 6, scale: 2 }).notNull().default('1'),
})

export const criteria = pgTable('criteria', {
  ...baseColumns,
  tenantId: tenantId(),
  groupId: uuid('group_id').notNull().references(() => criteriaGroups.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  description: text('description'),
  scaleId: uuid('scale_id').notNull().references(() => ratingScales.id),
  weight: numeric('weight', { precision: 6, scale: 2 }).notNull().default('1'),
  isCritical: boolean('is_critical').notNull().default(false),
  requiresCommentBelow: numeric('requires_comment_below', { precision: 6, scale: 2 }),
  competencyId: uuid('competency_id').references(() => competencies.id),
  requiresPhoto: boolean('requires_photo').notNull().default(false),
  sort: integer('sort').notNull().default(0),
}, t => [
  index().on(t.tenantId, t.groupId),
])

/** Анкета — набор групп критериев (docs/20 §3.3 form_id). */
export const assessmentForms = pgTable('assessment_forms', {
  ...baseColumns,
  tenantId: tenantId(),
  title: text('title').notNull(),
  description: text('description'),
  groupIds: uuid('group_ids').array().notNull().default(sql`'{}'::uuid[]`),
  isActive: boolean('is_active').notNull().default(true),
})

export const assessmentCycles = pgTable('assessment_cycles', {
  ...baseColumns,
  tenantId: tenantId(),
  title: text('title').notNull(),
  formId: uuid('form_id').notNull().references(() => assessmentForms.id),
  periodFrom: date('period_from').notNull(),
  periodTo: date('period_to').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  subjects: jsonb('subjects').notNull(), // Audience (docs/15 §3.2)
  raterKinds: text('rater_kinds').array().notNull(), // self | manager | peer | subordinate | mentor
  peersCount: integer('peers_count'),
  peersSelection: text('peers_selection').default('auto'), // auto | by_subject | by_manager
  anonymousForSubject: boolean('anonymous_for_subject').notNull().default(true),
  minRatersToShow: integer('min_raters_to_show').notNull().default(3),
  selfFirst: boolean('self_first').notNull().default(false),
  calibration: boolean('calibration').notNull().default(false),
  status: text('status').notNull().default('draft'), // draft | active | calibration | finished | cancelled
  createdBy: uuid('created_by').references(() => users.id),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, t => [
  index().on(t.tenantId, t.status),
])

export const assessmentTasks = pgTable('assessment_tasks', {
  ...baseColumns,
  tenantId: tenantId(),
  cycleId: uuid('cycle_id').notNull().references(() => assessmentCycles.id, { onDelete: 'cascade' }),
  subjectUserId: uuid('subject_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  raterUserId: uuid('rater_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  raterKind: text('rater_kind').notNull(),
  status: text('status').notNull().default('pending'), // pending | in_progress | submitted | declined | expired
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  declineReason: text('decline_reason'),
}, t => [
  unique().on(t.cycleId, t.subjectUserId, t.raterUserId),
  index().on(t.tenantId, t.raterUserId, t.status),
  index().on(t.tenantId, t.subjectUserId),
])

export const assessmentAnswers = pgTable('assessment_answers', {
  ...baseColumns,
  tenantId: tenantId(),
  taskId: uuid('task_id').notNull().references(() => assessmentTasks.id, { onDelete: 'cascade' }),
  criterionId: uuid('criterion_id').notNull().references(() => criteria.id, { onDelete: 'cascade' }),
  value: numeric('value', { precision: 6, scale: 2 }),
  comment: text('comment'),
  isNa: boolean('is_na').notNull().default(false),
}, t => [
  unique().on(t.taskId, t.criterionId),
])

export const checklists = pgTable('checklists', {
  ...baseColumns,
  tenantId: tenantId(),
  title: text('title').notNull(),
  kind: text('kind').notNull().default('observation'), // observation | audit | mystery
  items: jsonb('items').notNull(), // [{id, group, text, scaleId, weight, isCritical, requiresPhoto, hint}]
  scoring: text('scoring').notNull().default('percent'), // percent | points | pass_fail
  passScore: numeric('pass_score', { precision: 6, scale: 2 }).notNull().default('80'),
  criticalFailRule: text('critical_fail_rule').notNull().default('any_critical_fails_all'), // | none
  whoCanRun: jsonb('who_can_run').notNull().default('{"roles":["mentor","manager","admin"]}'),
  subjectKind: text('subject_kind').notNull().default('location'), // location | user | shift
  frequency: jsonb('frequency'), // {timesPerWeek: 2}
  requireSignature: boolean('require_signature').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id),
})

export const checklistRuns = pgTable('checklist_runs', {
  ...baseColumns,
  tenantId: tenantId(),
  checklistId: uuid('checklist_id').notNull().references(() => checklists.id),
  subjectKind: text('subject_kind').notNull(),
  locationId: uuid('location_id').references(() => locations.id),
  subjectUserId: uuid('subject_user_id').references(() => users.id),
  observerId: uuid('observer_id').notNull().references(() => users.id),
  status: text('status').notNull().default('draft'), // draft | finished
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  answers: jsonb('answers').notNull().default('[]'), // [{itemId, value, comment, photoMediaIds, isNa}]
  score: numeric('score', { precision: 6, scale: 2 }),
  passed: boolean('passed'),
  criticalFailed: jsonb('critical_failed').notNull().default('[]'), // itemIds
  actionPlan: jsonb('action_plan').notNull().default('[]'), // [{id, text, responsibleId, dueAt, status}]
  signatureMediaId: uuid('signature_media_id'),
  geo: jsonb('geo'),
  device: text('device'),
}, t => [
  index().on(t.tenantId, t.checklistId, t.startedAt.desc()),
  index().on(t.tenantId, t.locationId),
  index().on(t.tenantId, t.observerId, t.status),
])
