import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { news, newsViews, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import { sanitizeBody } from './sanitize'
import { resolveAudience } from './audience'
import type { ContentBlock } from '../../shared/schemas/content'
import type { Audience } from '../../shared/schemas/assignments'

interface Ctx { tenantId: string, actorId: string }

/** Новости (docs/03 §3.22 R1): лента, закрепление, обязательное прочтение, кто прочитал. */

export async function listNews(ctx: Ctx, opts: { all?: boolean } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select({
      id: news.id, title: news.title, coverKey: news.coverKey, isPinned: news.isPinned, requiresAck: news.requiresAck, kind: news.kind, ackDueAt: news.ackDueAt,
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

export async function createNews(ctx: Ctx, input: { title: string, body: ContentBlock[], coverKey?: string, isPinned?: boolean, requiresAck?: boolean, kind?: 'news' | 'announcement', ackDueAt?: string | null, audience?: Audience | null, publish?: boolean }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [n] = await tx.insert(news).values({
      tenantId: ctx.tenantId,
      title: input.title,
      body: sanitizeBody(input.body),
      coverKey: input.coverKey ?? null,
      isPinned: input.isPinned ?? false,
      requiresAck: input.kind === 'announcement' ? true : (input.requiresAck ?? false),
      kind: input.kind ?? 'news',
      ackDueAt: input.ackDueAt ? new Date(input.ackDueAt) : null,
      audience: input.audience ?? null,
      status: input.publish ? 'published' : 'draft',
      publishedAt: input.publish ? new Date() : null,
      authorId: ctx.actorId,
    }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'news.create', entity: 'news', entityId: n!.id, after: { title: input.title } })
    return n!
  })
}

export async function updateNews(ctx: Ctx, id: string, input: Partial<{ title: string, body: ContentBlock[], isPinned: boolean, requiresAck: boolean, status: string, audience: Audience | null, kind: 'news' | 'announcement', ackDueAt: string | null }>) {
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
      ...(input.kind !== undefined ? { kind: input.kind, ...(input.kind === 'announcement' ? { requiresAck: true } : {}) } : {}),
      ...(input.ackDueAt !== undefined ? { ackDueAt: input.ackDueAt ? new Date(input.ackDueAt) : null } : {}),
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

/** Объявления, которые надо показать модально при входе (docs/03 §3.22): опубликованы, требуют подтверждения, не подтверждены, человек в аудитории. */
export async function pendingAnnouncements(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select({ id: news.id, title: news.title, body: news.body, ackDueAt: news.ackDueAt, audience: news.audience, publishedAt: news.publishedAt })
      .from(news)
      .where(and(isNull(news.deletedAt), eq(news.status, 'published'), eq(news.kind, 'announcement'),
        sql`not exists (select 1 from ${newsViews} v where v.news_id = ${news.id} and v.user_id = ${ctx.actorId}::uuid and v.acked_at is not null)`))
      .orderBy(desc(news.publishedAt)).limit(10)
    const out = []
    for (const r of rows) {
      if (r.audience) { const ids = await resolveAudience(tx, r.audience as Audience); if (!ids.has(ctx.actorId)) continue }
      out.push(r)
    }
    return out
  })
}

/** Отчёт по объявлению: аудитория против прочитавших, по точкам (приёмка этапа 10: «доходит до 100% смены, видно кто прочитал»). */
export async function announcementReport(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [n] = await tx.select().from(news).where(and(eq(news.id, id), isNull(news.deletedAt)))
    if (!n) return null
    const audienceIds = n.audience ? [...await resolveAudience(tx, n.audience as Audience)] : (await tx.select({ id: users.id }).from(users).where(eq(users.status, 'active'))).map(u => u.id)
    if (!audienceIds.length) return { news: n, total: 0, acked: 0, viewed: 0, byLocation: [], notAcked: [] }
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

/** Ежедневно: непрочитанные объявления → напоминание человеку; просроченные — руководителю точки список. */
export async function announcementScan(tenantId: string): Promise<{ reminded: number, escalated: number }> {
  const out = { reminded: 0, escalated: 0 }
  const items = await withTenant(tenantId, null, tx => tx.select({ id: news.id, title: news.title, ackDueAt: news.ackDueAt }).from(news).where(and(isNull(news.deletedAt), eq(news.status, 'published'), eq(news.kind, 'announcement'))))
  const day = new Date().toISOString().slice(0, 10)
  for (const n of items) {
    const rep = await announcementReport({ tenantId, actorId: null as unknown as string }, n.id)
    if (!rep || !rep.notAcked.length) continue
    await withTenant(tenantId, null, async (tx) => {
      for (const u of rep.notAcked) {
        if (await enqueueNotification(tx, { tenantId, userId: u.id, code: 'announcement_reminder', payload: { title: n.title, due: n.ackDueAt?.toISOString() ?? '' }, dedupKey: `ann_rem:${n.id}:${u.id}:${day}` })) out.reminded++
      }
      if (n.ackDueAt && n.ackDueAt.getTime() < Date.now()) {
        const mgrs = await tx.execute(sql`select distinct l.manager_id, l.name from users u join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null join locations l on l.id = up.location_id where l.manager_id is not null and u.id in (${sql.join(rep.notAcked.map(x => sql`${x.id}::uuid`), sql`, `)})`) as unknown as { manager_id: string, name: string }[]
        for (const m of mgrs) {
          const names = rep.notAcked.filter(x => x.location === m.name).map(x => x.fullName).join(', ')
          if (await enqueueNotification(tx, { tenantId, userId: m.manager_id, code: 'announcement_overdue_manager', payload: { title: n.title, names }, dedupKey: `ann_over:${n.id}:${m.manager_id}:${day}` })) out.escalated++
        }
      }
    })
  }
  return out
}
