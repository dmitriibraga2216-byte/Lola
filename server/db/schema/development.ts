import { sql } from 'drizzle-orm'
import {
  boolean, date, index, integer, jsonb, numeric, pgTable, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { users } from './people'
import { positions } from './org'
import { positionLevels } from './refs'
import { courseCategories } from './content'

/**
 * Развитие (docs/19-development.md): библиотека компетенций с уровнями-поведением,
 * профили должностей (мост между людьми и обучением), оценки уровня, ИПР,
 * цели с настраиваемыми статусами, заявки на внешнее обучение и карьеру.
 */

export const competencies = pgTable('competencies', {
  ...baseColumns,
  tenantId: tenantId(),
  name: text('name').notNull(),
  categoryId: uuid('category_id').references(() => courseCategories.id),
  description: text('description'),
  kind: text('kind').notNull().default('hard'), // hard | soft | managerial
  levels: jsonb('levels').notNull(), // [{level, title, behavior}] — 3–5 уровней
  linkedCourses: uuid('linked_courses').array().notNull().default(sql`'{}'::uuid[]`),
  linkedKnowledge: uuid('linked_knowledge').array().notNull().default(sql`'{}'::uuid[]`),
  isActive: boolean('is_active').notNull().default(true),
}, t => [
  unique().on(t.tenantId, t.name),
])

export const positionProfiles = pgTable('position_profiles', {
  ...baseColumns,
  tenantId: tenantId(),
  positionId: uuid('position_id').notNull().references(() => positions.id),
  positionLevelId: uuid('position_level_id').references(() => positionLevels.id),
  description: text('description'),
  competencyRequirements: jsonb('competency_requirements').notNull().default('[]'), // [{competencyId, requiredLevel, isCritical}]
  mandatoryContent: jsonb('mandatory_content').notNull().default('[]'), // [{subjectType, subjectId, dueDays}]
  probationDays: integer('probation_days'),
  isActive: boolean('is_active').notNull().default(true),
  updatedBy: uuid('updated_by').references(() => users.id),
}, t => [
  unique().on(t.tenantId, t.positionId, t.positionLevelId),
])

export const competencyAssessments = pgTable('competency_assessments', {
  ...baseColumns,
  tenantId: tenantId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  competencyId: uuid('competency_id').notNull().references(() => competencies.id, { onDelete: 'cascade' }),
  level: integer('level').notNull(),
  source: text('source').notNull(), // self | manager | test | workshop | assessment | certification
  evidenceId: uuid('evidence_id'),
  assessedBy: uuid('assessed_by').references(() => users.id),
  assessedAt: timestamp('assessed_at', { withTimezone: true }).notNull().defaultNow(),
  validUntil: timestamp('valid_until', { withTimezone: true }),
  comment: text('comment'),
}, t => [
  index().on(t.tenantId, t.userId, t.competencyId, t.assessedAt.desc()),
])

export const developmentPlans = pgTable('development_plans', {
  ...baseColumns,
  tenantId: tenantId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  periodFrom: date('period_from').notNull(),
  periodTo: date('period_to').notNull(),
  ownerId: uuid('owner_id').references(() => users.id), // руководитель
  status: text('status').notNull().default('draft'), // draft | on_approval | active | review | closed
  summary: text('summary'),
  createdBy: uuid('created_by').references(() => users.id),
  approvedBy: uuid('approved_by').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  resultComment: text('result_comment'),
}, t => [
  index().on(t.tenantId, t.userId, t.status),
])

/** Настраиваемый жизненный цикл целей (docs/19 §3.6) — эталонный раздел «Налаштування статусів». */
export const goalStatuses = pgTable('goal_statuses', {
  ...baseColumns,
  tenantId: tenantId(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  color: text('color').notNull().default('muted'), // sun | teal | coral | muted — токены бренда
  sort: integer('sort').notNull().default(0),
  isInitial: boolean('is_initial').notNull().default(false),
  isFinal: boolean('is_final').notNull().default(false),
  isSuccess: boolean('is_success').notNull().default(false),
  requiresComment: boolean('requires_comment').notNull().default(false),
  allowedTransitions: text('allowed_transitions').array().notNull().default(sql`'{}'::text[]`), // коды
  whoCanSet: text('who_can_set').array().notNull().default(sql`'{development.own,development.team}'::text[]`), // скоупы
}, t => [
  unique().on(t.tenantId, t.code),
])

export const developmentGoals = pgTable('development_goals', {
  ...baseColumns,
  tenantId: tenantId(),
  planId: uuid('plan_id').references(() => developmentPlans.id, { onDelete: 'set null' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  kind: text('kind').notNull().default('learning'), // competency | learning | result | project
  competencyId: uuid('competency_id').references(() => competencies.id),
  targetLevel: integer('target_level'),
  metric: text('metric'),
  linkedContent: jsonb('linked_content').notNull().default('[]'), // [{subjectType, subjectId}]
  dueAt: date('due_at').notNull(),
  statusCode: text('status_code').notNull(),
  progressPct: integer('progress_pct').notNull().default(0),
  mentorId: uuid('mentor_id').references(() => users.id),
  result: text('result'),
  evaluatedBy: uuid('evaluated_by').references(() => users.id),
  evaluatedAt: timestamp('evaluated_at', { withTimezone: true }),
  evaluation: text('evaluation'),
  createdBy: uuid('created_by').references(() => users.id),
}, t => [
  index().on(t.tenantId, t.userId, t.statusCode),
  index().on(t.tenantId, t.dueAt),
])

export const goalStatusLog = pgTable('goal_status_log', {
  ...baseColumns,
  tenantId: tenantId(),
  goalId: uuid('goal_id').notNull().references(() => developmentGoals.id, { onDelete: 'cascade' }),
  fromStatus: text('from_status'),
  toStatus: text('to_status').notNull(),
  actorId: uuid('actor_id').references(() => users.id),
  comment: text('comment'),
})

export const goalComments = pgTable('goal_comments', {
  ...baseColumns,
  tenantId: tenantId(),
  goalId: uuid('goal_id').notNull().references(() => developmentGoals.id, { onDelete: 'cascade' }),
  authorId: uuid('author_id').notNull().references(() => users.id),
  body: text('body').notNull(),
})

export const externalTrainingRequests = pgTable('external_training_requests', {
  ...baseColumns,
  tenantId: tenantId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  provider: text('provider'),
  format: text('format').notNull().default('online'), // online | offline
  startsAt: date('starts_at'),
  cost: numeric('cost', { precision: 12, scale: 2 }),
  currency: text('currency').notNull().default('UAH'),
  justification: text('justification'),
  expectedResult: text('expected_result'),
  status: text('status').notNull().default('new'), // new | manager_approved | hr_approved | approved | rejected | completed
  approvals: jsonb('approvals').notNull().default('[]'), // [{step, by, at, decision, comment}]
  report: text('report'),
  documents: jsonb('documents').notNull().default('[]'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
}, t => [
  index().on(t.tenantId, t.status),
])

export const careerRequests = pgTable('career_requests', {
  ...baseColumns,
  tenantId: tenantId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  targetPositionId: uuid('target_position_id').notNull().references(() => positions.id),
  targetLocationId: uuid('target_location_id'),
  motivation: text('motivation'),
  status: text('status').notNull().default('new'),
  approvals: jsonb('approvals').notNull().default('[]'),
  assessmentId: uuid('assessment_id'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
})
