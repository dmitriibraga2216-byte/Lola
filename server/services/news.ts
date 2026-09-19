import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { news, newsViews, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'
import { sanitizeBody } from './sanitize'
import { resolveAudience } from './audience'
import type { ContentBlock } from '../../shared/schemas/content'
import type { Audience } from '../../shared/schemas/assignments'

interface Ctx { tenantId: string, actorId: string }

/** Новости (docs/03 §3.22 R1): лента, закрепление, обязательное прочтение, кто прочитал. */

export async function listNews(ctx: Ctx, opts: { all?: boolean } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select({
      id: news.id, title: news.title, coverKey: news.coverKey, isPinned: news.isPinned, requiresAck: news.requiresAck,
      status: news.status, publishedAt: news.publishedAt, authorName: users.fullName, audience: news.audience, body: news.body,
      viewed: sql<boolean>`exists (select 1 from ${newsViews} v where v.news_id = ${news.id} and v.user_id = ${ctx.actorId}::uuid)`,
      acked: sql<boolean>`exists (select 1 from ${newsViews} v where v.news_id = ${news.id} and v.user_id = ${ctx.actorId}::uuid and v.acked_at is not null)`,
      views: sql<number>`(select count(*)::int from ${newsViews} v where v.news_id = ${news.id})`,
      acks: sql<number>`(select count(*)::int from ${newsViews} v where v.news_id = ${news.id} and v.acked_at is not null)`,
    })
      .from(news)
      .leftJoin(users, eq(users.id, news.authorId))
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
    const [v] = await tx.select().from(newsViews).where(and(eq(newsViews.newsId, id), eq(newsViews.userId, ctx.actorId)))
    return { ...n, ackedAt: v?.ackedAt ?? null }
  })
}

export async function ackNews(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [v] = await tx.insert(newsViews).values({ tenantId: ctx.tenantId, newsId: id, userId: ctx.actorId, ackedAt: new Date() })
      .onConflictDoUpdate({ target: [newsViews.tenantId, newsViews.newsId, newsViews.userId], set: { ackedAt: new Date() } })
      .returning()
    return v!
  })
}

export async function createNews(ctx: Ctx, input: { title: string, body: ContentBlock[], coverKey?: string, isPinned?: boolean, requiresAck?: boolean, audience?: Audience | null, publish?: boolean }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [n] = await tx.insert(news).values({
      tenantId: ctx.tenantId,
      title: input.title,
      body: sanitizeBody(input.body),
      coverKey: input.coverKey ?? null,
      isPinned: input.isPinned ?? false,
      requiresAck: input.requiresAck ?? false,
      audience: input.audience ?? null,
      status: input.publish ? 'published' : 'draft',
      publishedAt: input.publish ? new Date() : null,
      authorId: ctx.actorId,
    }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'news.create', entity: 'news', entityId: n!.id, after: { title: input.title } })
    return n!
  })
}

export async function updateNews(ctx: Ctx, id: string, input: Partial<{ title: string, body: ContentBlock[], isPinned: boolean, requiresAck: boolean, status: string, audience: Audience | null }>) {
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
      ...(publishing ? { publishedAt: new Date() } : {}),
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
