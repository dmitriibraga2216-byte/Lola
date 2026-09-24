import { sql } from 'drizzle-orm'
import { bigint, boolean, check, date, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { tenantId } from './_common'
import { tenants } from './tenants'
import { users } from './people'
import { mediaAssets } from './content'
import { enrollments } from './learning'
import {
  LIFECYCLE_STAGE_CODES,
  STORAGE_DELETION_MODES,
  STORAGE_DELETION_STATUSES,
  STORAGE_PENDING_UPLOAD_STATUSES,
  STORAGE_RETENTION_ACTIONS,
  STORAGE_RETENTION_ANCHORS,
} from '../../../shared/enums'

/**
 * Хранилище как управляемый ресурс (docs/v2/34-storage.md §3.3, миграция `0083_v2_storage_quota`,
 * план docs/v2/45 PR-36). Реестр файлов остаётся один — `media_assets` (§3.1); здесь только
 * агрегаты, правила и операционные таблицы.
 *
 * **Лимита здесь нет.** Эффективную квоту считает только `effectiveLimits()` из
 * `server/services/tenantLimits.ts` (решение docs/v2/44 В-5, риск Р-6): тариф + переопределение
 * оператора + `tenant_addons` со `storage_pack`. Эти таблицы хранят факт — сколько занято.
 *
 * `origin` не закрыт check-ом ни в одной из них: перечень один — на `media_assets.origin`
 * (инвариант 19, контрактный тест №4). `stage_code` — ключ разбивки (В-10), тот же перечень
 * `LIFECYCLE_STAGE_CODES`, что у `media_assets.stage_code`; `null` = девятый ключ `other`.
 */

/** `col in ('a','b',…)` из перечня shared/enums — вместо литералов в тексте схемы. */
function inList(column: unknown, values: readonly string[]) {
  return sql`${column} in (${sql.join(values.map(v => sql`${v}`), sql`, `)})`
}

/**
 * Оперативный счётчик (§7.4 п. 1): ведёт триггер `storage_counter_apply` на `media_assets`
 * в той же транзакции, что и изменение файла. Экран и проверка квоты читают только его.
 * Ключ с `nulls not distinct` (Postgres 15+): файлы вне курса складываются в одну строку.
 */
export const storageUsageCounters = pgTable('storage_usage_counters', {
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  origin: text('origin').notNull(),
  stageCode: text('stage_code'),
  bytes: bigint('bytes', { mode: 'number' }).notNull().default(0),
  filesCount: integer('files_count').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique('storage_usage_counters_pk').on(t.tenantId, t.origin, t.stageCode).nullsNotDistinct(),
  index('idx_storage_usage_counters_tenant').on(t.tenantId),
  check('storage_usage_counters_bytes_check', sql`${t.bytes} >= 0`),
  check('storage_usage_counters_files_count_check', sql`${t.filesCount} >= 0`),
  check('storage_usage_counters_stage_code_chk', sql`${t.stageCode} is null or ${inList(t.stageCode, LIFECYCLE_STAGE_CODES)}`),
])

/**
 * Суточный срез (§7.4 п. 2): полный пересчёт `storage.counter_reconcile` внутри
 * `usage.collect`. `driftBytes = counterBytes − bytes`; биллинг берёт максимум срезов за
 * период (§7.4 п. 3), а не значение на дату счёта.
 */
export const storageUsageDaily = pgTable('storage_usage_daily', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  day: date('day').notNull(),
  origin: text('origin').notNull(),
  stageCode: text('stage_code'),
  bytes: bigint('bytes', { mode: 'number' }).notNull(),
  filesCount: integer('files_count').notNull(),
  counterBytes: bigint('counter_bytes', { mode: 'number' }),
  driftBytes: bigint('drift_bytes', { mode: 'number' }).notNull().default(0),
  collectedAt: timestamp('collected_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique('storage_usage_daily_uq').on(t.tenantId, t.day, t.origin, t.stageCode).nullsNotDistinct(),
  index('idx_storage_usage_daily_tenant').on(t.tenantId, t.day.desc()),
  check('storage_usage_daily_stage_code_chk', sql`${t.stageCode} is null or ${inList(t.stageCode, LIFECYCLE_STAGE_CODES)}`),
])

/**
 * Политика хранения — строка на происхождение (§3.3, §6.2, §7.3). У нового тенанта выключено
 * всё. `trashDays` — срок корзины (docs/v2/44 §8): живёт строкой, а не константой в коде.
 */
export const storageRetentionPolicies = pgTable('storage_retention_policies', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  /** Одно из `MEDIA_ORIGINS`; проверяется zod-схемой, второго check-а на перечень нет. */
  origin: text('origin').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  keepMonths: integer('keep_months'),
  anchor: text('anchor').notNull().default('graded_at'),
  action: text('action').notNull().default('soft_delete'),
  keepEvidence: boolean('keep_evidence').notNull().default(true),
  warnDaysBefore: integer('warn_days_before').notNull().default(14),
  maxBatchPerRun: integer('max_batch_per_run').notNull().default(500),
  trashDays: integer('trash_days').notNull().default(30),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique().on(t.tenantId, t.origin),
  index('idx_storage_retention_policies_tenant').on(t.tenantId, t.enabled),
  check('storage_retention_policies_keep_months_check', sql`${t.keepMonths} is null or ${t.keepMonths} between 1 and 120`),
  check('storage_retention_policies_anchor_check', inList(t.anchor, STORAGE_RETENTION_ANCHORS)),
  check('storage_retention_policies_action_check', inList(t.action, STORAGE_RETENTION_ACTIONS)),
  check('storage_retention_policies_warn_days_check', sql`${t.warnDaysBefore} between 0 and 90`),
  check('storage_retention_policies_batch_check', sql`${t.maxBatchPerRun} between 1 and 5000`),
  check('storage_retention_policies_trash_days_check', sql`${t.trashDays} between 1 and 365`),
  check('storage_retention_policies_keep_required', sql`not ${t.enabled} or ${t.action} = 'notify_only' or ${t.keepMonths} is not null`),
])

/**
 * Заявка на массовое удаление (§3.3, §6.1): единственный путь удалить много файлов
 * (решение В-17). Одна запись `storage.bulk_delete` в `audit_log` на заявку, пофайловый
 * состав — здесь: `mediaIds` (снимок выборки) и `skipped` (`[{mediaId, reason}]`).
 */
export const storageDeletionRequests = pgTable('storage_deletion_requests', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
  mode: text('mode').notNull().default('selection'),
  filter: jsonb('filter').notNull().default({}),
  mediaIds: uuid('media_ids').array().notNull().default(sql`'{}'::uuid[]`),
  plannedFiles: integer('planned_files').notNull().default(0),
  plannedBytes: bigint('planned_bytes', { mode: 'number' }).notNull().default(0),
  evidenceCount: integer('evidence_count').notNull().default(0),
  reason: text('reason'),
  confirmPhrase: text('confirm_phrase'),
  status: text('status').notNull().default('draft'),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  skipped: jsonb('skipped').notNull().default([]),
  deletedFiles: integer('deleted_files').notNull().default(0),
  deletedBytes: bigint('deleted_bytes', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('idx_storage_deletion_requests_tenant').on(t.tenantId, t.status, t.createdAt.desc()),
  check('storage_deletion_requests_mode_check', inList(t.mode, STORAGE_DELETION_MODES)),
  check('storage_deletion_requests_status_check', inList(t.status, STORAGE_DELETION_STATUSES)),
  check('storage_deletion_requests_reason_check', sql`${t.reason} is null or char_length(${t.reason}) between 10 and 500`),
])

/**
 * Отложенная загрузка (§3.3, §7.5): запись сотрудника на устройстве под `clientRef`, строка
 * здесь — обещание дослать. `mediaId` — файл, заведённый под загрузку, когда место появилось.
 */
export const storagePendingUploads = pgTable('storage_pending_uploads', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  enrollmentId: uuid('enrollment_id').references(() => enrollments.id, { onDelete: 'cascade' }),
  sourceEntity: text('source_entity').notNull(),
  sourceId: uuid('source_id'),
  origin: text('origin').notNull(),
  declaredBytes: bigint('declared_bytes', { mode: 'number' }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  clientRef: text('client_ref').notNull(),
  status: text('status').notNull().default('waiting'),
  lastError: text('last_error'),
  mediaId: uuid('media_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique().on(t.tenantId, t.userId, t.clientRef),
  index('idx_storage_pending_uploads_tenant').on(t.tenantId, t.status, t.expiresAt),
  check('storage_pending_uploads_status_check', inList(t.status, STORAGE_PENDING_UPLOAD_STATUSES)),
  check('storage_pending_uploads_declared_bytes_check', sql`${t.declaredBytes} > 0`),
])
