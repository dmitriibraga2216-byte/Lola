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

/**
 * Типы вопросов: семь эталона (docs/12 §14.3) + три Lola (number, text_short, file)
 * + `cloze` — пропуски в тексте (docs/12 §3.3 п. 11, `[решение, R2]`, docs/33 D-015). Коды — из docs/02.
 */
export const QUESTION_KINDS = [
  'single', 'multi', 'free', 'ordering', 'classification', 'comparison', 'answer_by_map',
  'number', 'text_short', 'file', 'cloze',
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

/** Тип анкеты оценки (docs/20 §14.2): «За критеріями» | «За компетенціями». */
export const ASSESSMENT_KINDS = ['by_criteria', 'by_competencies'] as const
export type AssessmentKind = typeof ASSESSMENT_KINDS[number]

/** Режим опроса (docs/20 §14.5): «Лінійне опитування» | «Опитування з умовами». */
export const POLL_MODES = ['linear', 'conditional'] as const
export type PollMode = typeof POLL_MODES[number]

/** Типы вопросов опроса (docs/20 §14.7): «Одиночне» · «Множинне» · «Вільна відповідь» · «По шкалі». */
export const POLL_QUESTION_KINDS = ['single', 'multi', 'free', 'scale'] as const
export type PollQuestionKind = typeof POLL_QUESTION_KINDS[number]

/** Источник уровня компетенции человека (docs/19 Г-19.2, docs/02 `user_competencies.source`): приоритет assessment > task > manual. */
export const COMPETENCY_SOURCES = ['assessment', 'task', 'manual'] as const
export type CompetencySource = typeof COMPETENCY_SOURCES[number]

/** Спосіб відображення рівня компетенції (docs/19 §14.1 «Шкала компетенцій»): назва рівня чи число. */
export const DISPLAY_AS = ['label', 'value'] as const
export type DisplayAs = typeof DISPLAY_AS[number]

/**
 * Материал, который можно оценить читателем (docs/21 §14.1 «Оцінок: N», докс/33 D-042):
 * ресурс базы знаний и статья вики — наше перечисление, `[решение]`, не путать с `content_type`.
 */
export const CONTENT_RATING_TARGETS = ['resource', 'knowledge_article'] as const
export type ContentRatingTarget = typeof CONTENT_RATING_TARGETS[number]

/**
 * Роли оценщиков (docs/02 `assessment_raters.rater_kind`, docs/20 Г-20.1; docs/33 D-036). Не в `ENUMS`: в разделе
 * «Перечисления, снятые с эталона» docs/02 этого списка нет — он наш `[решение]`. Вес и анонимность —
 * свойство роли (Г-20.2): `manager` и `self` всегда именные, `self` показывается, но не считается.
 */
export const RATER_KINDS = ['self', 'manager', 'functional_manager', 'peer', 'subordinate', 'external'] as const
export type RaterKind = typeof RATER_KINDS[number]
export interface RaterRole { kind: RaterKind, weight: number, isAnonymous: boolean }
export const RATER_ROLE_DEFAULTS: Record<RaterKind, RaterRole> = {
  manager: { kind: 'manager', weight: 2, isAnonymous: false },
  functional_manager: { kind: 'functional_manager', weight: 1, isAnonymous: false },
  self: { kind: 'self', weight: 0, isAnonymous: false },
  peer: { kind: 'peer', weight: 1, isAnonymous: true },
  subordinate: { kind: 'subordinate', weight: 1, isAnonymous: true },
  external: { kind: 'external', weight: 1, isAnonymous: false },
}

/**
 * Вид человека в `users` (docs/v2/28 §2, docs/v2/44 В-8 и В-14): кандидат и сотрудник —
 * одна запись с разным `kind`, а не две таблицы. Перевод кандидата в штат меняет `kind`,
 * история откликов, оценок и обучения остаётся на том же `users.id`.
 * Любая списочная выборка людей обязана идти через `server/services/repo/people.ts`
 * (три слоя фильтра, П-16.1) — иначе кандидаты попадут в списки сотрудников.
 */
export const USER_KINDS = ['employee', 'candidate'] as const
export type UserKind = typeof USER_KINDS[number]

/**
 * Коды этапов жизненного цикла (docs/v2/33-lifecycle.md §3.2, docs/v2/44-decisions.md В-3).
 * Перечень **платформенный**: тенант включает, переименовывает и сортирует этапы, но
 * выдумать девятый код не может (`33` §12.8) — на этом держится сравнимость отчётов и
 * ключей разбивки хранилища между тенантами (В-10). Код неизменяем и закрыт констрейнтом
 * `lifecycle_stages_code_check`.
 *
 * Единственное место кроме посева (`server/db/tenantDefaults.ts`) и миграции, где коды
 * встречаются буквально: ветвление по коду запрещено, все различия — через `stageCan()`
 * (`33` §7.1, сквозная проверка 1 в `scripts/v2-crosschecks.sh`).
 */
export const LIFECYCLE_STAGE_CODES = [
  'recruiting', 'onboarding', 'integration', 'training',
  'attestation', 'psychological', 'knowledge', 'offboarding',
] as const
export type LifecycleStageCode = typeof LIFECYCLE_STAGE_CODES[number]

/**
 * Возможности этапа (docs/v2/33 §3.3) — **фиксированный** перечень ключей `capabilities`
 * (docs/v2/44 В-3: «не свободный jsonb»). Неизвестный ключ отвергается `422`, а не
 * игнорируется: опечатка `certificat` вместо `certificate` иначе тихо выключила бы
 * возможность. Отсутствующий ключ читается как `false`.
 */
export const STAGE_CAPABILITIES = [
  'progress', 'deadline', 'grading', 'attempts', 'review', 'certificate', 'graph',
  'ai_generate', 'applies_to_candidate', 'applies_to_employee', 'counts_in_rating',
] as const
export type StageCapability = typeof STAGE_CAPABILITIES[number]
/** Карта возможностей этапа: отсутствующий ключ = `false` (`33` §3.3). */
export type StageCapabilityMap = Partial<Record<StageCapability, boolean>>

/**
 * Оси лимитов тарифа (docs/v2/35-billing-limits.md §7.1, решение docs/v2/44 В-5, патч П-25.1
 * в редакции «шесть осей → одиннадцать»). Одиннадцать значений — не шесть, как в схеме до
 * PR-08, и не три, как считал П-25.1 до сверки.
 *
 * Десять осей тарифицируются и потому имеют **явную колонку** лимита в `tenant_limits`
 * (`users`, `candidates`, `storage_gb`, `ai_generate_ops`, `ai_review_ops`, `ai_interview_ops`,
 * `sms_per_month`, `webhooks` = `integrations_active`, `api_per_minute` = `api_rate_rpm`,
 * `export_rows`). Мягкая `telegram_out` колонки не получает: канал бесплатный, ось только
 * наблюдается — её место в `tenant_usage.axes jsonb` (В-5: «ось, по которой выставляется
 * счёт, обязана иметь имя в схеме; ось, которую мы только наблюдаем, — не заслуживает»).
 */
export const LIMIT_AXES = [
  'users_active', 'candidates_active', 'storage_bytes', 'ai_generate_ops', 'ai_review_ops',
  'ai_interview_ops', 'sms_out', 'telegram_out', 'integrations_active', 'api_rate_rpm',
  'export_rows',
] as const
export type LimitAxis = typeof LIMIT_AXES[number]

/**
 * Куда человек переходит, закрыв все обязательные назначения этапа (docs/v2/33 §4.1, §7.6).
 *
 * Граф переходов — такая же платформенная данность, как сам перечень кодов, и живёт здесь
 * по той же причине: в `server/` и `app/` ветвления по коду этапа нет ни одного (`33` §7.1,
 * сквозная проверка 1). Перехода из `training` нет намеренно — это рабочее состояние по
 * умолчанию (`33` §4.1: «иначе пришлось бы придумывать девятый этап „работает“»); из
 * `attestation` человек возвращается в него же. `recruiting` — только для кандидата,
 * `knowledge` и `psychological` этапами человека не бывают, `offboarding` закрывается
 * завершением случая увольнения, а не переходом.
 */
export const LIFECYCLE_STAGE_FLOW: Partial<Record<LifecycleStageCode, LifecycleStageCode>> = {
  onboarding: 'integration',
  integration: 'training',
  attestation: 'training',
}

/** Этап, который человек получает при найме и при повторном найме (`33` §4.1, §7.8). */
export const STAGE_ON_HIRE: LifecycleStageCode = 'onboarding'
/** Этап уходящего человека (`33` §4.2). */
export const STAGE_ON_OFFBOARDING: LifecycleStageCode = 'offboarding'
/** Рабочее состояние по умолчанию (`33` §4.1). */
export const STAGE_WORKING: LifecycleStageCode = 'training'

/**
 * Почему человек оказался на этапе — `employee_lifecycle_state.reason_code` (docs/v2/33 §3.5).
 *
 * Перечень живёт здесь, рядом с кодами этапов, и по той же причине: значение `offboarding`
 * текстуально совпадает с кодом этапа, и в коде оно обязано быть именем константы, а не
 * литералом — иначе сквозная проверка 1 не отличит причину перехода от ветвления по этапу.
 */
export const LIFECYCLE_REASON_CODES = [
  'hire', 'rehire', 'advance', 'manual', 'backfill', 'offboarding', 'offboarding_cancelled',
] as const
export type LifecycleReasonCode = typeof LIFECYCLE_REASON_CODES[number]

/** Причина перехода при запуске офбординга и снятия его назначений при отмене. */
export const REASON_OFFBOARDING: LifecycleReasonCode = 'offboarding'
export const REASON_OFFBOARDING_CANCELLED: LifecycleReasonCode = 'offboarding_cancelled'

/** Состояния случая увольнения (docs/v2/33 §3.6, §4.2). */
export const OFFBOARDING_STATES = ['started', 'handover', 'interview', 'done', 'cancelled'] as const
export type OffboardingState = typeof OFFBOARDING_STATES[number]

/** Причины увольнения (docs/v2/33 §3.6, форма §6.2): свободный текст обязателен только при `other`. */
export const OFFBOARDING_REASONS = [
  'own_wish', 'probation_failed', 'performance', 'redundancy',
  'no_show', 'end_of_contract', 'transfer_out', 'other',
] as const
export type OffboardingReason = typeof OFFBOARDING_REASONS[number]

/**
 * Вид операции, породившей строку журнала расхода `usage_events.ref_kind`
 * (docs/v2/35-billing-limits.md §3.5). Шесть измеряемых операций — и ни одной сверх:
 * моментальные оси (`users_active`, `candidates_active`, `integrations_active`) расхода не
 * порождают, их счётчик сходится пересчётом факта (§7.1, §7.5), а не суммой журнала.
 */
export const USAGE_REF_KINDS = ['ai_generation', 'ai_review', 'ai_interview', 'sms', 'upload', 'export'] as const
export type UsageRefKind = typeof USAGE_REF_KINDS[number]

/**
 * Уровень предупреждения по оси (`limit_notices.level`, docs/v2/35 §3.5, §4 «Баннер», §7.9):
 * `warn` — достигнуто 80 % эффективного лимита, `exceeded` — 100 %. Третьего уровня нет:
 * ниже 80 % запись закрывается (`resolved_at`), а не понижается.
 */
export const LIMIT_NOTICE_LEVELS = ['warn', 'exceeded'] as const
export type LimitNoticeLevel = typeof LIMIT_NOTICE_LEVELS[number]

/**
 * Происхождение файла (`media_assets.origin`, docs/v2/34 §3.2 и §7.1, итоговая редакция
 * docs/v2/40 §4.2, решение В-6) — **пятнадцать** значений и **один** check-констрейнт.
 *
 * Перечень описан тремя документами пакета по-разному (`34` — 13 значений, `30` добавляет
 * `interview_answer`, `38` пересоздаёт констрейнт целиком и `interview_answer` в его версии
 * нет). Собирается один раз: иначе запись авто-собеседования становится невставляемой.
 * Здесь, в `docs/02` «Перечисления» и в миграции `0063_v2_media_origin` — три копии одного
 * списка, расхождение любой валит CI (`schema-parity.spec.ts` и контрактный тест №4).
 *
 * Значение задаёт клиент при выдаче presigned URL (`34` §7.1): без него
 * `POST /media/upload-url` отвечает `400 origin_required`. `other` — не «по умолчанию»,
 * а «не отнесено»: доля выше 5 % объёма считается дефектом классификации.
 */
export const MEDIA_ORIGINS = [
  'content_cover', 'lesson_attachment', 'workshop_submission', 'video_answer', 'candidate_cv',
  'certificate', 'import', 'checklist_photo', 'avatar', 'brand_asset', 'ai_artifact',
  'report_export', 'interview_answer', 'person_document', 'other',
] as const
export type MediaOrigin = typeof MEDIA_ORIGINS[number]

/**
 * Положение файла в хранилище (`media_assets.lifecycle`, docs/v2/34 §3.1, §4) — ось,
 * отдельная от `status`: `status` — техническая готовность объекта, `lifecycle` — место
 * в хранилище. Файл бывает `status='ready'` и `lifecycle='orphaned'` одновременно.
 * `purged` терминально: строка `media_assets` не удаляется никогда.
 */
export const MEDIA_LIFECYCLES = ['active', 'orphaned', 'pending_delete', 'purged'] as const
export type MediaLifecycle = typeof MEDIA_LIFECYCLES[number]

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
  assessment_kind: ASSESSMENT_KINDS,
  poll_mode: POLL_MODES,
  poll_question_kind: POLL_QUESTION_KINDS,
  competency_source: COMPETENCY_SOURCES,
  display_as: DISPLAY_AS,
  content_rating_target: CONTENT_RATING_TARGETS,
  user_kind: USER_KINDS,
  lifecycle_stage_code: LIFECYCLE_STAGE_CODES,
  stage_capability: STAGE_CAPABILITIES,
  lifecycle_reason_code: LIFECYCLE_REASON_CODES,
  offboarding_state: OFFBOARDING_STATES,
  offboarding_reason: OFFBOARDING_REASONS,
  limit_axis: LIMIT_AXES,
  usage_ref_kind: USAGE_REF_KINDS,
  limit_notice_level: LIMIT_NOTICE_LEVELS,
  media_origin: MEDIA_ORIGINS,
  media_lifecycle: MEDIA_LIFECYCLES,
}
