import { eq, sql } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { roles, userRoles, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { Scope } from '../../shared/domain/roles'
import type { AuthContext } from './session'

/**
 * Проверка прав (docs/01-roles.md §1.1): права выдаются скоупами,
 * роль назначена в области видимости (tenant | org_unit | location).
 */

export interface RoleGrant {
  scopes: string[]
  scopeType: 'tenant' | 'org_unit' | 'location'
  scopeId: string | null
}

export interface Access {
  userId: string
  tenantId: string
  grants: RoleGrant[]
}

export async function loadAccess(auth: AuthContext): Promise<Access | null> {
  return withTenant(auth.tenantId, auth.userId, async (tx) => {
    const [user] = await tx.select({ status: users.status, isBlocked: users.isBlocked })
      .from(users).where(eq(users.id, auth.userId))
    if (!user || user.status !== 'active' || user.isBlocked) return null

    const rows = await tx.select({
      scopes: roles.scopes,
      scopeType: userRoles.scopeType,
      scopeId: userRoles.scopeId,
    })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, auth.userId))

    return {
      userId: auth.userId,
      tenantId: auth.tenantId,
      grants: rows.map(r => ({
        scopes: r.scopes,
        scopeType: r.scopeType as RoleGrant['scopeType'],
        scopeId: r.scopeId,
      })),
    }
  })
}

export interface ScopeArea {
  locationId?: string
  orgUnitId?: string
}

/**
 * can(user, 'course.edit', { locationId }) → true, если есть роль со скоупом,
 * назначенная на тенант, это подразделение или эту точку.
 * Без области — достаточно скоупа в любой области.
 */
export function can(access: Access, scope: Scope | string, area?: ScopeArea): boolean {
  for (const grant of access.grants) {
    if (!grant.scopes.includes(scope)) continue
    if (grant.scopeType === 'tenant') return true
    if (!area) return true
    if (grant.scopeType === 'location' && area.locationId && grant.scopeId === area.locationId) return true
    if (grant.scopeType === 'org_unit' && area.orgUnitId && grant.scopeId === area.orgUnitId) return true
  }
  return false
}

/** Достаёт Access из контекста запроса (лениво, с кешем на время запроса). */
export async function getAccess(event: H3Event): Promise<Access | null> {
  const auth = event.context.auth as AuthContext | undefined
  if (!auth) return null
  if (event.context.access !== undefined) return event.context.access as Access | null
  const tokenScopes = event.context.tokenScopes as string[] | undefined
  let access: Access | null
  if (tokenScopes) {
    // API-токен: скоупы токена, область — весь тенант (docs/09 §9.6)
    access = { userId: auth.userId, tenantId: auth.tenantId, grants: [{ scopes: tokenScopes, scopeType: 'tenant', scopeId: null }] }
  }
  else {
    access = await loadAccess(auth)
  }
  event.context.access = access
  return access
}

/** Тонкая проверка для эндпоинтов: 401 без сессии, 403 без скоупа. */
export async function requireScope(event: H3Event, scope: Scope | string, area?: ScopeArea): Promise<Access> {
  const access = await getAccess(event)
  if (!access) {
    throw createError({ statusCode: 401, data: { code: 'auth_required', message: 'Потрібен вхід' } })
  }
  if (!can(access, scope, area)) {
    throw createError({ statusCode: 403, data: { code: 'forbidden', message: 'Немає доступу' } })
  }
  return access
}

/**
 * Область видимости отчётов (docs/22 §2, §7.1): null — вся сеть (`report.tenant` или скоуп на весь тенант);
 * иначе — точки, где у человека есть роль с этим скоупом (точка напрямую или через подразделение).
 * Пустой массив — не видит ничего. Фильтр «точка» из запроса может только сузить (см. narrowScope).
 */
export async function reportScope(access: Access, scope: Scope | string = 'report.team'): Promise<string[] | null> {
  if (can(access, 'report.tenant')) return null
  const grants = access.grants.filter(g => g.scopes.includes(scope))
  if (grants.some(g => g.scopeType === 'tenant')) return null
  const locs = new Set(grants.filter(g => g.scopeType === 'location' && g.scopeId).map(g => g.scopeId!))
  const units = grants.filter(g => g.scopeType === 'org_unit' && g.scopeId).map(g => g.scopeId!)
  if (units.length) {
    const rows = await withTenant(access.tenantId, access.userId, tx => tx.execute(sql`
      select l.id from locations l join org_units u on u.id = l.org_unit_id
      where u.path <@ any(array(select path from org_units where id in ${units}))
    `)) as unknown as { id: string }[]
    for (const r of rows) locs.add(r.id)
  }
  return [...locs]
}

/** Сужение области фильтром из запроса: точка вне области → пусто, а не расширение. */
export function narrowScope(scope: string[] | null, requested?: string | null): string[] | null {
  if (!requested) return scope
  if (scope === null) return [requested]
  return scope.includes(requested) ? [requested] : []
}

/** SQL-фрагмент `and <col> in (...)`; пустая область — `and false`. */
export function scopeSql(scope: string[] | null, column: ReturnType<typeof sql>) {
  if (scope === null) return sql``
  if (scope.length === 0) return sql`and false`
  return sql`and ${column} in (${sql.join(scope.map(id => sql`${id}::uuid`), sql`, `)})`
}
