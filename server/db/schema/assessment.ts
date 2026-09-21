import { sql } from 'drizzle-orm'
import {
  boolean, date, index, integer, jsonb, numeric, pgTable, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { users } from './people'
import { locations } from './org'
import { competencies } from './development'
import { scales } from './settings'

/**
 * Оценка персонала и чек-листы (docs/20-assessment.md): группы критериев (словарь, docs/20 §14.6),
 * анкеты с нормами (docs/02 «Оценка и чек-листы»), циклы 360°, задачи оценщиков с ответами,
 * чек-листы наблюдения и их прогоны. Шкалы — общие `scales(kind=levels)` (docs/24 Г-24.4, Spec 20:
 * прежняя `rating_scales` перенесена миграцией 0039).
 */

export const criteriaGroups = pgTable('criteria_groups', {
  ...baseColumns,
  tenantId: tenantId(),
  name: text('name').notNull(),
  description: text('description'),
  sort: integer('sort').notNull().default(0),
  weight: numeric('weight', { precision: 6, scale: 2 }).notNull().default('1'),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`), // «Мітки» группы (docs/20 §14.6)
}, t => [
  index().on(t.tenantId),
])

export const criteria = pgTable('criteria', {
  ...baseColumns,
  tenantId: tenantId(),
  groupId: uuid('group_id').notNull().references(() => criteriaGroups.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  description: text('description'),
  weight: numeric('weight', { precision: 6, scale: 2 }).notNull().default('1'),
  isCritical: boolean('is_critical').notNull().default(false),
  competencyId: uuid('competency_id').references(() => competencies.id),
  requiresPhoto: boolean('requires_photo').notNull().default(false),
  sort: integer('sort').notNull().default(0),
}, t => [
  index().on(t.tenantId, t.groupId),
])

/**
 * Анкета оценки (docs/20 §14.2, docs/02 `assessments`): тип, шкала, правила комментирования,
 * состав — `assessment_items` с нормой на критерий. После первого заполнения `is_locked`:
 * шкала, состав и нормы не меняются (docs/20 §14.4), только название, описание, инструкция и метки.
 */
export const assessmentForms = pgTable('assessment_forms', {
  ...baseColumns,
  tenantId: tenantId(),
  title: text('title').notNull(),
  description: text('description'),
  instruction: jsonb('instruction').notNull().default('[]'), // «Інструкція для тих, хто відповідає на анкету» — блоки
  kind: text('kind').notNull().default('by_criteria'), // assessment_kind: by_criteria | by_competencies
  scaleId: uuid('scale_id').notNull().references(() => scales.id),
  allowCommentGroups: boolean('allow_comment_groups').notNull().default(false),
  commentGroupsRequired: boolean('comment_groups_required').notNull().default(false),
  commentWhenAboveNorm: boolean('comment_when_above_norm').notNull().default(false),
  commentWhenBelowNorm: boolean('comment_when_below_norm').notNull().default(true),
  commentWhenEqual: boolean('comment_when_equal').notNull().default(false),
  zeroMeansNoGrade: boolean('zero_means_no_grade').notNull().default(false),
  isLocked: boolean('is_locked').notNull().default(false),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  isActive: boolean('is_active').notNull().default(true),
}, t => [
  index().on(t.tenantId),
])

/** Состав анкеты: «критерій — індикатор · Норма» (docs/20 §14.2). Кластер — «Додати новий кластер». */
export const assessmentItems = pgTable('assessment_items', {
  ...baseColumns,
  tenantId: tenantId(),
  formId: uuid('form_id').notNull().references(() => assessmentForms.id, { onDelete: 'cascade' }),
  criterionId: uuid('criterion_id').notNull().references(() => criteria.id, { onDelete: 'cascade' }),
  norm: numeric('norm', { precision: 6, scale: 2 }).notNull(),
  cluster: text('cluster'),
  sortOrder: integer('sort_order').notNull().default(0),
}, t => [
  index().on(t.tenantId, t.formId),
  unique().on(t.formId, t.criterionId),
])

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
  raterKinds: text('rater_kinds').array().notNull(), // self | manager | functional_manager | peer | subordinate | external (docs/02, Г-20.1)
  raterRoles: jsonb('rater_roles').notNull().default('[]'), // [{kind, weight, isAnonymous}] — вага і анонімність ролі (Г-20.1/Г-20.2, docs/33 D-036); порожньо — RATER_ROLE_DEFAULTS
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
  raterKind: text('rater_kind').notNull(), // self | manager | functional_manager | peer | subordinate | external
  weight: numeric('weight', { precision: 4, scale: 2 }).notNull().default('1'), // знімок ваги ролі на момент старту циклу (docs/02 assessment_raters.weight)
  isAnonymous: boolean('is_anonymous').notNull().default(false), // знімок анонімності ролі (docs/02 assessment_raters.is_anonymous)
  items: jsonb('items'), // by_competencies (docs/33 D-039): склад анкети для цього оцінюваного [{criterionId, norm}] з вимог профілю посади; null — склад анкети
  status: text('status').notNull().default('pending'), // pending | in_progress | submitted | declined | expired
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  declineReason: text('decline_reason'),
  groupComments: jsonb('group_comments').notNull().default('{}'), // {groupId: text} — «Дозволити коментувати групи критеріїв»
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
  index().on(t.tenantId),
  unique().on(t.taskId, t.criterionId),
])

/**
 * Чек-лист (docs/20 §3.5, §14.3; docs/02 `checklists`): одна шкала на чек-лист, у пункта — вес
 * («у чек-листа вага, в анкеті оцінки — норма»). `is_locked` — после первого прогона (docs/20 §14.4).
 */
export const checklists = pgTable('checklists', {
  ...baseColumns,
  tenantId: tenantId(),
  title: text('title').notNull(),
  description: text('description'),
  instruction: jsonb('instruction').notNull().default('[]'),
  kind: text('kind').notNull().default('observation'), // observation | audit | mystery
  scaleId: uuid('scale_id').notNull().references(() => scales.id),
  items: jsonb('items').notNull(), // [{id, group, text, criterionId?, weight, isCritical, requiresPhoto, hint}]
  allowSkip: boolean('allow_skip').notNull().default(false), // «Дозволити пропускати питання»
  allowItemComment: boolean('allow_item_comment').notNull().default(true), // «Дозволити коментування кожного критерію»
  itemCommentRequired: boolean('item_comment_required').notNull().default(false), // «Зробити поле обов'язковим» — для провалених пунктів (мокап Checklist)
  isLocked: boolean('is_locked').notNull().default(false),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  scoring: text('scoring').notNull().default('percent'), // percent | points | pass_fail
  passScore: numeric('pass_score', { precision: 6, scale: 2 }).notNull().default('80'),
  criticalFailRule: text('critical_fail_rule').notNull().default('any_critical_fails_all'), // | none
  whoCanRun: jsonb('who_can_run').notNull().default('{"roles":["mentor","manager","admin"]}'),
  subjectKind: text('subject_kind').notNull().default('location'), // location | user | shift
  frequency: jsonb('frequency'), // {timesPerWeek: 2}
  requireSignature: boolean('require_signature').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id),
}, t => [
  index().on(t.tenantId),
])

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
  // Тайный покупатель (docs/20 §7.8, Б.2): прогон по одноразовой ссылке, привязан к волне
  waveId: uuid('wave_id'),
  isExternal: boolean('is_external').notNull().default(false),
}, t => [
  index().on(t.tenantId, t.checklistId, t.startedAt.desc()),
  index().on(t.tenantId, t.locationId),
  index().on(t.tenantId, t.observerId, t.status),
])

/** Волны тайного покупателя (docs/20 §9): результаты видны руководителю сети до публикации. */
export const mysteryWaves = pgTable('mystery_waves', {
  ...baseColumns,
  tenantId: tenantId(),
  checklistId: uuid('checklist_id').notNull().references(() => checklists.id),
  title: text('title').notNull(),
  startsAt: date('starts_at').notNull(),
  endsAt: date('ends_at').notNull(),
  status: text('status').notNull().default('active'), // active | published | closed
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id),
}, t => [
  index().on(t.tenantId, t.status),
])

/** Одноразовая ссылка тайного покупателя: без входа, 24 часа, на одну точку и волну (Б.2). */
export const mysteryLinks = pgTable('mystery_links', {
  ...baseColumns,
  tenantId: tenantId(),
  waveId: uuid('wave_id').notNull().references(() => mysteryWaves.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  runId: uuid('run_id').references(() => checklistRuns.id),
  createdBy: uuid('created_by').notNull().references(() => users.id),
}, t => [
  index().on(t.tenantId),
  unique().on(t.tokenHash),
])
