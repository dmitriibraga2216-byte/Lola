import { sql } from 'drizzle-orm'
import { boolean, date, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { tenants } from './tenants'
import { users } from './people'
import { enrollments } from './learning'
import type { StageCapabilityMap } from '../../../shared/enums'

/**
 * Справочник этапов жизненного цикла (docs/v2/33-lifecycle.md §3.2, docs/v2/40 §0005).
 *
 * Гибридная модель (docs/v2/44-decisions.md В-3): свободный каталог `course_categories`
 * остаётся основой, этап — **необязательный** атрибут курса, а разное поведение выражено
 * не веткой по названию, а картой возможностей `capabilities`. Код спрашивает «можно ли
 * здесь считать прогресс» через `stageCan()` (`server/services/lifecycle.ts`), а не
 * «это база знаний или нет».
 *
 * `code` неизменяем и закрыт констрейнтом на восемь платформенных значений
 * (`shared/enums.ts` → `LIFECYCLE_STAGE_CODES`); тенант правит `name_uk`, `icon`, `color`,
 * `sort`, `is_enabled`, `expected_days`. `capabilities` меняет только оператор платформы
 * (`33` §2): для тенанта они только на чтение — `403 capabilities.readonly`.
 */
export const lifecycleStages = pgTable('lifecycle_stages', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  /** Один из `LIFECYCLE_STAGE_CODES`; неизменяем (`33` §3.2). */
  code: text('code').notNull(),
  nameUk: text('name_uk').notNull(),
  nameEn: text('name_en'),
  icon: text('icon'),
  /** Токен бренд-бука: ink | sun | teal | coral (CLAUDE.md п. 9). */
  color: text('color').notNull().default('ink'),
  sort: integer('sort').notNull(),
  isEnabled: boolean('is_enabled').notNull().default(true),
  /** Норма времени в этапе, дней (`33` §7.11) — только сигнал для отчёта «застрягли». */
  expectedDays: integer('expected_days'),
  /** Фиксированный перечень ключей `STAGE_CAPABILITIES`; отсутствующий ключ = false. */
  capabilities: jsonb('capabilities').notNull().default({}).$type<StageCapabilityMap>(),
  /**
   * Зеркало ключа `capabilities.applies_to_candidate` (`33` §3.3, правило §7.9): генерируемая
   * колонка, а не вторая копия правды — иначе флаг и карта возможностей разъезжаются.
   * Нужна как колонка, потому что по ней фильтруют список этапов в форме назначения кандидату.
   */
  appliesToCandidate: boolean('applies_to_candidate')
    .notNull()
    .generatedAlwaysAs(sql`coalesce((capabilities ->> 'applies_to_candidate')::boolean, false)`),
}, t => [
  unique().on(t.tenantId, t.code),
  index().on(t.tenantId, t.sort),
])

/**
 * Где человек находится сейчас (docs/v2/33-lifecycle.md §3.5, docs/v2/40 §0021).
 *
 * Этап человека и этап курса — **разные вещи**, и вывести один из другого нельзя (§3.5):
 * человек «на онбординге» параллельно проходит курс этапа «база знань», а давно работающий
 * сотрудник после перевода проходит онбординг новой точки. Поэтому состояние хранится явно.
 *
 * Текущая запись ровно одна — частичным уникальным индексом `uq_employee_lifecycle_current`,
 * а не проверкой в коде (критерий §13 п. 7). История не удаляется: предыдущие записи получают
 * `left_at` и `is_current = false`, по ним считается «дней в этапе» и отчёт «застрягли» (§9).
 */
export const employeeLifecycleState = pgTable('employee_lifecycle_state', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  stageId: uuid('stage_id').notNull().references(() => lifecycleStages.id),
  enteredAt: timestamp('entered_at', { withTimezone: true }).notNull().defaultNow(),
  leftAt: timestamp('left_at', { withTimezone: true }),
  enteredBy: uuid('entered_by').references(() => users.id, { onDelete: 'set null' }),
  /** Почему человек сюда попал: `hire`, `rehire`, `advance`, `offboarding`, `manual`, `backfill`. */
  reasonCode: text('reason_code'),
  isCurrent: boolean('is_current').notNull().default(true),
}, t => [
  index().on(t.tenantId, t.userId, t.enteredAt.desc()),
  uniqueIndex('uq_employee_lifecycle_current').on(t.tenantId, t.userId).where(sql`is_current`),
])

/**
 * Процесс увольнения (docs/v2/33-lifecycle.md §3.6, §4.2, §7.7).
 *
 * Офбординг — не только курсы, но и процесс: передача дел, выходное интервью, закрытие
 * доступа и освобождение лимита активных людей (§15 Г-33.3 — иначе тенант платит за уволенных,
 * а они продолжают получать уведомления). Завершение **не удаляет человека и не обезличивает
 * его** (§4.2): история обучения — доказательство того, что инструктаж проводился, и живёт
 * дольше, чем сам сотрудник работает; обезличивание — отдельная операция `gdpr.erase`.
 *
 * Активный случай на человека один — частичным уникальным индексом `uq_offboarding_case_active`
 * (`409 offboarding.active_exists`).
 */
export const offboardingCases = pgTable('offboarding_cases', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** `OFFBOARDING_STATES`: started | handover | interview | done | cancelled (§4.2). */
  state: text('state').notNull().default('started'),
  /** `OFFBOARDING_REASONS` — восемь кодов §3.6; свободный текст только при `other` (§6.2). */
  reasonCode: text('reason_code').notNull(),
  reasonText: text('reason_text'),
  lastWorkingDay: date('last_working_day').notNull(),
  initiatedBy: uuid('initiated_by').references(() => users.id, { onDelete: 'set null' }),
  /** «Відповідальний» (§6.2, колонка списка §5.4) — не обязательно инициатор. */
  responsibleId: uuid('responsible_id').references(() => users.id, { onDelete: 'set null' }),
  exitInterviewEnrollmentId: uuid('exit_interview_enrollment_id').references(() => enrollments.id, { onDelete: 'set null' }),
  handoverDoneAt: timestamp('handover_done_at', { withTimezone: true }),
  accessRevokedAt: timestamp('access_revoked_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelReason: text('cancel_reason'),
}, t => [
  index().on(t.tenantId, t.state),
  uniqueIndex('uq_offboarding_case_active').on(t.tenantId, t.userId).where(sql`state not in ('done', 'cancelled')`),
])
