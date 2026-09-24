import { randomBytes } from 'node:crypto'
import { and, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm'
import {
  cities, enrollments, functionalChiefs, invitations, locations, orgUnits, positionLevels, positions, roles, sessions, userNotes, userPlacements, userRoles, users,
} from '../db/schema'
import { OWNER_ROLE_CODE } from '../../shared/domain/roles'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { keysetAfter, keysetAt } from '../utils/keyset'
import { KEYSETS, encodeKeyset } from '../../shared/domain/keyset'
import { enqueueNotification } from './notifications'
import { recordAudit } from './audit'
import { logSecurity } from './securityLog'
import { ensureTags } from './tags'
import { logOrgConflict } from './journals'
import { scopeSql } from './access'
import { hashToken } from './session'
import { applyPositionRoles } from './positionRoleMap'
import { levelLabel } from './development'
import type { CompetencyLevel } from './development'
import { studyHistory } from './reportsExtra'
import { EMPLOYEES_ONLY, employeeOnly } from './repo/people'
import { STAGE_ON_HIRE } from '../../shared/enums'
import type { z } from 'zod'
import type { PersonCreateInput, PersonUpdateInput, personListQuerySchema } from '../../shared/schemas/people'

interface Ctx { tenantId: string, actorId: string }

export type PersonListFilter = z.infer<typeof personListQuerySchema>

/**
 * Список людей с фильтрами (docs/05-screens.md §5.9), курсорная пагинация по `(created_at, id)`.
 * Момент в курсоре — текстом из Postgres с микросекундами (`shared/domain/keyset.ts`): импорт
 * пишет пачку в одной транзакции, у всей пачки один `created_at`, и курсор в миллисекундах
 * выбрасывал её остаток со второй страницы и из выгрузки.
 */
export async function listPeople(ctx: Ctx, filter: PersonListFilter) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    // Условия фильтров без вкладки и курсора — общие для страницы и для счётчиков чипов
    // «Активні · Заблоковані · Усі» (docs/31 `People`): счётчик считает по тем же фильтрам
    // (пошук, посада, точка …), только статус переключается.
    const baseConditions = []
    if (filter.q) {
      baseConditions.push(or(
        ilike(users.fullName, `%${filter.q}%`),
        ilike(users.phone, `%${filter.q}%`),
      )!)
    }
    if (filter.locationId || filter.positionId || filter.positionLevelId || filter.orgUnitId) {
      const placementCond = [
        eq(userPlacements.tenantId, ctx.tenantId),
        isNull(userPlacements.endedAt),
        ...(filter.locationId ? [eq(userPlacements.locationId, filter.locationId)] : []),
        ...(filter.positionId ? [eq(userPlacements.positionId, filter.positionId)] : []),
        ...(filter.positionLevelId ? [eq(userPlacements.positionLevelId, filter.positionLevelId)] : []),
        ...(filter.orgUnitId ? [eq(userPlacements.orgUnitId, filter.orgUnitId)] : []),
      ]
      baseConditions.push(sql`exists (select 1 from ${userPlacements}
        where ${and(...placementCond, eq(userPlacements.userId, users.id))})`)
    }
    if (filter.cityId) baseConditions.push(eq(users.cityId, filter.cityId))
    if (filter.tag) baseConditions.push(sql`${filter.tag} = any(${users.tags})`)
    if (filter.role) baseConditions.push(sql`exists (select 1 from ${userRoles} ur join ${roles} r on r.id = ur.role_id where ur.user_id = ${users.id} and r.code = ${filter.role})`)
    if (filter.registeredFrom) baseConditions.push(sql`${users.createdAt} >= ${filter.registeredFrom}::date`)
    if (filter.registeredTo) baseConditions.push(sql`${users.createdAt} < (${filter.registeredTo}::date + 1)`)
    if (filter.activeFrom) baseConditions.push(sql`${users.lastSeenAt} >= ${filter.activeFrom}::date`)
    if (filter.activeTo) baseConditions.push(sql`${users.lastSeenAt} < (${filter.activeTo}::date + 1)`)
    // Скрытые (docs/16 §7.5) — только администратору, который явно попросил
    if (!filter.includeHidden) baseConditions.push(eq(users.isHidden, false))

    const conditions = [...baseConditions]
    if (filter.tab === 'active') conditions.push(inArray(users.status, ['invited', 'active']))
    if (filter.tab === 'blocked') conditions.push(inArray(users.status, ['suspended', 'archived']))
    const after = keysetAfter(KEYSETS.people, filter.cursor, [users.createdAt, users.id], 'desc')
    if (after) conditions.push(after)

    const [counts] = await tx.select({
      active: sql<number>`count(*) filter (where ${users.status} in ('invited', 'active'))::int`,
      blocked: sql<number>`count(*) filter (where ${users.status} in ('suspended', 'archived'))::int`,
      all: sql<number>`count(*)::int`,
    }).from(users).where(employeeOnly(...baseConditions))

    const rows = await tx.select({
      id: users.id,
      fullName: users.fullName,
      phone: users.phone,
      email: users.email,
      status: users.status,
      tags: users.tags,
      hiredAt: users.hiredAt,
      lastSeenAt: users.lastSeenAt,
      createdAt: users.createdAt,
      cursorAt: keysetAt(users.createdAt),
      cityName: cities.name,
      externalId: users.externalId,
      isBlocked: users.isBlocked,
      isHidden: users.isHidden,
    })
      .from(users)
      .leftJoin(cities, eq(cities.id, users.cityId))
      .where(employeeOnly(...conditions))
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(filter.limit + 1)

    const hasMore = rows.length > filter.limit
    const page = hasMore ? rows.slice(0, filter.limit) : rows
    const last = page[page.length - 1]

    const ids = page.map(r => r.id)
    const placements = ids.length
      ? await tx.select({
          userId: userPlacements.userId,
          isPrimary: userPlacements.isPrimary,
          locationName: locations.name,
          positionName: positions.name,
          levelName: positionLevels.name,
          orgUnitName: orgUnits.name,
        })
          .from(userPlacements)
          .innerJoin(locations, eq(locations.id, userPlacements.locationId))
          .innerJoin(positions, eq(positions.id, userPlacements.positionId))
          .leftJoin(positionLevels, eq(positionLevels.id, userPlacements.positionLevelId))
          .leftJoin(orgUnits, eq(orgUnits.id, userPlacements.orgUnitId))
          .where(and(inArray(userPlacements.userId, ids), isNull(userPlacements.endedAt)))
      : []

    const roleRows = ids.length
      ? await tx.select({ userId: userRoles.userId, code: roles.code, name: roles.name })
          .from(userRoles)
          .innerJoin(roles, eq(roles.id, userRoles.roleId))
          .where(inArray(userRoles.userId, ids))
      : []

    return {
      items: page.map(({ cursorAt: _cursorAt, ...r }) => ({
        ...r,
        placements: placements.filter(p => p.userId === r.id)
          .map(({ userId: _, ...p }) => p),
        roles: [...new Set(roleRows.filter(x => x.userId === r.id).map(x => x.name))],
      })),
      cursor: hasMore && last ? encodeKeyset(KEYSETS.people, [last.cursorAt, last.id]) : null,
      counts: counts ?? { active: 0, blocked: 0, all: 0 },
    }
  })
}

export async function getPerson(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [person] = await tx.select().from(users).where(eq(users.id, id))
    if (!person) return null

    const placements = await tx.select({
      id: userPlacements.id,
      isPrimary: userPlacements.isPrimary,
      startedAt: userPlacements.startedAt,
      endedAt: userPlacements.endedAt,
      locationId: userPlacements.locationId,
      positionId: userPlacements.positionId,
      locationName: locations.name,
      positionName: positions.name,
    })
      .from(userPlacements)
      .innerJoin(locations, eq(locations.id, userPlacements.locationId))
      .innerJoin(positions, eq(positions.id, userPlacements.positionId))
      .where(eq(userPlacements.userId, id))
      .orderBy(desc(userPlacements.startedAt))

    const roleRows = await tx.select({
      id: userRoles.id,
      code: roles.code,
      name: roles.name,
      scopeType: userRoles.scopeType,
      scopeId: userRoles.scopeId,
      validUntil: userRoles.validUntil,
      reason: userRoles.reason,
      isOrgDerived: userRoles.isOrgDerived,
      createdAt: userRoles.createdAt,
    })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, id))
      .orderBy(desc(userRoles.createdAt))

    const sessionRows = await tx.select({
      id: sessions.id,
      createdAt: sessions.createdAt,
      userAgent: sessions.userAgent,
      ip: sessions.ip,
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
    })
      .from(sessions)
      .where(eq(sessions.userId, id))
      .orderBy(desc(sessions.createdAt))
      .limit(20)

    // Хеш пароля в API не отдаётся никогда (docs/16 §3.1, CLAUDE.md п. 10); наружу — только факт наличия
    const { passwordHash, ...safe } = person
    return { ...safe, hasPassword: passwordHash != null, placements, roles: roleRows, sessions: sessionRows }
  })
}

/** ФИО хранится и по частям, и собранным — «Прізвище Імʼя По батькові» (docs/16 §3.1). */
export function splitName(input: { fullName?: string, lastName?: string | null, firstName?: string | null, middleName?: string | null }) {
  if (input.lastName && input.firstName) {
    return { lastName: input.lastName, firstName: input.firstName, middleName: input.middleName ?? null, fullName: [input.lastName, input.firstName, input.middleName].filter(Boolean).join(' ') }
  }
  const parts = (input.fullName ?? '').trim().split(/\s+/)
  return { lastName: parts[0] ?? null, firstName: parts[1] ?? null, middleName: parts.slice(2).join(' ') || null, fullName: (input.fullName ?? '').trim() }
}

/**
 * Единственного владельца нельзя заблокировать, архивировать и лишить роли (docs/01 §1.9.4).
 * Отличие от «последнего администратора» принципиальное: администраторов можно назначить
 * ещё, а владелец в тенанте ровно один — значит выход у него один, передать владение
 * (`server/services/owner.ts`, `POST /settings/owner/transfer`). Поэтому здесь нет условия
 * «и он единственный»: владелец всегда единственный.
 */
export async function isLastOwner(tx: TenantTx, userId: string): Promise<boolean> {
  const { isSoleOwner } = await import('./owner')
  return isSoleOwner(tx, userId)
}

/** Последнего администратора нельзя заблокировать, архивировать или лишить роли (docs/16 §7.6). */
export async function isLastAdmin(tx: TenantTx, userId: string): Promise<boolean> {
  const admins = await tx.execute(sql`select ur.user_id from user_roles ur join roles r on r.id = ur.role_id join users u on u.id = ur.user_id where r.code = 'admin' and ur.scope_type = 'tenant' and (ur.valid_until is null or ur.valid_until > now()) and u.status in ('active','invited') and not u.is_blocked ${EMPLOYEES_ONLY()}`) as unknown as { user_id: string }[]
  const ids = new Set(admins.map(a => a.user_id))
  return ids.has(userId) && ids.size === 1
}

export async function createPerson(ctx: Ctx, input: PersonCreateInput) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const parts = splitName(input)
    // Метки человека — область `user` (docs/16 §14.2): неизвестные заводятся в справочнике
    const personTags = await ensureTags(tx, ctx.tenantId, 'user', input.tags)
    const [person] = await tx.insert(users).values({
      tenantId: ctx.tenantId,
      fullName: parts.fullName,
      lastName: parts.lastName, firstName: parts.firstName, middleName: parts.middleName,
      latinName: input.latinName ?? null,
      workContacts: input.workContacts ?? {},
      birthDate: input.birthDate ?? null,
      gender: input.gender ?? null,
      positionSince: input.positionSince ?? null,
      comment: input.comment ?? null,
      isBlocked: input.isBlocked ?? false,
      isHidden: input.isHidden ?? false,
      phone: input.phone ?? null,
      email: input.email ?? null,
      cityId: input.cityId ?? null,
      tags: personTags,
      hiredAt: input.hiredAt ?? null,
      externalId: input.externalId ?? null,
      locale: input.locale ?? null,
    }).returning()

    // docs/v2/33 §4.1: ручное заведение человека — тот же вход в цикл, что и найм из воронки,
    // и даёт этап «Онбординг». Без этого состояние человека появлялось бы только у тех, кого
    // нанимают через `POST /people/hire`, а счётчик людей в этапе врал бы (§5.2).
    const { enterStageByCodeTx } = await import('./lifecycleState')
    await enterStageByCodeTx(tx, { tenantId: ctx.tenantId, userId: person!.id, code: STAGE_ON_HIRE, reasonCode: 'hire', enteredBy: ctx.actorId })

    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'people.create',
      entity: 'user',
      entityId: person!.id,
      after: { fullName: person!.fullName, phone: person!.phone },
    })
    const { emitWebhook } = await import('./webhooks')
    await emitWebhook(tx, ctx.tenantId, 'user.created', { userId: person!.id, fullName: person!.fullName, externalId: person!.externalId })
    await logSecurity({ tenantId: ctx.tenantId, userId: person!.id, event: 'user.created', meta: { by: ctx.actorId } })
    return person!
  })
}

export async function updatePerson(ctx: Ctx, id: string, input: PersonUpdateInput) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(users).where(eq(users.id, id))
    if (!before) return null

    if (input.status === 'archived' || input.status === 'suspended' || input.isBlocked) {
      if (await isLastAdmin(tx, id)) return { lastAdmin: true as const }
      if (await isLastOwner(tx, id)) return { lastOwner: true as const }
    }
    const nameParts = (input.lastName !== undefined || input.firstName !== undefined || input.middleName !== undefined || input.fullName !== undefined)
      ? splitName({ fullName: input.fullName, lastName: input.lastName ?? before.lastName ?? undefined, firstName: input.firstName ?? before.firstName ?? undefined, middleName: input.middleName === undefined ? before.middleName : input.middleName })
      : null
    const [after] = await tx.update(users).set({
      ...(nameParts ? { fullName: nameParts.fullName, lastName: nameParts.lastName, firstName: nameParts.firstName, middleName: nameParts.middleName } : {}),
      ...(input.latinName !== undefined ? { latinName: input.latinName } : {}),
      ...(input.workContacts !== undefined ? { workContacts: input.workContacts } : {}),
      ...(input.birthDate !== undefined ? { birthDate: input.birthDate } : {}),
      ...(input.gender !== undefined ? { gender: input.gender } : {}),
      ...(input.positionSince !== undefined ? { positionSince: input.positionSince } : {}),
      ...(input.comment !== undefined ? { comment: input.comment } : {}),
      ...(input.isBlocked !== undefined ? { isBlocked: input.isBlocked } : {}),
      ...(input.isHidden !== undefined ? { isHidden: input.isHidden } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.cityId !== undefined ? { cityId: input.cityId } : {}),
      ...(input.tags !== undefined ? { tags: await ensureTags(tx, ctx.tenantId, 'user', input.tags) } : {}),
      ...(input.hiredAt !== undefined ? { hiredAt: input.hiredAt } : {}),
      ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
      ...(input.status !== undefined
        ? {
            status: input.status,
            ...(input.status === 'archived' ? { archivedAt: new Date() } : {}),
          }
        : {}),
      updatedAt: new Date(),
    }).where(eq(users.id, id)).returning()

    // Архивация, блокировка и смена телефона отзывают сессии (docs/01 §1.6, docs/16 §7.4, §12)
    if (input.status === 'archived' || input.status === 'suspended' || input.isBlocked || (input.phone !== undefined && input.phone !== before.phone)) {
      await tx.update(sessions).set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, id), isNull(sessions.revokedAt)))
    }
    if (input.isBlocked && !before.isBlocked) {
      const [mgr] = await tx.execute(sql`select l.manager_id from user_placements up join locations l on l.id = up.location_id where up.user_id = ${id}::uuid and up.is_primary and up.ended_at is null limit 1`) as unknown as { manager_id: string | null }[]
      if (mgr?.manager_id) await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: mgr.manager_id, code: 'user_blocked', payload: { name: before.fullName }, dedupKey: `user_blocked:${id}:${Date.now()}` })
    }

    // Аудит с diff по изменившимся полям (docs/16 §5.2 «Журнал»): before/after — только то, что поменялось
    const changed = (Object.keys(after!) as (keyof typeof after)[]).filter(k => k !== 'updatedAt' && k !== 'passwordHash' && JSON.stringify(before[k]) !== JSON.stringify(after![k]))
    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'people.update',
      entity: 'user',
      entityId: id,
      before: Object.fromEntries(changed.map(k => [k, before[k]])),
      after: Object.fromEntries(changed.map(k => [k, after![k]])),
    })
    // Журнал безопасности (docs/16 §15): смена контактов, блокировка/разблокировка, архив
    const contactKeys = changed.filter(k => k === 'phone' || k === 'email' || k === 'workContacts' || k === 'telegramChatId')
    if (contactKeys.length) await logSecurity({ tenantId: ctx.tenantId, userId: id, event: 'contacts.changed', meta: { by: ctx.actorId, fields: contactKeys } })
    if (before.isBlocked !== after!.isBlocked) await logSecurity({ tenantId: ctx.tenantId, userId: id, event: after!.isBlocked ? 'user.blocked' : 'user.unblocked', meta: { by: ctx.actorId } })
    if (before.status !== 'archived' && after!.status === 'archived') await logSecurity({ tenantId: ctx.tenantId, userId: id, event: 'user.archived', meta: { by: ctx.actorId } })
    return after!
  })
}

/** Приглашение: одноразовый токен 48 часов; отдаём ссылку (доставка каналами — этап 4). */
export async function createInvitation(ctx: Ctx, userId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [person] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId))
    if (!person) return null

    const token = randomBytes(24).toString('base64url')
    await tx.insert(invitations).values({
      tenantId: ctx.tenantId,
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      createdBy: ctx.actorId,
    })

    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'people.invite',
      entity: 'user',
      entityId: userId,
    })
    const url = `/invite?token=${token}`
    // docs/16 §8 user_invited — человеку по SMS/Telegram (ссылка абсолютная, APP_URL из окружения)
    await enqueueNotification(tx, { tenantId: ctx.tenantId, userId, code: 'user_invited', payload: { url: `${process.env.APP_URL ?? ''}${url}` }, dedupKey: `user_invited:${userId}:${Date.now()}` })
    return { token, url }
  })
}

export async function addPlacement(ctx: Ctx, userId: string, input: {
  locationId: string
  positionId: string
  positionLevelId?: string | null
  cityId?: string | null
  orgUnitId?: string | null
  isPrimary: boolean
  startedAt?: string
}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [loc] = await tx.select({ orgUnitId: locations.orgUnitId, cityId: locations.cityId }).from(locations).where(eq(locations.id, input.locationId))
    if (!loc) throw createError({ statusCode: 400, data: { code: 'validation_failed', message: 'Точку не знайдено' } })
    // docs/16 §6.1: точка должна принадлежать выбранному подразделению
    if (input.orgUnitId && input.orgUnitId !== loc.orgUnitId) throw createError({ statusCode: 400, data: { code: 'validation_failed', message: 'Точка не належить обраному підрозділу' } })
    if (!input.isPrimary) {
      // docs/16 §14: человек в двух подразделениях — не ошибка, а строка протокола конфликтов; действие продолжается
      const other = await tx.select({ id: userPlacements.id, orgUnitId: userPlacements.orgUnitId, locationId: userPlacements.locationId }).from(userPlacements)
        .where(and(eq(userPlacements.userId, userId), isNull(userPlacements.endedAt)))
      const unitId = input.orgUnitId ?? loc.orgUnitId
      const clash = other.find(o => (o.orgUnitId ?? null) !== unitId)
      if (clash) await logOrgConflict(tx, { tenantId: ctx.tenantId, userId, kind: 'double_unit', actorId: ctx.actorId, details: { orgUnitId: unitId, otherOrgUnitId: clash.orgUnitId, otherLocationId: clash.locationId, locationId: input.locationId } })
    }
    if (input.isPrimary) {
      // Прошлое основное размещение закрывается (docs/01-roles.md §1.8: история цела)
      await tx.update(userPlacements)
        .set({ endedAt: sql`current_date` })
        .where(and(
          eq(userPlacements.userId, userId),
          eq(userPlacements.isPrimary, true),
          isNull(userPlacements.endedAt),
        ))
    }
    const [placement] = await tx.insert(userPlacements).values({
      tenantId: ctx.tenantId,
      userId,
      locationId: input.locationId,
      positionId: input.positionId,
      positionLevelId: input.positionLevelId ?? null,
      cityId: input.cityId ?? loc.cityId ?? null,
      orgUnitId: input.orgUnitId ?? loc.orgUnitId,
      isPrimary: input.isPrimary,
      ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    }).returning()

    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'people.placement',
      entity: 'user',
      entityId: userId,
      after: input,
    })
    // docs/01 §1.9.3: правило «должность → роль» применяется при смене должности
    if (input.isPrimary) await applyPositionRoles(tx, ctx, userId)
    return placement!
  }).then(async (placement) => {
    // Новый человек на позиции → профили/правила/автосинхронизация (docs/15 §7.2, §7.6)
    const { onPlacementChanged } = await import('./automation')
    onPlacementChanged(ctx.tenantId, userId).catch(err => console.error('onPlacementChanged', err))
    return placement
  })
}

/** Роль `owner` через `assignRole` не выдаётся — см. комментарий внутри и docs/01 §1.9.4. */
export const OWNER_NOT_ASSIGNABLE = 'owner_role' as const

/**
 * Назначение роли (docs/16 §6.2): роль, область, срок (бессрочно или до даты), причина — для аудита.
 * Повторное назначение той же роли в той же области — редактирование срока и причины
 * (роль, выданная правилом «должность → роль», при этом становится ручной).
 */
export async function assignRole(ctx: Ctx, userId: string, input: {
  roleCode: string
  scopeType: 'tenant' | 'org_unit' | 'location'
  scopeId?: string | null
  validUntil?: string | null
  reason?: string | null
}) {
  // Владение не раздают через карточку человека (docs/01 §1.9.4): у роли `owner` свой путь —
  // «Стати власником» в пустом тенанте и «Передати володіння» от действующего владельца.
  // Иначе `role.assign` (есть у администратора) обходил бы `tenant.transfer` (его нет ни у кого,
  // кроме владельца), а частичный уникальный индекс отвечал бы на это голым 23505.
  if (input.roleCode === OWNER_ROLE_CODE) return OWNER_NOT_ASSIGNABLE
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [role] = await tx.select().from(roles).where(eq(roles.code, input.roleCode))
    if (!role) return null

    const scopeId = input.scopeType === 'tenant' ? null : (input.scopeId ?? null)
    const validUntil = input.validUntil ? new Date(`${input.validUntil}T23:59:59.999Z`) : null
    const reason = input.reason?.trim() || null
    const [prev] = await tx.select({ id: userRoles.id, validUntil: userRoles.validUntil, reason: userRoles.reason, isOrgDerived: userRoles.isOrgDerived })
      .from(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.roleId, role.id), eq(userRoles.scopeType, input.scopeType), scopeId ? eq(userRoles.scopeId, scopeId) : isNull(userRoles.scopeId)))
    const [assigned] = await tx.insert(userRoles).values({
      tenantId: ctx.tenantId,
      userId,
      roleId: role.id,
      scopeType: input.scopeType,
      scopeId,
      validUntil,
      reason,
    }).onConflictDoUpdate({
      target: [userRoles.tenantId, userRoles.userId, userRoles.roleId, userRoles.scopeType, userRoles.scopeId],
      set: { validUntil, reason, isOrgDerived: false, updatedAt: new Date() },
    }).returning()

    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: prev ? 'role.update' : 'role.assign',
      entity: 'user',
      entityId: userId,
      before: prev ? { roleCode: input.roleCode, scopeType: input.scopeType, scopeId, validUntil: prev.validUntil, reason: prev.reason, isOrgDerived: prev.isOrgDerived } : null,
      after: { roleCode: input.roleCode, scopeType: input.scopeType, scopeId, validUntil, reason },
    })
    await logSecurity({ tenantId: ctx.tenantId, userId, event: 'roles.changed', meta: { by: ctx.actorId, action: prev ? 'update' : 'assign', roleCode: input.roleCode, scopeType: input.scopeType, scopeId } })
    // docs/16 §8: человеку — о новой роли (кроме базовой employee при создании)
    if (assigned && !prev && input.roleCode !== 'employee' && userId !== ctx.actorId) {
      await enqueueNotification(tx, { tenantId: ctx.tenantId, userId, code: 'user_role_granted', payload: { role: role.name }, dedupKey: `role_granted:${userId}:${role.id}:${Date.now()}` })
    }
    return assigned ?? role
  })
}

// ── docs/16: блокировка, архивирование, сессии, слияние, GDPR, экспорт ──

export type BlockResult = { ok: true } | { ok: false, code: 'not_found' | 'last_admin' | 'last_owner' }

/** Блокировка запрещает вход, обучение не снимает (docs/16 §7.4). */
export async function setBlocked(ctx: Ctx, userId: string, blocked: boolean): Promise<BlockResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [u] = await tx.select({ id: users.id, fullName: users.fullName }).from(users).where(eq(users.id, userId))
    if (!u) return { ok: false as const, code: 'not_found' as const }
    if (blocked && await isLastAdmin(tx, userId)) return { ok: false as const, code: 'last_admin' as const }
    if (blocked && await isLastOwner(tx, userId)) return { ok: false as const, code: 'last_owner' as const }
    await tx.update(users).set({ isBlocked: blocked, status: blocked ? 'suspended' : 'active', updatedAt: new Date() }).where(eq(users.id, userId))
    if (blocked) await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: blocked ? 'people.block' : 'people.unblock', entity: 'user', entityId: userId })
    // docs/16 §15, Г-16.2: «Адміністратор заблокував користувача»
    await logSecurity({ tenantId: ctx.tenantId, userId, event: blocked ? 'user.blocked' : 'user.unblocked', meta: { by: ctx.actorId } })
    if (blocked) {
      const [mgr] = await tx.execute(sql`select l.manager_id from user_placements up join locations l on l.id = up.location_id where up.user_id = ${userId}::uuid and up.is_primary and up.ended_at is null limit 1`) as unknown as { manager_id: string | null }[]
      if (mgr?.manager_id && mgr.manager_id !== ctx.actorId) await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: mgr.manager_id, code: 'user_blocked', payload: { name: u.fullName }, dedupKey: `user_blocked:${userId}:${Date.now()}` })
    }
    return { ok: true as const }
  })
}

/** Архивирование (docs/16 §4, §6.3): снимает незавершённое обучение, закрывает сессии, отзывает роли; история и сертификаты остаются. */
export async function archivePerson(ctx: Ctx, userId: string, input: { reason: 'dismissal' | 'transfer' | 'mistake' | 'other', comment?: string, date?: string, closeSessions?: boolean, cancelLearning?: boolean }): Promise<BlockResult & { cancelled?: number }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId))
    if (!u) return { ok: false as const, code: 'not_found' as const }
    if (await isLastAdmin(tx, userId)) return { ok: false as const, code: 'last_admin' as const }
    if (await isLastOwner(tx, userId)) return { ok: false as const, code: 'last_owner' as const }
    const at = input.date ? new Date(input.date) : new Date()
    await tx.update(users).set({ status: 'archived', archivedAt: at, updatedAt: new Date() }).where(eq(users.id, userId))
    await tx.update(userPlacements).set({ endedAt: sql`${at.toISOString().slice(0, 10)}::date` }).where(and(eq(userPlacements.userId, userId), isNull(userPlacements.endedAt)))
    if (input.closeSessions !== false) await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    let cancelled = 0
    if (input.cancelLearning !== false) {
      cancelled = (await tx.update(enrollments).set({ cancelledAt: new Date(), cancelledBy: ctx.actorId, cancelReason: 'archived', updatedAt: new Date() }).where(and(eq(enrollments.userId, userId), inArray(enrollments.status, ['not_started', 'in_progress']), isNull(enrollments.cancelledAt))).returning({ id: enrollments.id })).length
    }
    await tx.delete(userRoles).where(eq(userRoles.userId, userId))
    // docs/21 §12: статьи уволившегося владельца → тому, кто архивирует, с пометкой «потребує перевірки»
    const { reassignOwner } = await import('./knowledge')
    await reassignOwner(tx, ctx.tenantId, userId, ctx.actorId)
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'people.archive', entity: 'user', entityId: userId, after: { reason: input.reason, comment: input.comment ?? null, cancelled } })
    await logSecurity({ tenantId: ctx.tenantId, userId, event: 'user.archived', meta: { by: ctx.actorId, reason: input.reason } })
    if (input.closeSessions !== false) await logSecurity({ tenantId: ctx.tenantId, userId, event: 'session.revoked', meta: { by: ctx.actorId, reason: 'archived' } })
    return { ok: true as const, cancelled }
  })
}

export async function listSessions(ctx: Ctx, userId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({ id: sessions.id, userAgent: sessions.userAgent, ip: sessions.ip, createdAt: sessions.createdAt, updatedAt: sessions.updatedAt, expiresAt: sessions.expiresAt, revokedAt: sessions.revokedAt, impersonatedBy: sessions.impersonatedBy })
      .from(sessions).where(eq(sessions.userId, userId)).orderBy(desc(sessions.createdAt)).limit(50)
  })
}

export async function closeSessions(ctx: Ctx, userId: string, sessionId?: string): Promise<number> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), ...(sessionId ? [eq(sessions.id, sessionId)] : []))).returning({ id: sessions.id })
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'people.close_sessions', entity: 'user', entityId: userId, after: { closed: rows.length, sessionId: sessionId ?? null } })
    if (rows.length) await logSecurity({ tenantId: ctx.tenantId, userId, event: 'session.revoked', meta: { by: ctx.actorId, reason: 'admin', closed: rows.length } })
    return rows.length
  })
}

/** Слияние дублей (docs/16 §7.7): история, сертификаты, попытки переносятся в основную; дубль архивируется с пометкой. */
export async function mergePeople(ctx: Ctx, primaryId: string, duplicateId: string): Promise<{ ok: true, moved: Record<string, number> } | { ok: false, code: 'not_found' | 'same' | 'last_owner' }> {
  if (primaryId === duplicateId) return { ok: false, code: 'same' }
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [p] = await tx.select({ id: users.id, fullName: users.fullName }).from(users).where(eq(users.id, primaryId))
    const [d] = await tx.select({ id: users.id, fullName: users.fullName, phone: users.phone, email: users.email }).from(users).where(eq(users.id, duplicateId))
    if (!p || !d) return { ok: false as const, code: 'not_found' as const }
    // Дубль архивируется — значит владельцем он быть не может (docs/01 §1.9.4): иначе
    // владение осталось бы на архивной карточке, и передать его стало бы некому.
    if (await isLastOwner(tx, duplicateId)) return { ok: false as const, code: 'last_owner' as const }
    const moved: Record<string, number> = {}
    for (const [table, col] of [['enrollments', 'user_id'], ['attempts', 'user_id'], ['certificates', 'user_id'], ['workshop_submissions', 'user_id'], ['meetup_registrations', 'user_id'], ['program_enrollments', 'user_id'], ['competency_assessments', 'user_id'], ['development_goals', 'user_id'], ['news_views', 'user_id'], ['notifications', 'user_id']] as const) {
      const r = await tx.execute(sql`update ${sql.identifier(table)} set ${sql.identifier(col)} = ${primaryId}::uuid where ${sql.identifier(col)} = ${duplicateId}::uuid`) as unknown as { count?: number }
      moved[table] = Number((r as { count?: number }).count ?? 0)
    }
    await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, duplicateId), isNull(sessions.revokedAt)))
    await tx.update(userPlacements).set({ endedAt: sql`current_date` }).where(and(eq(userPlacements.userId, duplicateId), isNull(userPlacements.endedAt)))
    await tx.update(users).set({ status: 'archived', archivedAt: new Date(), phone: null, email: null, externalId: null, comment: sql`coalesce(${users.comment}, '') || ${`\nОбʼєднано з ${p.fullName} (${primaryId})`}`, updatedAt: new Date() }).where(eq(users.id, duplicateId))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'people.merge', entity: 'user', entityId: primaryId, before: { duplicateId, phone: d.phone, email: d.email }, after: moved })
    return { ok: true as const, moved }
  })
}

/** Удаление данных по запросу (docs/16 §7.9): ФИО → «Користувач #id», контакты и фото в null; результаты остаются обезличенно; необратимо. */
export async function gdprErase(ctx: Ctx, userId: string, reason: string): Promise<boolean | 'last_owner'> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId))
    if (!u) return false
    // Стирание архивирует карточку, а владелец в архив не уходит (docs/01 §1.9.4).
    // Владелец, потребовавший забыть его, сперва передаёт владение — иначе простор остаётся
    // без подписанта договора, и это необратимо.
    if (await isLastOwner(tx, userId)) return 'last_owner' as const
    const short = userId.slice(0, 8)
    await tx.update(users).set({ fullName: `Користувач #${short}`, lastName: `Користувач`, firstName: `#${short}`, middleName: null, latinName: null, phone: null, email: null, workContacts: {}, birthDate: null, avatarKey: null, comment: null, telegramChatId: null, externalId: null, status: 'archived', archivedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, userId))
    await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    await tx.delete(userNotes).where(eq(userNotes.userId, userId))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'people.gdpr_erase', entity: 'user', entityId: userId, after: { reason } })
    return true
  })
}

/** Экспорт списка в Excel — только колонки, доступные по роли (docs/16 §7.8). */
export async function exportPeople(ctx: Ctx, filter: PersonListFilter, opts: { withContacts: boolean }): Promise<Buffer> {
  const { toXlsx } = await import('./reports')
  const all: Record<string, unknown>[] = []
  let cursor: string | undefined
  do {
    const page = await listPeople(ctx, { ...filter, cursor, limit: 100 })
    for (const r of page.items) all.push({ 'ПІБ': r.fullName, 'Посада': r.placements[0]?.positionName ?? '', 'Рівень': r.placements[0]?.levelName ?? '', 'Місто': r.cityName ?? '', 'Підрозділ': r.placements[0]?.orgUnitName ?? '', 'Точка': r.placements[0]?.locationName ?? '', 'Ролі': r.roles.join(', '), 'Мітки': r.tags.join(', '), ...(opts.withContacts ? { 'Телефон': r.phone ?? '' } : {}), 'Зареєстровано': r.createdAt.toISOString().slice(0, 10), 'Остання активність': r.lastSeenAt?.toISOString().slice(0, 10) ?? '', 'Зовнішній №': r.externalId ?? '', 'Статус': r.status })
    cursor = page.cursor ?? undefined
  } while (cursor && all.length < 10_000)
  return toXlsx('Люди', all as never)
}

// ── Заметки, функциональные руководители, группы (docs/16 §3.4–3.5, §5.2) ──

export async function addNote(ctx: Ctx, userId: string, body: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => (await tx.insert(userNotes).values({ tenantId: ctx.tenantId, userId, authorId: ctx.actorId, body }).returning())[0]!)
}
export async function listNotes(ctx: Ctx, userId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, tx => tx.execute(sql`select n.id, n.body, n.created_at, u.full_name as author from user_notes n left join users u on u.id = n.author_id where n.user_id = ${userId}::uuid order by n.created_at desc`) as unknown as Promise<Record<string, unknown>[]>)
}

export async function listChiefs(ctx: Ctx, userId?: string) {
  return withTenant(ctx.tenantId, ctx.actorId, tx => tx.execute(sql`
    select fc.id, fc.kind, fc.scope, fc.user_id, u.full_name as user_name, fc.chief_id, c.full_name as chief_name
    from functional_chiefs fc join users u on u.id = fc.user_id join users c on c.id = fc.chief_id
    where true ${EMPLOYEES_ONLY()} ${EMPLOYEES_ONLY('c')}
    ${userId ? sql`and (fc.user_id = ${userId}::uuid or fc.chief_id = ${userId}::uuid)` : sql``} order by c.full_name, u.full_name limit 1000
  `) as unknown as Promise<Record<string, unknown>[]>)
}
export async function setChief(ctx: Ctx, input: { userId: string, chiefId: string, kind: 'line' | 'functional', scope?: string }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    // docs/16 §14: «начальник сам себе подчинён» и кольцо руководителей — строка протокола конфликтов; сам себе — не сохраняем
    if (input.userId === input.chiefId) {
      await logOrgConflict(tx, { tenantId: ctx.tenantId, userId: input.userId, kind: 'manager_self', actorId: ctx.actorId, details: { kind: input.kind } })
      return null
    }
    const [cycle] = await tx.select({ id: functionalChiefs.id }).from(functionalChiefs).where(and(eq(functionalChiefs.userId, input.chiefId), eq(functionalChiefs.chiefId, input.userId), eq(functionalChiefs.kind, input.kind)))
    if (cycle) await logOrgConflict(tx, { tenantId: ctx.tenantId, userId: input.userId, kind: 'manager_cycle', actorId: ctx.actorId, details: { chiefId: input.chiefId, kind: input.kind } })
    const [r] = await tx.insert(functionalChiefs).values({ tenantId: ctx.tenantId, ...input, scope: input.scope ?? null }).onConflictDoUpdate({ target: [functionalChiefs.userId, functionalChiefs.chiefId, functionalChiefs.kind], set: { scope: input.scope ?? null, updatedAt: new Date() } }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'people.chief_set', entity: 'user', entityId: input.userId, after: input })
    return r!
  })
}
export async function removeChief(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async tx => (await tx.delete(functionalChiefs).where(eq(functionalChiefs.id, id)).returning({ id: functionalChiefs.id })).length > 0)
}

/** Ежедневно (docs/16 §11): кто не заходил > 30 дней — админам список кандидатов на архив. */
export async function inactiveScan(tenantId: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const rows = await tx.execute(sql`select count(*)::int as n from users where status = 'active' and not is_hidden and coalesce(last_seen_at, created_at) < now() - interval '30 days' ${EMPLOYEES_ONLY('')}`) as unknown as { n: number }[]
    const n = rows[0]?.n ?? 0
    if (!n) return 0
    const admins = await tx.execute(sql`select ur.user_id from user_roles ur join roles r on r.id = ur.role_id where r.code = 'admin' and ur.scope_type = 'tenant'`) as unknown as { user_id: string }[]
    const month = new Date().toISOString().slice(0, 7)
    for (const a of admins) await enqueueNotification(tx, { tenantId, userId: a.user_id, code: 'people_inactive', payload: { n }, dedupKey: `inactive:${month}:${a.user_id}` })
    return n
  })
}

/** Снятие роли (docs/16 §6.2): последнего администратора не лишить. */
export async function removeRole(ctx: Ctx, userId: string, roleCode: string, reason?: string | null): Promise<{ ok: true } | { ok: false, code: 'not_found' | 'last_admin' | 'owner_role' }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [role] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.code, roleCode))
    if (!role) return { ok: false as const, code: 'not_found' as const }
    // Владение не снимают, его передают (docs/01 §1.9.4): иначе у пространства не осталось бы
    // ни подписанта договора, ни того, кто может сменить тариф, — и вернуть это было бы нечем.
    if (roleCode === OWNER_ROLE_CODE) return { ok: false as const, code: 'owner_role' as const }
    if (roleCode === 'admin' && await isLastAdmin(tx, userId)) return { ok: false as const, code: 'last_admin' as const }
    const rows = await tx.delete(userRoles).where(and(eq(userRoles.userId, userId), eq(userRoles.roleId, role.id)))
      .returning({ scopeType: userRoles.scopeType, scopeId: userRoles.scopeId, validUntil: userRoles.validUntil, reason: userRoles.reason, isOrgDerived: userRoles.isOrgDerived })
    if (!rows.length) return { ok: false as const, code: 'not_found' as const }
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'role.revoke', entity: 'user', entityId: userId, before: { roleCode, grants: rows }, after: { reason: reason?.trim() || null } })
    await logSecurity({ tenantId: ctx.tenantId, userId, event: 'roles.changed', meta: { by: ctx.actorId, action: 'revoke', roleCode, reason: reason?.trim() || null } })
    return { ok: true as const }
  })
}

// ── Отчёты (docs/16 §9) ─────────────────────────────────────────────────

/** Штат по точкам на дату: размещения с историей — переведённый в прошлом месяце показан там, где работал тогда (§13.2). */
export async function staffingReport(ctx: Ctx, asOf?: string, scope: string[] | null = null) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const d = asOf ?? new Date().toISOString().slice(0, 10)
    return tx.execute(sql`
      select l.name as location, p.name as position, count(*)::int as people,
             count(*) filter (where u.hired_at >= ${d}::date - 30)::int as newcomers,
             round(avg(${d}::date - coalesce(u.hired_at, u.created_at::date)))::int as avg_tenure_days
      from user_placements up join users u on u.id = up.user_id join locations l on l.id = up.location_id join positions p on p.id = up.position_id
      where up.is_primary and up.started_at <= ${d}::date and (up.ended_at is null or up.ended_at > ${d}::date)
        and u.status <> 'archived' and not u.is_hidden and (u.archived_at is null or u.archived_at > ${d}::date) ${EMPLOYEES_ONLY()}
        ${scopeSql(scope, sql`up.location_id`)}
      group by 1, 2 order by 1, 2
    `) as unknown as Promise<{ location: string, position: string, people: number, newcomers: number, avg_tenure_days: number }[]>
  })
}

/** Где человек был на дату — для отчётов за прошлый период. */
export async function placementAt(ctx: Ctx, userId: string, date: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.execute(sql`select l.name as location, p.name as position from user_placements up join locations l on l.id = up.location_id join positions p on p.id = up.position_id where up.user_id = ${userId}::uuid and up.is_primary and up.started_at <= ${date}::date and (up.ended_at is null or up.ended_at > ${date}::date) order by up.started_at desc limit 1`) as unknown as { location: string, position: string }[]
    return r ?? null
  })
}

export async function turnoverReport(ctx: Ctx, from: string, to: string, scope: string[] | null = null) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.execute(sql`
      select l.name as location, p.name as position, count(*)::int as archived
      from users u join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is not null
      join locations l on l.id = up.location_id join positions p on p.id = up.position_id
      where u.status = 'archived' and u.archived_at >= ${from}::date and u.archived_at < (${to}::date + 1) ${EMPLOYEES_ONLY()}
        and up.ended_at = (select max(ended_at) from user_placements x where x.user_id = u.id)
        ${scopeSql(scope, sql`up.location_id`)}
      group by 1, 2 order by 3 desc
    `) as unknown as Promise<{ location: string, position: string, archived: number }[]>
  })
}

export async function inactiveReport(ctx: Ctx, days = 30, scope: string[] | null = null) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.execute(sql`
      select u.id, u.full_name, u.last_seen_at, l.name as location, p.name as position
      from users u left join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null
      left join locations l on l.id = up.location_id left join positions p on p.id = up.position_id
      where u.status = 'active' and coalesce(u.last_seen_at, u.created_at) < now() - (${days} || ' days')::interval ${EMPLOYEES_ONLY()}
        ${scopeSql(scope, sql`up.location_id`)}
      order by u.last_seen_at nulls first limit 500
    `) as unknown as Promise<Record<string, unknown>[]>
  })
}

// ── Карточка: вкладки «Навчання», «Атестації», «Активність» (docs/16 §5.2) ──

export async function personLearning(ctx: Ctx, userId: string) {
  // «Рейтинг» у зведенні «Навчання» (докс/31 рядок PersonCard) — той самий розрахунок, що й
  // «Поточний рейтинг» у «Мій розвиток» (`/me/study-history`, docs/33 D-069): кількість
  // завершених курсів/програм/тестів. Окрема транзакція (studyHistory сам відкриває withTenant),
  // не вкладаємо в транзакцію нижче.
  const { currentRating } = await studyHistory(ctx, userId)
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [enrollmentsRows, attemptsRows, certs, assessments] = await Promise.all([
      tx.execute(sql`
        select e.id, e.subject_type, e.subject_id, e.status, e.progress_pct, e.due_at, e.completed_at, e.score, e.started_at, e.created_at,
               coalesce(c.title, p.title, q.title) as title
        from enrollments e
        left join courses c on e.subject_type = 'course' and c.id = e.subject_id
        left join programs p on e.subject_type = 'training_program' and p.id = e.subject_id
        left join quizzes q on e.subject_type = 'test' and q.id = e.subject_id
        where e.user_id = ${userId}::uuid and e.cancelled_at is null order by e.created_at desc limit 200`) as unknown as Promise<Record<string, unknown>[]>,
      tx.execute(sql`
        select a.id, a.attempt_no, a.status, a.score, a.max_score, a.passed, a.submitted_at, a.started_at, q.title
        from attempts a join quizzes q on q.id = a.quiz_id where a.user_id = ${userId}::uuid order by a.started_at desc limit 200`) as unknown as Promise<Record<string, unknown>[]>,
      tx.execute(sql`
        select c.id, c.number, c.score, c.issued_at, c.valid_until, c.revoked_at, c.public_token, co.title
        from certificates c left join courses co on co.id = c.course_id where c.user_id = ${userId}::uuid order by c.issued_at desc`) as unknown as Promise<Record<string, unknown>[]>,
      tx.execute(sql`
        select ca.id, ca.level, ca.source, ca.assessed_at, ca.valid_until, ca.comment, k.name as competency, k.levels as competency_levels
        from competency_assessments ca join competencies k on k.id = ca.competency_id where ca.user_id = ${userId}::uuid order by ca.assessed_at desc limit 200`) as unknown as Promise<(Record<string, unknown> & { level: number, competency_levels: CompetencyLevel[] })[]>,
    ])
    // docs/33 D-032: рівень компетенції — за тумблером `competencyDisplayAs` (не тільки на «Мій розвиток»)
    const { developmentSettings } = await import('./developmentExtra')
    const { competencyDisplayAs: displayAs } = await developmentSettings(tx, ctx.tenantId)
    const assessmentsOut = assessments.map(({ competency_levels, ...a }) => ({ ...a, levelLabel: levelLabel(competency_levels ?? [], a.level) }))
    return { enrollments: enrollmentsRows, attempts: attemptsRows, certificates: certs, assessments: assessmentsOut, displayAs, currentRating }
  })
}

/** Журнал действий самого человека — из audit_log по actor_id (docs/16 §5.2 «Активність»). */
export async function personActivity(ctx: Ctx, userId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, tx => tx.execute(sql`
    select id, action, entity, entity_id, created_at, ip from audit_log where actor_id = ${userId}::uuid order by created_at desc limit 100
  `) as unknown as Promise<Record<string, unknown>[]>)
}

/** Массовые действия из списка (docs/16 §5.1). */
export async function bulkPeople(ctx: Ctx, input: { ids: string[], action: 'add_tag' | 'set_location' | 'assign_role' | 'invite' | 'archive', tag?: string, locationId?: string, positionId?: string, roleCode?: string, reason?: 'dismissal' | 'transfer' | 'mistake' | 'other' }) {
  let done = 0
  const errors: { id: string, code: string }[] = []
  for (const id of input.ids) {
    try {
      switch (input.action) {
        case 'add_tag': {
          await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
            const [tag] = await ensureTags(tx, ctx.tenantId, 'user', [input.tag!])
            await tx.execute(sql`update users set tags = array(select distinct unnest(array_append(tags, ${tag ?? input.tag!}::text))), updated_at = now() where id = ${id}::uuid`)
            await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'people.tag', entity: 'user', entityId: id, after: { tag: input.tag } })
          })
          done++
          break
        }
        case 'set_location': {
          const [cur] = await withTenant(ctx.tenantId, ctx.actorId, tx => tx.select({ positionId: userPlacements.positionId }).from(userPlacements).where(and(eq(userPlacements.userId, id), eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt))))
          const positionId = input.positionId ?? cur?.positionId
          if (!positionId) { errors.push({ id, code: 'no_position' }); break }
          await addPlacement(ctx, id, { locationId: input.locationId!, positionId, isPrimary: true })
          done++
          break
        }
        case 'assign_role': {
          const r = await assignRole(ctx, id, { roleCode: input.roleCode!, scopeType: 'tenant' })
          if (r) done++
          else errors.push({ id, code: 'role_not_found' })
          break
        }
        case 'invite': {
          const r = await createInvitation(ctx, id)
          if (r) done++
          else errors.push({ id, code: 'not_found' })
          break
        }
        case 'archive': {
          const r = await archivePerson(ctx, id, { reason: input.reason ?? 'other' })
          if (r.ok) done++
          else errors.push({ id, code: r.code })
          break
        }
      }
    }
    catch (err) {
      errors.push({ id, code: String((err as Error).message ?? err).slice(0, 80) })
    }
  }
  return { done, errors }
}

/** «Скинути привʼязку Telegram» (docs/16 §5.1): канал повернеться на SMS до нової привʼязки. */
export async function resetTelegram(ctx: Ctx, userId: string): Promise<boolean> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.update(users).set({ telegramChatId: null, updatedAt: new Date() }).where(eq(users.id, userId)).returning({ id: users.id })
    if (!rows.length) return false
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'people.reset_telegram', entity: 'user', entityId: userId })
    return true
  })
}
