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
 * `done` — терминальное: решение принято. Повторная сдача после доработки открывает **ту же**
 * строку заново (`enqueueReview()` через `on conflict do update`), потому что источник
 * переиспользует ту же `workshop_submissions.id`.
 */
export const REVIEW_QUEUE_STATUSES = ['waiting', 'in_review', 'done'] as const
export type ReviewQueueStatus = typeof REVIEW_QUEUE_STATUSES[number]

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
  answer_input_mode: ANSWER_INPUT_MODES,
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
}
