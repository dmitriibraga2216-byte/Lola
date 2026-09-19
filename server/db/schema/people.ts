import { sql } from 'drizzle-orm'
import {
  bigint, boolean, date, index, inet, jsonb, pgTable, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { tenants } from './tenants'
import { locations, orgUnits, positions } from './org'
import { cities, positionLevels } from './refs'

export const users = pgTable('users', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
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
  avatarKey: text('avatar_key'),
  locale: text('locale'), // null → локаль тенанта
  status: text('status').notNull().default('invited'), // invited | active | suspended | archived
  hiredAt: date('hired_at'),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  telegramChatId: bigint('telegram_chat_id', { mode: 'bigint' }),
  passwordHash: text('password_hash'), // только для e-mail входа
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  externalId: text('external_id'), // ID в учётной системе тенанта (для импорта)
  cityId: uuid('city_id').references(() => cities.id),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
}, t => [
  unique().on(t.tenantId, t.phone),
  unique().on(t.tenantId, t.email),
  unique().on(t.tenantId, t.externalId),
  index().on(t.tenantId, t.status),
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
}, t => [
  unique().on(t.tenantId, t.userId, t.roleId, t.scopeType, t.scopeId),
])

export const sessions = pgTable('sessions', {
  ...baseColumns,
  tenantId: tenantId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  userAgent: text('user_agent'),
  ip: inet('ip'),
  impersonatedBy: uuid('impersonated_by').references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
})

/** tenant_id nullable: код запрашивается до выбора пространства. RLS настроен с учётом null. */
export const otpCodes = pgTable('otp_codes', {
  ...baseColumns,
  tenantId: uuid('tenant_id'),
  phone: text('phone').notNull(),
  codeHash: text('code_hash').notNull(),
  channel: text('channel').notNull(), // telegram | sms
  attempts: bigint('attempts', { mode: 'number' }).notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
}, t => [
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
})
