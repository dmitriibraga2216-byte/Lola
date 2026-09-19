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

/** Тип контента, одиннадцать значений. */
export const CONTENT_TYPES = [
  'course', 'training_program', 'resource', 'test', 'complex_test', 'workshop',
  'poll', 'assessment', 'check_list', 'meetup', 'webinar',
] as const
export type ContentType = typeof CONTENT_TYPES[number]

/** Режим назначения траектории и объявления. */
export const ASSIGN_MODES = ['manual', 'catalog_free', 'catalog_request', 'automation'] as const
export type AssignMode = typeof ASSIGN_MODES[number]

/** Узлы траектории (docs/17 §14.3). */
export const TRAJECTORY_NODE_KINDS = ['start', 'finish', 'task', 'and', 'or', 'delay', 'stop_delay', 'branch'] as const
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
}
