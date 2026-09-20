import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { bookmarks, courseCategories, news, newsViews, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'
import { sanitizeBody } from './sanitize'
import { resolveAudience } from './audience'
import { countView } from './notices'
import type { ContentBlock } from '../../shared/schemas/content'
import type { Audience } from '../../shared/schemas/assignments'

interface Ctx { tenantId: string, actorId: string }

/** Новости (docs/03 §3.22 R1): лента, закрепление, обязательное прочтение, кто прочитал. */

export async function listNews(ctx: Ctx, opts: { all?: boolean } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select({
      id: news.id, title: news.title, coverKey: news.coverKey, isPinned: news.isPinned, requiresAck: news.requiresAck, categoryId: news.categoryId, viewsCount: news.viewsCount,
      lead: news.lead, publishAt: news.publishAt, unpublishAt: news.unpublishAt, commentsEnabled: news.commentsEnabled,
      status: news.status, publishedAt: news.publishedAt, authorName: users.fullName, audience: news.audience, body: news.body, categoryName: courseCategories.name,
      viewed: sql<boolean>`exists (select 1 from ${newsViews} v where v.news_id = ${news.id} and v.user_id = ${ctx.actorId}::uuid)`,
      acked: sql<boolean>`exists (select 1 from ${newsViews} v where v.news_id = ${news.id} and v.user_id = ${ctx.actorId}::uuid and v.acked_at is not null)`,
      acks: sql<number>`(select count(*)::int from ${newsViews} v where v.news_id = ${news.id} and v.acked_at is not null)`,
      bookmarked: sql<boolean>`exists (select 1 from bookmarks b where b.content_type = 'news' and b.content_id = ${news.id} and b.user_id = ${ctx.actorId}::uuid)`,
    })
      .from(news)
      .leftJoin(users, eq(users.id, news.authorId))
      .leftJoin(courseCategories, eq(courseCategories.id, news.categoryId))
      .where(and(isNull(news.deletedAt), ...(opts.all ? [] : [eq(news.status, 'published')])))
      .orderBy(desc(news.isPinned), desc(news.publishedAt), desc(news.createdAt))
      .limit(100)

    if (opts.all) return rows
    // Фильтр по аудитории: если задана — только те, кто попадает
    const out = []
    for (const r of rows) {
      if (r.audience) {
        const ids = await resolveAudience(tx, r.audience as Audience)
        if (!ids.has(ctx.actorId)) continue
      }
      out.push(r)
    }
    return out
  })
}

export async function getNews(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [n] = await tx.select().from(news).where(and(eq(news.id, id), isNull(news.deletedAt)))
    if (!n) return null
    await tx.insert(newsViews).values({ tenantId: ctx.tenantId, newsId: id, userId: ctx.actorId }).onConflictDoNothing()
    await countView(tx, ctx, 'news', id, n.title) // views_count: раз на человека в день (Spec 21)
    const [v] = await tx.select().from(newsViews).where(and(eq(newsViews.newsId, id), eq(newsViews.userId, ctx.actorId)))
    const [b] = await tx.select({ id: bookmarks.id }).from(bookmarks).where(and(eq(bookmarks.userId, ctx.actorId), eq(bookmarks.contentType, 'news'), eq(bookmarks.contentId, id)))
    return { ...n, ackedAt: v?.ackedAt ?? null, bookmarked: !!b }
  })
}

/** Прогресс чтения (Б.5): секунды на странице и «долистал до кнопки» — копятся в news_views. */
export async function trackView(ctx: Ctx, id: string, input: { seconds?: number, scrolledToEnd?: boolean }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [v] = await tx.insert(newsViews).values({ tenantId: ctx.tenantId, newsId: id, userId: ctx.actorId, secondsSpent: Math.min(3600, input.seconds ?? 0), scrolledToEnd: input.scrolledToEnd ?? false })
      .onConflictDoUpdate({ target: [newsViews.tenantId, newsViews.newsId, newsViews.userId], set: { secondsSpent: sql`least(3600, ${newsViews.secondsSpent} + ${Math.min(600, input.seconds ?? 0)})`, ...(input.scrolledToEnd ? { scrolledToEnd: true } : {}) } })
      .returning({ secondsSpent: newsViews.secondsSpent, scrolledToEnd: newsViews.scrolledToEnd })
    return v!
  })
}

export type AckResult = { ok: true, ackedAt: Date } | { ok: false, code: 'not_found' | 'too_fast' | 'not_scrolled' }

/** Подтверждение засчитывается только после 10 секунд на странице и прокрутки до кнопки (docs/21 §7.3, Б.5). */
export async function ackNews(ctx: Ctx, id: string, opts: { force?: boolean } = {}): Promise<AckResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [n] = await tx.select({ id: news.id, requiresAck: news.requiresAck }).from(news).where(and(eq(news.id, id), isNull(news.deletedAt)))
    if (!n) return { ok: false as const, code: 'not_found' as const }
    if (n.requiresAck && !opts.force) {
      const [v] = await tx.select({ secondsSpent: newsViews.secondsSpent, scrolledToEnd: newsViews.scrolledToEnd }).from(newsViews).where(and(eq(newsViews.newsId, id), eq(newsViews.userId, ctx.actorId)))
      if ((v?.secondsSpent ?? 0) < 10) return { ok: false as const, code: 'too_fast' as const }
      if (!v?.scrolledToEnd) return { ok: false as const, code: 'not_scrolled' as const }
    }
    const [v] = await tx.insert(newsViews).values({ tenantId: ctx.tenantId, newsId: id, userId: ctx.actorId, ackedAt: new Date() })
      .onConflictDoUpdate({ target: [newsViews.tenantId, newsViews.newsId, newsViews.userId], set: { ackedAt: new Date() } })
      .returning()
    return { ok: true as const, ackedAt: v!.ackedAt! }
  })
}

export interface NewsExtra { lead?: string | null, publishAt?: string | null, unpublishAt?: string | null, commentsEnabled?: boolean, categoryId?: string | null }
const extra = (i: NewsExtra) => ({
  ...(i.lead !== undefined ? { lead: i.lead } : {}), ...(i.publishAt !== undefined ? { publishAt: i.publishAt ? new Date(i.publishAt) : null } : {}), ...(i.unpublishAt !== undefined ? { unpublishAt: i.unpublishAt ? new Date(i.unpublishAt) : null } : {}),
  ...(i.commentsEnabled !== undefined ? { commentsEnabled: i.commentsEnabled } : {}), ...(i.categoryId !== undefined ? { categoryId: i.categoryId } : {}),
})

export async function createNews(ctx: Ctx, input: { title: string, body: ContentBlock[], coverKey?: string, isPinned?: boolean, requiresAck?: boolean, audience?: Audience | null, publish?: boolean } & NewsExtra) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [n] = await tx.insert(news).values({
      tenantId: ctx.tenantId,
      title: input.title,
      body: sanitizeBody(input.body),
      coverKey: input.coverKey ?? null,
      isPinned: input.isPinned ?? false,
      requiresAck: input.requiresAck ?? false,
      audience: input.audience ?? null,
      // Отложенная публикация (docs/21 §3.2): publish_at в будущем → scheduled, publish_scan опубликует
      status: input.publish ? (input.publishAt && new Date(input.publishAt) > new Date() ? 'scheduled' : 'published') : 'draft',
      publishedAt: input.publish && !(input.publishAt && new Date(input.publishAt) > new Date()) ? new Date() : null,
      authorId: ctx.actorId,
      ...extra(input),
    }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'news.create', entity: 'news', entityId: n!.id, after: { title: input.title } })
    return n!
  })
}

export async function updateNews(ctx: Ctx, id: string, input: Partial<{ title: string, body: ContentBlock[], isPinned: boolean, requiresAck: boolean, status: string, audience: Audience | null, coverKey: string | null }> & NewsExtra) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(news).where(and(eq(news.id, id), isNull(news.deletedAt)))
    if (!before) return null
    const publishing = input.status === 'published' && before.status !== 'published'
    const [n] = await tx.update(news).set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: sanitizeBody(input.body) } : {}),
      ...(input.isPinned !== undefined ? { isPinned: input.isPinned } : {}),
      ...(input.requiresAck !== undefined ? { requiresAck: input.requiresAck } : {}),
      ...(input.audience !== undefined ? { audience: input.audience } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.coverKey !== undefined ? { coverKey: input.coverKey } : {}),
      ...(publishing ? { publishedAt: new Date() } : {}),
      ...extra(input),
      updatedAt: new Date(),
    }).where(eq(news.id, id)).returning()
    return n!
  })
}

/** Кто прочитал / подтвердил (для requires_ack). */
export async function newsReaders(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({ userId: newsViews.userId, fullName: users.fullName, viewedAt: newsViews.viewedAt, ackedAt: newsViews.ackedAt })
      .from(newsViews).innerJoin(users, eq(users.id, newsViews.userId))
      .where(eq(newsViews.newsId, id)).orderBy(desc(newsViews.viewedAt))
  })
}

/**
 * Отчёт «Хто ознайомився» по новости с обязательным прочтением (docs/21 §5.3): аудитория против
 * подтвердивших, по точкам. Объявления с подтверждением — `notices.coverage` (Spec 21).
 */
export async function newsAckReport(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [n] = await tx.select().from(news).where(and(eq(news.id, id), isNull(news.deletedAt)))
    if (!n) return null
    const audienceIds = n.audience ? [...await resolveAudience(tx, n.audience as Audience)] : (await tx.select({ id: users.id }).from(users).where(eq(users.status, 'active'))).map(u => u.id)
    if (!audienceIds.length) return { news: n, total: 0, acked: 0, viewed: 0, byLocation: [], notAcked: [], readers: [] }
    const rows = await tx.execute(sql`
      select u.id, u.full_name, l.name as location, v.viewed_at, v.acked_at
      from users u
      left join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null
      left join locations l on l.id = up.location_id
      left join news_views v on v.news_id = ${id}::uuid and v.user_id = u.id
      where u.id in (${sql.join(audienceIds.map(x => sql`${x}::uuid`), sql`, `)})
      order by l.name nulls last, u.full_name
    `) as unknown as { id: string, full_name: string, location: string | null, viewed_at: string | null, acked_at: string | null }[]
    const byLoc = new Map<string, { location: string, total: number, acked: number }>()
    for (const r of rows) {
      const k = r.location ?? '—'
      const e = byLoc.get(k) ?? { location: k, total: 0, acked: 0 }
      e.total++; if (r.acked_at) e.acked++
      byLoc.set(k, e)
    }
    return {
      news: n, total: rows.length, acked: rows.filter(r => r.acked_at).length, viewed: rows.filter(r => r.viewed_at).length,
      byLocation: [...byLoc.values()].map(x => ({ ...x, pct: Math.round(x.acked / x.total * 100) })),
      notAcked: rows.filter(r => !r.acked_at).map(r => ({ id: r.id, fullName: r.full_name, location: r.location, viewedAt: r.viewed_at })),
      readers: rows.filter(r => r.acked_at).map(r => ({ id: r.id, fullName: r.full_name, location: r.location, ackedAt: r.acked_at })),
    }
  })
}

/** Категории новостей (мокап News/NewsForm «Категорія»): справочник course_categories. */
export async function listNewsCategories(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, tx => tx.select({ id: courseCategories.id, name: courseCategories.name }).from(courseCategories).orderBy(courseCategories.sort, courseCategories.name))
}
export async function createNewsCategory(ctx: Ctx, name: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [c] = await tx.insert(courseCategories).values({ tenantId: ctx.tenantId, name }).returning({ id: courseCategories.id, name: courseCategories.name })
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'news.category_create', entity: 'course_category', entityId: c!.id, after: { name } })
    return c!
  })
}

/** news.publish_scan / announcement.activate_scan (docs/21 §11): по расписанию публикует и снимает. */
export async function publishScan(tenantId: string): Promise<{ published: number, unpublished: number }> {
  return withTenant(tenantId, null, async (tx) => {
    const pub = await tx.update(news).set({ status: 'published', publishedAt: new Date(), updatedAt: new Date() })
      .where(and(isNull(news.deletedAt), eq(news.status, 'scheduled'), sql`${news.publishAt} <= now()`)).returning({ id: news.id })
    const unpub = await tx.update(news).set({ status: 'archived', updatedAt: new Date() })
      .where(and(isNull(news.deletedAt), eq(news.status, 'published'), sql`${news.unpublishAt} is not null and ${news.unpublishAt} <= now()`)).returning({ id: news.id })
    return { published: pub.length, unpublished: unpub.length }
  })
}
