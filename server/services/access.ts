import { eq, sql } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { roles as rolesTable, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { isSessionOnlyScope, type Scope } from '../../shared/domain/roles'
import type { AuthContext } from './session'
import { effectiveRoles, resolveActiveRole } from './activeRole'

/**
 * Проверка прав (docs/01-roles.md §1.1): права выдаются скоупами,
 * роль назначена в области видимости (tenant | org_unit | location).
 * Права считаются по активной роли сессии, а не по объединению всех ролей (docs/01 §1.9.2).
 */

export interface RoleGrant {
  scopes: string[]
  scopeType: 'tenant' | 'org_unit' | 'location'
  scopeId: string | null
}

export interface RoleRef {
  id: string
  code: string
  name: string
}

export interface Access {
  userId: string
  tenantId: string
  /** Области активной роли (у API-токена — весь тенант со скоупами токена) */
  grants: RoleGrant[]
  /** Активная роль сессии; null — у API-токена и у человека без ролей */
  activeRole: RoleRef | null
  /** Все действующие роли — для переключателя и аудита */
  roles: RoleRef[]
  /**
   * Доступ API-токена интеграции (Bearer), а не сессии человека (docs/v2/44 В-20). Права
   * токена — его скоупы без `sessionOnly`; «право по данным» без скоупа (свои заметки,
   * docs/v2/38 §7.4) — право человека, и токену, выпущенному этим человеком, оно не переходит.
   */
  viaToken?: true
}

export async function loadAccess(auth: AuthContext): Promise<Access | null> {
  return withTenant(auth.tenantId, auth.userId, async (tx) => {
    const [user] = await tx.select({ status: users.status, isBlocked: users.isBlocked })
      .from(users).where(eq(users.id, auth.userId))
    if (!user || user.status !== 'active' || user.isBlocked) return null

    // «Переглянути систему як роль» (docs/24 §3.5, докс/33 D-052): права рахуються тільки по цій ролі,
    // власні ролі людини на час перегляду не діють. Область — весь тенант (як у API-токена): режим
    // призначений показати, що бачить роль загалом, а не перевірити конкретну прив'язку до точки.
    if (auth.previewRoleId) {
      const [role] = await tx.select().from(rolesTable).where(eq(rolesTable.id, auth.previewRoleId))
      if (!role) return { userId: auth.userId, tenantId: auth.tenantId, grants: [], activeRole: null, roles: [] }
      const ref = { id: role.id, code: role.code, name: role.name }
      return { userId: auth.userId, tenantId: auth.tenantId, grants: [{ scopes: role.scopes, scopeType: 'tenant', scopeId: null }], activeRole: ref, roles: [ref] }
    }

    const list = await effectiveRoles(tx, auth.userId)
    const active = await resolveActiveRole(tx, auth, list)

    return {
      userId: auth.userId,
      tenantId: auth.tenantId,
      grants: active ? active.grants.map(g => ({ scopes: active.scopes, scopeType: g.scopeType, scopeId: g.scopeId })) : [],
      activeRole: active ? { id: active.id, code: active.code, name: active.name } : null,
      roles: list.map(r => ({ id: r.id, code: r.code, name: r.name })),
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
    // API-токен: скоупы токена, область — весь тенант (docs/09 §9.6). Скоупы `sessionOnly`
    // (docs/v2/44 В-20) вычёркиваются — второй рубеж для токенов, выданных до появления флага:
    // `requireScope` на такой скоуп отвечает 403 `forbidden` независимо от содержимого токена.
    // Список не путей, а прав: разграничение Bearer живёт здесь и в реестре скоупов, больше нигде.
    access = { userId: auth.userId, tenantId: auth.tenantId, grants: [{ scopes: tokenScopes.filter(s => !isSessionOnlyScope(s)), scopeType: 'tenant', scopeId: null }], activeRole: null, roles: [], viaToken: true }
  }
  else {
    access = await loadAccess(auth)
  }
  event.context.access = access
  return access
}

/**
 * Только вход, без скоупа: для ручек, где право зависит от данных, а не от роли —
 * человек читает **свои** заметки и документы без `person.note.read` (docs/v2/38 §2, §7.4),
 * и решает это сервис, а не список скоупов.
 */
export async function requireAccess(event: H3Event): Promise<Access> {
  const access = await getAccess(event)
  if (!access) {
    throw createError({ statusCode: 401, data: { code: 'auth_required', message: 'Потрібен вхід' } })
  }
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

/** Как requireScope, но достаточно любого из скоупов (докс/10 §14.1: групи доступу спільні для бази знань і каталогу). */
export async function requireAnyScope(event: H3Event, scopes: (Scope | string)[], area?: ScopeArea): Promise<Access> {
  const access = await getAccess(event)
  if (!access) {
    throw createError({ statusCode: 401, data: { code: 'auth_required', message: 'Потрібен вхід' } })
  }
  if (!scopes.some(s => can(access, s, area))) {
    throw createError({ statusCode: 403, data: { code: 'forbidden', message: 'Немає доступу' } })
  }
  return access
}

/**
 * Область видимости по паре скоупов «весь тенант / своя команда»: null — вся сеть (тенантный
 * скоуп или грант на весь тенант); иначе — точки, где у человека есть роль с командным скоупом
 * (точка напрямую или через подразделение). Пустой массив — не видит ничего.
 * Общая часть `reportScope` (docs/22 §2, §7.1) и видимости по роли в «Розвиток» (docs/19 §2) —
 * тот самый принцип «tenant-скоуп бачить усе, team-скоуп — тільки свою область».
 */
export async function scopeForGrants(access: Access, tenantScope: Scope | string, teamScope: Scope | string): Promise<string[] | null> {
  if (can(access, tenantScope)) return null
  return areaForScope(access, teamScope)
}

/**
 * Область одного скоупа — по назначениям ролей, где он есть: null — роль на весь тенант;
 * иначе точки (напрямую или через подразделение). Пустой массив — скоупа нет ни в одной роли.
 * Вторая половина `scopeForGrants` — для скоупов без «сетевой» пары: выдача заказов и ручные
 * бонусы (у наставника и руководителя точки они действуют только на своих людей, docs/21 §2),
 * чужое время обучения (`time.metrics.view`, `docs/v2/37` §2: наставник и руководитель — своя
 * область, администратор — весь тенант).
 */
export async function areaForScope(access: Access, scope: Scope | string): Promise<string[] | null> {
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

/** Есть ли у скоупа грант на **весь тенант** — не на точку и не на подразделение. */
export function hasTenantGrant(access: Access, scope: Scope | string): boolean {
  return access.grants.some(g => g.scopeType === 'tenant' && g.scopes.includes(scope))
}

/**
 * Область одного скоупа с различением «скоупа нет вовсе»: `'tenant'` — грант на весь тенант;
 * массив — точки его ролей (напрямую или через подразделение, `areaForScope`); `'none'` — ни
 * одной роли с этим скоупом. У `areaForScope` «нет скоупа» и «скоуп на подразделение без точек»
 * — один и тот же пустой массив; правам карточки человека (docs/v2/38 §2) нужна разница:
 * без скоупа чужие заметки — `403`, со скоупом на чужую точку — только свои как автора.
 */
export async function areaOf(access: Access, scope: Scope | string): Promise<'tenant' | 'none' | string[]> {
  if (!access.grants.some(g => g.scopes.includes(scope))) return 'none'
  const area = await areaForScope(access, scope)
  return area === null ? 'tenant' : area
}

/** Покрывает ли область точку: вся сеть — да; иначе точка должна быть в списке. */
export function areaCovers(area: 'tenant' | 'none' | string[], locationId: string | null | undefined): boolean {
  if (area === 'tenant') return true
  if (area === 'none' || !locationId) return false
  return area.includes(locationId)
}

/**
 * Область видимости отчётов (docs/22 §2, §7.1): null — вся сеть (`report.tenant` или скоуп на весь тенант);
 * иначе — точки, где у человека есть роль с этим скоупом (точка напрямую или через подразделение).
 * Пустой массив — не видит ничего. Фильтр «точка» из запроса может только сузить (см. narrowScope).
 */
export async function reportScope(access: Access, scope: Scope | string = 'report.team'): Promise<string[] | null> {
  return scopeForGrants(access, 'report.tenant', scope)
}

/**
 * Область видимости «Планів розвитку» (docs/19 §2, `31` DevelopmentPlans, spec-development):
 * `development.manage` (адмін/методист) — уся мережа; `development.team` (наставник/керівник) —
 * лише точки з роллю цього скоупа. Той самий принцип, що й `reportScope`, інша пара скоупів.
 */
export async function developmentPlanScope(access: Access): Promise<string[] | null> {
  return scopeForGrants(access, 'development.manage', 'development.team')
}

/** Сужение области фильтром из запроса: точка вне области → пусто, а не расширение. */
/**
 * Точка из фильтра отчёта: `not_found` — её нет в тенанте (чужая или удалённая; CLAUDE.md п. 15 — 404, существование
 * не подтверждается), `forbidden` — своя, но вне области видимости (403), иначе `ok`.
 */
export async function locationAccess(access: Access, scope: string[] | null, locationId: string): Promise<'ok' | 'forbidden' | 'not_found'> {
  if (scope?.includes(locationId)) return 'ok'
  const rows = await withTenant(access.tenantId, access.userId, tx => tx.execute(sql`select 1 from locations where id = ${locationId}::uuid`)) as unknown as unknown[]
  if (!rows.length) return 'not_found'
  return scope === null ? 'ok' : 'forbidden'
}

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
