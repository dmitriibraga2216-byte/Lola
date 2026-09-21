import { eq } from 'drizzle-orm'
import { roles, sessions } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { Access } from './access'
import { can } from './access'
import { recordAudit } from './audit'
import type { AuthContext } from './session'

/**
 * «Переглянути систему як роль» (docs/24 §3.5, docs/24 §9 `POST /settings/roles/preview-as`,
 * докс/33 D-052): адміністратор бачить меню й екрани очима ролі, не змінюючи власні права.
 * Позначка — `sessions.preview_role_id`; `loadAccess` рахує права рівно по цій ролі (область —
 * весь тенант, без прив'язки до конкретної точки/підрозділу — режим показує, що бачить роль
 * загалом). Мутації в цьому режимі заборонені middleware `03.guards` (як і «від імені»,
 * тільки без обмеження часом — вихід у будь-який момент кнопкою на плашці).
 * На відміну від `/me/role/switch` (перемикання між власними ролями), тут можна побачити роль,
 * якої в людини немає — але не більше прав, ніж є в самого адміністратора (Г-24.1: не можна
 * видати чи «приміряти» скоуп, якого немає у себе).
 */

export type PreviewError = 'not_found' | 'scope_not_owned'
export interface PreviewRole { id: string, code: string, name: string }

export async function startPreview(auth: AuthContext, access: Access, roleId: string): Promise<{ ok: true, role: PreviewRole } | { ok: false, code: PreviewError, details?: Record<string, unknown> }> {
  return withTenant(auth.tenantId, auth.userId, async (tx) => {
    const [role] = await tx.select().from(roles).where(eq(roles.id, roleId))
    if (!role) return { ok: false as const, code: 'not_found' as const }
    const notOwned = role.scopes.filter(s => !can(access, s))
    if (notOwned.length) return { ok: false as const, code: 'scope_not_owned' as const, details: { scopes: notOwned } }

    await tx.update(sessions).set({ previewRoleId: roleId }).where(eq(sessions.id, auth.sessionId))
    await recordAudit(tx, { tenantId: auth.tenantId, actorId: auth.userId, action: 'role.preview_as_started', entity: 'role', entityId: roleId, after: { role: { id: role.id, code: role.code, name: role.name } } })
    return { ok: true as const, role: { id: role.id, code: role.code, name: role.name } }
  })
}

/** Кнопка «Вихід» на плашці (як у impersonate) — знімає позначку з поточної сесії. */
export async function stopPreview(auth: AuthContext): Promise<boolean> {
  if (!auth.previewRoleId) return false
  return withTenant(auth.tenantId, auth.userId, async (tx) => {
    await tx.update(sessions).set({ previewRoleId: null }).where(eq(sessions.id, auth.sessionId))
    await recordAudit(tx, { tenantId: auth.tenantId, actorId: auth.userId, action: 'role.preview_as_stopped', entity: 'role', entityId: auth.previewRoleId })
    return true
  })
}

/** Для плашки: яку роль зараз переглядають. */
export async function previewInfo(auth: AuthContext): Promise<PreviewRole | null> {
  if (!auth.previewRoleId) return null
  return withTenant(auth.tenantId, auth.userId, async (tx) => {
    const [role] = await tx.select().from(roles).where(eq(roles.id, auth.previewRoleId!))
    return role ? { id: role.id, code: role.code, name: role.name } : null
  })
}
