import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { roles, userRoles, users, wikiPages, wikiRevisions } from '../db/schema'
import type { ContentBlock } from '../../shared/schemas/content'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import { slugify } from './courses'
import { blocksToText } from './knowledge'
import { sanitizeBody } from './sanitize'

interface Ctx { tenantId: string, actorId: string }

/**
 * Wiki (docs/03 §3.22): иерархия страниц, история правок, права по веткам —
 * view_roles/edit_roles на странице наследуются вниз, пустой список = как у родителя;
 * у корня пусто = видят все, правят обладатели wiki.edit.
 */

async function roleCodesOf(tx: TenantTx, userId: string): Promise<Set<string>> {
  const rows = await tx.select({ code: roles.code }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(eq(userRoles.userId, userId))
  return new Set(rows.map(r => r.code))
}

interface PageRow { id: string, parentId: string | null, viewRoles: string[], editRoles: string[] }

/** Эффективные права ветки: идём вверх до первого непустого списка. */
function effective(pages: Map<string, PageRow>, id: string, key: 'viewRoles' | 'editRoles'): string[] {
  let cur: PageRow | undefined = pages.get(id)
  while (cur) {
    if (cur[key].length) return cur[key]
    cur = cur.parentId ? pages.get(cur.parentId) : undefined
  }
  return []
}

export async function wikiTree(ctx: Ctx, opts: { all?: boolean } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select({ id: wikiPages.id, parentId: wikiPages.parentId, title: wikiPages.title, slug: wikiPages.slug, sort: wikiPages.sort, status: wikiPages.status, viewRoles: wikiPages.viewRoles, editRoles: wikiPages.editRoles, updatedAt: wikiPages.updatedAt, version: wikiPages.version })
      .from(wikiPages).where(isNull(wikiPages.deletedAt)).orderBy(asc(wikiPages.sort), asc(wikiPages.title))
    const map = new Map(rows.map(r => [r.id, r]))
    const my = await roleCodesOf(tx, ctx.actorId)
    const visible = rows.filter((r) => {
      if (!opts.all && r.status !== 'published') return false
      const v = effective(map, r.id, 'viewRoles')
      return v.length === 0 || v.some(c => my.has(c)) || my.has('admin')
    })
    const ids = new Set(visible.map(v => v.id))
    return visible.map(r => ({ ...r, parentId: r.parentId && ids.has(r.parentId) ? r.parentId : null, canEdit: canEditPage(map, r.id, my) }))
  })
}

function canEditPage(map: Map<string, PageRow>, id: string, my: Set<string>): boolean {
  if (my.has('admin')) return true
  const e = effective(map, id, 'editRoles')
  return e.length ? e.some(c => my.has(c)) : (my.has('author'))
}

export async function getPage(ctx: Ctx, idOrSlug: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const isUuid = /^[0-9a-f-]{36}$/.test(idOrSlug)
    const [p] = await tx.select().from(wikiPages).where(and(isNull(wikiPages.deletedAt), isUuid ? eq(wikiPages.id, idOrSlug) : eq(wikiPages.slug, idOrSlug)))
    if (!p) return null
    const all = await tx.select({ id: wikiPages.id, parentId: wikiPages.parentId, viewRoles: wikiPages.viewRoles, editRoles: wikiPages.editRoles, title: wikiPages.title, slug: wikiPages.slug }).from(wikiPages).where(isNull(wikiPages.deletedAt))
    const map = new Map(all.map(r => [r.id, r]))
    const my = await roleCodesOf(tx, ctx.actorId)
    const v = effective(map, p.id, 'viewRoles')
    if (v.length && !v.some(c => my.has(c)) && !my.has('admin')) return { forbidden: true as const }
    const crumbs: { id: string, title: string, slug: string }[] = []
    let cur = p.parentId ? map.get(p.parentId) : undefined
    while (cur) { crumbs.unshift({ id: cur.id, title: cur.title, slug: cur.slug }); cur = cur.parentId ? map.get(cur.parentId) : undefined }
    const children = all.filter(c => c.parentId === p.id).map(c => ({ id: c.id, title: c.title, slug: c.slug }))
    const [author] = p.updatedBy ? await tx.select({ fullName: users.fullName }).from(users).where(eq(users.id, p.updatedBy)) : []
    return { ...p, crumbs, children, canEdit: canEditPage(map, p.id, my), updatedByName: author?.fullName ?? null }
  })
}

export async function createPage(ctx: Ctx, input: { title: string, body: ContentBlock[], parentId?: string | null, viewRoles?: string[], editRoles?: string[], status?: string }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const my = await roleCodesOf(tx, ctx.actorId)
    if (input.parentId) {
      const all = await tx.select({ id: wikiPages.id, parentId: wikiPages.parentId, viewRoles: wikiPages.viewRoles, editRoles: wikiPages.editRoles }).from(wikiPages).where(isNull(wikiPages.deletedAt))
      if (!canEditPage(new Map(all.map(r => [r.id, r])), input.parentId, my)) return { forbidden: true as const }
    }
    const base = slugify(input.title) || 'page'
    let slug = base
    for (let i = 2; (await tx.select({ id: wikiPages.id }).from(wikiPages).where(eq(wikiPages.slug, slug))).length; i++) slug = `${base}-${i}`
    const body = sanitizeBody(input.body)
    const [p] = await tx.insert(wikiPages).values({ tenantId: ctx.tenantId, parentId: input.parentId ?? null, title: input.title, slug, body, plainText: blocksToText(body), viewRoles: input.viewRoles ?? [], editRoles: input.editRoles ?? [], status: input.status ?? 'published', updatedBy: ctx.actorId }).returning()
    await tx.insert(wikiRevisions).values({ tenantId: ctx.tenantId, pageId: p!.id, version: 1, title: p!.title, body, authorId: ctx.actorId, comment: 'Створено' })
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'wiki.create', entity: 'wiki_page', entityId: p!.id, after: { title: p!.title } })
    return p!
  })
}

/** Правка: изменение title/body создаёт ревизию с комментарием; права/статус/порядок — без версии. */
export async function updatePage(ctx: Ctx, id: string, input: Partial<{ title: string, body: ContentBlock[], parentId: string | null, viewRoles: string[], editRoles: string[], status: string, sort: number, comment: string }>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(wikiPages).where(and(eq(wikiPages.id, id), isNull(wikiPages.deletedAt)))
    if (!before) return null
    const all = await tx.select({ id: wikiPages.id, parentId: wikiPages.parentId, viewRoles: wikiPages.viewRoles, editRoles: wikiPages.editRoles }).from(wikiPages).where(isNull(wikiPages.deletedAt))
    if (!canEditPage(new Map(all.map(r => [r.id, r])), id, await roleCodesOf(tx, ctx.actorId))) return { forbidden: true as const }
    if (input.parentId === id) return { forbidden: true as const }
    const contentChanged = (input.title !== undefined && input.title !== before.title) || input.body !== undefined
    const body = input.body !== undefined ? sanitizeBody(input.body) : (before.body as ContentBlock[])
    const version = contentChanged ? before.version + 1 : before.version
    const [p] = await tx.update(wikiPages).set({
      ...(input.title !== undefined ? { title: input.title } : {}), ...(input.body !== undefined ? { body, plainText: blocksToText(body) } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}), ...(input.viewRoles !== undefined ? { viewRoles: input.viewRoles } : {}), ...(input.editRoles !== undefined ? { editRoles: input.editRoles } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}), ...(input.sort !== undefined ? { sort: input.sort } : {}),
      version, updatedBy: ctx.actorId, updatedAt: new Date(),
    }).where(eq(wikiPages.id, id)).returning()
    if (contentChanged) await tx.insert(wikiRevisions).values({ tenantId: ctx.tenantId, pageId: id, version, title: p!.title, body, authorId: ctx.actorId, comment: input.comment ?? null })
    return p!
  })
}

export async function pageHistory(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({ id: wikiRevisions.id, version: wikiRevisions.version, title: wikiRevisions.title, comment: wikiRevisions.comment, createdAt: wikiRevisions.createdAt, authorName: users.fullName, body: wikiRevisions.body })
      .from(wikiRevisions).leftJoin(users, eq(users.id, wikiRevisions.authorId)).where(eq(wikiRevisions.pageId, id)).orderBy(desc(wikiRevisions.version))
  })
}

export async function restoreRevision(ctx: Ctx, id: string, version: number) {
  const [rev] = await withTenant(ctx.tenantId, ctx.actorId, tx => tx.select().from(wikiRevisions).where(and(eq(wikiRevisions.pageId, id), eq(wikiRevisions.version, version))))
  if (!rev) return null
  return updatePage(ctx, id, { title: rev.title, body: rev.body as ContentBlock[], comment: `Відновлено версію ${version}` })
}

export async function deletePage(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const all = await tx.select({ id: wikiPages.id, parentId: wikiPages.parentId, viewRoles: wikiPages.viewRoles, editRoles: wikiPages.editRoles }).from(wikiPages).where(isNull(wikiPages.deletedAt))
    if (!canEditPage(new Map(all.map(r => [r.id, r])), id, await roleCodesOf(tx, ctx.actorId))) return { forbidden: true as const }
    const now = new Date()
    // Ветку целиком
    const ids = new Set([id])
    let grew = true
    while (grew) { grew = false; for (const p of all) if (p.parentId && ids.has(p.parentId) && !ids.has(p.id)) { ids.add(p.id); grew = true } }
    await tx.update(wikiPages).set({ deletedAt: now, updatedAt: now }).where(sql`${wikiPages.id} in (${sql.join([...ids].map(x => sql`${x}::uuid`), sql`, `)})`)
    return { deleted: ids.size }
  })
}

export async function searchWiki(ctx: Ctx, q: string) {
  const words = q.trim().split(/\s+/).filter(w => w.length >= 2).slice(0, 8)
  if (!words.length) return []
  const tsq = words.map(w => `${w.replace(/[':&|!()]/g, '').replace(/(.{4,}?).{1,2}$/u, '$1')}:*`).join(' & ')
  const tree = await wikiTree(ctx)
  const ids = new Set(tree.map(t => t.id))
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.execute(sql`
      select id, title, slug, ts_headline('simple', plain_text, to_tsquery('simple', ${tsq}), 'MaxWords=25, MinWords=10') as snippet
      from wiki_pages where deleted_at is null and status = 'published' and to_tsvector('simple', title || ' ' || plain_text) @@ to_tsquery('simple', ${tsq}) limit 20
    `) as unknown as { id: string, title: string, slug: string, snippet: string }[]
    return rows.filter(r => ids.has(r.id))
  })
}
