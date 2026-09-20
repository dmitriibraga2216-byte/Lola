import { and, asc, eq, sql } from 'drizzle-orm'
import { tags } from '../db/schema'
import type { TagScope } from '../../shared/enums'
import type { TenantTx } from '../utils/withTenant'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'

interface Ctx { tenantId: string, actorId: string }

/**
 * Метки с областью действия (docs/16 §14.2, docs/02 «Метки»): область обязательна — без неё на форме курса
 * всплывают метки должностей, а на карточке человека — метки выпечки. Имя ≤ 40 знаков без угловых скобок,
 * уникально в паре (scope, name). Метка хранится на сущностях строкой (`tags text[]`), поэтому «где используется»
 * считается по таблицам своей области.
 */

/** Таблицы, где живут метки каждой области (`tags text[]`). */
export const TAG_TABLES: Record<TagScope, string[]> = {
  user: ['users'],
  course: ['courses', 'programs', 'trajectories'],
  resource: ['resources', 'knowledge_articles'],
  question: ['questions', 'quizzes'],
  task: ['assignments', 'meetups'],
}

export interface TagInput { name: string, scope: TagScope, description?: string | null, color?: string | null }

export type TagError = 'not_found' | 'duplicate' | 'in_use'

function usageSql(scope: TagScope, name: string) {
  return sql.join(TAG_TABLES[scope].map(t => sql`(select count(*) from ${sql.identifier(t)} where ${name}::text = any(tags))`), sql` + `)
}

export async function usageOf(tx: TenantTx, scope: TagScope, name: string): Promise<number> {
  const [r] = await tx.execute(sql`select ${usageSql(scope, name)} as n`) as unknown as { n: number | string }[]
  return Number(r?.n ?? 0)
}

/** Список меток области (или всех) со счётчиком использований — экран «Керування мітками». */
export async function listTags(ctx: Ctx, scope?: TagScope) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select().from(tags).where(scope ? eq(tags.scope, scope) : sql`true`).orderBy(asc(tags.scope), asc(tags.name))
    const out = []
    for (const t of rows) out.push({ ...t, usage: await usageOf(tx, t.scope as TagScope, t.name) })
    return out
  })
}

export async function createTag(ctx: Ctx, input: TagInput): Promise<{ ok: true, tag: typeof tags.$inferSelect } | { ok: false, code: TagError }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [dup] = await tx.select({ id: tags.id }).from(tags).where(and(eq(tags.scope, input.scope), sql`lower(${tags.name}) = lower(${input.name})`))
    if (dup) return { ok: false as const, code: 'duplicate' as const }
    const [t] = await tx.insert(tags).values({ tenantId: ctx.tenantId, name: input.name, scope: input.scope, description: input.description ?? null, color: input.color ?? null }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'tag.create', entity: 'tag', entityId: t!.id, after: { name: t!.name, scope: t!.scope } })
    return { ok: true as const, tag: t! }
  })
}

/** Переименование сохраняет связи (docs/16 §3.3): строка на сущностях области переписывается той же транзакцией. Область менять нельзя. */
export async function updateTag(ctx: Ctx, id: string, patch: Partial<Omit<TagInput, 'scope'>>): Promise<{ ok: true, tag: typeof tags.$inferSelect } | { ok: false, code: TagError }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(tags).where(eq(tags.id, id))
    if (!before) return { ok: false as const, code: 'not_found' as const }
    const scope = before.scope as TagScope
    if (patch.name && patch.name !== before.name) {
      const [dup] = await tx.select({ id: tags.id }).from(tags).where(and(eq(tags.scope, scope), sql`lower(${tags.name}) = lower(${patch.name})`, sql`${tags.id} <> ${id}::uuid`))
      if (dup) return { ok: false as const, code: 'duplicate' as const }
      for (const table of TAG_TABLES[scope]) {
        await tx.execute(sql`update ${sql.identifier(table)} set tags = array(select distinct unnest(array_replace(tags, ${before.name}::text, ${patch.name}::text))) where ${before.name}::text = any(tags)`)
      }
    }
    const [t] = await tx.update(tags).set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
      updatedAt: new Date(),
    }).where(eq(tags.id, id)).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'tag.update', entity: 'tag', entityId: id, before: { name: before.name, description: before.description, color: before.color }, after: { name: t!.name, description: t!.description, color: t!.color } })
    return { ok: true as const, tag: t! }
  })
}

/** Используемую метку удалить нельзя (docs/16 §3.3) — 409 `in_use` со счётчиком. */
export async function deleteTag(ctx: Ctx, id: string): Promise<{ ok: true } | { ok: false, code: TagError, used?: number }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [t] = await tx.select().from(tags).where(eq(tags.id, id))
    if (!t) return { ok: false as const, code: 'not_found' as const }
    const used = await usageOf(tx, t.scope as TagScope, t.name)
    if (used > 0) return { ok: false as const, code: 'in_use' as const, used }
    await tx.delete(tags).where(eq(tags.id, id))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'tag.delete', entity: 'tag', entityId: id, before: { name: t.name, scope: t.scope } })
    return { ok: true as const }
  })
}

/**
 * Метки на сущности — только своей области: неизвестные имена заводятся в области сразу (docs/16 §14.2:
 * «с подтверждением при создании новой прямо из формы» — подтверждает форма, сервер гарантирует существование).
 * Имя нормализуется (trim), дубли без учёта регистра приводятся к уже существующему написанию.
 */
export async function ensureTags(tx: TenantTx, tenantId: string, scope: TagScope, names: string[]): Promise<string[]> {
  const wanted = [...new Set(names.map(n => n.trim()).filter(n => n && n.length <= 40 && !/[<>]/.test(n)))]
  if (!wanted.length) return []
  const rows = await tx.select({ name: tags.name }).from(tags).where(eq(tags.scope, scope))
  const known = new Map(rows.map(r => [r.name.toLowerCase(), r.name]))
  const missing = wanted.filter(n => !known.has(n.toLowerCase()))
  if (missing.length) {
    await tx.insert(tags).values(missing.map(name => ({ tenantId, name, scope }))).onConflictDoNothing()
    for (const m of missing) known.set(m.toLowerCase(), m)
  }
  return [...new Set(wanted.map(n => known.get(n.toLowerCase())!))]
}
