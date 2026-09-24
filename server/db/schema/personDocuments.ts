import { sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { boolean, check, date, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { tenants } from './tenants'
import { users } from './people'
import { mediaAssets } from './content'

/**
 * Документы человека (docs/v2/38-people-extensions.md §3.5, §4, §7.7, §7.8; миграция
 * `v2_person_notes_docs`, PR-32). В базовом ТЗ их не было вовсе.
 *
 * Документ — **факт и срок**, файл вторичен: у типа с `is_fact_only` файла нет и быть не
 * может (§7.7, `422 document_file_not_allowed`) — LMS нужен ответ «допущен ли человек»,
 * а не второй экземпляр медкнижки. Файл, где он есть, — обычный `media_assets` с
 * `origin='person_document'` (реестр `docs/v2/40` §4.2 уже содержит это значение).
 */

/**
 * Справочник типов документов тенанта (§3.5). Семь системных (`is_system`) заводятся при
 * инициализации тенанта (`SYSTEM_PERSON_DOCUMENT_TYPES`); удалить системный тип нельзя,
 * править и деактивировать — можно. Деактивированный тип уходит из формы добавления,
 * документы по нему остаются (§12).
 */
export const personDocumentTypes = pgTable('person_document_types', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  code: text('code').notNull(),
  name: text('name').notNull(),
  isSystem: boolean('is_system').notNull().default(false),
  isRequired: boolean('is_required').notNull().default(false),
  /** Для каких посад обязателен; пусто — для всех (§7.8). */
  requiredPositions: uuid('required_positions').array().notNull().default(sql`'{}'::uuid[]`),
  /** Срок действия в месяцах; null — бессрочный. */
  validityMonths: integer('validity_months'),
  /** За сколько дней до `expires_at` напоминать; наибольшее — окно состояния `expiring` (§4). */
  remindDays: integer('remind_days').array().notNull().default(sql`'{30,7,0}'::integer[]`),
  /** Файл запрещён: хранится факт, срок и маскированный номер (§7.7). */
  isFactOnly: boolean('is_fact_only').notNull().default(false),
  /** Человек может загрузить документ этого типа себе сам — источник помечается (§7.8). */
  selfUpload: boolean('self_upload').notNull().default(false),
  /** Видят ли тип руководители точки (§2), а не только HR и администратор. */
  visibleToManager: boolean('visible_to_manager').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
}, t => [
  unique('person_document_types_tenant_id_code_unique').on(t.tenantId, t.code),
  index('idx_person_document_types_tenant').on(t.tenantId, t.isActive),
])

/**
 * Документ человека (§3.5, §4). Состояние `valid → expiring → expired` двигает срок
 * (`documents.expiry_scan`), `revoked` — человек: вручную с причиной или заменой более
 * свежим документом того же типа (§4, §12). Отмена необратима.
 *
 * `revoked_at`, `revoke_reason`, `replaced_by_id` — сверх DDL §3.5: сам §4 требует
 * «revoked — вручную **с причиной**» и «с причиной «Замінено документом від {дата}»»,
 * а в DDL для причины места нет, `note` же — примечание загрузившего, затирать его нельзя.
 */
export const personDocuments = pgTable('person_documents', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  typeId: uuid('type_id').notNull().references(() => personDocumentTypes.id, { onDelete: 'restrict' }),
  /** null — у типа с `is_fact_only` (§7.7) и когда файл удалён. */
  mediaId: uuid('media_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
  title: text('title'),
  /** Последние 4 знака номера: `****1234` (§7.7). */
  numberMasked: text('number_masked'),
  issuedAt: date('issued_at'),
  expiresAt: date('expires_at'),
  /** Одно из `PERSON_DOCUMENT_STATUSES`. */
  status: text('status').notNull().default('valid'),
  /** Кто загрузил; совпадает с `user_id` — «Завантажено співробітником», источник не проверен (§7.8). */
  uploadedBy: uuid('uploaded_by').notNull().references(() => users.id),
  note: text('note'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokeReason: text('revoke_reason'),
  /** Более свежий документ того же типа, который заменил этот (§4). */
  replacedById: uuid('replaced_by_id').references((): AnyPgColumn => personDocuments.id, { onDelete: 'set null' }),
}, t => [
  index('idx_person_documents_tenant').on(t.tenantId, t.userId, t.status),
  index('idx_person_documents_tenant_expiry').on(t.tenantId, t.expiresAt).where(sql`status in ('valid', 'expiring')`),
  check('person_documents_status_chk', sql`${t.status} in ('valid', 'expiring', 'expired', 'revoked')`),
  check('person_documents_dates_chk', sql`${t.expiresAt} is null or ${t.issuedAt} is null or ${t.expiresAt} > ${t.issuedAt}`),
  check('person_documents_number_chk', sql`${t.numberMasked} is null or char_length(${t.numberMasked}) <= 8`),
  check('person_documents_revoked_chk', sql`(${t.status} = 'revoked') = (${t.revokedAt} is not null)`),
])
