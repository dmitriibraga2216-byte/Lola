import { randomBytes } from 'node:crypto'
import { and, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm'
import {
  cities, invitations, locations, positions, roles, sessions, userPlacements, userRoles, users,
} from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'
import { hashToken } from './session'
import type { PersonCreateInput, PersonUpdateInput } from '../../shared/schemas/people'

interface Ctx { tenantId: string, actorId: string }

export interface PersonListFilter {
  q?: string
  tab: 'active' | 'blocked' | 'all'
  locationId?: string
  positionId?: string
  cursor?: string
  limit: number
}

/** Список людей с фильтрами (docs/05-screens.md §5.9), курсорная пагинация по created_at+id. */
export async function listPeople(ctx: Ctx, filter: PersonListFilter) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const conditions = []

    if (filter.tab === 'active') conditions.push(inArray(users.status, ['invited', 'active']))
    if (filter.tab === 'blocked') conditions.push(inArray(users.status, ['suspended', 'archived']))
    if (filter.q) {
      conditions.push(or(
        ilike(users.fullName, `%${filter.q}%`),
        ilike(users.phone, `%${filter.q}%`),
      )!)
    }
    if (filter.cursor) {
      const [ts, id] = filter.cursor.split('_')
      conditions.push(sql`(${users.createdAt}, ${users.id}) < (${new Date(Number(ts))}, ${id}::uuid)`)
    }

    if (filter.locationId || filter.positionId) {
      const placementCond = [
        eq(userPlacements.tenantId, ctx.tenantId),
        isNull(userPlacements.endedAt),
        ...(filter.locationId ? [eq(userPlacements.locationId, filter.locationId)] : []),
        ...(filter.positionId ? [eq(userPlacements.positionId, filter.positionId)] : []),
      ]
      conditions.push(sql`exists (select 1 from ${userPlacements}
        where ${and(...placementCond, eq(userPlacements.userId, users.id))})`)
    }

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
      cityName: cities.name,
    })
      .from(users)
      .leftJoin(cities, eq(cities.id, users.cityId))
      .where(and(...conditions))
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
        })
          .from(userPlacements)
          .innerJoin(locations, eq(locations.id, userPlacements.locationId))
          .innerJoin(positions, eq(positions.id, userPlacements.positionId))
          .where(and(inArray(userPlacements.userId, ids), isNull(userPlacements.endedAt)))
      : []

    const roleRows = ids.length
      ? await tx.select({ userId: userRoles.userId, code: roles.code, name: roles.name })
          .from(userRoles)
          .innerJoin(roles, eq(roles.id, userRoles.roleId))
          .where(inArray(userRoles.userId, ids))
      : []

    return {
      items: page.map(r => ({
        ...r,
        placements: placements.filter(p => p.userId === r.id)
          .map(({ userId: _, ...p }) => p),
        roles: [...new Set(roleRows.filter(x => x.userId === r.id).map(x => x.name))],
      })),
      cursor: hasMore && last ? `${last.createdAt.getTime()}_${last.id}` : null,
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
    })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, id))

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

    const { passwordHash: _ph, ...safe } = person
    return { ...safe, placements, roles: roleRows, sessions: sessionRows }
  })
}

export async function createPerson(ctx: Ctx, input: PersonCreateInput) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [person] = await tx.insert(users).values({
      tenantId: ctx.tenantId,
      fullName: input.fullName,
      phone: input.phone ?? null,
      email: input.email ?? null,
      cityId: input.cityId ?? null,
      tags: input.tags,
      hiredAt: input.hiredAt ?? null,
      externalId: input.externalId ?? null,
      locale: input.locale ?? null,
    }).returning()

    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'people.create',
      entity: 'user',
      entityId: person!.id,
      after: { fullName: person!.fullName, phone: person!.phone },
    })
    return person!
  })
}

export async function updatePerson(ctx: Ctx, id: string, input: PersonUpdateInput) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(users).where(eq(users.id, id))
    if (!before) return null

    const [after] = await tx.update(users).set({
      ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.cityId !== undefined ? { cityId: input.cityId } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
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

    // Архивация отзывает сессии (docs/01-roles.md §1.6: вход запрещён)
    if (input.status === 'archived' || input.status === 'suspended') {
      await tx.update(sessions).set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, id), isNull(sessions.revokedAt)))
    }

    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'people.update',
      entity: 'user',
      entityId: id,
      before: { fullName: before.fullName, phone: before.phone, status: before.status },
      after: { fullName: after!.fullName, phone: after!.phone, status: after!.status },
    })
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
    return { token, url: `/invite?token=${token}` }
  })
}

export async function addPlacement(ctx: Ctx, userId: string, input: {
  locationId: string
  positionId: string
  isPrimary: boolean
  startedAt?: string
}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
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
    return placement!
  })
}

export async function assignRole(ctx: Ctx, userId: string, input: {
  roleCode: string
  scopeType: 'tenant' | 'org_unit' | 'location'
  scopeId?: string | null
}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [role] = await tx.select().from(roles).where(eq(roles.code, input.roleCode))
    if (!role) return null

    const [assigned] = await tx.insert(userRoles).values({
      tenantId: ctx.tenantId,
      userId,
      roleId: role.id,
      scopeType: input.scopeType,
      scopeId: input.scopeType === 'tenant' ? null : (input.scopeId ?? null),
    }).onConflictDoNothing().returning()

    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'role.assign',
      entity: 'user',
      entityId: userId,
      after: input,
    })
    return assigned ?? role
  })
}
