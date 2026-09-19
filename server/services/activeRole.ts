import { and, eq, gt, isNull, or, sql } from 'drizzle-orm'
import { auditLog, roles, sessions, userRoles } from '../db/schema'
import { withTenant, type TenantTx } from '../utils/withTenant'
import { currentRequestContext } from '../utils/requestContext'
import type { AuthContext } from './session'

/**
 * Активная роль сессии (docs/01 §1.9.2, docs/28 «Паритет 4»).
 *
 * Человек может иметь несколько ролей, но интерфейс и права считаются по одной — активной.
 * Она хранится в `sessions.active_role_id`; при входе — роль по умолчанию, переключение —
 * без выхода через `POST /me/role/switch`. Аудит пишет и активную роль, и полный набор.
 *
 * Действующая роль — назначение без срока или со сроком в будущем (`user_roles.valid_until`,
 * docs/16 §6.2, 29 Б.15). Истёкшие роли не участвуют ни в правах, ни в переключении.
 */

export interface EffectiveRole {
  id: string
  code: string
  name: string
  scopes: string[]
  grants: { scopeType: 'tenant' | 'org_unit' | 'location', scopeId: string | null, validUntil: Date | null }[]
}

/**
 * Приоритет роли по умолчанию: от самой широкой к самой узкой (порядок таблицы docs/01 §1.2
 * наоборот), свои роли тенанта — перед `employee`. Внутри одного ранга — по имени.
 */
const PRIORITY: Record<string, number> = { admin: 0, author: 1, manager: 2, mentor: 3, employee: 5 }
export const rankRole = (code: string): number => PRIORITY[code] ?? 4

export function defaultRoleOf(list: EffectiveRole[]): EffectiveRole | null {
  return [...list].sort((a, b) => rankRole(a.code) - rankRole(b.code) || a.name.localeCompare(b.name, 'uk') || a.id.localeCompare(b.id))[0] ?? null
}

/** Действующие роли человека, сгруппированные по роли (одна роль может быть выдана в нескольких областях). */
export async function effectiveRoles(tx: TenantTx, userId: string): Promise<EffectiveRole[]> {
  const rows = await tx.select({
    id: roles.id,
    code: roles.code,
    name: roles.name,
    scopes: roles.scopes,
    scopeType: userRoles.scopeType,
    scopeId: userRoles.scopeId,
    validUntil: userRoles.validUntil,
  })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(userRoles.userId, userId), or(isNull(userRoles.validUntil), gt(userRoles.validUntil, sql`now()`))))

  const byId = new Map<string, EffectiveRole>()
  for (const r of rows) {
    const role = byId.get(r.id) ?? { id: r.id, code: r.code, name: r.name, scopes: r.scopes, grants: [] }
    role.grants.push({ scopeType: r.scopeType as EffectiveRole['grants'][number]['scopeType'], scopeId: r.scopeId, validUntil: r.validUntil })
    byId.set(r.id, role)
  }
  return [...byId.values()]
}

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)

/**
 * Какая роль активна в сессии: та, что записана, если она ещё действует; иначе роль по умолчанию
 * (старая сессия до миграции, снятая или истёкшая роль). Подмена записывается в сессию, чтобы
 * последующие запросы и переключатель видели одно и то же.
 */
export async function resolveActiveRole(tx: TenantTx, auth: AuthContext, list: EffectiveRole[]): Promise<EffectiveRole | null> {
  const current = auth.activeRoleId ? list.find(r => r.id === auth.activeRoleId) : undefined
  if (current) return current
  const fallback = defaultRoleOf(list)
  if (isUuid(auth.sessionId) && (fallback?.id ?? null) !== auth.activeRoleId) {
    await tx.update(sessions).set({ activeRoleId: fallback?.id ?? null }).where(eq(sessions.id, auth.sessionId))
  }
  return fallback
}

export type SwitchResult
  = { ok: true, changed: boolean, role: { id: string, code: string, name: string } }
    | { ok: false, code: 'forbidden' | 'no_session' }

/**
 * Переключение активной роли: только среди своих действующих ролей (чужая, снятая или истёкшая —
 * `forbidden`, 403 по docs/04). Событие `role.switch` в audit_log — с обеими ролями и request_context.
 */
export async function switchRole(auth: AuthContext, roleId: string): Promise<SwitchResult> {
  if (!isUuid(auth.sessionId)) return { ok: false, code: 'no_session' }
  return withTenant(auth.tenantId, auth.userId, async (tx) => {
    const list = await effectiveRoles(tx, auth.userId)
    const next = list.find(r => r.id === roleId)
    if (!next) return { ok: false as const, code: 'forbidden' as const }
    const prev = await resolveActiveRole(tx, auth, list)
    const role = { id: next.id, code: next.code, name: next.name }
    if (prev?.id === next.id) return { ok: true as const, changed: false, role }

    await tx.update(sessions).set({ activeRoleId: next.id, updatedAt: new Date() }).where(eq(sessions.id, auth.sessionId))
    await tx.insert(auditLog).values({
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorRoleId: prev?.id ?? null,
      actorRoles: list.map(r => r.code),
      action: 'role.switch',
      entity: 'session',
      entityId: auth.sessionId,
      before: prev ? { roleId: prev.id, code: prev.code } : null,
      after: { roleId: next.id, code: next.code },
      requestContext: currentRequestContext(),
    })
    return { ok: true as const, changed: true, role }
  })
}
