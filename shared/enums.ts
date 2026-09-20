/**
 * Перечисления, снятые с эталона (docs/02-data-model.md, раздел «Перечисления, снятые
 * с эталона»). Единственный источник значений для схем, БД и интерфейса — CLAUDE.md п. 13.
 * Состав сверяется с docs/02 тестом tests/integration/schema-parity.spec.ts:
 * лишнее или недостающее значение валит CI.
 */

/** Статус прохождения. Пять значений: not_assigned (элемент ещё не выдан) ≠ not_started (выдан, не открыт). */
export const ENROLLMENT_STATUSES = ['not_assigned', 'not_started', 'in_progress', 'done', 'failed'] as const
export type EnrollmentStatus = typeof ENROLLMENT_STATUSES[number]

/** Тип назначения — вкладки списка эталона. */
export const TASK_TYPES = ['manual', 'auto', 'catalog', 'trajectory', 'archive'] as const
export type TaskType = typeof TASK_TYPES[number]

/** Тип контента: одиннадцать значений эталона + `notice` — объявление назначается как обучение (docs/21 §14.5, Spec 21). */
export const CONTENT_TYPES = [
  'course', 'training_program', 'resource', 'test', 'complex_test', 'workshop',
  'poll', 'assessment', 'check_list', 'meetup', 'webinar', 'notice',
] as const
export type ContentType = typeof CONTENT_TYPES[number]

/** Режим назначения траектории и объявления. */
export const ASSIGN_MODES = ['manual', 'catalog_free', 'catalog_request', 'automation'] as const
export type AssignMode = typeof ASSIGN_MODES[number]

/** Узлы траектории (docs/17 §14.3; branch и mentor — наши, Г-17.1/Г-17.2). */
export const TRAJECTORY_NODE_KINDS = ['start', 'finish', 'task', 'and', 'or', 'delay', 'stop_delay', 'branch', 'mentor'] as const
export type TrajectoryNodeKind = typeof TRAJECTORY_NODE_KINDS[number]

/** Тип объявления. */
export const NOTICE_KINDS = ['acknowledge', 'event', 'notification'] as const
export type NoticeKind = typeof NOTICE_KINDS[number]

/** Типы вопросов: семь эталона (docs/12 §14.3) + три Lola (number, text_short, file). Коды — из docs/02. */
export const QUESTION_KINDS = [
  'single', 'multi', 'free', 'ordering', 'classification', 'comparison', 'answer_by_map',
  'number', 'text_short', 'file',
] as const
export type QuestionKind = typeof QUESTION_KINDS[number]

/** «Метод підрахунку балів» (docs/12 §14.6): за формулою | все або нічого. */
export const SCORING_METHODS = ['formula', 'all_or_nothing'] as const
export type ScoringMethod = typeof SCORING_METHODS[number]

/** Статус запроса дополнительной попытки (docs/12 §14.5: «Очікує» по умолчанию, «Надано», «Відмовлено»). */
export const ATTEMPT_REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const
export type AttemptRequestStatus = typeof ATTEMPT_REQUEST_STATUSES[number]

/** Уровень события журнала безопасности. */
export const SECURITY_SEVERITIES = ['info', 'warning', 'critical'] as const
export type SecuritySeverity = typeof SECURITY_SEVERITIES[number]

/** Имя перечисления в docs/02 → значения. Используется тестом паритета. */
/** Область действия метки (docs/16 §14.2, docs/30): обязательна, без неё на форме курса всплывают метки должностей. */
export const TAG_SCOPES = ['user', 'course', 'resource', 'question', 'task'] as const
export type TagScope = typeof TAG_SCOPES[number]

/** Вид конфликта оргструктуры (docs/16 §7, §14; Spec 22 + `unit_missing` по мокапу OrgConflicts). */
export const ORG_CONFLICT_KINDS = ['double_unit', 'placement_replaced', 'manager_self', 'manager_cycle', 'unit_missing'] as const
export type OrgConflictKind = typeof ORG_CONFLICT_KINDS[number]

/** Коды событий журнала безопасности (docs/16 §15 Г-16.2) — единственный список, писатель `logSecurity` принимает только их. */
export const SECURITY_EVENTS = [
  'login.success', 'login.failed', 'login.blocked', 'otp.sent', 'otp.failed', 'session.revoked',
  'user.created', 'user.blocked', 'user.unblocked', 'user.archived',
  'password.changed', 'password.reset_by_admin',
  'roles.changed', 'contacts.changed', 'impersonation.started', 'impersonation.ended',
  'export.personal_data', 'settings.security_changed', 'api_token.created', 'api_token.revoked',
] as const
export type SecurityEvent = typeof SECURITY_EVENTS[number]

export const ENUMS: Record<string, readonly string[]> = {
  enrollment_status: ENROLLMENT_STATUSES,
  task_type: TASK_TYPES,
  content_type: CONTENT_TYPES,
  assign_mode: ASSIGN_MODES,
  trajectory_node_kind: TRAJECTORY_NODE_KINDS,
  notice_kind: NOTICE_KINDS,
  security_severity: SECURITY_SEVERITIES,
  question_kind: QUESTION_KINDS,
  scoring_method: SCORING_METHODS,
  attempt_request_status: ATTEMPT_REQUEST_STATUSES,
  tag_scope: TAG_SCOPES,
  org_conflict_kind: ORG_CONFLICT_KINDS,
  security_event: SECURITY_EVENTS,
}
