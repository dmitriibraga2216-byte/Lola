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
 * + `cloze` — пропуски в тексте (docs/12 §3.3 п. 11, `[решение, R2]`, docs/33 D-015)
 * + `scale` — «Лінійна шкала», числовой диапазон с настраиваемыми границами и подписями
 * концов (патч П-12.1 `docs/v2/39`, снято со второго эталона). Коды — из docs/02.
 */
export const QUESTION_KINDS = [
  'single', 'multi', 'free', 'ordering', 'classification', 'comparison', 'answer_by_map',
  'number', 'text_short', 'file', 'cloze', 'scale',
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

/**
 * Вид конфликта оргструктуры — **один список из десяти** (docs/16 §7, §14; Spec 22;
 * docs/v2/32 §3.3 и решение docs/v2/44 В-7).
 *
 * Первые пять существуют с Spec 16 и уже лежат в данных. Пять последних добавил PR-30 вместе
 * с деревом `org_nodes`. Три имени пакета в перечень не попали, потому что это переименования
 * уже существующих значений, а не новые виды: `self_manager` → `manager_self`,
 * `multi_primary` → `double_unit` (писатель `importPeople.ts` ставит его именно на «второе
 * активное размещение»), `orphan_user` → `unit_missing` (человек без узла = узла нет).
 * Заводить второе имя для того же конфликта значило бы показать его в отчёте дважды.
 */
export const ORG_CONFLICT_KINDS = [
  'double_unit', 'placement_replaced', 'manager_self', 'manager_cycle', 'unit_missing',
  'no_manager', 'manager_mismatch', 'depth_exceeded', 'dismissed_holder', 'position_mismatch',
] as const
export type OrgConflictKind = typeof ORG_CONFLICT_KINDS[number]

/**
 * Важность конфликта оргструктуры (`org_conflicts.severity`, docs/v2/32 §3.3, решение В-7).
 * Пакет предлагал свою пару `error | warning`; взят существующий `security_severity` —
 * один смысл не должен иметь в системе двух написаний.
 */
export const ORG_CONFLICT_SEVERITIES = ['info', 'warning', 'critical'] as const
export type OrgConflictSeverity = typeof ORG_CONFLICT_SEVERITIES[number]

/** Вид узла дерева подчинения (docs/v2/32 §3.2): штатная точка со счётчиком либо именная. */
export const ORG_NODE_TYPES = ['position', 'employee'] as const
export type OrgNodeType = typeof ORG_NODE_TYPES[number]

/** Состояние узла (docs/v2/32 §4). Физического удаления узла нет — только архивация. */
export const ORG_NODE_STATES = ['vacant', 'occupied', 'archived'] as const
export type OrgNodeState = typeof ORG_NODE_STATES[number]

/** Роль человека в узле (docs/v2/32 §3.3): держатель, в. о., заместитель. */
export const ORG_ASSIGNMENT_ROLES = ['holder', 'acting', 'deputy'] as const
export type OrgAssignmentRole = typeof ORG_ASSIGNMENT_ROLES[number]

/** Почему назначение на узел закрыто (docs/v2/32 §3.3). Обратного перехода нет. */
export const ORG_ASSIGNMENT_END_REASONS = ['moved', 'dismissed', 'node_archived', 'manual'] as const
export type OrgAssignmentEndReason = typeof ORG_ASSIGNMENT_END_REASONS[number]

/**
 * Откуда взят руководитель — результат `resolveManager()` (docs/v2/32 §7.8, патч П-16.4).
 * Строгий приоритет: дерево → точка → роль в области → никого. `functional` в цепочку
 * не входит (функциональный руководитель — отдельная ось), но значение зарезервировано
 * за отчётом «Підпорядкування людей», где источник показывается колонкой.
 */
export const ORG_MANAGER_SOURCES = ['org_tree', 'location', 'functional', 'role_scope', 'none'] as const
export type OrgManagerSource = typeof ORG_MANAGER_SOURCES[number]

/** Вид снимка дерева (docs/v2/32 §3.3). Откат по снимку — PR-31, здесь только таблица. */
export const ORG_SNAPSHOT_KINDS = ['manual', 'auto_daily', 'pre_import', 'pre_bulk_move'] as const
export type OrgSnapshotKind = typeof ORG_SNAPSHOT_KINDS[number]

/** Коды событий журнала безопасности (docs/16 §15 Г-16.2) — единственный список, писатель `logSecurity` принимает только их. */
export const SECURITY_EVENTS = [
  'login.success', 'login.failed', 'login.blocked', 'otp.sent', 'otp.failed', 'session.revoked',
  'user.created', 'user.blocked', 'user.unblocked', 'user.archived',
  'password.changed', 'password.reset_by_admin',
  'roles.changed', 'contacts.changed', 'impersonation.started', 'impersonation.ended',
  'export.personal_data', 'settings.security_changed', 'api_token.created', 'api_token.revoked',
  // Двухфакторный вход (docs/24 §3.4, П-24.1, PR-39): подключил, отключил сам, сбросил
  // администратор или оператор платформы, неверный код, вход резервным кодом
  'two_factor.enabled', 'two_factor.disabled', 'two_factor.reset', 'two_factor.failed', 'two_factor.recovery_used',
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
  'report_export', 'interview_answer', 'person_document', 'issue_screenshot', 'other',
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

/**
 * Положения файла, которые **засчитываются в квоту** (docs/v2/34 §7.4 п. 3): `active` и
 * `orphaned` — да, `pending_delete` и `purged` — нет. Корзина квоту не держит: тенант платит
 * за то, чем распоряжается (§7.2 п. 3). Тот же список — в триггере `storage_counter_apply`.
 */
export const MEDIA_COUNTED_LIFECYCLES = ['active', 'orphaned'] as const satisfies readonly MediaLifecycle[]

/**
 * Точка отсчёта срока хранения (`storage_retention_policies.anchor`, docs/v2/34 §3.3, §6.2):
 * дата загрузки, дата оценки сдачи или дата последнего обращения к файлу.
 */
export const STORAGE_RETENTION_ANCHORS = ['created_at', 'graded_at', 'last_accessed_at'] as const
export type StorageRetentionAnchor = typeof STORAGE_RETENTION_ANCHORS[number]

/**
 * Что политика делает с файлом по истечении срока (`storage_retention_policies.action`,
 * docs/v2/34 §3.3): в корзину, сразу в `purged` без корзины, или только предупредить.
 */
export const STORAGE_RETENTION_ACTIONS = ['soft_delete', 'purge', 'notify_only'] as const
export type StorageRetentionAction = typeof STORAGE_RETENTION_ACTIONS[number]

/**
 * Откуда пришла заявка на массовое удаление (`storage_deletion_requests.mode`, docs/v2/34
 * §3.3): выделение на экране, снимок фильтра, политика хранения, решение по осиротевшим.
 */
export const STORAGE_DELETION_MODES = ['selection', 'filter', 'retention', 'orphan'] as const
export type StorageDeletionMode = typeof STORAGE_DELETION_MODES[number]

/**
 * Состояние заявки на массовое удаление (`storage_deletion_requests.status`, docs/v2/34 §4):
 * `draft → confirmed → running → done`, ветки `cancelled` (до подтверждения) и `failed`.
 */
export const STORAGE_DELETION_STATUSES = ['draft', 'confirmed', 'running', 'done', 'cancelled', 'failed'] as const
export type StorageDeletionStatus = typeof STORAGE_DELETION_STATUSES[number]

/**
 * Почему файл из заявки не удалён (`storage_deletion_requests.skipped[].reason`, docs/v2/34
 * §12, §13 к. 4): запрещён к удалению (сертификат), уже в корзине, сдача сейчас на проверке.
 */
export const STORAGE_SKIP_REASONS = ['not_deletable', 'already_deleted', 'under_review'] as const
export type StorageSkipReason = typeof STORAGE_SKIP_REASONS[number]

/**
 * Отложенная загрузка — работа сотрудника, не поместившаяся в квоту (`storage_pending_uploads
 * .status`, docs/v2/34 §4, §7.5): `waiting → uploading → done`, ветка `abandoned` по сроку.
 */
export const STORAGE_PENDING_UPLOAD_STATUSES = ['waiting', 'uploading', 'done', 'abandoned'] as const
export type StoragePendingUploadStatus = typeof STORAGE_PENDING_UPLOAD_STATUSES[number]

/**
 * Девятый ключ разбивки хранилища (решение docs/v2/44 В-10): файл вне курса кода этапа не
 * получает (`media_assets.stage_code is null`) и в сводке показывается под этим ключом.
 * Восемь остальных — `LIFECYCLE_STAGE_CODES`; девять ключей сравнимы между тенантами.
 */
export const STORAGE_OTHER_KEY = 'other'

/**
 * Терминальное состояние воронки кандидата (`users.candidate_state`, docs/v2/28 §3.2, §4.2).
 *
 * Первая из **двух независимых осей** состояния (§4.1): на эту смотрят отчёты, лимиты тарифа
 * и уведомления, и она закрыта пятью значениями. Вторая ось — колонка канбана
 * (`users.candidate_status_id` → `candidate_statuses`), она расширяемая и нужна людям.
 * Сливать оси нельзя: первая же пользовательская колонка («Передзвонити у січні») ломает
 * всю отчётность по воронке — это самая частая ошибка систем с настраиваемыми статусами.
 *
 * `hired` терминален в обе стороны: ошибочный найм исправляется офбордингом (`docs/v2/33`),
 * а не возвратом в воронку — иначе в системе появляется сотрудник с живым прогрессом,
 * которого «вернули в кандидаты», и отчёты по штату начинают врать (§4.2).
 */
export const CANDIDATE_STATES = ['active', 'hired', 'rejected', 'archived', 'withdrawn'] as const
export type CandidateState = typeof CANDIDATE_STATES[number]

/** Откуда пришёл кандидат (`users.source`, docs/v2/28 §3.2). Уточнение — в `source_detail`. */
export const CANDIDATE_SOURCES = ['manual', 'vacancy_link', 'job_board', 'referral', 'import', 'api'] as const
export type CandidateSource = typeof CANDIDATE_SOURCES[number]

/**
 * Вид оценки кандидата (`candidate_scores.kind`, docs/v2/28 §3.4). Четыре независимых вида,
 * **не сводимые в один `score`**: усреднение прячет случай «блестящее тестовое, провальное
 * собеседование», ради которого воронка и существует. Действующая оценка каждого вида одна —
 * частичный уникальный индекс `uq_candidate_scores_current`, история остаётся строками.
 */
export const CANDIDATE_SCORE_KINDS = ['manual', 'task', 'ai', 'recruiter'] as const
export type CandidateScoreKind = typeof CANDIDATE_SCORE_KINDS[number]

/**
 * Видимость комментария о кандидате (`candidate_comments.visibility`, docs/v2/28 §3.5).
 * Самому кандидату комментарий не виден **ни при какой** видимости: это служебная переписка
 * о человеке, а не с человеком.
 */
export const CANDIDATE_COMMENT_VISIBILITIES = ['recruiters', 'managers', 'all_staff'] as const
export type CandidateCommentVisibility = typeof CANDIDATE_COMMENT_VISIBILITIES[number]

/**
 * Причина отказа кандидату (docs/v2/28 §6.2). При `other` комментарий обязателен (10–500).
 * Причина попадает в `candidate_status_history.reason_code` и в отчёт «Отказы по причинам» (§9).
 */
export const CANDIDATE_REJECT_REASONS = ['skills', 'experience', 'no_contact', 'conditions', 'vacancy_closed', 'other'] as const
export type CandidateRejectReason = typeof CANDIDATE_REJECT_REASONS[number]

/**
 * Шесть системных колонок воронки нового тенанта (docs/v2/28 §3.3). `is_system` запрещает
 * удаление и смену `code`; `name_uk`, `color` и `sort` тенант меняет. Каждая колонка знает
 * своё `maps_to` — иначе отчётность по воронке разваливается на первой же своей колонке.
 * Здесь и в миграции `0064_v2_candidates` — две копии одного списка, как у этапов цикла.
 */
export const SYSTEM_CANDIDATE_STATUSES: {
  code: string
  nameUk: string
  nameEn: string
  color: 'ink' | 'sun' | 'teal' | 'coral'
  mapsTo: CandidateState
}[] = [
  { code: 'new', nameUk: 'Не розпочали', nameEn: 'Not started', color: 'ink', mapsTo: 'active' },
  { code: 'in_progress', nameUk: 'Проходять', nameEn: 'In progress', color: 'teal', mapsTo: 'active' },
  { code: 'on_review', nameUk: 'На перевірці', nameEn: 'On review', color: 'sun', mapsTo: 'active' },
  { code: 'approved', nameUk: 'Схвалені', nameEn: 'Approved', color: 'teal', mapsTo: 'active' },
  { code: 'doubt', nameUk: 'Під сумнівом', nameEn: 'In doubt', color: 'sun', mapsTo: 'active' },
  { code: 'rejected', nameUk: 'Відхилені', nameEn: 'Rejected', color: 'coral', mapsTo: 'rejected' },
]

/**
 * Два значения, текстуально совпадающие с кодами этапов жизненного цикла, — и потому живущие
 * здесь константами, а не литералами в коде (та же причина, что у `LIFECYCLE_REASON_CODES`,
 * см. `docs/28-implementation-notes.md` §28.13 п. 8): сквозная проверка 1
 * (`scripts/v2-crosschecks.sh`) не может отличить ключ группы настроек и область наставника
 * от ветвления по коду этапа, а инвариант 16 запрещает именно ветвление.
 *
 * `SETTINGS_GROUP_RECRUITING` — группа `tenants.settings.recruiting` (сроки воронки, docs/v2/28
 * §7.5, §7.9). `MENTOR_SCOPE_ONBOARDING` — область функционального руководителя, которым
 * записывается наставник при найме (`functional_chiefs.scope`, docs/v2/28 §5.5).
 */
export const SETTINGS_GROUP_RECRUITING = 'recruiting'
export const MENTOR_SCOPE_ONBOARDING = 'onboarding'

/** Срок согласия на обработку ПД по умолчанию — 6 месяцев (docs/v2/28 §7.9, диапазон 1–24). */
export const CANDIDATE_CONSENT_MONTHS = 6

// ── Вакансии (docs/v2/29-vacancies.md §3) ──────────────────────────────────────────────────

/**
 * Состояние вакансии (`vacancies.state`, `29` §4). Пять значений, переходы — §4:
 * `draft → published ⇄ paused`, `published|paused → closed → archived → draft`.
 * Переоткрытие закрытой выдаёт **новый** токен: старая ссылка расходится по чатам и
 * агрегаторам, и пришедший через полгода должен видеть «вакансію закрито», а не форму
 * на позицию с другими условиями.
 */
export const VACANCY_STATES = ['draft', 'published', 'paused', 'closed', 'archived'] as const
export type VacancyState = typeof VACANCY_STATES[number]

/** Тип занятости (`vacancies.employment_type`, `29` §3.1, снято с эталона §14). */
export const VACANCY_EMPLOYMENT_TYPES = ['full_time', 'part_time', 'shift', 'temporary', 'internship', 'contract'] as const
export type VacancyEmploymentType = typeof VACANCY_EMPLOYMENT_TYPES[number]

/** Формат работы (`vacancies.work_format`, `29` §3.1). */
export const VACANCY_WORK_FORMATS = ['on_site', 'hybrid', 'remote'] as const
export type VacancyWorkFormat = typeof VACANCY_WORK_FORMATS[number]

/** Требуемый опыт (`vacancies.experience_level`, `29` §3.1). */
export const VACANCY_EXPERIENCE_LEVELS = ['none', 'under_1y', '1_3y', '3_5y', 'over_5y'] as const
export type VacancyExperienceLevel = typeof VACANCY_EXPERIENCE_LEVELS[number]

/** Требуемое образование (`vacancies.education_level`, `29` §3.1). */
export const VACANCY_EDUCATION_LEVELS = ['none', 'secondary', 'vocational', 'incomplete_higher', 'higher'] as const
export type VacancyEducationLevel = typeof VACANCY_EDUCATION_LEVELS[number]

/** Уровень языка (`vacancy_languages.level`, `29` §3.2): шкала CEFR плюс `native`. */
export const VACANCY_LANGUAGE_LEVELS = ['a1', 'a2', 'b1', 'b2', 'c1', 'c2', 'native'] as const
export type VacancyLanguageLevel = typeof VACANCY_LANGUAGE_LEVELS[number]

/**
 * Происхождение критерия оценки (`vacancy_criteria.origin`, `29` §3.3): рука рекрутера,
 * черновик ИИ, принятый человеком (§7.11), или шаблон вакансии (§3.4).
 */
export const VACANCY_CRITERION_ORIGINS = ['manual', 'ai', 'template'] as const
export type VacancyCriterionOrigin = typeof VACANCY_CRITERION_ORIGINS[number]

/**
 * Причина закрытия вакансии (`vacancies.close_reason`, `29` §4 «указана причина»).
 * Перечня в `29` нет — [гипотеза] выведена из причин отказа кандидату (`28` §6.2) и
 * колонки «Причина закриття» отчёта §9.2; [решение] пять значений плюс `other` с текстом,
 * потому что свободная строка в отчёте не группируется, а без `other` рекрутер напишет
 * причину в название вакансии (`docs/28-implementation-notes.md` §28.17 п. 4).
 */
export const VACANCY_CLOSE_REASONS = ['filled', 'no_need', 'budget', 'postponed', 'other'] as const
export type VacancyCloseReason = typeof VACANCY_CLOSE_REASONS[number]

/** Длина публичного токена вакансии: 22 знака base62 ≈ 132 бита (`29` §7.2). */
export const VACANCY_TOKEN_LENGTH = 22

/** Суточный потолок откликов по умолчанию и его границы (`vacancies.apply_daily_cap`, `29` §3.1). */
export const VACANCY_APPLY_CAP_DEFAULT = 200
export const VACANCY_APPLY_CAP_MIN = 10
export const VACANCY_APPLY_CAP_MAX = 5000

/** Сколько дней после закрытия вакансию ещё можно переоткрыть (`29` §4). */
export const VACANCY_REOPEN_DAYS = 90

/**
 * Состояние отклика (`vacancy_applications.state`, docs/v2/29 §3.9, §4).
 *
 * Отклик — **отдельная сущность, а не сразу кандидат** (§3.9 [решение]): подозрительный
 * отклик надо уметь придержать, не засоряя воронку и не занимая место в оплачиваемой оси
 * `candidates_active`. `pending` — ждёт подтверждения контакта кодом; `pending_review` —
 * сработала хотя бы одна проверка §7.6–§7.7, решение за человеком; `accepted` — кандидат
 * создан; `merged` — человек уже есть в тенанте (§7.20, §12.6), второго профиля не будет;
 * `expired` — код не введён за сутки, место в лимите не занято (§13 к. 6).
 */
export const VACANCY_APPLICATION_STATES = ['pending', 'pending_review', 'accepted', 'merged', 'rejected', 'spam', 'expired'] as const
export type VacancyApplicationState = typeof VACANCY_APPLICATION_STATES[number]

/**
 * Исход обращения к публичному контуру (`public_apply_attempts.outcome`, `29` §3.9, §7.4).
 * Журнал попыток нужен ровно затем, чтобы **блокировка была доказуема**: ответ публичной
 * формы одинаков при успехе и при отказе (§7.3), и без этой строки «почему не приняли»
 * не восстановить ни рекрутеру, ни поддержке.
 */
export const PUBLIC_APPLY_OUTCOMES = ['view', 'submit_ok', 'submit_blocked', 'otp_sent', 'otp_failed'] as const
export type PublicApplyOutcome = typeof PUBLIC_APPLY_OUTCOMES[number]

/**
 * Частотные пороги публичного контура (`29` §7.4) — **вместо внешней капчи** (§7.5
 * [решение]: капча отдаёт поведение посетителей третьей стороне на странице, где собираются
 * ПД). Единицы: откликов с одного `ip_hash` за час и за сутки на тенант, откликов на одну
 * вакансию с одного `ip_hash` за сутки, просмотров публичной страницы за десять минут.
 */
export const VACANCY_APPLY_LIMITS = {
  ipHour: 3,
  ipDay: 10,
  perVacancyDay: 1,
  viewPer10Min: 30,
} as const

/** Слагаемые `spam_score` (`29` §7.7). Чёрного списка контактов в продукте нет — см. `publicApply.ts`. */
export const VACANCY_APPLY_SPAM_SCORES = {
  honeypot: 60,
  fastSubmit: 40,
  nonceReplay: 100,
  commentLinks: 30,
  consonantName: 20,
  ipMarkedSpam: 50,
} as const

/** Порог ручной модерации и порог немого отсева (`29` §7.7). */
export const VACANCY_APPLY_REVIEW_SCORE = 50
export const VACANCY_APPLY_SPAM_SCORE = 100

/** Окно жизни подписанного `form_nonce` (`29` §6.3, §7.6): раньше 4 с — бот, позже часа — протух. */
export const VACANCY_NONCE_MIN_SEC = 4
export const VACANCY_NONCE_TTL_SEC = 3600

/** Подтверждение контакта кодом (`29` §7.5): 10 минут жизни, сутки на ввод, 3 отправки в час. */
export const VACANCY_APPLY_OTP_TTL_SEC = 600
export const VACANCY_APPLY_OTP_SENDS_PER_HOUR = 3
export const VACANCY_APPLY_EXPIRE_HOURS = 24

/**
 * Версия текста согласия на обработку ПД, записываемая в `vacancy_applications`
 * и далее в карточку человека (`29` §7.23).
 *
 * [гипотеза] §7.23 говорит «сам текст версионируется в настройках тенанта», но ни экрана,
 * ни колонки под редактируемый текст согласия в продукте нет. [решение] Версия зафиксирована
 * константой продукта: смысл колонки — «по какой редакции текста человек дал согласие», и
 * выдуманная колонка настроек не сделала бы её честнее. Когда текст станет редактируемым
 * (`docs/32`), константа сменится на значение из настроек — колонка уже на месте, и
 * переписывать выданные согласия не придётся.
 */
export const PUBLIC_CONSENT_TEXT_VERSION = 'consent-2026-09'

/**
 * Площадка публикации вакансии (`job_board_accounts.provider`, `vacancy_publications`,
 * `29` §3.7). Три площадки эталона; `telegram` здесь — канал объявлений о вакансии, отдельный
 * от `tenant_secrets.telegram` (бот напоминаний): собственный ключ `key` разводит секреты
 * одного тенанта в общей таблице (docs/v2/45 PR-17).
 */
export const JOB_BOARD_PROVIDERS = ['work_ua', 'robota_ua', 'telegram'] as const
export type JobBoardProvider = typeof JOB_BOARD_PROVIDERS[number]

/** Кто распоряжается аккаунтом площадки (`job_board_accounts.owner_type`, `29` §3.7 [решение]). */
export const JOB_BOARD_OWNER_TYPES = ['company', 'personal', 'recruiter'] as const
export type JobBoardOwnerType = typeof JOB_BOARD_OWNER_TYPES[number]

/** Состояние аккаунта площадки (`job_board_accounts.status`, `29` §3.7, статусы из `docs/09` §9.3). */
export const JOB_BOARD_ACCOUNT_STATUSES = ['not_connected', 'connecting', 'active', 'failing', 'revoked', 'disabled'] as const
export type JobBoardAccountStatus = typeof JOB_BOARD_ACCOUNT_STATUSES[number]

/**
 * Состояние публикации (`vacancy_publications.state`, `29` §3.8, §4, §7.13–§7.17).
 *
 * > [исправлено, PR-17: `44` §8 предписывает обходной путь «рекрутер публикує вручну,
 * > без площадки» — состоянию нужно имя] Ранее перечень заканчивался на `conflict`.
 * > Добавлено `manual`: строка публикации, у которой нет и не будет вызова адаптера —
 * > рекрутер сам разместил об'яву на площадці і вставив посилання. Це не синонім `active`:
 * > `active` тримає `external_id`, здатний піти в `update()`/`remove()` адаптера, а `manual`
 * > — ні, і фонові задачі `vacancy.publish_external`/`vacancy.publication_health` рядки
 * > `manual` не чіпають зовсім (нема секрету і нема з чим звертатись до провайдера).
 */
export const VACANCY_PUBLICATION_STATES = ['queued', 'publishing', 'active', 'failed', 'removed', 'expired', 'conflict', 'manual'] as const
export type VacancyPublicationState = typeof VACANCY_PUBLICATION_STATES[number]

/** Ретраи временной ошибки публикации (`29` §7.16): 1, 5, 25 минут, затем `failed`. */
export const VACANCY_PUBLISH_RETRY_DELAYS_SEC = [60, 300, 1500] as const

/** Через сколько дней истёкшая публикация напоминает о себе (`29` §11 `vacancy.publication_expiring`). */
export const VACANCY_PUBLICATION_EXPIRING_DAYS = 3

/**
 * Блок формы вакансии, который умеет генерировать ИИ (`vacancy_ai_generations.target`,
 * `vacancies.ai_blocks`, `29` §3.6, §3.10, §7.10–§7.11). `criteria` — тоже цель генерации
 * (черновик критериев), хотя пишет не в `ai_blocks`, а в отдельный ответ §7.11.
 */
export const VACANCY_AI_GENERATION_TARGETS = ['description', 'requirements', 'duties', 'extra', 'criteria'] as const
export type VacancyAiGenerationTarget = typeof VACANCY_AI_GENERATION_TARGETS[number]

/** Итог вызова ИИ-генерации (`vacancy_ai_generations.status`, `29` §3.10): `limited` не списывает операцию (§7.10). */
export const VACANCY_AI_GENERATION_STATUSES = ['ok', 'failed', 'limited'] as const
export type VacancyAiGenerationStatus = typeof VACANCY_AI_GENERATION_STATUSES[number]

/** Лимит символов одного сгенерированного блока (`29` §7.10) — тот же, что у ручного ввода блока (§6.1). */
export const VACANCY_AI_TEXT_MAX_CHARS = 2500

/** Черновик критериев от ИИ (`29` §7.11): от и до строк в ответе. */
export const VACANCY_AI_CRITERIA_MIN = 3
export const VACANCY_AI_CRITERIA_MAX = 8

/**
 * Всплеск блокировок публичной формы (`29` §7.8): порог за час, на который ужесточаются
 * частотные лимиты §7.4, и срок ужесточения.
 */
export const VACANCY_SPAM_BURST_THRESHOLD_PER_HOUR = 20
export const VACANCY_SPAM_BURST_HARDEN_HOURS = 6
export const VACANCY_SPAM_BURST_HARDEN_DIVISOR = 2

/**
 * Вид работы в очереди проверки (`review_queue_items.task_type`, docs/v2/37 §3.1,
 * решение docs/v2/44 В-2). Он же «Тип завдання» — колонка, фильтр и таб экрана «Черга
 * перевірки» (`37` §5.1).
 *
 * **Одна ось, а не две.** В-2 перечисляет `source` (`test_answer` | `workshop` |
 * `offline_confirm` | `survey_open`), `37` §3.1 — `task_type` (те же четыре под именами
 * интерфейса плюс `ai_interview_review`). Это одно и то же измерение под двумя именами:
 * значение однозначно указывает и таблицу источника, и подпись в интерфейсе. Две колонки
 * одной оси однажды разойдутся, и починить их будет нечем — оставлено `task_type`
 * (Р-18.1 в `docs/v2/46-progress.md`).
 *
 * Куда смотрит `source_id` при каждом значении:
 * `quiz_open_answer` → `attempt_answers.id`; `workshop` → `workshop_submissions.id`;
 * `offline_confirm` → `certification_attempts.id`; `survey_open` → ответ опроса;
 * `ai_interview_review` → сессия ИИ-собеседования (PR-28). Первые два наполняются с PR-18,
 * остальные — по мере появления своих модулей.
 */
export const REVIEW_TASK_TYPES = ['quiz_open_answer', 'workshop', 'offline_confirm', 'survey_open', 'ai_interview_review'] as const
export type ReviewTaskType = typeof REVIEW_TASK_TYPES[number]

/**
 * Состояние элемента очереди (`review_queue_items.status`, docs/14 §3.3, docs/v2/37 §4).
 * `delegated` — есть активное делегирование, работа у делегата; `escalated` — срок нарушен на
 * 150 %, работу видит и руководитель области (PR-19). `done` — терминальное: решение принято.
 * Повторная сдача после доработки открывает **ту же** строку заново (`enqueueReview()` через
 * `on conflict do update`), потому что источник переиспользует ту же `workshop_submissions.id`.
 */
export const REVIEW_QUEUE_STATUSES = ['waiting', 'in_review', 'delegated', 'escalated', 'done'] as const
export type ReviewQueueStatus = typeof REVIEW_QUEUE_STATUSES[number]

/** Причина делегирования (`review_delegations.reason_code`, docs/v2/37 §3.2, §6.1); при `other` пояснение 10–500. */
export const REVIEW_DELEGATION_REASONS = ['absence', 'workload', 'expertise', 'conflict_of_interest', 'location_change', 'other'] as const
export type ReviewDelegationReason = typeof REVIEW_DELEGATION_REASONS[number]

/**
 * Состояние звена делегирования (`review_delegations.state`, docs/v2/37 §4): `resolved` — делегат
 * принял решение, `revoked_by_author` / `revoked_by_manager` — отозвано, `revoked_sla` — делегат
 * не уложился в срок и работа вернулась (§7.5), `cancelled` — работа аннулирована.
 */
export const REVIEW_DELEGATION_STATES = ['active', 'resolved', 'revoked_by_author', 'revoked_by_manager', 'revoked_sla', 'cancelled'] as const
export type ReviewDelegationState = typeof REVIEW_DELEGATION_STATES[number]

/** Стратегия правила распределения (`review_routing_rules.strategy`, docs/v2/37 §3.3, §7.16). */
export const REVIEW_ROUTING_STRATEGIES = ['location_mentor', 'course_author', 'specific_list', 'round_robin', 'least_loaded', 'manual'] as const
export type ReviewRoutingStrategy = typeof REVIEW_ROUTING_STRATEGIES[number]

/** Вид отсутствия проверяющего (`reviewer_absences.kind`, docs/v2/37 §3.4, §7.18); `dismissal` — бессрочно. */
export const REVIEWER_ABSENCE_KINDS = ['vacation', 'sick', 'training', 'dismissal', 'other'] as const
export type ReviewerAbsenceKind = typeof REVIEWER_ABSENCE_KINDS[number]

/** Событие журнала SLA (`review_sla_events.event`, docs/v2/37 §3.4, §7.17, §7.19). */
export const REVIEW_SLA_EVENTS = ['assigned', 'warned', 'breached', 'escalated', 'reassigned', 'resolved', 'delegation_expired'] as const
export type ReviewSlaEvent = typeof REVIEW_SLA_EVENTS[number]

/**
 * Достоверность измерения времени (`review_queue_items.time_confidence`, docs/v2/37 §7.15).
 * `partial` — биения дошли не все (офлайн-досылка); `unreliable` — в расчёт нормы
 * (`observed_seconds`) сеанс не входит. Наполняется с PR-21, до него всегда `ok`.
 */
export const REVIEW_TIME_CONFIDENCE = ['ok', 'partial', 'unreliable'] as const
export type ReviewTimeConfidence = typeof REVIEW_TIME_CONFIDENCE[number]

/**
 * Вид измеряемого времени (`learning_time_sessions.kind`, docs/v2/37 §3.6, §7.12):
 * `content` — «Час на контент» (изучение материала), `attempt` — «Час на випробування»
 * (выполнение теста или сдача практикума). Виды одного элемента не пересекаются.
 */
export const LEARNING_TIME_KINDS = ['content', 'attempt'] as const
export type LearningTimeKind = typeof LEARNING_TIME_KINDS[number]

/**
 * Элемент, по которому меряется время (`learning_time_sessions.subject_type`, `37` §3.6).
 * Тот же перечень у норм времени `content_time_norms.subject_type` (`37` §3.5, PR-22).
 */
export const LEARNING_TIME_SUBJECT_TYPES = ['lesson', 'quiz', 'workshop', 'track_node'] as const
export type LearningTimeSubjectType = typeof LEARNING_TIME_SUBJECT_TYPES[number]

/**
 * Почему закрыт сегмент измерения (`learning_time_sessions.closed_reason`, `37` §3.6, §4):
 * `completed` — элемент завершён (урок зачтён, попытка или сдача отправлены); `idle_timeout` —
 * следующее биение пришло позже 120 с; `segment_cap` — 90 минут подряд, «Ви ще тут?»;
 * `daily_cap` — 8 часов за сутки; `navigated_away` — открыт другой сеанс того же элемента
 * (второе устройство или смена вида); `session_end` — экран закрыт; `stale` — биений нет
 * дольше 120 с, закрыто фоновой задачей (предварительно: вернувшийся сеанс переписывает её
 * на `idle_timeout`, решение Р-21.5).
 */
export const LEARNING_TIME_CLOSED_REASONS = ['completed', 'idle_timeout', 'segment_cap', 'daily_cap', 'navigated_away', 'session_end', 'stale'] as const
export type LearningTimeClosedReason = typeof LEARNING_TIME_CLOSED_REASONS[number]

/**
 * Откуда «Розрахунковий час» элемента (`content_time_norms.source`, docs/v2/37 §3.5, §7.13;
 * PR-22): `author` — число автора (форма §6.3 или «Орієнтовний час» материала); `auto` —
 * расчёт по объёму; `observed` — медиана факта, которую автор принял кнопкой «Застосувати».
 * Молча система норму не меняет: `observed` появляется только нажатием.
 */
export const CONTENT_TIME_NORM_SOURCES = ['author', 'auto', 'observed'] as const
export type ContentTimeNormSource = typeof CONTENT_TIME_NORM_SOURCES[number]

/**
 * Флаг отклонения факта от нормы (`content_time_norms.deviation_flag`, `37` §7.14): медиана
 * факта больше нормы вдвое — `too_slow`, меньше 0,4 нормы — `too_fast`, выборка меньше 10 или
 * норма не задана — `no_data`. **Сигнал качества материала, а не оценка человека**: флаг не
 * входит ни в одну формулу балла, зачёта, рейтинга и начисления баллов (`37` §7.14 б).
 */
export const CONTENT_TIME_DEVIATION_FLAGS = ['none', 'too_fast', 'too_slow', 'no_data'] as const
export type ContentTimeDeviationFlag = typeof CONTENT_TIME_DEVIATION_FLAGS[number]

/**
 * Способ ввода ответа (`attempt_answers.input_mode`, docs/v2/30 §3.7, решение docs/v2/44 В-12):
 * голос — не новый тип вопроса, а способ ответа. Четыре значения DDL `30` §3.7 (`video` —
 * видеоответ собеседования при `record_video`, `30` §3.3).
 */
export const ANSWER_INPUT_MODES = ['text', 'voice', 'video', 'file'] as const
export type AnswerInputMode = typeof ANSWER_INPUT_MODES[number]
/** На что жалуются (`v2/36` §3.1): девять видов элементов контента. */
export const CONTENT_ISSUE_TARGET_TYPES = [
  'resource', 'lesson', 'block', 'quiz', 'question', 'workshop', 'survey', 'knowledge_article', 'media',
] as const
export type ContentIssueTargetType = typeof CONTENT_ISSUE_TARGET_TYPES[number]

/**
 * Типы проблем (`v2/36` §7.3) — закрытый список, он же фильтр «Тип» очереди. Построен не по
 * предметности, а по тому, **кто чинит и чем**: три `broken_*` разведены потому, что это три
 * разные починки, `bad_question`/`wrong_key` — единственные, что тянут пересчёт результатов,
 * `tech` уходит администратору, а не автору.
 */
export const CONTENT_ISSUE_TYPES = [
  'typo', 'wrong_fact', 'outdated', 'unclear', 'broken_media', 'broken_link', 'broken_file',
  'bad_question', 'wrong_key', 'tech', 'other',
] as const
export type ContentIssueType = typeof CONTENT_ISSUE_TYPES[number]

/** Типы, при которых комментарий обязателен (`v2/36` §3.1, форма §6.1). */
export const CONTENT_ISSUE_COMMENT_REQUIRED: readonly ContentIssueType[] = ['other', 'wrong_fact', 'bad_question', 'wrong_key']

/** Статус карточки дефекта (`v2/36` §4). */
export const CONTENT_ISSUE_STATUSES = ['new', 'in_progress', 'fixed', 'rejected', 'deferred', 'closed'] as const
export type ContentIssueStatus = typeof CONTENT_ISSUE_STATUSES[number]

/** Резолюция разбора (`v2/36` §4, §6.2). */
export const CONTENT_ISSUE_RESOLUTIONS = ['fixed', 'question_fixed', 'question_void', 'not_an_error', 'duplicate', 'wont_fix', 'spam'] as const
export type ContentIssueResolution = typeof CONTENT_ISSUE_RESOLUTIONS[number]

/** Важность карточки (`v2/36` §7.4): считает система, не человек. */
export const CONTENT_ISSUE_SEVERITIES = ['blocking', 'normal', 'cosmetic'] as const
export type ContentIssueSeverity = typeof CONTENT_ISSUE_SEVERITIES[number]

/** Состояние пересчёта результатов по карточке (`v2/36` §7.8). */
export const CONTENT_ISSUE_RESCORE_STATES = ['none', 'needed', 'in_progress', 'done', 'skipped'] as const
export type ContentIssueRescoreState = typeof CONTENT_ISSUE_RESCORE_STATES[number]

/** Откуда подана жалоба (`v2/36` §3.2, §5.1). */
export const CONTENT_REPORT_SOURCES = ['lesson', 'attempt', 'workshop', 'catalog', 'knowledge', 'review'] as const
export type ContentReportSource = typeof CONTENT_REPORT_SOURCES[number]

/** Событие журнала карточки (`v2/36` §3). */
export const CONTENT_ISSUE_EVENT_KINDS = ['created', 'merged', 'status_changed', 'assigned', 'commented', 'rescored', 'reopened'] as const
export type ContentIssueEventKind = typeof CONTENT_ISSUE_EVENT_KINDS[number]

/**
 * Защита от злоупотребления (`v2/36` §7.7, §7.10, §7.11) — одни и те же числа для сервера,
 * формы и тестов. Шестая жалоба за сутки отвергается текстом, а не молча: счётчик и предел
 * приходят в теле ошибки `content_issue.rate_limited`.
 */
export const CONTENT_ISSUE_LIMITS = {
  /** Жалоб в сутки на человека. */
  perDay: 5,
  /** Жалоб за календарный месяц на человека. */
  perMonth: 20,
  /** Жалоб за одну попытку теста. */
  perAttempt: 3,
  /** Компенсация времени формы, секунд на жалобу (`v2/36` §7.7 б). */
  deadlineShiftSecPerReport: 60,
  /** Компенсация времени формы, секунд за всю попытку. */
  deadlineShiftSecPerAttempt: 180,
  /** Резолюций `spam` подряд до автоматического mute. */
  spamStreakToMute: 3,
  /** Окно, в котором считается серия `spam`, дней. */
  spamStreakWindowDays: 30,
  /** Длительность автоматического mute, дней. */
  muteDays: 14,
} as const

/**
 * Валюта книги операций (`points_ledger.currency`, docs/15 §14.3 «Нагороди»). У эталона в
 * назначении два разных поля: «Бали за виконання завдання» — «використовуються для розрахунку
 * рейтингу», «Бонуси за виконання завдання» — «для купівлі товарів у магазині подарунків».
 * Одна книга, две валюты: баланс считается по валюте, трата бонусов рейтинг не уменьшает.
 */
export const POINTS_CURRENCIES = ['points', 'bonuses'] as const
export type PointsCurrency = typeof POINTS_CURRENCIES[number]

/**
 * Событие книги операций (`points_ledger.event`) — колонка «Подія» журнала эталона
 * `/gift-store/bonuses-log` (docs/21 §14.9): «Виконання завдання», «Ручне нарахування»,
 * «Покупка»; плюс `refund` — возврат при отмене заказа отдельной строкой, а не удалением
 * покупки (docs/21 Г-21.1: «обе операции — строками в книге»).
 */
export const POINTS_EVENTS = ['task_completed', 'manual', 'purchase', 'refund'] as const
export type PointsEvent = typeof POINTS_EVENTS[number]

/**
 * Статус заказа в магазине (`shop_orders.status`, docs/02 «Корпоративный хаб», docs/21 Г-21.1
 * `[решение]`): `reserved` — бонусы списаны и остаток уменьшен, `ready` — подготовлено на
 * точке, `issued` — выдано (кто и когда), `cancelled` — бонусы и остаток возвращены.
 */
export const SHOP_ORDER_STATUSES = ['reserved', 'ready', 'issued', 'cancelled'] as const
export type ShopOrderStatus = typeof SHOP_ORDER_STATUSES[number]

/**
 * Библиотека переиспользуемых модулей (`v2/31` §3, §4; PR-25 плана `docs/v2/45`).
 *
 * Тип модуля своего перечня не имеет (`31` §7.7, Р-31.5): `library_modules.content_kind` —
 * это `RESOURCE_KINDS` из `shared/schemas/resources.ts`, потому что тело модуля и есть
 * материал (`31` §3.1 в редакции PR-25). Здесь — только то, чего у материала не бывает.
 */

/** Статус карточки модуля (`31` §4): из `archived` назад в `draft` дороги нет — у модуля уже есть версии. */
export const LIBRARY_MODULE_STATUSES = ['draft', 'published', 'archived'] as const
export type LibraryModuleStatus = typeof LIBRARY_MODULE_STATUSES[number]

/** Статус версии (`31` §4): `retired` — ни одно активное место её не закрепляет; тело-снимок остаётся. */
export const LIBRARY_VERSION_STATUSES = ['published', 'retired'] as const
export type LibraryVersionStatus = typeof LIBRARY_VERSION_STATUSES[number]

/** Кто держит ссылку на версию (`31` §3.4): узел графа траектории или урок курса. */
export const LIBRARY_HOLDER_TYPES = ['trajectory_node', 'course_lesson'] as const
export type LibraryHolderType = typeof LIBRARY_HOLDER_TYPES[number]

/** Контейнер места использования (`31` §3.4) — строка «Трек/Курс» экрана «Де використовується». */
export const LIBRARY_CONTAINER_TYPES = ['trajectory', 'course'] as const
export type LibraryContainerType = typeof LIBRARY_CONTAINER_TYPES[number]

/**
 * Режим закрепления версии (`31` §3.4, §7.2, §7.4). Версия закреплена **всегда**; режим
 * отвечает только на вопрос, доезжает ли «Критичне виправлення» само. По умолчанию —
 * `hotfix_auto` (Р-31.4 и критерий приёмки 6; DDL `31` §3.6 исправлен PR-25).
 */
export const LIBRARY_PIN_MODES = ['fixed', 'hotfix_auto'] as const
export type LibraryPinMode = typeof LIBRARY_PIN_MODES[number]

/** Предложение урока в библиотеку (`31` §3.5, §4): все три исхода конечные. */
export const LIBRARY_PROPOSAL_STATUSES = ['pending', 'accepted', 'rejected', 'withdrawn'] as const
export type LibraryProposalStatus = typeof LIBRARY_PROPOSAL_STATUSES[number]

// ── Карточка человека: заметки и документы (docs/v2/38-people-extensions.md §3.4, §3.5, PR-32) ──

/**
 * Видимость заметки о человеке (`user_notes.visibility`, `v2/38` §3.4, §7.4). Уровня
 * «тільки автор» нет — такую заметку никто не проверит и она не переживёт ротацию
 * руководителя. `shared_with_person` однонаправленный (§4): открытое человеку назад не
 * закрывается, он это уже прочитал — `409 visibility_narrowing_forbidden`.
 */
export const PERSON_NOTE_VISIBILITIES = ['hr', 'manager', 'shared_with_person'] as const
export type PersonNoteVisibility = typeof PERSON_NOTE_VISIBILITIES[number]

/** Категория заметки (`user_notes.category`, `v2/38` §3.4) — определяет срок хранения (§7.6). */
export const PERSON_NOTE_CATEGORIES = ['general', 'onboarding', 'performance', 'training_plan', 'incident', 'agreement'] as const
export type PersonNoteCategory = typeof PERSON_NOTE_CATEGORIES[number]

/**
 * Состояние документа человека (`person_documents.status`, `v2/38` §4): `valid → expiring →
 * expired` двигает срок, `revoked` ставится вручную с причиной или заменой и необратим.
 */
export const PERSON_DOCUMENT_STATUSES = ['valid', 'expiring', 'expired', 'revoked'] as const
export type PersonDocumentStatus = typeof PERSON_DOCUMENT_STATUSES[number]

/** Числа заметок (`v2/38` §3.4, §6.1, §7.6) — одни для сервера, формы и тестов. */
export const PERSON_NOTE_LIMITS = {
  bodyMin: 3,
  bodyMax: 2000,
  /** Закреплённых заметок на человека (§3.4): «договорённость о развитии», а не лента. */
  pinnedMax: 3,
  /** Срок хранения `general`, `onboarding`, `performance`, `incident` (§7.6). */
  retentionMonths: 24,
  /** Срок хранения `training_plan`, `agreement` и любой закреплённой (§7.6). */
  retentionMonthsLong: 36,
} as const

/** Категории заметок с долгим сроком хранения (§7.6): договорённость переживает годовой цикл. */
export const PERSON_NOTE_LONG_RETENTION: readonly PersonNoteCategory[] = ['training_plan', 'agreement']

/** Числа документов (`v2/38` §3.5, §6.2, §7.8). */
export const PERSON_DOCUMENT_LIMITS = {
  titleMax: 120,
  numberMax: 32,
  /** Хранятся последние 4 знака номера (§7.7): факт, а не содержание. */
  numberKeep: 4,
  noteMax: 300,
  reasonMin: 5,
  reasonMax: 300,
  fileMaxMb: 20,
  fileMimes: ['application/pdf', 'image/jpeg', 'image/png'],
  /** Файл хранится ещё 3 года после истечения — срок исковой давности по трудовым спорам (§7.8). */
  retentionYearsAfterExpiry: 3,
  /** После истечения напоминание ежедневно ещё 14 дней, дальше — тишина (§7.8). */
  expiredReminderDays: 14,
} as const

/**
 * Семь системных типов документов нового тенанта (`v2/38` §3.5). `is_system` запрещает
 * удаление; название, обязательность, срок, посады тенант правит. Здесь и в миграции
 * `v2_person_notes_docs` — две копии одного списка, как у колонок воронки.
 *
 * `medical_book` — факт и срок без файла (§7.7). Обязателен «для посад из
 * `required_positions`», но при создании тенанта посад ещё нет, а пустой список значит
 * «для всех» — HR сужает его сам.
 */
export const SYSTEM_PERSON_DOCUMENT_TYPES: {
  code: string
  name: string
  isRequired: boolean
  validityMonths: number | null
  isFactOnly: boolean
  selfUpload: boolean
}[] = [
  { code: 'employment_contract', name: 'Трудовий договір', isRequired: true, validityMonths: null, isFactOnly: false, selfUpload: false },
  { code: 'labor_safety_briefing', name: 'Інструктаж з охорони праці', isRequired: true, validityMonths: 12, isFactOnly: false, selfUpload: false },
  { code: 'fire_safety_briefing', name: 'Інструктаж з пожежної безпеки', isRequired: true, validityMonths: 12, isFactOnly: false, selfUpload: false },
  { code: 'medical_book', name: 'Медична книжка', isRequired: true, validityMonths: 12, isFactOnly: true, selfUpload: false },
  { code: 'nda', name: 'Угода про нерозголошення', isRequired: true, validityMonths: null, isFactOnly: false, selfUpload: false },
  { code: 'external_certificate', name: 'Сертифікат стороннього навчання', isRequired: false, validityMonths: null, isFactOnly: false, selfUpload: true },
  { code: 'other', name: 'Інше', isRequired: false, validityMonths: null, isFactOnly: false, selfUpload: false },
]

/**
 * Кому адресовано объявление платформы (`platform_announcements.audience`, docs/v2/39 П-21
 * [решение]: «всем / по тарифу / конкретным тенантам»). Список тарифов и тенантов — в
 * `plan_codes` и `tenant_ids` той же строки, CHECK держит их согласованными с видом адресации.
 */
export const ANNOUNCEMENT_AUDIENCES = ['all', 'plans', 'tenants'] as const
export type AnnouncementAudience = typeof ANNOUNCEMENT_AUDIENCES[number]

/**
 * Уровень нормы отсутствий (`absence_norms.scope_type`, docs/v2/38 §3.6, §7.13): компания,
 * точка, человек. Разрешение — снизу вверх, по каждому виду отдельно: человек → точка →
 * компания → системный дефолт (відпустка 24, лікарняний 5).
 */
export const ABSENCE_NORM_SCOPES = ['tenant', 'location', 'user'] as const
export type AbsenceNormScope = typeof ABSENCE_NORM_SCOPES[number]

/**
 * Вид отсутствия человека (`absence_records.kind`, docs/v2/38 §3.6). Норма ведётся только для
 * `vacation` и `sick` (§7.13); `unpaid` и `other` учитываются как факт — для остатка их нет,
 * а дедлайн обязательного обучения они сдвигают так же (§7.14: «покрытые отсутствием» дни).
 * Не путать с `reviewer_absence_kind` — отсутствие проверяющего из docs/v2/37 (`41` §8.3.4).
 */
export const ABSENCE_KINDS = ['vacation', 'sick', 'unpaid', 'other'] as const
export type AbsenceKind = typeof ABSENCE_KINDS[number]
/** Виды с нормой (`absence_norms.vacation_days` / `sick_days`, §7.13). */
export const ABSENCE_NORM_KINDS = ['vacation', 'sick'] as const satisfies readonly AbsenceKind[]
export type AbsenceNormKind = typeof ABSENCE_NORM_KINDS[number]

/**
 * Состояние записи отсутствия (`absence_records.status`, `38` §4): `planned → approved →
 * cancelled`. В остаток входит только `approved` (§7.13); дедлайны и напоминания блокируют
 * `planned` и `approved` (§7.14). `cancelled` — конечное.
 */
export const ABSENCE_STATUSES = ['planned', 'approved', 'cancelled'] as const
export type AbsenceStatus = typeof ABSENCE_STATUSES[number]

/** Откуда пришла запись отсутствия (`absence_records.source`, `38` §3.6): вручную, импортом, по API. */
export const ABSENCE_SOURCES = ['manual', 'import', 'api'] as const
export type AbsenceSource = typeof ABSENCE_SOURCES[number]

/**
 * Почему сдвинут дедлайн записи (`enrollments.deadline_shifted_reason`, `38` §7.14, §13 к. 10).
 * Единственное значение задано документом; ручное продление (`POST /manage/enrollments/:id/extend`)
 * причину снимает — действующий срок поставил человек, а не правило.
 */
export const DEADLINE_SHIFT_REASONS = ['absence'] as const
export type DeadlineShiftReason = typeof DEADLINE_SHIFT_REASONS[number]

/** Числа записей отсутствий (`38` §6.3, §6.4) — одни для сервера, формы и тестов. */
export const ABSENCE_LIMITS = {
  commentMax: 300,
  reasonMin: 5,
  reasonMax: 300,
  /**
   * Самая длинная запись — 366 календарных дней `[решение]` (`38` §3.6 [дополнено, PR-33]):
   * `days_count numeric(4,1)` и норма на календарный год; более долгое отсутствие вносится
   * записями по годам.
   */
  maxRangeDays: 366,
} as const

// ── Провайдер модели и журнал вызовов (docs/v2/30 §3.2, план `45` PR-27) ──────────────────

/**
 * Роль профиля провайдера (`ai_providers.purpose`, `ai_calls.purpose`): одна роль на профиль.
 * Четыре — из `30` §3.2; `generate` и `embed` добавлены PR-27 (пометка-исправление там же):
 * генерация текста вакансии (PR-17) и эмбеддинги библиотеки и базы знаний (PR-25) — тоже
 * вызовы модели, и без своей роли они шли бы мимо профиля, журнала и оси потребления.
 */
export const AI_PURPOSES = ['transcribe', 'interview_score', 'review_hint', 'summary', 'generate', 'embed'] as const
export type AiPurpose = typeof AI_PURPOSES[number]

/**
 * Драйвер профиля (`ai_providers.driver`, `30` §3.2): вендор скрыт за драйвером. `stub` —
 * детерминированная заглушка без сети (`docs/v2/44` §8, `HANDOFF` §6): четвёртое значение
 * сверх документа, чтобы «работает заглушка» было строкой профиля, а не переменной окружения.
 */
export const AI_DRIVERS = ['openai_compatible', 'http_custom', 'self_hosted', 'stub'] as const
export type AiDriver = typeof AI_DRIVERS[number]

/** Сколько данные живут у поставщика (`ai_providers.provider_retention`, `30` §3.2, §7.7). */
export const AI_PROVIDER_RETENTIONS = ['none', 'ephemeral', 'unknown'] as const
export type AiProviderRetention = typeof AI_PROVIDER_RETENTIONS[number]

/** Регион обработки данных (`ai_providers.data_region`, `30` §3.2): `other` — только с комментарием админа. */
export const AI_DATA_REGIONS = ['eu', 'other'] as const
export type AiDataRegion = typeof AI_DATA_REGIONS[number]

/**
 * Итог вызова (`ai_calls.status`, `30` §3.2). `refused` — вызов не сделан: жёсткая ось
 * исчерпана, ИИ-подписка не действует, профиля нет; `degraded` — вызов не сделан, а операция
 * идёт дальше без ИИ (ось «жёсткий с деградацией», `35` §7.1).
 */
export const AI_CALL_STATUSES = ['queued', 'running', 'ok', 'failed', 'timeout', 'refused', 'degraded'] as const
export type AiCallStatus = typeof AI_CALL_STATUSES[number]

/**
 * О чём вызов (`ai_calls.ref_kind`, мягкая ссылка, `44` В-11). Четыре — `30` §3.2; ещё четыре
 * добавлены PR-27 для вызовов, которые были до журнала: генерация вакансии (`ref_id` — строка
 * `vacancy_ai_generations`), эмбеддинг модуля библиотеки и статьи базы знаний, вектор
 * поискового запроса (`ref_id` пуст — запрос не сущность).
 */
export const AI_CALL_REF_KINDS = [
  'interview_session', 'interview_turn', 'review_hint', 'summary',
  'vacancy_generation', 'library_module', 'knowledge_article', 'search_query',
] as const
export type AiCallRefKind = typeof AI_CALL_REF_KINDS[number]

/** Три ИИ-оси тарифа (`35` §7.1, §7.7 п. 3): подмножество `LIMIT_AXES`, `ai_calls.usage_axis`. */
export const AI_USAGE_AXES = ['ai_interview_ops', 'ai_review_ops', 'ai_generate_ops'] as const satisfies readonly LimitAxis[]
export type AiUsageAxis = typeof AI_USAGE_AXES[number]

/**
 * Вид события ленты активности (`user_activity_events.kind`, docs/v2/38 §3.3, §7.9; PR-34).
 * Закрытый список из двенадцати: карта отвечает на «людина вчилася?», поэтому вход в систему,
 * открытие урока без завершения, просмотр списка или карточки, уведомление и сообщение событиями
 * не являются. `review_graded` и `content_issue_accepted` — учебная работа наставника и автора
 * замечаний. Кто и где порождает каждый вид — `ACTIVITY_SOURCES` в `shared/domain/activity.ts`.
 */
export const USER_ACTIVITY_KINDS = [
  'lesson_completed', 'attempt_submitted', 'attempt_graded', 'enrollment_started', 'enrollment_completed',
  'workshop_submitted', 'checklist_run_completed', 'knowledge_read', 'survey_submitted', 'certificate_issued',
  'review_graded', 'content_issue_accepted',
] as const
export type UserActivityKind = typeof USER_ACTIVITY_KINDS[number]

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
  org_conflict_severity: ORG_CONFLICT_SEVERITIES,
  org_node_type: ORG_NODE_TYPES,
  org_node_state: ORG_NODE_STATES,
  org_assignment_role: ORG_ASSIGNMENT_ROLES,
  org_assignment_end_reason: ORG_ASSIGNMENT_END_REASONS,
  org_manager_source: ORG_MANAGER_SOURCES,
  org_snapshot_kind: ORG_SNAPSHOT_KINDS,
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
  storage_retention_anchor: STORAGE_RETENTION_ANCHORS,
  storage_retention_action: STORAGE_RETENTION_ACTIONS,
  storage_deletion_mode: STORAGE_DELETION_MODES,
  storage_deletion_status: STORAGE_DELETION_STATUSES,
  storage_skip_reason: STORAGE_SKIP_REASONS,
  storage_pending_upload_status: STORAGE_PENDING_UPLOAD_STATUSES,
  candidate_state: CANDIDATE_STATES,
  candidate_source: CANDIDATE_SOURCES,
  candidate_score_kind: CANDIDATE_SCORE_KINDS,
  candidate_comment_visibility: CANDIDATE_COMMENT_VISIBILITIES,
  candidate_reject_reason: CANDIDATE_REJECT_REASONS,
  review_task_type: REVIEW_TASK_TYPES,
  review_queue_status: REVIEW_QUEUE_STATUSES,
  review_time_confidence: REVIEW_TIME_CONFIDENCE,
  learning_time_kind: LEARNING_TIME_KINDS,
  learning_time_subject_type: LEARNING_TIME_SUBJECT_TYPES,
  learning_time_closed_reason: LEARNING_TIME_CLOSED_REASONS,
  content_time_norm_source: CONTENT_TIME_NORM_SOURCES,
  content_time_deviation_flag: CONTENT_TIME_DEVIATION_FLAGS,
  answer_input_mode: ANSWER_INPUT_MODES,
  review_delegation_reason: REVIEW_DELEGATION_REASONS,
  review_delegation_state: REVIEW_DELEGATION_STATES,
  review_routing_strategy: REVIEW_ROUTING_STRATEGIES,
  reviewer_absence_kind: REVIEWER_ABSENCE_KINDS,
  review_sla_event: REVIEW_SLA_EVENTS,
  content_issue_target_type: CONTENT_ISSUE_TARGET_TYPES,
  content_issue_type: CONTENT_ISSUE_TYPES,
  content_issue_status: CONTENT_ISSUE_STATUSES,
  content_issue_resolution: CONTENT_ISSUE_RESOLUTIONS,
  content_issue_severity: CONTENT_ISSUE_SEVERITIES,
  content_issue_rescore_state: CONTENT_ISSUE_RESCORE_STATES,
  content_report_source: CONTENT_REPORT_SOURCES,
  content_issue_event_kind: CONTENT_ISSUE_EVENT_KINDS,
  vacancy_state: VACANCY_STATES,
  vacancy_employment_type: VACANCY_EMPLOYMENT_TYPES,
  vacancy_work_format: VACANCY_WORK_FORMATS,
  vacancy_experience_level: VACANCY_EXPERIENCE_LEVELS,
  vacancy_education_level: VACANCY_EDUCATION_LEVELS,
  vacancy_language_level: VACANCY_LANGUAGE_LEVELS,
  vacancy_criterion_origin: VACANCY_CRITERION_ORIGINS,
  vacancy_close_reason: VACANCY_CLOSE_REASONS,
  vacancy_application_state: VACANCY_APPLICATION_STATES,
  public_apply_outcome: PUBLIC_APPLY_OUTCOMES,
  points_currency: POINTS_CURRENCIES,
  points_event: POINTS_EVENTS,
  shop_order_status: SHOP_ORDER_STATUSES,
  library_module_status: LIBRARY_MODULE_STATUSES,
  library_version_status: LIBRARY_VERSION_STATUSES,
  library_holder_type: LIBRARY_HOLDER_TYPES,
  library_container_type: LIBRARY_CONTAINER_TYPES,
  library_pin_mode: LIBRARY_PIN_MODES,
  library_proposal_status: LIBRARY_PROPOSAL_STATUSES,
  person_note_visibility: PERSON_NOTE_VISIBILITIES,
  person_note_category: PERSON_NOTE_CATEGORIES,
  person_document_status: PERSON_DOCUMENT_STATUSES,
  announcement_audience: ANNOUNCEMENT_AUDIENCES,
  absence_norm_scope: ABSENCE_NORM_SCOPES,
  absence_kind: ABSENCE_KINDS,
  absence_status: ABSENCE_STATUSES,
  absence_source: ABSENCE_SOURCES,
  deadline_shift_reason: DEADLINE_SHIFT_REASONS,
  job_board_provider: JOB_BOARD_PROVIDERS,
  job_board_owner_type: JOB_BOARD_OWNER_TYPES,
  job_board_account_status: JOB_BOARD_ACCOUNT_STATUSES,
  vacancy_publication_state: VACANCY_PUBLICATION_STATES,
  vacancy_ai_generation_target: VACANCY_AI_GENERATION_TARGETS,
  vacancy_ai_generation_status: VACANCY_AI_GENERATION_STATUSES,
  ai_purpose: AI_PURPOSES,
  ai_driver: AI_DRIVERS,
  ai_provider_retention: AI_PROVIDER_RETENTIONS,
  ai_data_region: AI_DATA_REGIONS,
  ai_call_status: AI_CALL_STATUSES,
  ai_call_ref_kind: AI_CALL_REF_KINDS,
  user_activity_kind: USER_ACTIVITY_KINDS,
}
