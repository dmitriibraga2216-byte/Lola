import { asc, eq, sql } from 'drizzle-orm'
import { roles, userRoles } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { SCOPES, SYSTEM_ROLES } from '../../shared/domain/roles'
import type { RoleCreate, RolePatch } from '../../shared/schemas/settings'
import type { Access } from './access'
import { can } from './access'
import { recordAudit } from './audit'
import { logSecurity } from './securityLog'

/**
 * Редактор ролей (docs/24 §3.5, Г-24.1; docs/01 §1.2): свои роли тенанта поверх матрицы системных.
 * Права — скоупы `<объект>.<операция>`, роль — набор скоупов; таблица `roles` (docs/02), `loadAccess`
 * читает скоупы из неё, поэтому своя роль действует сразу.
 * Защиты: системные роли не удаляются; набор `admin` не меняется (docs/01 §1.2 — иначе тенант заблокирует
 * сам себя); нельзя удалить роль, выданную людям; нельзя снять `settings.tenant` у последней роли с этим
 * скоупом (docs/24 §11); нельзя выдать скоуп, которого нет у самого редактора (Г-24.1).
 */

export interface Ctx { tenantId: string, actorId: string }

export type RoleError = 'not_found' | 'code_taken' | 'system_role' | 'admin_role' | 'role_in_use' | 'last_settings_role' | 'scope_not_owned'

/** Группы скоупов для экрана (docs/01 §1.3): ключ группы — i18n `settings.roles.group.*`. */
export const SCOPE_GROUPS: { key: string, scopes: string[] }[] = [
  { key: 'learn', scopes: ['learn.view', 'learn.catalog', 'learn.attempt'] },
  { key: 'content', scopes: ['course.view', 'course.create', 'course.edit', 'course.publish', 'course.archive', 'question.manage', 'media.upload', 'media.delete', 'knowledge.manage', 'survey.manage', 'wiki.edit'] },
  { key: 'people', scopes: ['people.view', 'people.invite', 'people.edit', 'people.deactivate', 'people.import', 'assignment.create', 'assignment.cancel', 'role.assign'] },
  { key: 'review', scopes: ['review.queue', 'review.grade', 'certification.confirm'] },
  { key: 'reports', scopes: ['report.own', 'report.team', 'report.tenant', 'report.export', 'report.builder'] },
  { key: 'development', scopes: ['development.own', 'development.team', 'development.manage', 'competency.manage', 'position_profile.manage', 'request.decide'] },
  { key: 'assessment', scopes: ['assessment.own', 'assessment.team', 'assessment.run', 'assessment.manage', 'checklist.run', 'checklist.manage'] },
  { key: 'meetups', scopes: ['meetup.view', 'meetup.enroll', 'meetup.manage', 'meetup.attendance', 'webinar.manage', 'complextest.manage'] },
  { key: 'programs', scopes: ['program.manage', 'program.publish', 'program.link_rule'] },
  { key: 'settings', scopes: ['settings.tenant', 'settings.notifications', 'settings.integrations', 'audit.view'] },
]

export interface RoleRow {
  id: string
  code: string
  name: string
  description: string | null
  scopes: string[]
  isSystem: boolean
  defaultScopeType: string
  peopleCount: number
}

export async function listRoles(ctx: Ctx): Promise<RoleRow[]> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select().from(roles).orderBy(asc(roles.isSystem), asc(roles.name))
    const counts = await tx.execute(sql`
      select role_id, count(distinct user_id)::int as n from user_roles
      where valid_until is null or valid_until > now() group by role_id
    `) as unknown as { role_id: string, n: number }[]
    const n = new Map(counts.map(c => [c.role_id, c.n]))
    // Системные — в порядке матрицы docs/01 §1.2, свои — по имени
    const order = Object.keys(SYSTEM_ROLES)
    return rows
      .map(r => ({ id: r.id, code: r.code, name: r.name, description: r.description, scopes: r.scopes, isSystem: r.isSystem, defaultScopeType: r.defaultScopeType, peopleCount: n.get(r.id) ?? 0 }))
      .sort((a, b) => (a.isSystem === b.isSystem ? (a.isSystem ? order.indexOf(a.code) - order.indexOf(b.code) : a.name.localeCompare(b.name, 'uk')) : a.isSystem ? -1 : 1))
  })
}

/** Скоупы, которых нет у самого редактора, выдать нельзя (Г-24.1). */
function notOwned(access: Access, scopes: string[]): string[] {
  return scopes.filter(s => !can(access, s))
}

export async function createRole(ctx: Ctx, access: Access, input: RoleCreate): Promise<{ ok: true, role: RoleRow } | { ok: false, code: RoleError, details?: Record<string, unknown> }> {
  const missing = notOwned(access, input.scopes)
  if (missing.length) return { ok: false, code: 'scope_not_owned', details: { scopes: missing } }
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [dup] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.code, input.code))
    if (dup || input.code in SYSTEM_ROLES) return { ok: false as const, code: 'code_taken' as const }
    const [r] = await tx.insert(roles).values({ tenantId: ctx.tenantId, code: input.code, name: input.name, description: input.description ?? null, scopes: [...new Set(input.scopes)], isSystem: false, defaultScopeType: input.defaultScopeType }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'role.create', entity: 'role', entityId: r!.id, after: { code: r!.code, name: r!.name, scopes: r!.scopes } })
    await logSecurity({ tenantId: ctx.tenantId, userId: ctx.actorId, event: 'roles.changed', meta: { roleId: r!.id, code: r!.code, action: 'create' } })
    return { ok: true as const, role: { id: r!.id, code: r!.code, name: r!.name, description: r!.description, scopes: r!.scopes, isSystem: false, defaultScopeType: r!.defaultScopeType, peopleCount: 0 } }
  })
}

export async function updateRole(ctx: Ctx, access: Access, id: string, patch: RolePatch): Promise<{ ok: true, role: RoleRow } | { ok: false, code: RoleError, details?: Record<string, unknown> }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(roles).where(eq(roles.id, id))
    if (!before) return { ok: false as const, code: 'not_found' as const }
    if (patch.scopes) {
      if (before.code === 'admin') return { ok: false as const, code: 'admin_role' as const }
      const added = patch.scopes.filter(s => !before.scopes.includes(s))
      const missing = notOwned(access, added)
      if (missing.length) return { ok: false as const, code: 'scope_not_owned' as const, details: { scopes: missing } }
      if (before.scopes.includes('settings.tenant') && !patch.scopes.includes('settings.tenant')) {
        // docs/24 §3.5, §11: последняя роль с settings.tenant не может его лишиться
        const others = await tx.execute(sql`select 1 from roles where id <> ${id}::uuid and 'settings.tenant' = any(scopes) limit 1`) as unknown as unknown[]
        if (!others.length) return { ok: false as const, code: 'last_settings_role' as const }
      }
    }
    const [after] = await tx.update(roles).set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.scopes !== undefined ? { scopes: [...new Set(patch.scopes)] } : {}),
      ...(patch.defaultScopeType !== undefined ? { defaultScopeType: patch.defaultScopeType } : {}),
      updatedAt: new Date(),
    }).where(eq(roles.id, id)).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'role.update', entity: 'role', entityId: id, before: { name: before.name, scopes: before.scopes, description: before.description, defaultScopeType: before.defaultScopeType }, after: { name: after!.name, scopes: after!.scopes, description: after!.description, defaultScopeType: after!.defaultScopeType } })
    if (patch.scopes) {
      const next: string[] = patch.scopes
      await logSecurity({ tenantId: ctx.tenantId, userId: ctx.actorId, event: 'roles.changed', meta: { roleId: id, code: before.code, action: 'scopes', added: next.filter(s => !before.scopes.includes(s)), removed: before.scopes.filter(s => !next.includes(s)) } })
    }
    const [{ n }] = await tx.select({ n: sql<number>`count(distinct ${userRoles.userId})::int` }).from(userRoles).where(eq(userRoles.roleId, id)) as [{ n: number }]
    return { ok: true as const, role: { id, code: after!.code, name: after!.name, description: after!.description, scopes: after!.scopes, isSystem: after!.isSystem, defaultScopeType: after!.defaultScopeType, peopleCount: n } }
  })
}

export async function deleteRole(ctx: Ctx, id: string): Promise<{ ok: true } | { ok: false, code: RoleError, details?: Record<string, unknown> }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.select().from(roles).where(eq(roles.id, id))
    if (!r) return { ok: false as const, code: 'not_found' as const }
    if (r.isSystem) return { ok: false as const, code: 'system_role' as const }
    const [{ n }] = await tx.select({ n: sql<number>`count(distinct ${userRoles.userId})::int` }).from(userRoles).where(eq(userRoles.roleId, id)) as [{ n: number }]
    if (n > 0) return { ok: false as const, code: 'role_in_use' as const, details: { people: n } }
    await tx.execute(sql`delete from position_role_map where role_id = ${id}::uuid`)
    await tx.delete(roles).where(eq(roles.id, id))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'role.delete', entity: 'role', entityId: id, before: { code: r.code, name: r.name, scopes: r.scopes } })
    await logSecurity({ tenantId: ctx.tenantId, userId: ctx.actorId, event: 'roles.changed', meta: { roleId: id, code: r.code, action: 'delete' } })
    return { ok: true as const }
  })
}

export const ALL_SCOPES: readonly string[] = SCOPES
