import { sql } from 'drizzle-orm'
import { boolean, check, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { PERSON_NOTE_CATEGORIES } from '../../../shared/enums'
import { baseColumns, tenantId } from './_common'
import { tenants } from './tenants'
import { users } from './people'
import { locations, orgUnits } from './org'

/** Группы и сегменты, функциональные руководители, заметки о человеке (docs/16 §3.4–3.5, §5.2). */

export const userGroups = pgTable('user_groups', {
  ...baseColumns,
  tenantId: tenantId(),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('static'), // static | dynamic
  members: uuid('members').array().notNull().default(sql`'{}'::uuid[]`),
  filter: jsonb('filter'), // как audience.segment (docs/15 §3.2)
  isActive: boolean('is_active').notNull().default(true),
  recalcAt: timestamp('recalc_at', { withTimezone: true }),
  // docs/16 §14.1: группы, порождённые оргструктурой, руками не правятся и пересобираются при импорте и смене размещения
  isOrgDerived: boolean('is_org_derived').notNull().default(false),
  orgUnitId: uuid('org_unit_id').references(() => orgUnits.id, { onDelete: 'cascade' }), // узел-источник производной группы
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
}, t => [
  unique().on(t.tenantId, t.name),
])

export const functionalChiefs = pgTable('functional_chiefs', {
  ...baseColumns,
  tenantId: tenantId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  chiefId: uuid('chief_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().default('functional'), // line | functional
  scope: text('scope'), // по точке, подразделению, направлению — текстом
}, t => [
  index().on(t.tenantId),
  unique().on(t.userId, t.chiefId, t.kind),
])

/**
 * Заметка о человеке (docs/16 §5.2 п. 6; модель — docs/v2/38-people-extensions.md §3.4, §7.4–§7.6).
 *
 * Пакет заводил отдельную `person_notes`, но это та же сущность, что уже жила здесь
 * (docs/v2/43-reconciliation.md §1.2) — поэтому `alter table user_notes`, а не вторая таблица
 * (миграция `v2_person_notes_docs`, PR-32). Видимость, категория, закрепление, отметка скрина
 * чувствительного содержания, момент, когда заметку открыли человеку, и архив по сроку.
 *
 * Чтение пишет `person_note.read` в `audit_log` — перечень `note_ids`, **без текста**
 * (§7.6): смысл записи «кто открывал заметки об этом человеке», а не копия содержания.
 */
export const userNotes = pgTable('user_notes', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }), // о ком
  authorId: uuid('author_id').references(() => users.id), // кто написал; null — только у заметок до PR-32, написанных о себе
  body: text('body').notNull(),
  /** Одно из `PERSON_NOTE_VISIBILITIES`; `shared_with_person` назад не сужается (§4). */
  visibility: text('visibility').notNull().default('manager'),
  /** Одно из `PERSON_NOTE_CATEGORIES` — определяет срок хранения (§7.6). */
  category: text('category').notNull().default('general'),
  isPinned: boolean('is_pinned').notNull().default(false),
  /** Сохранено вопреки скрину чувствительного содержания (§7.5): сохранение не блокируется, но отмечается. */
  flaggedAt: timestamp('flagged_at', { withTimezone: true }),
  flaggedTerms: text('flagged_terms').array().notNull().default(sql`'{}'::text[]`),
  /** Когда заметку открыли человеку (`visibility → shared_with_person`, §7.4). */
  sharedAt: timestamp('shared_at', { withTimezone: true }),
  /** Архив по сроку хранения (`notes.archive_scan`, §7.6): из карточки исчезает, admin видит по ссылке. */
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, t => [
  // Горячий путь — неархивные заметки карточки; полный индекс рядом — холодный путь (архив,
  // gdpr.erase) и контрактный тест №2 пакета (docs/v2/40 §7.1–7.2)
  index('idx_user_notes_tenant').on(t.tenantId, t.userId, t.createdAt.desc()).where(sql`archived_at is null`),
  index('idx_user_notes_tenant_all').on(t.tenantId, t.userId, t.createdAt.desc()),
  check('user_notes_visibility_chk', sql`${t.visibility} in ('hr', 'manager', 'shared_with_person')`),
  // Перечень — из `PERSON_NOTE_CATEGORIES`, а не литералами: категория `onboarding` совпадает
  // текстом с кодом этапа цикла, и сквозная проверка 1 (`scripts/v2-crosschecks.sh`) не отличила
  // бы её от ветвления по этапу мимо `stageCan()`
  check('user_notes_category_chk', sql`${t.category} in (${sql.raw(PERSON_NOTE_CATEGORIES.map(c => `'${c}'`).join(', '))})`),
  check('user_notes_body_chk', sql`char_length(${t.body}) between 3 and 2000`),
  check('user_notes_self_chk', sql`${t.authorId} <> ${t.userId}`),
])
