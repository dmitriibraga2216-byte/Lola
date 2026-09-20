import { asc, eq, sql } from 'drizzle-orm'
import { courseCategories } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { z } from 'zod'
import type { categorySchema } from '../../shared/schemas/settings'
import { recordAudit } from './audit'

/**
 * «Категорії каталогу навчання» (docs/24 §3.7.1): второй справочник рядом с категориями ресурсов
 * (`resource_categories`, #37 — не дублируем, тот остаётся как есть). Плоский список с `sort`,
 * порядок — перетаскиванием (`reorder`), цифры в названиях не нужны. Используется каталогом курсов и новостями.
 */

export interface Ctx { tenantId: string, actorId: string }

export async function listCategories(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select().from(courseCategories).orderBy(asc(courseCategories.sort), asc(courseCategories.name))
    const counts = await tx.execute(sql`select category_id as id, count(*)::int as n from courses where category_id is not null and deleted_at is null group by category_id`) as unknown as { id: string, n: number }[]
    const n = new Map(counts.map(c => [c.id, c.n]))
    return rows.map(c => ({ id: c.id, name: c.name, parentId: c.parentId, sort: c.sort, coursesCount: n.get(c.id) ?? 0 }))
  })
}

export async function createCategory(ctx: Ctx, input: z.infer<typeof categorySchema>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [{ max }] = await tx.select({ max: sql<number>`coalesce(max(${courseCategories.sort}), -1)::int` }).from(courseCategories) as [{ max: number }]
    const [c] = await tx.insert(courseCategories).values({ tenantId: ctx.tenantId, name: input.name, parentId: input.parentId ?? null, sort: max + 1 }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'category.create', entity: 'course_category', entityId: c!.id, after: { name: c!.name } })
    return c!
  })
}

export async function updateCategory(ctx: Ctx, id: string, input: Partial<z.infer<typeof categorySchema>>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(courseCategories).where(eq(courseCategories.id, id))
    if (!before) return null
    const [after] = await tx.update(courseCategories).set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId === id ? null : input.parentId } : {}),
      updatedAt: new Date(),
    }).where(eq(courseCategories.id, id)).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'category.update', entity: 'course_category', entityId: id, before: { name: before.name }, after: { name: after!.name } })
    return after!
  })
}

/** Категория с курсами не удаляется — 409 `in_use`, чтобы каталог не потерял разделы. */
export async function deleteCategory(ctx: Ctx, id: string): Promise<{ ok: true } | { ok: false, code: 'not_found' | 'in_use', used?: number }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [c] = await tx.select().from(courseCategories).where(eq(courseCategories.id, id))
    if (!c) return { ok: false as const, code: 'not_found' as const }
    const [{ n }] = await tx.execute(sql`select (select count(*)::int from courses where category_id = ${id}::uuid and deleted_at is null) + (select count(*)::int from news where category_id = ${id}::uuid) as n`) as unknown as [{ n: number }]
    if (n > 0) return { ok: false as const, code: 'in_use' as const, used: n }
    await tx.delete(courseCategories).where(eq(courseCategories.id, id))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'category.delete', entity: 'course_category', entityId: id, before: { name: c.name } })
    return { ok: true as const }
  })
}

/** Порядок перетаскиванием: позиция в массиве = sort. */
export async function reorderCategories(ctx: Ctx, ids: string[]) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    for (const [i, id] of ids.entries()) await tx.update(courseCategories).set({ sort: i, updatedAt: new Date() }).where(eq(courseCategories.id, id))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'category.reorder', entity: 'course_category', after: { ids } })
    return true
  })
}
