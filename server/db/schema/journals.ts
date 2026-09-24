import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { users } from './people'

/**
 * Журналы по эталону (docs/22 §13.4, docs/16 §14; Spec 22). Записи неизменяемы, технический контекст —
 * `request_context` одинаково с остальными журналами (CLAUDE.md п. 14). Протокол смены статусов
 * заданий живёт в `enrollment_events` (docs/02) — отдельной таблицы нет.
 */

/** «Звіт звернень до завдань»: каждое открытие или скачивание задания, а не первый вход. */
export const taskAccessLog = pgTable('task_access_log', {
  ...baseColumns,
  tenantId: tenantId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  contentType: text('content_type').notNull(), // content_type (docs/02)
  contentId: uuid('content_id').notNull(),
  title: text('title'), // название на момент обращения — журнал не пересчитывается задним числом
  assignmentId: uuid('assignment_id'),
  enrollmentId: uuid('enrollment_id'),
  action: text('action').notNull().default('open'), // open | download
  requestContext: jsonb('request_context'), // {ip, geo, user_agent, browser, os, device}
}, t => [
  index().on(t.tenantId, t.createdAt.desc()),
  index().on(t.tenantId, t.contentType, t.contentId, t.createdAt.desc()),
  index().on(t.tenantId, t.userId, t.createdAt.desc()),
])

/** «Протокол конфліктів в оргструктурі»: эталон не падает на конфликте, а пишет строку и продолжает (docs/16 §7, §14). */
export const orgConflicts = pgTable('org_conflicts', {
  ...baseColumns,
  tenantId: tenantId(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), // ORG_CONFLICT_KINDS — один список из десяти (docs/v2/44 В-7)
  // Важность конфликта (docs/v2/32 §3.3, решение В-7): перечень взят у существующего
  // `security_severity`, а не заведён свой парой `error | warning` — один смысл, одно написание.
  severity: text('severity').notNull().default('warning'), // ORG_CONFLICT_SEVERITIES
  // Узел дерева, на котором конфликт обнаружен; null — конфликт про человека, а не про узел.
  nodeId: uuid('node_id'),
  source: text('source').notNull().default('manual'), // manual | import
  importJobId: uuid('import_job_id'),
  details: jsonb('details').notNull().default('{}'),
  actorId: uuid('actor_id'),
  requestContext: jsonb('request_context'),
  // Состояние конфликта выражено этой парой, а не третьей колонкой `status` (решение В-7):
  // открыт = `resolved_at is null`.
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: uuid('resolved_by'),
}, t => [
  index().on(t.tenantId, t.createdAt.desc()),
  index().on(t.tenantId, t.userId),
])

/**
 * Єдиний журнал «завдання завершено» для всіх типів контенту (docs/33 D-020, D-034): курс, тест, ресурс,
 * заняття/вебінар, оголошення, опитування, анкета, чек-лист, практикум, програма, комплексний тест,
 * траєкторія. Пише лише хук `onTaskCompleted` (`server/services/taskCompletion.ts`) — одна точка,
 * з якої підтверджуються компетенції призначення і з якої звіти читають прохождення типів, у яких
 * немає власного запису (`enrollments` є лише у курсу й програми). Статуси — п'ять `enrollment_status`
 * (CLAUDE.md п. 12), у журналі — тільки `done` і `failed`.
 */
export const taskStatusLog = pgTable('task_status_log', {
  ...baseColumns,
  tenantId: tenantId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  contentType: text('content_type').notNull(), // content_type (docs/02) + trajectory (не назначаемый контент, но завершается так само)
  contentId: uuid('content_id').notNull(),
  assignmentId: uuid('assignment_id'), // назначение, по которому завершено (null — контент без назначения: самостоятельно/каталог)
  enrollmentId: uuid('enrollment_id'), // запись курса/программы, если есть
  status: text('status').notNull(), // enrollment_status: done | failed
  result: text('result'), // результат (%, бали) на момент завершения — числом строкой, как enrollments.score
  sourceKind: text('source_kind').notNull(), // откуда пришло: enrollment | attempt | complex_attempt | resource_view | meetup_attendance | notice_ack | survey_response | assessment_cycle | checklist_run | workshop_submission | program_enrollment | trajectory_enrollment
  sourceId: uuid('source_id'), // id строки-источника (попытки, прогона, участия…)
  actorId: uuid('actor_id'), // кто зафиксировал (наставник, наблюдатель); null — сам человек или система
  requestContext: jsonb('request_context'), // {ip, geo, user_agent, browser, os, device}
}, t => [
  index().on(t.tenantId, t.createdAt.desc()),
  index().on(t.tenantId, t.userId, t.contentType, t.contentId, t.createdAt.desc()),
  index().on(t.tenantId, t.assignmentId),
])

/**
 * Протокол змін статусу проходження програми або траєкторії (docs/33 D-045; docs/22 §13.4).
 * У записей на курс есть `enrollment_events`, у `program_enrollments`/`trajectory_enrollments` журнала
 * не было — журнал `task-status` показывал только курсы и тесты. Одна таблица на оба типа:
 * `subject_type` — training_program | trajectory; `event` — как у enrollment_events
 * (created | started | completed | failed | cancelled | reset); `payload` — {from, to, result, reason, source}.
 */
export const passEvents = pgTable('pass_events', {
  ...baseColumns,
  tenantId: tenantId(),
  subjectType: text('subject_type').notNull(), // training_program | trajectory
  subjectId: uuid('subject_id').notNull(), // programs.id | trajectories.id
  enrollmentId: uuid('enrollment_id').notNull(), // program_enrollments.id | trajectory_enrollments.id
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  event: text('event').notNull(),
  payload: jsonb('payload').notNull().default('{}'),
  actorId: uuid('actor_id'), // null — системное событие (движок, сканер)
  requestContext: jsonb('request_context'),
}, t => [
  index().on(t.tenantId, t.createdAt.desc()),
  index().on(t.tenantId, t.userId, t.createdAt.desc()),
  index().on(t.tenantId, t.subjectType, t.subjectId),
])
