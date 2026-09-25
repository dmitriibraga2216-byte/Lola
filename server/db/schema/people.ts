import { sql } from 'drizzle-orm'
import {
  bigint, boolean, check, date, index, inet, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { tenants } from './tenants'
import { locations, orgUnits, positions } from './org'
import { cities, positionLevels } from './refs'

export const users = pgTable('users', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  // Вид человека (docs/02 «Перечисления» user_kind, docs/v2/44 В-8 и В-14): employee | candidate.
  // Кандидат и сотрудник — одна запись с разным kind; перевод в штат меняет kind, а не заводит
  // вторую строку. Списочные выборки людей идут только через server/services/repo/people.ts.
  kind: text('kind').notNull().default('employee'),
  /**
   * Колонки кандидата (docs/v2/28 §3.2, миграция 0064_v2_candidates). У сотрудника они пусты:
   * `users_candidate_coherence_chk` требует `candidate_state` ровно у кандидата и запрещает
   * его у сотрудника — две оси состояния (§4.1) не могут разъехаться. `vacancy_id` приехал
   * миграцией-развязкой 0072_v2_users_vacancy_fk (PR-15, решение docs/v2/44 В-13): цикл
   * `users → vacancies → users` настоящий, и ключ добавляется после обеих таблиц.
   */
  candidateState: text('candidate_state'), // одно из CANDIDATE_STATES — терминальное состояние воронки
  candidateStatusId: uuid('candidate_status_id'), // колонка канбана, FK candidate_statuses (set null)
  source: text('source'), // одно из CANDIDATE_SOURCES — откуда пришёл
  sourceDetail: text('source_detail'), // название площадки или ФИО рекомендателя, ≤200
  recruiterId: uuid('recruiter_id'), // ответственный рекрутер, самоссылка на users (set null)
  vacancyId: uuid('vacancy_id'), // вакансия отклика, FK vacancies users_vacancy_id_fk (set null, 0071)
  accessUntil: date('access_until'), // право входа, НЕ дедлайн прохождения (§3.2): дедлайн живёт в назначении
  commLanguage: text('comm_language').notNull().default('uk'), // язык писем и интерфейса кандидата
  resumeAssetId: uuid('resume_asset_id'), // резюме, media_assets с origin='candidate_cv'
  convertedFromCandidateAt: timestamp('converted_from_candidate_at', { withTimezone: true }), // факт прихода через воронку
  consentGivenAt: timestamp('consent_given_at', { withTimezone: true }), // согласие на обработку ПД (§7.9)
  consentExpiresAt: date('consent_expires_at'), // дата, после которой ПД подлежат стиранию
  /**
   * Воронка, миграция 0068_v2_candidates_funnel (docs/v2/28 §7.5, §7.9).
   * `candidate_state_at` — момент последней смены состояния: по нему считает срок
   * `candidate.auto_archive` («N дней с момента отказа») и «днів у стані» на карточке.
   * История колонок канбана этот момент не знает: состояние меняют и решения без смены
   * колонки (отзыв, повторное открытие, фоновая задача).
   * `anonymized_at` — отметка необратимого стирания ПД по истёкшему согласию (§7.9):
   * по ней задача идемпотентна, а карточка объясняет, почему поля пусты.
   */
  candidateStateAt: timestamp('candidate_state_at', { withTimezone: true }),
  anonymizedAt: timestamp('anonymized_at', { withTimezone: true }),
  phone: text('phone'), // E.164, уникален в тенанте — ключ входа
  email: text('email'),
  fullName: text('full_name').notNull(), // «Прізвище Імʼя По батькові» — собирается из частей
  lastName: text('last_name'),
  firstName: text('first_name'),
  middleName: text('middle_name'),
  latinName: text('latin_name'), // транслитерация для сертификатов на английском
  workContacts: jsonb('work_contacts').notNull().default(sql`'{}'::jsonb`), // {ext, workEmail, messenger}
  birthDate: date('birth_date'),
  gender: text('gender'), // male | female | unspecified
  positionSince: date('position_since'),
  comment: text('comment'), // внутренняя заметка, человеку не видна
  isBlocked: boolean('is_blocked').notNull().default(false), // вход запрещён, обучение не снимается
  isHidden: boolean('is_hidden').notNull().default(false), // не виден в списках, рейтингах и публичной оргструктуре
  birthdayConsent: boolean('birthday_consent').notNull().default(true), // согласие показывать день рождения (docs/21 §3.8, §7.8; 29 Б.16 — opt-out)
  avatarKey: text('avatar_key'),
  locale: text('locale'), // null → локаль тенанта
  /**
   * IANA-пояс человека — override пояса точки, только для удалённых (docs/v2/38 §3.1, §7.10;
   * миграция `v2_user_activity`, PR-34). null — пояс точки размещения. Первое звено единой
   * цепочки `personTimezone()` (`server/services/activity.ts`): по ней локальный день события
   * ленты и тихие часы уведомлений. Неизвестное Postgres имя не сохраняется (`users_timezone_chk`).
   */
  timezone: text('timezone'),
  status: text('status').notNull().default('invited'), // invited | active | suspended | archived
  hiredAt: date('hired_at'),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  telegramChatId: bigint('telegram_chat_id', { mode: 'bigint' }),
  telegramBlocked: boolean('telegram_blocked').notNull().default(false), // бот заблокирован (403) — канал переключается на SMS (docs/23 §6.5)
  passwordHash: text('password_hash'), // вход по e-mail + паролю (docs/01 §1.5, docs/16 §14.4): argon2id; в API никогда не отдаётся
  mustChangePassword: boolean('must_change_password').notNull().default(false), // «Змінити пароль після першого входу» (docs/16 §14.4, docs/24 §3.4.1 «Паролі»)
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }), // для политики «Обмежити максимальний термін дії пароля»
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  externalId: text('external_id'), // ID в учётной системе тенанта (для импорта)
  cityId: uuid('city_id').references(() => cities.id),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
}, t => [
  unique().on(t.tenantId, t.phone),
  unique().on(t.tenantId, t.email),
  unique().on(t.tenantId, t.externalId),
  index().on(t.tenantId, t.status),
  // Списки сотрудников — самый частый запрос; кандидаты в индекс не попадают (docs/v2/44 В-14).
  index('users_tenant_status_employee_idx').on(t.tenantId, t.status).where(sql`kind = 'employee'`),
  check('users_kind_chk', sql`${t.kind} in ('employee', 'candidate')`),
  // Рекрутинг (docs/v2/28 §3.2, миграция 0064): вид ↔ состояние согласованы схемой,
  // колонка канбана и ответственный рекрутер — только у кандидатов, поэтому индексы частичные.
  index('idx_users_tenant_kind').on(t.tenantId, t.kind),
  index('idx_users_tenant_candidate_status').on(t.tenantId, t.candidateStatusId).where(sql`kind = 'candidate'`),
  index('idx_users_tenant_recruiter').on(t.tenantId, t.recruiterId).where(sql`kind = 'candidate'`),
  // Развязка 0071 (PR-15): вакансия бывает только у кандидата, поэтому индекс частичный.
  index('idx_users_tenant_vacancy').on(t.tenantId, t.vacancyId).where(sql`kind = 'candidate'`),
  // Воронка (0068): страница колонки канбана по 50 карточек с курсором (§5.2, критерий §13 к. 12)
  // и два прохода ночных задач — архивация отказанных и стирание по истёкшему согласию (§11).
  index('idx_users_candidate_board').on(t.tenantId, t.candidateStatusId, t.createdAt.desc(), t.id).where(sql`kind = 'candidate'`),
  index('idx_users_candidate_state_at').on(t.tenantId, t.candidateState, t.candidateStateAt).where(sql`kind = 'candidate'`),
  index('idx_users_candidate_consent').on(t.tenantId, t.consentExpiresAt).where(sql`kind = 'candidate' and anonymized_at is null`),
  check('users_candidate_state_chk', sql`${t.candidateState} is null or ${t.candidateState} in ('active', 'hired', 'rejected', 'archived', 'withdrawn')`),
  check('users_candidate_coherence_chk', sql`(${t.kind} = 'candidate' and ${t.candidateState} is not null) or (${t.kind} = 'employee' and ${t.candidateState} is null)`),
  check('users_candidate_source_chk', sql`${t.source} is null or ${t.source} in ('manual', 'vacancy_link', 'job_board', 'referral', 'import', 'api')`),
  // Пояс, которого Postgres не знает, не сохраняется: выражение падает «time zone not recognized»
  // (миграция `v2_user_activity`). Иначе он ломал бы позже запись события ленты этого человека.
  check('users_timezone_chk', sql`${t.timezone} is null or (timestamptz '2000-01-01 00:00:00+00' at time zone ${t.timezone}) is not null`),
])

export const userPlacements = pgTable('user_placements', {
  ...baseColumns,
  tenantId: tenantId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  positionId: uuid('position_id').notNull().references(() => positions.id),
  positionLevelId: uuid('position_level_id').references(() => positionLevels.id),
  cityId: uuid('city_id').references(() => cities.id),
  orgUnitId: uuid('org_unit_id').references(() => orgUnits.id),
  // Лінійний керівник цього розміщення (docs/16 §15 Г-16.1 `manager_external_id`, docs/33 D-023) — окремо від
  // `functional_chiefs` (там — виключення з дерева оргструктури, тут — прямий керівник за розміщенням, з імпорту).
  // v2-allow: check9 — (а) объявление колонки user_placements.manager_id в справочнике размещений
  managerId: uuid('manager_id').references(() => users.id, { onDelete: 'set null' }),
  isPrimary: boolean('is_primary').notNull().default(true),
  startedAt: date('started_at').notNull().default(sql`current_date`),
  endedAt: date('ended_at'),
}, t => [
  index().on(t.tenantId, t.locationId, t.positionId).where(sql`${t.endedAt} is null`),
])

export const roles = pgTable('roles', {
  ...baseColumns,
  tenantId: tenantId(),
  code: text('code').notNull(), // employee | mentor | manager | author | admin | custom_*
  name: text('name').notNull(),
  scopes: text('scopes').array().notNull(), // см. docs/01-roles.md §1.3
  isSystem: boolean('is_system').notNull().default(false),
  description: text('description'), // редактор ролей (docs/24 §3.5)
  defaultScopeType: text('default_scope_type').notNull().default('location'), // «область по умолчанию»: tenant | org_unit | location
}, t => [
  unique().on(t.tenantId, t.code),
])

export const userRoles = pgTable('user_roles', {
  ...baseColumns,
  tenantId: tenantId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  roleId: uuid('role_id').notNull().references(() => roles.id),
  scopeType: text('scope_type').notNull(), // tenant | org_unit | location
  scopeId: uuid('scope_id'), // null для tenant
  validUntil: timestamp('valid_until', { withTimezone: true }), // docs/16 §6.2, 29 Б.15: бессрочно (null) или до даты; истёкшая роль не даёт прав
  reason: text('reason'), // причина назначения — для аудита (docs/16 §6.2)
  isOrgDerived: boolean('is_org_derived').notNull().default(false), // выдана правилом «должность → роль» (position_role_map), пересобирается при смене должности
  /**
   * Признак «это назначение роли `owner`» (docs/01 §1.2, миграция 0070_owner_role).
   * Значение проставляет триггер `user_roles_is_owner_trg` из кода роли — руками его не пишут:
   * иначе колонка и роль разошлись бы, а вместе с ними — гарантия БД и права в приложении.
   * Ради него колонка и существует: на неё повешен частичный уникальный индекс
   * `user_roles_single_owner_uq` по `(tenant_id) where is_owner`, и это единственное место,
   * где инвариант «владелец в тенанте ровно один» держится по-настоящему — не в сервисе,
   * не в UI, а в схеме.
   */
  isOwner: boolean('is_owner').notNull().default(false),
}, t => [
  unique().on(t.tenantId, t.userId, t.roleId, t.scopeType, t.scopeId),
  uniqueIndex('user_roles_single_owner_uq').on(t.tenantId).where(sql`${t.isOwner}`),
])

/**
 * Правило «должность → роль» (docs/01 §1.9.1, §1.9.3; docs/02 «Сквозные таблицы»):
 * применяется при импорте и смене должности. scope_id null при scope_type location | org_unit
 * означает «точка/подразделение размещения» — правило одно на всю сеть.
 */
export const positionRoleMap = pgTable('position_role_map', {
  ...baseColumns,
  tenantId: tenantId(),
  positionId: uuid('position_id').notNull().references(() => positions.id, { onDelete: 'cascade' }),
  roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  scopeType: text('scope_type').notNull().default('location'), // tenant | org_unit | location
  scopeId: uuid('scope_id'), // null — область размещения
}, t => [
  unique().on(t.tenantId, t.positionId, t.roleId, t.scopeType, t.scopeId),
  index().on(t.tenantId),
])

export const sessions = pgTable('sessions', {
  ...baseColumns,
  tenantId: tenantId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  userAgent: text('user_agent'),
  ip: inet('ip'),
  impersonatedBy: uuid('impersonated_by').references(() => users.id),
  impersonatorAdminId: uuid('impersonator_admin_id'), // оператор платформы, вошедший «от имени» (docs/24 §4.5): FK на platform_admins в миграции; сессия 60 минут без продления
  impersonationReason: text('impersonation_reason'),
  activeRoleId: uuid('active_role_id').references(() => roles.id, { onDelete: 'set null' }), // активная роль сессии (docs/01 §1.9.2): права — по ней, переключение без выхода
  // Режим «Переглянути систему як роль» (docs/24 §3.5, докс/33 D-052): права сесії рахуються по цій ролі,
  // а не по власних ролях людини; знята роль (delete) сама скидає перегляд. Мутації заборонені (middleware 03.guards).
  previewRoleId: uuid('preview_role_id').references(() => roles.id, { onDelete: 'set null' }),
  requestContext: jsonb('request_context'), // технический контекст события (CLAUDE.md п. 14): {ip, geo, user_agent, browser, os, device}
  loginMethod: text('login_method'), // чем подтверждена личность при входе (docs/33 D-021): otp_sms | otp_telegram | otp_email | password | password_otp | google | invite | impersonation
  // Промежуточная сессия двухфакторного входа (docs/24 §3.4, PR-39): первый фактор пройден,
  // второго ещё нет. Такая сессия открывает только `/auth/two-factor/*` и выход (01.session.ts),
  // живёт 10 минут и после кода получает новый токен — промежуточный в полную не превращается.
  twoFactorPending: boolean('two_factor_pending').notNull().default(false),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, t => [
  index().on(t.tenantId),
])

/** tenant_id nullable: код запрашивается до выбора пространства. RLS настроен с учётом null. */
export const otpCodes = pgTable('otp_codes', {
  ...baseColumns,
  tenantId: uuid('tenant_id'),
  phone: text('phone').notNull(),
  codeHash: text('code_hash').notNull(),
  channel: text('channel').notNull(), // telegram | sms | email (docs/28 «Вхід: код на e-mail»)
  attempts: bigint('attempts', { mode: 'number' }).notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
}, t => [
  index().on(t.tenantId),
  index().on(t.phone, t.expiresAt.desc()),
])

export const invitations = pgTable('invitations', {
  ...baseColumns,
  tenantId: tenantId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id),
}, t => [
  index().on(t.tenantId),
])
