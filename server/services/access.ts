import { eq } from 'drizzle-orm'
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
