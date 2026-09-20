import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { bookmarks, locations, meetupRegistrations, meetups, tenants } from '../db/schema'
import type { TenantTx } from '../utils/withTenant'
import { withTenant } from '../utils/withTenant'
import { db } from '../db/client'
import { recordAudit } from './audit'
import { createMeetup, register, updateMeetup } from './meetups'
import { resolveAudience } from './audience'
import { sanitizeBody } from './sanitize'
import type { Audience } from '../../shared/schemas/assignments'
import type { ContentBlock } from '../../shared/schemas/content'
import type { BookmarkType, EventInput, GuestBlocks } from '../../shared/schemas/hub'
import { guestBlocksSchema } from '../../shared/schemas/hub'

interface Ctx { tenantId: string, actorId: string }

// ── Закладки (docs/21 §14.1 «Мої закладки», docs/04 §4.13) ─────────────────────────────

/** Поставить/снять закладку — переключатель; чужой тенант/несуществующее — not_found (404). */
export async function toggleBookmark(ctx: Ctx, contentType: BookmarkType, contentId: string): Promise<{ ok: true, bookmarked: boolean } | { ok: false, code: 'not_found' }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const table = contentType === 'resource' ? sql`resources` : contentType === 'article' ? sql`knowledge_articles` : contentType === 'news' ? sql`news` : sql`notices`
    const [exists] = await tx.execute(sql`select 1 from ${table} where id = ${contentId}::uuid and deleted_at is null`) as unknown as unknown[]
    if (!exists) return { ok: false as const, code: 'not_found' as const }
    const [cur] = await tx.select({ id: bookmarks.id }).from(bookmarks).where(and(eq(bookmarks.userId, ctx.actorId), eq(bookmarks.contentType, contentType), eq(bookmarks.contentId, contentId)))
    if (cur) {
      await tx.delete(bookmarks).where(eq(bookmarks.id, cur.id))
      return { ok: true as const, bookmarked: false }
    }
    await tx.insert(bookmarks).values({ tenantId: ctx.tenantId, userId: ctx.actorId, contentType, contentId }).onConflictDoNothing()
    return { ok: true as const, bookmarked: true }
  })
}

/** Мои закладки с названиями — для левой колонки базы знаний. */
export async function listBookmarks(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.execute(sql`
      select b.content_type, b.content_id, b.created_at,
        coalesce(r.title, a.title, n.title, o.title) as title, a.slug
      from bookmarks b
      left join resources r on b.content_type = 'resource' and r.id = b.content_id and r.deleted_at is null
      left join knowledge_articles a on b.content_type = 'article' and a.id = b.content_id and a.deleted_at is null
      left join news n on b.content_type = 'news' and n.id = b.content_id and n.deleted_at is null
      left join notices o on b.content_type = 'notice' and o.id = b.content_id and o.deleted_at is null
      where b.user_id = ${ctx.actorId}::uuid
      order by b.created_at desc limit 200`) as unknown as { content_type: BookmarkType, content_id: string, created_at: string, title: string | null, slug: string | null }[]
    return rows.filter(r => r.title).map(r => ({ contentType: r.content_type, contentId: r.content_id, title: r.title!, slug: r.slug, createdAt: r.created_at }))
  })
}

/** Ключи закладок человека — чтобы пометить результаты поиска. */
export async function bookmarkKeys(tx: TenantTx, userId: string): Promise<Set<string>> {
  const rows = await tx.select({ contentType: bookmarks.contentType, contentId: bookmarks.contentId }).from(bookmarks).where(eq(bookmarks.userId, userId))
  return new Set(rows.map(r => `${r.contentType}:${r.contentId}`))
}

// ── События (docs/21 §3.4, §14.6; мокап Events) — над meetups(kind=event) ──────────────

const eventAudience = (locationIds?: string[]): Audience | null => locationIds?.length ? { rules: [{ type: 'location', ids: locationIds }], match: 'any' } : null

/** Список для админки: Назва · Коли · Де · Запрошено · Опубліковано. */
export async function listEvents(ctx: Ctx, opts: { upcomingOnly?: boolean } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select({
      id: meetups.id, title: meetups.title, startsAt: meetups.startsAt, endsAt: meetups.endsAt, status: meetups.status, locationId: meetups.locationId, address: meetups.address, room: meetups.room,
      capacity: meetups.capacity, registrationRequired: meetups.registrationRequired, audience: meetups.audience, coverKey: meetups.coverKey, createdAt: meetups.createdAt, locationName: locations.name,
      registered: sql<number>`(select count(*)::int from ${meetupRegistrations} r where r.meetup_id = ${meetups.id} and r.status in ('registered', 'attended'))`,
      mine: sql<boolean>`exists (select 1 from ${meetupRegistrations} r where r.meetup_id = ${meetups.id} and r.user_id = ${ctx.actorId}::uuid and r.status in ('registered', 'attended'))`,
    }).from(meetups).leftJoin(locations, eq(locations.id, meetups.locationId))
      .where(and(eq(meetups.kind, 'event'), ...(opts.upcomingOnly ? [inArray(meetups.status, ['planned', 'ongoing']), sql`${meetups.endsAt} > now()`] : [])))
      .orderBy(opts.upcomingOnly ? asc(meetups.startsAt) : desc(meetups.startsAt)).limit(200)
    const out = []
    for (const r of rows) {
      const invited = r.audience
        ? (await resolveAudience(tx, r.audience as Audience)).size
        : ((await tx.execute(sql`select count(*)::int as n from users where status = 'active'`)) as unknown as { n: number }[])[0]?.n ?? 0
      out.push({ ...r, invited, published: r.status !== 'draft' })
    }
    return out
  })
}

/** Афиша для кабинета: только события, куда человек запрошен (аудитория) и которые ещё не прошли. */
export async function listEventsForUser(ctx: Ctx) {
  const all = await listEvents(ctx, { upcomingOnly: true })
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const out = []
    for (const e of all) {
      if (e.audience && !(await resolveAudience(tx, e.audience as Audience)).has(ctx.actorId)) continue
      out.push(e)
    }
    return out
  })
}

/** Создание события: организатор — автор (trainer_ids), регистрация по флагу, «Усі точки» = location null. */
export async function createEvent(ctx: Ctx, input: EventInput) {
  const endsAt = input.endsAt ?? new Date(new Date(input.startsAt).getTime() + 2 * 3_600_000).toISOString()
  const m = await createMeetup(ctx, {
    kind: 'event', title: input.title, description: input.description ? sanitizeBody(input.description as ContentBlock[]) : [],
    startsAt: input.startsAt, endsAt, locationId: input.locationId ?? null, address: input.address ?? null,
    trainerIds: [ctx.actorId], capacity: input.capacity ?? null, waitlistEnabled: false, enrollDeadlineHours: 0,
    attendanceMode: 'manual', requiresFeedback: false, coverKey: input.coverKey ?? null,
    registrationRequired: input.registrationRequired ?? false, status: input.publish === false ? 'draft' : 'planned',
  })
  await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    await tx.update(meetups).set({ audience: eventAudience(input.audienceLocationIds) }).where(eq(meetups.id, m.id))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'event.create', entity: 'meetup', entityId: m.id, after: { title: input.title, startsAt: input.startsAt } })
  })
  return { ...m, audience: eventAudience(input.audienceLocationIds) }
}

export async function updateEvent(ctx: Ctx, id: string, input: Partial<EventInput>) {
  const m = await updateMeetup(ctx, id, {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.description !== undefined ? { description: sanitizeBody(input.description as ContentBlock[]) } : {}),
    ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
    ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
    ...(input.locationId !== undefined ? { locationId: input.locationId } : {}),
    ...(input.address !== undefined ? { address: input.address } : {}),
    ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
    ...(input.registrationRequired !== undefined ? { registrationRequired: input.registrationRequired } : {}),
    ...(input.coverKey !== undefined ? { coverKey: input.coverKey } : {}),
    ...(input.publish !== undefined ? { status: input.publish ? 'planned' : 'draft' } : {}),
  })
  if (!m) return null
  if (input.audienceLocationIds !== undefined) {
    await withTenant(ctx.tenantId, ctx.actorId, tx => tx.update(meetups).set({ audience: eventAudience(input.audienceLocationIds) }).where(and(eq(meetups.id, id), eq(meetups.kind, 'event'))))
  }
  return m
}

/** `POST /events/:id/register` — запись на событие с гостями (docs/21 §3.4); только если человек запрошен. */
export async function registerForEvent(ctx: Ctx, id: string, guestsCount = 0) {
  const allowed = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [m] = await tx.select({ audience: meetups.audience, registrationRequired: meetups.registrationRequired }).from(meetups).where(and(eq(meetups.id, id), eq(meetups.kind, 'event')))
    if (!m) return 'not_found' as const
    if (m.audience && !(await resolveAudience(tx, m.audience as Audience)).has(ctx.actorId)) return 'not_found' as const
    return 'ok' as const
  })
  if (allowed !== 'ok') return { ok: false as const, code: 'not_found' as const }
  return register(ctx, id, ctx.actorId, { guestsCount })
}

// ── Гостевая страница (docs/21 Г-21.3, docs/24 §3.1 guest_page_block, docs/25 §4) ──────

/** Три блока в tenants.settings.guestPage; читается публично по slug — только эти поля. */
export async function getGuestBlocks(ctx: Ctx): Promise<GuestBlocks> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [t] = await tx.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, ctx.tenantId))
    return guestBlocksSchema.parse(((t?.settings ?? {}) as { guestPage?: unknown }).guestPage ?? {})
  })
}

export async function setGuestBlocks(ctx: Ctx, input: GuestBlocks): Promise<GuestBlocks> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const before = await getGuestBlocks(ctx)
    const next: GuestBlocks = { ...input, welcome: sanitizeBody(input.welcome as ContentBlock[]) as GuestBlocks['welcome'] }
    await tx.execute(sql`update tenants set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{guestPage}', ${JSON.stringify(next)}::jsonb) where id = ${ctx.tenantId}::uuid`)
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'settings.guest_page', entity: 'tenant', entityId: ctx.tenantId, before, after: next })
    return next
  })
}

/**
 * Что видит гость до входа (docs/21 §14.6, Г-21.3; docs/25 §4 «отдаёт только то, что явно помечено публичным»):
 * название пространства и три гостевых блока. Тенант — по поддомену Host (docs/25 §16.1) или `?slug=` (dev);
 * неизвестный slug — null → 404, список клиентов перебором не узнать.
 */
export async function guestPage(slug: string): Promise<{ name: string, slug: string, blocks: GuestBlocks } | null> {
  if (!/^[a-z0-9-]{3,40}$/.test(slug)) return null
  const [t] = await db.select({ name: tenants.name, slug: tenants.slug, settings: tenants.settings, status: tenants.status }).from(tenants).where(eq(tenants.slug, slug))
  if (!t || t.status === 'suspended') return null
  const blocks = guestBlocksSchema.parse(((t.settings ?? {}) as { guestPage?: unknown }).guestPage ?? {})
  return { name: t.name, slug: t.slug, blocks }
}

/** Slug тенанта из Host (`<slug>.lola.app`) — поддомен первого уровня; localhost/IP — нет. */
export function slugFromHost(host: string | undefined): string | null {
  if (!host) return null
  const h = host.split(':')[0]!.toLowerCase()
  if (/^(localhost|\d+\.\d+\.\d+\.\d+)$/.test(h)) return null
  const parts = h.split('.')
  if (parts.length < 3) return null
  const slug = parts[0]!
  return /^[a-z0-9-]{3,40}$/.test(slug) && slug !== 'www' && slug !== 'app' ? slug : null
}
