import { and, eq, inArray, sql } from 'drizzle-orm'
import { accessGroupMembers, contentAccessGroups, tenants } from '../db/schema'
import type { TenantTx } from '../utils/withTenant'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'
import { userAccessSubjects } from './resources'

interface Ctx { tenantId: string, actorId: string }

/**
 * Групи доступу каталогу навчання (docs/10 §14.1: «Устроено так же, как доступ к базе
 * знаний», docs/21 §14.1) — переиспользуем `access_groups`/`content_access_groups` из #37,
 * не дублируем. Тумблер «Використовувати обмеження доступу до завдань в каталозі навчання» —
 * `tenants.settings.catalog.restrictAccess`, за замовчуванням вимкнено (докс/10 §14.1: «поки
 * він вимкнений — Завдання в Каталозі доступні усім користувачам»).
 */
export interface CatalogSettings { restrictAccess: boolean }

export async function catalogSettings(tx: TenantTx, tenantId: string): Promise<CatalogSettings> {
  const [t] = await tx.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId))
  const c = ((t?.settings ?? {}) as { catalog?: Partial<CatalogSettings> }).catalog ?? {}
  return { restrictAccess: c.restrictAccess ?? false }
}

export async function getCatalogSettings(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, tx => catalogSettings(tx, ctx.tenantId))
}

export async function updateCatalogSettings(ctx: Ctx, patch: Partial<CatalogSettings>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const before = await catalogSettings(tx, ctx.tenantId)
    const next = { ...before, ...patch }
    await tx.execute(sql`update tenants set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{catalog}', ${JSON.stringify(next)}::jsonb) where id = ${ctx.tenantId}::uuid`)
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'settings.catalog', entity: 'tenant', entityId: ctx.tenantId, before, after: next })
    return next
  })
}

/**
 * Доступ до предмету каталогу (docs/10 §14.1, docs/21 §14.1): без груп — відкрито всім
 * у тенанті; з групами — людина повинна входити хоча б в одну (посада, підрозділ, роль,
 * особисто). Тумблер вимкнений — групи не діють взагалі.
 */
export async function canAccessCatalogItem(tx: TenantTx, tenantId: string, userId: string, contentType: string, contentId: string): Promise<boolean> {
  if (!(await catalogSettings(tx, tenantId)).restrictAccess) return true
  const groups = await tx.select({ groupId: contentAccessGroups.groupId }).from(contentAccessGroups)
    .where(and(eq(contentAccessGroups.contentType, contentType), eq(contentAccessGroups.contentId, contentId)))
  if (!groups.length) return true
  const subjects = await userAccessSubjects(tx, userId)
  const members = await tx.select({ subjectType: accessGroupMembers.subjectType, subjectId: accessGroupMembers.subjectId })
    .from(accessGroupMembers).where(inArray(accessGroupMembers.groupId, groups.map(g => g.groupId)))
  return members.some(m => (subjects[m.subjectType as keyof typeof subjects] ?? []).includes(m.subjectId))
}

/** Для списку каталогу: які з переданих contentId людині доступні (один запит на групи замість N). */
export async function accessibleCatalogIds(tx: TenantTx, tenantId: string, userId: string, contentType: string, contentIds: string[]): Promise<Set<string>> {
  if (!contentIds.length) return new Set()
  if (!(await catalogSettings(tx, tenantId)).restrictAccess) return new Set(contentIds)
  const groups = await tx.select({ contentId: contentAccessGroups.contentId, groupId: contentAccessGroups.groupId }).from(contentAccessGroups)
    .where(and(eq(contentAccessGroups.contentType, contentType), inArray(contentAccessGroups.contentId, contentIds)))
  const gated = new Set(groups.map(g => g.contentId))
  const open = contentIds.filter(id => !gated.has(id))
  if (!groups.length) return new Set(contentIds)
  const subjects = await userAccessSubjects(tx, userId)
  const members = await tx.select({ subjectType: accessGroupMembers.subjectType, subjectId: accessGroupMembers.subjectId, groupId: accessGroupMembers.groupId })
    .from(accessGroupMembers).where(inArray(accessGroupMembers.groupId, groups.map(g => g.groupId)))
  const allowedGroupIds = new Set(members.filter(m => (subjects[m.subjectType as keyof typeof subjects] ?? []).includes(m.subjectId)).map(m => m.groupId))
  const allowed = new Set(open)
  for (const g of groups) if (allowedGroupIds.has(g.groupId)) allowed.add(g.contentId)
  return allowed
}
