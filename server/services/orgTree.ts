import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { locations, orgUnits, positions, userPlacements, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'

interface Ctx { tenantId: string, actorId: string }

/** Публичная оргструктура (docs/03 §3.22): подразделения → точки → люди с должностями, руководители точек. */
export async function orgTree(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const units = await tx.select({ id: orgUnits.id, name: orgUnits.name, parentId: orgUnits.parentId, path: orgUnits.path }).from(orgUnits).orderBy(asc(orgUnits.path))
    const locs = await tx.select({ id: locations.id, name: locations.name, orgUnitId: locations.orgUnitId, managerId: locations.managerId, address: locations.address }).from(locations).where(eq(locations.isActive, true)).orderBy(asc(locations.name))
    const people = await tx.select({ id: users.id, fullName: users.fullName, locationId: userPlacements.locationId, position: positions.name, positionId: positions.id })
      .from(userPlacements).innerJoin(users, eq(users.id, userPlacements.userId)).innerJoin(positions, eq(positions.id, userPlacements.positionId))
      .where(and(eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt), eq(users.status, 'active'), eq(users.isHidden, false))).orderBy(asc(users.fullName))
    const [counts] = await tx.execute(sql`select count(distinct l.id)::int as locations, count(distinct up.user_id)::int as people from locations l left join user_placements up on up.location_id = l.id and up.is_primary and up.ended_at is null`) as unknown as { locations: number, people: number }[]
    const byLoc = new Map<string, typeof people>()
    for (const p of people) byLoc.set(p.locationId, [...(byLoc.get(p.locationId) ?? []), p])
    const nameOf = new Map(people.map(p => [p.id, p.fullName]))
    const build = (parentId: string | null): unknown[] => units.filter(u => u.parentId === parentId).map(u => ({
      id: u.id, name: u.name,
      locations: locs.filter(l => l.orgUnitId === u.id).map(l => ({ id: l.id, name: l.name, address: l.address, manager: l.managerId ? nameOf.get(l.managerId) ?? null : null, people: (byLoc.get(l.id) ?? []).map(p => ({ id: p.id, fullName: p.fullName, position: p.position })) })),
      children: build(u.id),
    }))
    return { units: build(null), totals: counts }
  })
}
