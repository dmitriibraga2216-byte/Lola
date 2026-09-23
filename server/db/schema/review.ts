import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { tenants } from './tenants'
import { users } from './people'
import { locations, positions } from './org'

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
  /** «Розрахунковий час» — снимок нормы (`37` §3.5). Нормы приезжают с PR-20, пока null. */
  estimatedSeconds: integer('estimated_seconds'),
  /** «Час на контент» и «Час на випробування» — заполняются биениями (PR-21), не разницей «открыл/закрыл». */
  contentSeconds: integer('content_seconds').notNull().default(0),
  attemptSeconds: integer('attempt_seconds').notNull().default(0),
  /** Одно из `REVIEW_TIME_CONFIDENCE` — достоверность измерения времени (`37` §7.15). */
  timeConfidence: text('time_confidence').notNull().default('ok'),

  // ── Состояние очереди ─────────────────────────────────────────────────────────────────
  /** Одно из `REVIEW_QUEUE_STATUSES`: `waiting` | `in_review` | `done`. */
  status: text('status').notNull().default('waiting'),
  /** Просроченные и аттестации выше (`docs/14` §3.3). Больше — раньше. */
  priority: integer('priority').notNull().default(0),

  // ── Маршрутизация и делегирование (наполняется с PR-19) ───────────────────────────────
  assignedReviewerId: uuid('assigned_reviewer_id').references(() => users.id, { onDelete: 'set null' }),
  assignedAt: timestamp('assigned_at', { withTimezone: true }),
  /** FK на `review_routing_rules` ставится развязкой PR-19: таблицы правил ещё нет. */
  assignedByRuleId: uuid('assigned_by_rule_id'),
  /** FK на `review_delegations` ставится развязкой PR-19 (цикл `40` §5 0022). */
  delegationId: uuid('delegation_id'),
  /** Первый в цепочке A→B→C, не меняется при передаче (`37` §7.3). */
  originReviewerId: uuid('origin_reviewer_id').references(() => users.id, { onDelete: 'set null' }),
  delegationDepth: integer('delegation_depth').notNull().default(0),

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
  /**
   * Одна единица работы — одна строка очереди. Повторная сдача после доработки переиспользует
   * ту же `workshop_submissions.id`, поэтому `enqueueReview()` пишет через `on conflict do update`
   * (строка открывается заново), а не вставляет вторую и не удаляет первую.
   */
  uniqueIndex('uq_review_queue_items_source').on(t.tenantId, t.taskType, t.sourceId),
  check('rqi_task_type_chk', sql`${t.taskType} in ('quiz_open_answer', 'workshop', 'offline_confirm', 'survey_open', 'ai_interview_review')`),
  check('rqi_subject_kind_chk', sql`${t.subjectKind} in ('employee', 'candidate')`),
  check('rqi_status_chk', sql`${t.status} in ('waiting', 'in_review', 'done')`),
  check('rqi_time_confidence_chk', sql`${t.timeConfidence} in ('ok', 'partial', 'unreliable')`),
  check('rqi_depth_chk', sql`${t.delegationDepth} between 0 and 2`),
  check('rqi_sla_hours_chk', sql`${t.slaHours} between 1 and 720`),
  check('rqi_attempt_no_chk', sql`${t.attemptNo} >= 1`),
  check('rqi_seconds_chk', sql`${t.contentSeconds} >= 0 and ${t.attemptSeconds} >= 0 and (${t.estimatedSeconds} is null or ${t.estimatedSeconds} between 60 and 216000)`),
])
