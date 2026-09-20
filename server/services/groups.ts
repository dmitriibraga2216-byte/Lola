import { desc, eq, sql } from 'drizzle-orm'
import { userGroups } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import { resolveAudience } from './audience'
import { readSettings } from './settings'

interface Ctx { tenantId: string, actorId: string }

/** Группы и сегменты (docs/16 §3.4): статические — список людей, динамические — фильтр как segment, пересчёт ежечасно. */
export async function listGroups(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select().from(userGroups).orderBy(desc(userGroups.isOrgDerived), desc(userGroups.createdAt))
    return rows.map(g => ({ ...g, size: g.members.length }))
  })
}

export type GroupUpsertResult = typeof userGroups.$inferSelect | null | { error: 'org_derived' }

/** Группу «з оргструктури» руками не правят (docs/16 §14.1) — 409 `org_derived`. */
export async function upsertGroup(ctx: Ctx, input: { id?: string, name: string, kind: 'static' | 'dynamic', members?: string[], filter?: Record<string, unknown> | null, isActive?: boolean }): Promise<GroupUpsertResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    let members = input.members ?? []
    if (input.kind === 'dynamic' && input.filter) members = [...await resolveAudience(tx, { rules: [{ type: 'segment', filter: input.filter as never }], match: 'any' })]
    const values = { name: input.name, kind: input.kind, members, filter: input.kind === 'dynamic' ? (input.filter ?? {}) : null, isActive: input.isActive ?? true, recalcAt: new Date() }
    if (input.id) {
      const [existing] = await tx.select({ isOrgDerived: userGroups.isOrgDerived }).from(userGroups).where(eq(userGroups.id, input.id))
      if (!existing) return null
      if (existing.isOrgDerived) return { error: 'org_derived' as const }
      const [g] = await tx.update(userGroups).set({ ...values, updatedAt: new Date() }).where(eq(userGroups.id, input.id)).returning()
      await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'group.update', entity: 'user_group', entityId: input.id, after: { name: input.name, kind: input.kind, members: members.length } })
      return g ?? null
    }
    const [g] = await tx.insert(userGroups).values({ tenantId: ctx.tenantId, ...values }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'group.create', entity: 'user_group', entityId: g!.id, after: { name: input.name, kind: input.kind } })
    return g!
  })
}

export async function deleteGroup(ctx: Ctx, id: string): Promise<{ ok: true } | { ok: false, code: 'not_found' | 'org_derived' }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [g] = await tx.select({ isOrgDerived: userGroups.isOrgDerived }).from(userGroups).where(eq(userGroups.id, id))
    if (!g) return { ok: false as const, code: 'not_found' as const }
    if (g.isOrgDerived) return { ok: false as const, code: 'org_derived' as const }
    await tx.delete(userGroups).where(eq(userGroups.id, id))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'group.delete', entity: 'user_group', entityId: id })
    return { ok: true as const }
  })
}

/** Ежечасно: пересчёт динамических групп (docs/16 §11 groups.recalc) и пересборка производных от оргструктуры. */
export async function recalcGroups(tenantId: string): Promise<number> {
  const n = await withTenant(tenantId, null, async (tx) => {
    const groups = await tx.select().from(userGroups).where(sql`${userGroups.kind} = 'dynamic' and ${userGroups.isActive} and not ${userGroups.isOrgDerived}`)
    for (const g of groups) {
      const members = [...await resolveAudience(tx, { rules: [{ type: 'segment', filter: (g.filter ?? {}) as never }], match: 'any' })]
      await tx.update(userGroups).set({ members, recalcAt: new Date() }).where(eq(userGroups.id, g.id))
    }
    return groups.length
  })
  await rebuildOrgGroups(tenantId)
  return n
}

/**
 * Группы «з оргструктури» (docs/16 §3.3, §14.1, мокап UserGroups): по группе на подразделение (люди открытых
 * размещений в нём и его потомках) и на точку. Пересобираются при импорте, смене размещения и ежечасно;
 * руками не правятся, при исчезновении узла — уходят (FK on delete cascade). Ручная группа с тем же именем
 * не затирается — производная получает суффикс « (оргструктура)».
 *
 * Режим оргструктуры (`policies.orgStructure.mode`, docs/16 §14.3, docs/33 D-022): при `user_groups`
 * («За групами користувачів») людей объединяют вручную самими группами, а не деревом подразделений/точек —
 * производные группы не строятся, а уже существующие (например, оставшиеся от `import`/`hybrid`) снимаются.
 */
export async function rebuildOrgGroups(tenantId: string, tx?: TenantTx): Promise<number> {
  const run = async (t: TenantTx) => {
    const { policies } = await readSettings(t, tenantId)
    if (policies.orgStructure.mode === 'user_groups') {
      const removed = await t.delete(userGroups).where(eq(userGroups.isOrgDerived, true)).returning({ id: userGroups.id })
      return removed.length
    }
    const units = await t.execute(sql`
      select ou.id, ou.name,
             coalesce(array_agg(distinct up.user_id) filter (where up.user_id is not null), '{}'::uuid[]) as members
      from org_units ou
      left join org_units d on d.path <@ ou.path
      left join user_placements up on up.ended_at is null and coalesce(up.org_unit_id, (select l.org_unit_id from locations l where l.id = up.location_id)) = d.id
      left join users u on u.id = up.user_id and u.status in ('active', 'invited') and not u.is_hidden
      group by ou.id, ou.name`) as unknown as { id: string, name: string, members: string[] }[]
    const locs = await t.execute(sql`
      select l.id, l.name,
             coalesce(array_agg(distinct up.user_id) filter (where up.user_id is not null), '{}'::uuid[]) as members
      from locations l
      left join user_placements up on up.ended_at is null and up.location_id = l.id
      left join users u on u.id = up.user_id and u.status in ('active', 'invited') and not u.is_hidden
      group by l.id, l.name`) as unknown as { id: string, name: string, members: string[] }[]
    const manual = new Set((await t.select({ name: userGroups.name }).from(userGroups).where(eq(userGroups.isOrgDerived, false))).map(g => g.name))
    let n = 0
    const upsert = async (name: string, members: string[], ref: { orgUnitId?: string, locationId?: string }) => {
      const finalName = manual.has(name) ? `${name} (оргструктура)` : name
      const where = ref.orgUnitId ? eq(userGroups.orgUnitId, ref.orgUnitId) : eq(userGroups.locationId, ref.locationId!)
      const [existing] = await t.select({ id: userGroups.id }).from(userGroups).where(sql`${where} and ${userGroups.isOrgDerived}`)
      if (existing) await t.update(userGroups).set({ name: finalName, members, recalcAt: new Date(), updatedAt: new Date() }).where(eq(userGroups.id, existing.id))
      else await t.insert(userGroups).values({ tenantId, name: finalName, kind: 'static', members, isActive: true, isOrgDerived: true, orgUnitId: ref.orgUnitId ?? null, locationId: ref.locationId ?? null, recalcAt: new Date() }).onConflictDoNothing()
      n++
    }
    for (const u of units) await upsert(u.name, u.members, { orgUnitId: u.id })
    for (const l of locs) await upsert(l.name, l.members, { locationId: l.id })
    return n
  }
  return tx ? run(tx) : withTenant(tenantId, null, run)
}
