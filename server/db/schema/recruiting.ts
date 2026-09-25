import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, jsonb, numeric, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { tenants } from './tenants'
import { users } from './people'
import { scaleLevels, scales } from './settings'

/**
 * Рекрутинг: кандидат (docs/v2/28-recruiting-candidates.md §3, миграция 0064_v2_candidates).
 *
 * Самой записи кандидата здесь нет и быть не может: кандидат — это `users` с
 * `kind = 'candidate'` (§3.1, решение docs/v2/44 В-8). В этом файле живёт только то, чего у
 * сотрудника нет: колонки канбана, оценки, комментарии рекрутеров и история статусов.
 *
 * Списочные выборки кандидатов идут через `server/services/repo/people.ts` (`candidates()`,
 * `candidateOnly()`), а не прямым `from(users)`: сканер `tests/integration/users-kind-filter.spec.ts`
 * красит гейт на обходе.
 */

/**
 * Колонка воронки (`28` §3.3). Справочник расширяемый, но каждая колонка обязана назвать
 * `maps_to` — терминальное состояние, к которому она приравнивается (§4.1). Отчётность и
 * лимиты смотрят на ось `users.candidate_state`, интерфейс — на эту; связывает их `maps_to`.
 *
 * Шесть системных колонок (`is_system`) заводятся при инициализации тенанта
 * (`server/db/tenantDefaults.ts`) и догоняющей вставкой миграции: их нельзя удалить и нельзя
 * переименовать `code`; `name_uk`, `color` и `sort` — можно.
 */
export const candidateStatuses = pgTable('candidate_statuses', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  code: text('code').notNull(),
  nameUk: text('name_uk').notNull(),
  nameEn: text('name_en'),
  /** Токен бренд-бука: ink | sun | teal | coral (CLAUDE.md п. 9). */
  color: text('color').notNull().default('ink'),
  sort: integer('sort').notNull(),
  isSystem: boolean('is_system').notNull().default(false),
  /** Одно из `CANDIDATE_STATES` — к какому терминальному состоянию приравнивается колонка. */
  mapsTo: text('maps_to').notNull().default('active'),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
}, t => [
  unique('candidate_statuses_tenant_id_code_unique').on(t.tenantId, t.code),
  index('candidate_statuses_tenant_id_sort_index').on(t.tenantId, t.sort),
  check('candidate_statuses_maps_to_chk', sql`${t.mapsTo} in ('active', 'hired', 'rejected', 'archived', 'withdrawn')`),
  check('candidate_statuses_color_chk', sql`${t.color} in ('ink', 'sun', 'teal', 'coral')`),
])

/**
 * Оценка кандидата (`28` §3.4). Четыре независимых вида (`manual` | `task` | `ai` | `recruiter`),
 * сведение в единое число запрещено на уровне модели: усреднение прячет случай «блестящее
 * тестовое, провальное собеседование», ради которого воронка и существует.
 *
 * История сохраняется: новая оценка того же вида создаёт новую строку и снимает `is_current`
 * с предыдущей. Действующая ровно одна — частичным уникальным индексом, а не проверкой в коде.
 */
export const candidateScores = pgTable('candidate_scores', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  candidateId: uuid('candidate_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Одно из `CANDIDATE_SCORE_KINDS`. */
  kind: text('kind').notNull(),
  valueNum: numeric('value_num', { precision: 6, scale: 2 }),
  scaleId: uuid('scale_id').references(() => scales.id),
  scaleLevelId: uuid('scale_level_id').references(() => scaleLevels.id),
  comment: text('comment'),
  /** Чем порождена оценка: `attempt` | `workshop_submission` | `interview` | `manual` (`28` §3.4). */
  sourceType: text('source_type'),
  sourceId: uuid('source_id'),
  authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
  isCurrent: boolean('is_current').notNull().default(true),
  /**
   * Оценку ИИ дал профиль-заглушка (`docs/v2/30` §7.2 г, план `45` PR-28, Р-28.4): явный признак,
   * а не догадка по имени модели. Заглушка — не модель, и её балл не бывает основанием решения
   * человека без пометки: карточка и уведомление показывают её рядом с числом. Только у `kind = 'ai'`.
   */
  aiStub: boolean('ai_stub').notNull().default(false),
}, t => [
  index('idx_candidate_scores_tenant').on(t.tenantId, t.candidateId, t.kind),
  uniqueIndex('uq_candidate_scores_current').on(t.tenantId, t.candidateId, t.kind).where(sql`is_current`),
  check('candidate_scores_kind_chk', sql`${t.kind} in ('manual', 'task', 'ai', 'recruiter')`),
  check('candidate_scores_value_chk', sql`${t.valueNum} is not null or ${t.scaleLevelId} is not null`),
  check('candidate_scores_ai_stub_chk', sql`not ${t.aiStub} or ${t.kind} = 'ai'`),
])

/**
 * Комментарий рекрутера о кандидате (`28` §3.5). Кандидату не виден никогда, ни при какой
 * `visibility`: это служебная переписка о человеке, а не переписка с ним.
 */
export const candidateComments = pgTable('candidate_comments', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  candidateId: uuid('candidate_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  authorId: uuid('author_id').notNull().references(() => users.id),
  body: text('body').notNull(),
  /** Одно из `CANDIDATE_COMMENT_VISIBILITIES`. */
  visibility: text('visibility').notNull().default('recruiters'),
  editedAt: timestamp('edited_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, t => [
  index('idx_candidate_comments_tenant').on(t.tenantId, t.candidateId, t.createdAt.desc()),
  check('candidate_comments_visibility_chk', sql`${t.visibility} in ('recruiters', 'managers', 'all_staff')`),
  check('candidate_comments_body_chk', sql`length(${t.body}) between 1 and 4000`),
])

/**
 * Лента смен колонки канбана (`28` §3.6). Хранит и воронку по времени («днів у статусі»
 * считается от последней записи, §7.11), и доказательство, кто принял решение.
 * `request_context` — правило CLAUDE.md п. 14: журнал пишет технический контекст одинаково.
 */
export const candidateStatusHistory = pgTable('candidate_status_history', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  candidateId: uuid('candidate_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  fromStatusId: uuid('from_status_id').references(() => candidateStatuses.id, { onDelete: 'set null' }),
  toStatusId: uuid('to_status_id').notNull().references(() => candidateStatuses.id),
  reasonCode: text('reason_code'),
  reasonText: text('reason_text'),
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  isAutomatic: boolean('is_automatic').notNull().default(false),
  requestContext: jsonb('request_context'), // технический контекст события (CLAUDE.md п. 14)
}, t => [
  index('idx_candidate_status_history_tenant').on(t.tenantId, t.candidateId, t.createdAt.desc()),
])
