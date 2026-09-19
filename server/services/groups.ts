import { desc, eq, sql } from 'drizzle-orm'
import { userGroups } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'
import { resolveAudience } from './audience'

interface Ctx { tenantId: string, actorId: string }

/** Группы и сегменты (docs/16 §3.4): статические — список людей, динамические — фильтр как segment, пересчёт ежечасно. */
export async function listGroups(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select().from(userGroups).orderBy(desc(userGroups.createdAt))
    return rows.map(g => ({ ...g, size: g.members.length }))
  })
}

export async function upsertGroup(ctx: Ctx, input: { id?: string, name: string, kind: 'static' | 'dynamic', members?: string[], filter?: Record<string, unknown> | null, isActive?: boolean }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    let members = input.members ?? []
    if (input.kind === 'dynamic' && input.filter) members = [...await resolveAudience(tx, { rules: [{ type: 'segment', filter: input.filter as never }], match: 'any' })]
    const values = { name: input.name, kind: input.kind, members, filter: input.kind === 'dynamic' ? (input.filter ?? {}) : null, isActive: input.isActive ?? true, recalcAt: new Date() }
    if (input.id) {
      const [g] = await tx.update(userGroups).set({ ...values, updatedAt: new Date() }).where(eq(userGroups.id, input.id)).returning()
      return g ?? null
    }
    const [g] = await tx.insert(userGroups).values({ tenantId: ctx.tenantId, ...values }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'group.create', entity: 'user_group', entityId: g!.id, after: { name: input.name, kind: input.kind } })
    return g!
  })
}

export async function deleteGroup(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async tx => (await tx.delete(userGroups).where(eq(userGroups.id, id)).returning({ id: userGroups.id })).length > 0)
}

/** Ежечасно: пересчёт динамических групп (docs/16 §11 groups.recalc). */
export async function recalcGroups(tenantId: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const groups = await tx.select().from(userGroups).where(sql`${userGroups.kind} = 'dynamic' and ${userGroups.isActive}`)
    for (const g of groups) {
      const members = [...await resolveAudience(tx, { rules: [{ type: 'segment', filter: (g.filter ?? {}) as never }], match: 'any' })]
      await tx.update(userGroups).set({ members, recalcAt: new Date() }).where(eq(userGroups.id, g.id))
    }
    return groups.length
  })
}
