import { sql } from 'drizzle-orm'
import { boolean, check, date, index, integer, jsonb, numeric, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { tenants } from './tenants'
import { users } from './people'
import { locations, positions } from './org'
import { REVIEWER_ABSENCE_KINDS } from '../../../shared/enums'

/** Перечень значений для `check` из справочника, а не литералами: коды видов отсутствия
 * пересекаются с кодами этапов (`training`), и литерал здесь красил бы сквозную проверку 1. */
const inList = (values: readonly string[]) => sql.raw(values.map(v => `'${v}'`).join(', '))

/**
 * Единая очередь проверки (`docs/14-certification.md` §3.3, `docs/v2/37-review-delegation.md` §3.1,
 * решение `docs/v2/44-decisions.md` В-2, миграция `0066_v2_review_queue`).
 *
 * **Таблица, а не витрина.** Базовое ТЗ оставляло выбор открытым («матвью раз в минуту либо
 * обычная таблица»), а `37` делал по этой витрине `alter table` на 21 колонку состояния с тремя
 * внешними ключами. Решение В-2 — вариант C: строка очереди имеет собственную идентичность,
 * потому что на неё ссылаются делегирование, события SLA, «каким правилом назначено» и суточная
 * статистика проверяющего. У строки, собранной запросом, устойчивого идентификатора нет.
 *
 * **Содержание работы сюда не копируется.** Текст ответа, файлы и критерии читаются по
 * `(task_type, source_id)` из источника; здесь живёт только состояние очереди плюс снимки для
 * списка (`task_title`, `track_id`, `location_id`, `position_id`) — чтобы экран рисовался одним
 * запросом, а не join-ом к четырём источникам.
 *
 * **Единый писатель.** Наполняется только `server/services/reviewQueue.ts`
 * (`enqueueReview()` / `closeReview()`), в той же транзакции, что и само событие. Ни триггера,
 * ни матвью, ни пересборки «с нуля»: сквозная проверка 21 (`docs/v2/42` §5) требует, чтобы в
 * коде не было ни `truncate`, ни `delete from review_queue_items` — собственное состояние
 * (`assigned_reviewer_id`, `sla_breached_at`, `delegation_depth`) из источников не
 * восстанавливается.
 */
export const reviewQueueItems = pgTable('review_queue_items', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),

  // ── Идентичность работы ───────────────────────────────────────────────────────────────
  /**
   * Одно из `REVIEW_TASK_TYPES`. Одна ось вместо двух: В-2 называет `source`
   * (`test_answer | workshop | offline_confirm | survey_open`), `37` §3.1 — `task_type`
   * (те же значения под именами интерфейса плюс `ai_interview_review`). Держать обе — значит
   * завести две колонки одной оси, которые однажды разойдутся; оставлен `task_type`, потому
   * что на него смотрят фильтр «Тип завдання», табы и отчёты (`docs/v2/46-progress.md`, Р-18.1).
   */
  taskType: text('task_type').notNull(),
  /** Строка источника: `attempt_answers.id` | `workshop_submissions.id` | … Без FK — ссылка полиморфная. */
  sourceId: uuid('source_id').notNull(),
  /** Чья работа. Списки людей фильтруются `kind`-ом, очередь — нет: её собственный `subject_kind` уже снят. */
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /**
   * Сотрудник или кандидат (`USER_KINDS`). Снимается из `users.kind` **один раз**, при
   * постановке в очередь (решение В-8 × В-2): фильтр применяется в `enqueueReview()`, а не в
   * каждом чтении очереди. Найм кандидата не переписывает уже стоящие в очереди работы —
   * маскировка ПД в карточке проверки считается по состоянию на момент сдачи.
   */
  subjectKind: text('subject_kind').notNull().default('employee'),

  // ── Снимки для списка (`37` §5.1, порядок колонок эталона) ────────────────────────────
  /** «Назва завдання» на момент сдачи: переименование материала не переписывает очередь. */
  taskTitle: text('task_title'),
  /** «Трек»: курс или траектория. Снимок идентификатора без FK — источник полиморфный. */
  trackId: uuid('track_id'),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
  positionId: uuid('position_id').references(() => positions.id, { onDelete: 'set null' }),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  /** «Дата виконання» — момент, когда проверка закрыта (`closeReview()`); у `waiting` пусто. */
  completedAt: timestamp('completed_at', { withTimezone: true }),
  /** «Кількість спроб» — какая по счёту сдача. Имя `attempt_no` — как в `workshop_submissions`. */
  attemptNo: integer('attempt_no').notNull().default(1),
  /**
   * «Розрахунковий час» — снимок нормы на момент сдачи (`37` §3.5, §7.14): кладёт писатель
   * работы из `plannedSecondsFor()` (PR-22), правка нормы историю не переписывает. Нормы нет — null.
   */
  estimatedSeconds: integer('estimated_seconds'),
  /** «Час на контент» и «Час на випробування» — заполняются биениями (PR-21), не разницей «открыл/закрыл». */
  contentSeconds: integer('content_seconds').notNull().default(0),
  attemptSeconds: integer('attempt_seconds').notNull().default(0),
  /** Одно из `REVIEW_TIME_CONFIDENCE` — достоверность измерения времени (`37` §7.15). */
  timeConfidence: text('time_confidence').notNull().default('ok'),

  // ── Состояние очереди ─────────────────────────────────────────────────────────────────
  /**
   * Одно из `REVIEW_QUEUE_STATUSES` (`37` §4): `waiting` — ждёт, назначена или в пуле;
   * `in_review` — карточка открыта (`claimed_by`); `delegated` — есть активное делегирование;
   * `escalated` — срок нарушен на 150 %, работу видит и руководитель; `done` — решение принято.
   */
  status: text('status').notNull().default('waiting'),
  /** Просроченные и аттестации выше (`docs/14` §3.3). Больше — раньше. */
  priority: integer('priority').notNull().default(0),

  // ── Маршрутизация и делегирование (PR-19) ─────────────────────────────────────────────
  /** Кто отвечает за работу: правило, делегирование, переназначение, переброс. `null` — общий пул. */
  assignedReviewerId: uuid('assigned_reviewer_id').references(() => users.id, { onDelete: 'set null' }),
  /** Момент назначения текущему ответственному. Срок проверки от него **не** пересчитывается. */
  assignedAt: timestamp('assigned_at', { withTimezone: true }),
  /**
   * Каким правилом назначено; `null` — вручную или общий пул. FK `rqi_assigned_by_rule_id_fk` →
   * `review_routing_rules` (set null) ставит миграция-развязка 0080 (В-13): в схеме Drizzle ключ
   * не объявлен, как и `users.vacancy_id`, — имя констрейнта фиксировано решением и проверяется
   * по имени девятым контрактным тестом.
   */
  assignedByRuleId: uuid('assigned_by_rule_id'),
  /** Текущее (самое глубокое) активное звено делегирования. FK `rqi_delegation_id_fk` → `review_delegations` (set null, 0080, В-13). */
  delegationId: uuid('delegation_id'),
  /** Первый в цепочке A→B→C, не меняется при передаче (`37` §7.3). */
  originReviewerId: uuid('origin_reviewer_id').references(() => users.id, { onDelete: 'set null' }),
  delegationDepth: integer('delegation_depth').notNull().default(0),
  /**
   * Захват карточки — кто открыл её и когда (`docs/13` §7.2, 30 минут бездействия). Отделён от
   * назначения в PR-19: назначенную B работу может открыть эскалированный руководитель, а
   * «Пропустити» снимает захват, но не назначение. Прямой аналог зеркала
   * `workshop_submissions.reviewer_id` / `claimed_at` (В-2).
   */
  claimedBy: uuid('claimed_by').references(() => users.id, { onDelete: 'set null' }),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),

  // ── Сроки (`37` §7.19) ────────────────────────────────────────────────────────────────
  slaHours: integer('sla_hours').notNull().default(48),
  slaDueAt: timestamp('sla_due_at', { withTimezone: true }),
  slaWarnedAt: timestamp('sla_warned_at', { withTimezone: true }),
  slaBreachedAt: timestamp('sla_breached_at', { withTimezone: true }),
  escalatedAt: timestamp('escalated_at', { withTimezone: true }),
  escalatedToId: uuid('escalated_to_id').references(() => users.id, { onDelete: 'set null' }),
}, t => [
  // Полный (не частичный) индекс с tenant_id первым — контрактный тест 2 пакета.
  index('idx_review_queue_items_tenant').on(t.tenantId, t.status, t.slaDueAt),
  index('idx_review_queue_items_reviewer').on(t.tenantId, t.assignedReviewerId, t.status).where(sql`status <> 'done'`),
  index('idx_review_queue_items_origin').on(t.tenantId, t.originReviewerId).where(sql`delegation_id is not null`),
  index('idx_review_queue_items_claimed').on(t.tenantId, t.claimedBy).where(sql`claimed_by is not null and status <> 'done'`),
  index('idx_review_queue_items_escalated').on(t.tenantId, t.escalatedToId).where(sql`escalated_to_id is not null and status <> 'done'`),
  /**
   * Одна единица работы — одна строка очереди. Повторная сдача после доработки переиспользует
   * ту же `workshop_submissions.id`, поэтому `enqueueReview()` пишет через `on conflict do update`
   * (строка открывается заново), а не вставляет вторую и не удаляет первую.
   */
  uniqueIndex('uq_review_queue_items_source').on(t.tenantId, t.taskType, t.sourceId),
  check('rqi_task_type_chk', sql`${t.taskType} in ('quiz_open_answer', 'workshop', 'offline_confirm', 'survey_open', 'ai_interview_review')`),
  check('rqi_subject_kind_chk', sql`${t.subjectKind} in ('employee', 'candidate')`),
  check('rqi_status_chk', sql`${t.status} in ('waiting', 'in_review', 'delegated', 'escalated', 'done')`),
  check('rqi_time_confidence_chk', sql`${t.timeConfidence} in ('ok', 'partial', 'unreliable')`),
  check('rqi_depth_chk', sql`${t.delegationDepth} between 0 and 2`),
  check('rqi_sla_hours_chk', sql`${t.slaHours} between 1 and 720`),
  check('rqi_attempt_no_chk', sql`${t.attemptNo} >= 1`),
  check('rqi_seconds_chk', sql`${t.contentSeconds} >= 0 and ${t.attemptSeconds} >= 0 and (${t.estimatedSeconds} is null or ${t.estimatedSeconds} between 60 and 216000)`),
])

/**
 * Правила распределения (`docs/v2/37` §3.3, §7.16–7.17). Выигрывает первое подошедшее по
 * `priority` (меньше — раньше); остальные не применяются. `match_scope` — `{location_ids,
 * org_node_ids, position_ids, course_ids}`, пустой объект — весь тенант.
 */
export const reviewRoutingRules = pgTable('review_routing_rules', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  nameUk: text('name_uk').notNull(),
  priority: integer('priority').notNull().default(100),
  matchScope: jsonb('match_scope').notNull().default(sql`'{}'::jsonb`),
  matchSubjectKind: text('match_subject_kind'),
  matchTaskTypes: text('match_task_types').array().notNull().default(sql`'{}'::text[]`),
  /** Одно из `REVIEW_ROUTING_STRATEGIES`. */
  strategy: text('strategy').notNull().default('round_robin'),
  reviewerIds: uuid('reviewer_ids').array().notNull().default(sql`'{}'::uuid[]`),
  fallbackUserId: uuid('fallback_user_id').references(() => users.id, { onDelete: 'set null' }),
  slaHoursOverride: integer('sla_hours_override'),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
}, t => [
  // Горячий путь — частичный; экрану правил нужны и выключенные — полный рядом (`40` §7.2).
  index('idx_review_routing_rules_tenant').on(t.tenantId, t.priority).where(sql`is_active`),
  index('idx_review_routing_rules_tenant_all').on(t.tenantId, t.priority),
  check('rrr_strategy_chk', sql`${t.strategy} in ('location_mentor', 'course_author', 'specific_list', 'round_robin', 'least_loaded', 'manual')`),
  check('rrr_sla_chk', sql`${t.slaHoursOverride} is null or ${t.slaHoursOverride} between 1 and 720`),
  check('rrr_subject_chk', sql`${t.matchSubjectKind} is null or ${t.matchSubjectKind} in ('employee', 'candidate')`),
  check('rrr_task_types_chk', sql`${t.matchTaskTypes} <@ array['quiz_open_answer', 'workshop', 'offline_confirm', 'survey_open', 'ai_interview_review']::text[]`),
  check('rrr_name_chk', sql`length(${t.nameUk}) between 1 and 200`),
])

/**
 * Делегирование проверки (`docs/v2/37` §3.2, §7.1–7.6) — журнал передач. Модель — передача
 * ответственности, а не второй проверяющий: делегат становится единственным ответственным.
 * Цепочка A→B→C — две строки (глубина 1 и 2), обе `active`, пока работа у C; текущая —
 * самая глубокая, на неё смотрит `review_queue_items.delegation_id`.
 */
export const reviewDelegations = pgTable('review_delegations', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  queueItemId: uuid('queue_item_id').notNull().references(() => reviewQueueItems.id, { onDelete: 'cascade' }),
  fromUserId: uuid('from_user_id').notNull().references(() => users.id),
  toUserId: uuid('to_user_id').notNull().references(() => users.id),
  depth: integer('depth').notNull().default(1),
  /** Одно из `REVIEW_DELEGATION_REASONS`. */
  reasonCode: text('reason_code').notNull(),
  reasonText: text('reason_text'),
  /** Срок делегата — не позже срока проверки элемента (`37` §6.1); сам срок проверки не двигается. */
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
  /** Одно из `REVIEW_DELEGATION_STATES`. */
  state: text('state').notNull().default('active'),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
  revokeReason: text('revoke_reason'),
  /** Правило 14: журнал пишет технический контекст (`null` у фоновых задач — норма). */
  requestContext: jsonb('request_context'),
}, t => [
  index('idx_review_delegations_tenant').on(t.tenantId, t.fromUserId, t.state),
  index('idx_review_delegations_to').on(t.tenantId, t.toUserId, t.state),
  index('idx_review_delegations_item').on(t.tenantId, t.queueItemId, t.createdAt.desc()),
  /** Одно активное звено на уровень цепочки (Р-19.3), а не одно на элемент, как в `37` §3.2. */
  uniqueIndex('uq_review_delegations_active').on(t.tenantId, t.queueItemId, t.depth).where(sql`state = 'active'`),
  check('rd_reason_chk', sql`${t.reasonCode} in ('absence', 'workload', 'expertise', 'conflict_of_interest', 'location_change', 'other')`),
  check('rd_state_chk', sql`${t.state} in ('active', 'resolved', 'revoked_by_author', 'revoked_by_manager', 'revoked_sla', 'cancelled')`),
  check('rd_self_chk', sql`${t.fromUserId} <> ${t.toUserId}`),
  check('rd_depth_chk', sql`${t.depth} between 1 and 2`),
  check('rd_text_chk', sql`${t.reasonCode} <> 'other' or length(coalesce(${t.reasonText}, '')) between 10 and 500`),
  check('rd_revoke_reason_chk', sql`${t.revokeReason} is null or length(${t.revokeReason}) <= 500`),
])

/** Ёмкость проверяющего (`docs/v2/37` §3.4, §7.17): вход в распределение и триггер перегрузки, не запрет. */
export const reviewerCapacity = pgTable('reviewer_capacity', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  maxOpenItems: integer('max_open_items').notNull().default(20),
  dailyTarget: integer('daily_target').notNull().default(10),
  acceptsDelegation: boolean('accepts_delegation').notNull().default(true),
  /** Пусто — любые виды работ. */
  taskTypes: text('task_types').array().notNull().default(sql`'{}'::text[]`),
  /** Сколько работ человек получил по кругу: круг — «следующий, у кого меньше» (`37` §7.17). */
  rrCursor: integer('rr_cursor').notNull().default(0),
}, t => [
  index('idx_reviewer_capacity_tenant').on(t.tenantId, t.userId),
  unique('reviewer_capacity_tenant_id_user_id_unique').on(t.tenantId, t.userId),
  check('rc_max_chk', sql`${t.maxOpenItems} between 1 and 200`),
  check('rc_daily_chk', sql`${t.dailyTarget} between 1 and 200`),
  check('rc_task_types_chk', sql`${t.taskTypes} <@ array['quiz_open_answer', 'workshop', 'offline_confirm', 'survey_open', 'ai_interview_review']::text[]`),
])

/** Отсутствия проверяющего и замещение (`docs/v2/37` §3.4, §6.2, §7.18). */
export const reviewerAbsences = pgTable('reviewer_absences', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Одно из `REVIEWER_ABSENCE_KINDS`. */
  kind: text('kind').notNull(),
  startsOn: date('starts_on').notNull(),
  endsOn: date('ends_on'),
  substituteId: uuid('substitute_id').references(() => users.id, { onDelete: 'set null' }),
  moveOpenItems: boolean('move_open_items').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
}, t => [
  index('idx_reviewer_absences_tenant').on(t.tenantId, t.userId, t.startsOn),
  check('ra_kind_chk', sql`${t.kind} in (${inList(REVIEWER_ABSENCE_KINDS)})`),
  check('ra_range_chk', sql`${t.endsOn} is null or ${t.endsOn} >= ${t.startsOn}`),
  check('ra_dismissal_chk', sql`${t.kind} <> 'dismissal' or ${t.endsOn} is null`),
  check('ra_sub_chk', sql`${t.substituteId} is null or ${t.substituteId} <> ${t.userId}`),
])

/** Журнал событий SLA элемента очереди (`docs/v2/37` §3.4, §7.17, §7.19). */
export const reviewSlaEvents = pgTable('review_sla_events', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  queueItemId: uuid('queue_item_id').notNull().references(() => reviewQueueItems.id, { onDelete: 'cascade' }),
  reviewerId: uuid('reviewer_id').references(() => users.id, { onDelete: 'set null' }),
  /** Одно из `REVIEW_SLA_EVENTS`. */
  event: text('event').notNull(),
  dueAt: timestamp('due_at', { withTimezone: true }),
  overdueHours: numeric('overdue_hours', { precision: 8, scale: 2 }),
  targetId: uuid('target_id').references(() => users.id, { onDelete: 'set null' }),
  /** Пометка перегрузки, стратегия и правило назначения (`37` §7.17 — в DDL документа места не было). */
  details: jsonb('details').notNull().default(sql`'{}'::jsonb`),
  requestContext: jsonb('request_context'),
}, t => [
  index('idx_review_sla_events_tenant').on(t.tenantId, t.queueItemId, t.createdAt.desc()),
  check('rse_event_chk', sql`${t.event} in ('assigned', 'warned', 'breached', 'escalated', 'reassigned', 'resolved', 'delegation_expired')`),
])

/** Суточная статистика проверяющего (`docs/v2/37` §3.4, §9.2) — заполняет `review.stats_rollup`. */
export const reviewerStatsDaily = pgTable('reviewer_stats_daily', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  reviewerId: uuid('reviewer_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  day: date('day').notNull(),
  reviewedCount: integer('reviewed_count').notNull().default(0),
  acceptedCount: integer('accepted_count').notNull().default(0),
  rejectedCount: integer('rejected_count').notNull().default(0),
  reworkCount: integer('rework_count').notNull().default(0),
  delegatedOut: integer('delegated_out').notNull().default(0),
  delegatedIn: integer('delegated_in').notNull().default(0),
  breachedCount: integer('breached_count').notNull().default(0),
  ownContentCount: integer('own_content_count').notNull().default(0),
  medianReactSec: integer('median_react_sec'),
  medianReviewSec: integer('median_review_sec'),
}, t => [
  index('idx_reviewer_stats_daily_tenant').on(t.tenantId, t.day.desc()),
  unique('reviewer_stats_daily_tenant_id_reviewer_id_day_unique').on(t.tenantId, t.reviewerId, t.day),
])
