import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { enrollments, orgUnits, roles, userPlacements, userRoles, users } from '../db/schema'
import type { TenantTx } from '../utils/withTenant'
import type { Audience, AudienceRule } from '../../shared/schemas/assignments'

/**
 * Раскрытие аудитории (docs/15 §3.2, §7.1): набор правил → множество userId.
 * match=any — объединение, all — пересечение; exclude вычитается.
 * Учитываются только активные размещения и люди в статусе invited/active.
 */

async function resolveRule(tx: TenantTx, rule: AudienceRule): Promise<Set<string>> {
  const activePeople = inArray(users.status, ['invited', 'active'])

  switch (rule.type) {
    case 'user': {
      const rows = await tx.select({ id: users.id }).from(users)
        .where(and(inArray(users.id, rule.ids), activePeople))
      return new Set(rows.map(r => r.id))
    }
    case 'position': {
      const rows = await tx.select({ id: userPlacements.userId }).from(userPlacements)
        .innerJoin(users, eq(users.id, userPlacements.userId))
        .where(and(
          inArray(userPlacements.positionId, rule.ids),
          isNull(userPlacements.endedAt),
          activePeople,
          ...(rule.locationIds?.length ? [inArray(userPlacements.locationId, rule.locationIds)] : []),
        ))
      return new Set(rows.map(r => r.id))
    }
    case 'location': {
      const rows = await tx.select({ id: userPlacements.userId }).from(userPlacements)
        .innerJoin(users, eq(users.id, userPlacements.userId))
        .where(and(inArray(userPlacements.locationId, rule.ids), isNull(userPlacements.endedAt), activePeople))
      return new Set(rows.map(r => r.id))
    }
    case 'org_unit': {
      // Точки подразделения (с потомками по ltree, если includeChildren)
      let unitIds = rule.ids
      if (rule.includeChildren) {
        const parents = await tx.select({ path: orgUnits.path }).from(orgUnits).where(inArray(orgUnits.id, rule.ids))
        if (parents.length) {
          const children = await tx.select({ id: orgUnits.id }).from(orgUnits)
            .where(sql`${orgUnits.path} <@ ANY(ARRAY[${sql.join(parents.map(p => sql`${p.path}::ltree`), sql`, `)}])`)
          unitIds = [...new Set([...unitIds, ...children.map(c => c.id)])]
        }
      }
      const rows = await tx.execute(sql`
        select up.user_id as id from user_placements up
        join locations l on l.id = up.location_id
        join users u on u.id = up.user_id
        where l.org_unit_id in ${unitIds} and up.ended_at is null and u.status in ('invited','active')
      `)
      return new Set((rows as unknown as { id: string }[]).map(r => r.id))
    }
    case 'role': {
      const rows = await tx.select({ id: userRoles.userId }).from(userRoles)
        .innerJoin(roles, eq(roles.id, userRoles.roleId))
        .innerJoin(users, eq(users.id, userRoles.userId))
        .where(and(inArray(roles.code, rule.codes), activePeople))
      return new Set(rows.map(r => r.id))
    }
    case 'tag': {
      const rows = await tx.select({ id: users.id }).from(users)
        .where(and(sql`${users.tags} && ARRAY[${sql.join(rule.values.map(v => sql`${v}`), sql`, `)}]::text[]`, activePeople))
      return new Set(rows.map(r => r.id))
    }
    case 'segment': {
      const f = rule.filter
      const conds = [f.status?.length ? inArray(users.status, f.status) : activePeople]
      if (f.hiredFrom) conds.push(sql`${users.hiredAt} >= ${f.hiredFrom}`)
      if (f.hiredTo) conds.push(sql`${users.hiredAt} <= ${f.hiredTo}`)
      if (f.positionIds?.length || f.locationIds?.length) {
        conds.push(sql`exists (select 1 from ${userPlacements} up where up.user_id = ${users.id} and up.ended_at is null
          ${f.positionIds?.length ? sql`and up.position_id in ${f.positionIds}` : sql``}
          ${f.locationIds?.length ? sql`and up.location_id in ${f.locationIds}` : sql``})`)
      }
      if (f.hasCompletedCourseIds?.length) {
        conds.push(sql`exists (select 1 from ${enrollments} e where e.user_id = ${users.id} and e.status = 'completed' and e.subject_id in ${f.hasCompletedCourseIds})`)
      }
      if (f.notCompletedCourseIds?.length) {
        conds.push(sql`not exists (select 1 from ${enrollments} e where e.user_id = ${users.id} and e.status = 'completed' and e.subject_id in ${f.notCompletedCourseIds})`)
      }
      const rows = await tx.select({ id: users.id }).from(users).where(and(...conds))
      return new Set(rows.map(r => r.id))
    }
  }
}

export async function resolveAudience(tx: TenantTx, audience: Audience, exclude?: Audience | null): Promise<Set<string>> {
  if (audience.rules.length === 0) return new Set()
  const sets = await Promise.all(audience.rules.map(r => resolveRule(tx, r)))
  let result: Set<string>
  if (audience.match === 'all') {
    result = sets.reduce((acc, s) => new Set([...acc].filter(id => s.has(id))))
  }
  else {
    result = new Set(sets.flatMap(s => [...s]))
  }
  if (exclude?.rules.length) {
    const ex = await resolveAudience(tx, { rules: exclude.rules, match: 'any' })
    for (const id of ex) result.delete(id)
  }
  return result
}
