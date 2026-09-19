import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm'
import { positionRoleMap, positions, roles, userPlacements, userRoles, users } from '../db/schema'
import { withTenant, type TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'

/**
 * Правило «должность → роль» (docs/01 §1.9.1, §1.9.3; docs/02 «Сквозные таблицы»; docs/28 «Паритет 4»).
 *
 * В сети из ста человек роли руками не раздают: карта `position_role_map` говорит, какую роль
 * и в какой области получает человек на должности. Применяется при смене должности
 * (`addPlacement`, массовые операции) и при импорте. Выданная так роль помечена
 * `user_roles.is_org_derived` (по аналогии с группами, docs/16 §3.3) и пересобирается при
 * следующей смене должности: правило перестало действовать — производная роль снимается,
 * роль, выданная руками, не трогается.
 */

interface Ctx { tenantId: string, actorId: string | null }

export interface PositionRoleMapItem {
  positionId: string
  positionName: string
  roleId: string
  roleCode: string
  roleName: string
  scopeType: 'tenant' | 'org_unit' | 'location'
  scopeId: string | null
}

export async function getPositionRoleMap(ctx: Ctx): Promise<PositionRoleMapItem[]> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select({
      positionId: positionRoleMap.positionId,
      positionName: positions.name,
      roleId: positionRoleMap.roleId,
      roleCode: roles.code,
      roleName: roles.name,
      scopeType: positionRoleMap.scopeType,
      scopeId: positionRoleMap.scopeId,
    })
      .from(positionRoleMap)
      .innerJoin(positions, eq(positions.id, positionRoleMap.positionId))
      .innerJoin(roles, eq(roles.id, positionRoleMap.roleId))
      .orderBy(asc(positions.name), asc(roles.code))
    return rows.map(r => ({ ...r, scopeType: r.scopeType as PositionRoleMapItem['scopeType'] }))
  })
}

/**
 * Замена карты целиком (PUT, docs/04 §4.13). Неизвестная должность или роль — `not_found`.
 * Уже выданные производные роли не пересобираются здесь: это произойдёт при следующей смене
 * должности или импорте (иначе один PUT перекроил бы права всей сети без предупреждения).
 */
export async function setPositionRoleMap(ctx: Ctx, items: { positionId: string, roleCode: string, scopeType: 'tenant' | 'org_unit' | 'location', scopeId?: string | null }[]): Promise<{ ok: true, count: number } | { ok: false, code: 'not_found', detail: string }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const roleRows = await tx.select({ id: roles.id, code: roles.code }).from(roles)
    const roleByCode = new Map(roleRows.map(r => [r.code, r.id]))
    const posRows = await tx.select({ id: positions.id }).from(positions)
    const posIds = new Set(posRows.map(p => p.id))
    for (const it of items) {
      if (!roleByCode.has(it.roleCode)) return { ok: false as const, code: 'not_found' as const, detail: `role:${it.roleCode}` }
      if (!posIds.has(it.positionId)) return { ok: false as const, code: 'not_found' as const, detail: `position:${it.positionId}` }
    }
    const before = await tx.select({ positionId: positionRoleMap.positionId, roleId: positionRoleMap.roleId, scopeType: positionRoleMap.scopeType, scopeId: positionRoleMap.scopeId }).from(positionRoleMap)
    await tx.delete(positionRoleMap)
    const values = items.map(it => ({
      tenantId: ctx.tenantId,
      positionId: it.positionId,
      roleId: roleByCode.get(it.roleCode)!,
      scopeType: it.scopeType,
      scopeId: it.scopeType === 'tenant' ? null : (it.scopeId ?? null),
    }))
    if (values.length) await tx.insert(positionRoleMap).values(values).onConflictDoNothing()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'settings.position_role_map', entity: 'tenant', entityId: ctx.tenantId, before, after: values.map(({ tenantId: _t, ...v }) => v) })
    return { ok: true as const, count: values.length }
  })
}

/**
 * Пересборка производных ролей человека по его основному размещению. Вызывается в той же
 * транзакции, что и смена должности. Возвращает, что выдано и что снято (для аудита вызывающего).
 */
export async function applyPositionRoles(tx: TenantTx, ctx: Ctx, userId: string): Promise<{ granted: string[], revoked: string[] }> {
  const [placement] = await tx.select({
    positionId: userPlacements.positionId,
    locationId: userPlacements.locationId,
    orgUnitId: userPlacements.orgUnitId,
  })
    .from(userPlacements)
    .where(and(eq(userPlacements.userId, userId), eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt)))
    .orderBy(sql`${userPlacements.startedAt} desc`)
    .limit(1)

  const rules = placement
    ? await tx.select({ roleId: positionRoleMap.roleId, code: roles.code, scopeType: positionRoleMap.scopeType, scopeId: positionRoleMap.scopeId })
        .from(positionRoleMap).innerJoin(roles, eq(roles.id, positionRoleMap.roleId))
        .where(eq(positionRoleMap.positionId, placement.positionId))
    : []

  const key = (r: { roleId: string, scopeType: string, scopeId: string | null }) => `${r.roleId}:${r.scopeType}:${r.scopeId ?? ''}`
  const desired = new Map<string, { roleId: string, code: string, scopeType: string, scopeId: string | null }>()
  for (const r of rules) {
    const scopeId = r.scopeType === 'tenant' ? null : (r.scopeId ?? (r.scopeType === 'location' ? placement!.locationId : placement!.orgUnitId))
    if (r.scopeType !== 'tenant' && !scopeId) continue // у размещения нет подразделения — правило не применимо
    const item = { roleId: r.roleId, code: r.code, scopeType: r.scopeType, scopeId }
    desired.set(key(item), item)
  }

  const existing = await tx.select({ id: userRoles.id, roleId: userRoles.roleId, scopeType: userRoles.scopeType, scopeId: userRoles.scopeId, isOrgDerived: userRoles.isOrgDerived, code: roles.code })
    .from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(eq(userRoles.userId, userId))
  const have = new Set(existing.map(key))

  const revoked: string[] = []
  for (const e of existing) {
    if (!e.isOrgDerived || desired.has(key(e))) continue
    if (e.code === 'admin' && await isLastTenantAdmin(tx, userId)) continue // docs/16 §7.6
    await tx.delete(userRoles).where(eq(userRoles.id, e.id))
    revoked.push(e.code)
  }
  const granted: string[] = []
  for (const [k, d] of desired) {
    if (have.has(k)) continue
    await tx.insert(userRoles).values({ tenantId: ctx.tenantId, userId, roleId: d.roleId, scopeType: d.scopeType, scopeId: d.scopeId, isOrgDerived: true, reason: 'position_role_map' }).onConflictDoNothing()
    granted.push(d.code)
  }
  if (granted.length || revoked.length) {
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'role.derive', entity: 'user', entityId: userId, before: { revoked }, after: { granted, positionId: placement?.positionId ?? null } })
  }
  return { granted, revoked }
}

async function isLastTenantAdmin(tx: TenantTx, userId: string): Promise<boolean> {
  const rows = await tx.execute(sql`select ur.user_id from user_roles ur join roles r on r.id = ur.role_id join users u on u.id = ur.user_id
    where r.code = 'admin' and ur.scope_type = 'tenant' and (ur.valid_until is null or ur.valid_until > now()) and u.status in ('active','invited') and not u.is_blocked`) as unknown as { user_id: string }[]
  const ids = new Set(rows.map(r => r.user_id))
  return ids.has(userId) && ids.size === 1
}

/**
 * Снятие ролей по сроку (29 Б.15: «снятие по сроку ежедневно»). Истёкшая роль и так не даёт прав
 * (`effectiveRoles`), здесь строка удаляется и пишется `role.expire`, чтобы карточка и отчёты
 * не показывали её как действующую.
 */
export async function expireRoles(tenantId: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const rows = await tx.select({ id: userRoles.id, userId: userRoles.userId, code: roles.code, scopeType: userRoles.scopeType, scopeId: userRoles.scopeId, validUntil: userRoles.validUntil, reason: userRoles.reason })
      .from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).innerJoin(users, eq(users.id, userRoles.userId))
      .where(lt(userRoles.validUntil, sql`now()`))
    for (const r of rows) {
      await tx.delete(userRoles).where(eq(userRoles.id, r.id))
      await recordAudit(tx, { tenantId, actorId: null, action: 'role.expire', entity: 'user', entityId: r.userId, before: { roleCode: r.code, scopeType: r.scopeType, scopeId: r.scopeId, validUntil: r.validUntil, reason: r.reason } })
    }
    return rows.length
  })
}
