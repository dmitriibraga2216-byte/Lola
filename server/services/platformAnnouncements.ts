import { desc, eq, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { platformAnnouncementReads, platformAnnouncements, plans } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { AnnouncementCreate, AnnouncementPatch } from '../../shared/schemas/platformAnnouncements'
import { platformDb, type PlatformAuth } from './platform'
import { recordPlatformAudit } from './platformTenants'

/**
 * Объявления платформы (docs/v2/39 П-21, П-24.2; docs/24 §4.7) — **вторая «новость»**, не
 * корпоративная лента тенанта. Разведены полностью, и это условие выхода PR-39:
 *
 * | | новости компании (`news`, docs/21 §3.2) | объявления платформы (здесь) |
 * |---|---|---|
 * | пишет | администратор тенанта | оператор платформы |
 * | видит | сотрудники тенанта по аудитории | все тенанты по адресации, только чтение |
 * | таблица | тенантная под RLS | платформенная, без `tenant_id` |
 * | ручки | `/news` | `/platform/announcements` (оператор), `/platform-announcements` (тенант) |
 *
 * Этот модуль — **единственный**, кто читает `platform_announcements` (сквозная проверка 12):
 * лента новостей тенанта к ней не обращается, а объявление не попадает в `news`. Запись —
 * только ролью `platform_admin`: у `app_user` в миграции отозваны `insert/update/delete`.
 */

interface Ctx { tenantId: string, actorId: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── Оператор платформы ─────────────────────────────────────────────────────────────────

export interface OperatorAnnouncement {
  id: string
  title: string
  body: string
  audience: string
  planCodes: string[]
  tenantIds: string[]
  publishedAt: Date | null
  archivedAt: Date | null
  createdAt: Date
  readers: number
}

/** Список для панели оператора: черновики, опубликованные и снятые; сколько человек прочитали. */
export async function listForOperator(): Promise<OperatorAnnouncement[]> {
  const db = platformDb()
  const rows = await db.select({
    id: platformAnnouncements.id, title: platformAnnouncements.title, body: platformAnnouncements.body,
    audience: platformAnnouncements.audience, planCodes: platformAnnouncements.planCodes, tenantIds: platformAnnouncements.tenantIds,
    publishedAt: platformAnnouncements.publishedAt, archivedAt: platformAnnouncements.archivedAt, createdAt: platformAnnouncements.createdAt,
    // Роль platform_admin обходит RLS — счёт прочтений по всем тенантам, без имён
    readers: sql<number>`(select count(*)::int from platform_announcement_reads r where r.announcement_id = ${platformAnnouncements.id})`,
  }).from(platformAnnouncements).orderBy(desc(platformAnnouncements.createdAt)).limit(200)
  return rows
}

export type AnnouncementError = 'not_found' | 'unknown_plan' | 'archived'

/** Тарифы адресации — только существующие коды `plans` (опечатка оператора не должна тихо сделать объявление «никому»). */
async function unknownPlans(codes: string[]): Promise<boolean> {
  if (!codes.length) return false
  const rows = await platformDb().select({ code: plans.code }).from(plans)
  const known = new Set(rows.map(r => r.code))
  return codes.some(c => !known.has(c))
}

export async function createAnnouncement(op: PlatformAuth, input: AnnouncementCreate): Promise<{ ok: true, id: string } | { ok: false, code: AnnouncementError }> {
  if (await unknownPlans(input.planCodes)) return { ok: false, code: 'unknown_plan' }
  const [row] = await platformDb().insert(platformAnnouncements).values({
    title: input.title, body: input.body, audience: input.audience, planCodes: input.planCodes, tenantIds: input.tenantIds,
    publishedAt: input.publish ? new Date() : null, createdBy: op.adminId,
  }).returning({ id: platformAnnouncements.id })
  await recordPlatformAudit(op, { action: 'announcement.create', entity: 'platform_announcement', entityId: row!.id, after: { title: input.title, audience: input.audience, published: input.publish } })
  return { ok: true, id: row!.id }
}

export async function updateAnnouncement(op: PlatformAuth, id: string, patch: AnnouncementPatch): Promise<{ ok: true } | { ok: false, code: AnnouncementError }> {
  if (!UUID_RE.test(id)) return { ok: false, code: 'not_found' }
  const db = platformDb()
  const [cur] = await db.select().from(platformAnnouncements).where(eq(platformAnnouncements.id, id))
  if (!cur) return { ok: false, code: 'not_found' }
  if (cur.archivedAt) return { ok: false, code: 'archived' }
  if (patch.planCodes && await unknownPlans(patch.planCodes)) return { ok: false, code: 'unknown_plan' }
  const set: Partial<typeof platformAnnouncements.$inferInsert> = { updatedAt: new Date() }
  if (patch.title !== undefined) set.title = patch.title
  if (patch.body !== undefined) set.body = patch.body
  if (patch.audience !== undefined) {
    set.audience = patch.audience
    set.planCodes = patch.planCodes ?? []
    set.tenantIds = patch.tenantIds ?? []
  }
  await db.update(platformAnnouncements).set(set).where(eq(platformAnnouncements.id, id))
  await recordPlatformAudit(op, { action: 'announcement.update', entity: 'platform_announcement', entityId: id, before: { title: cur.title, audience: cur.audience }, after: patch })
  return { ok: true }
}

/** Публикация черновика; повторная — без изменений (дата первой публикации сохраняется). */
export async function publishAnnouncement(op: PlatformAuth, id: string): Promise<{ ok: true } | { ok: false, code: AnnouncementError }> {
  if (!UUID_RE.test(id)) return { ok: false, code: 'not_found' }
  const db = platformDb()
  const [cur] = await db.select({ publishedAt: platformAnnouncements.publishedAt, archivedAt: platformAnnouncements.archivedAt }).from(platformAnnouncements).where(eq(platformAnnouncements.id, id))
  if (!cur) return { ok: false, code: 'not_found' }
  if (cur.archivedAt) return { ok: false, code: 'archived' }
  if (!cur.publishedAt) {
    await db.update(platformAnnouncements).set({ publishedAt: new Date(), updatedAt: new Date() }).where(eq(platformAnnouncements.id, id))
    await recordPlatformAudit(op, { action: 'announcement.publish', entity: 'platform_announcement', entityId: id })
  }
  return { ok: true }
}

/** Снять с ленты: строка остаётся (история и счёт прочтений), тенанты её больше не видят. */
export async function archiveAnnouncement(op: PlatformAuth, id: string): Promise<{ ok: true } | { ok: false, code: AnnouncementError }> {
  if (!UUID_RE.test(id)) return { ok: false, code: 'not_found' }
  const db = platformDb()
  const [cur] = await db.select({ publishedAt: platformAnnouncements.publishedAt, archivedAt: platformAnnouncements.archivedAt }).from(platformAnnouncements).where(eq(platformAnnouncements.id, id))
  if (!cur) return { ok: false, code: 'not_found' }
  if (cur.archivedAt) return { ok: true }
  // Черновик снимать нечего — его просто публикуют позже или правят; CHECK запрещает архив без публикации
  await db.update(platformAnnouncements).set({ archivedAt: new Date(), publishedAt: cur.publishedAt ?? new Date(), updatedAt: new Date() }).where(eq(platformAnnouncements.id, id))
  await recordPlatformAudit(op, { action: 'announcement.archive', entity: 'platform_announcement', entityId: id })
  return { ok: true }
}

// ── Тенант: лента только для чтения ─────────────────────────────────────────────────────

/**
 * Адресовано ли объявление тенанту — **единственное** место этого правила. Тенант не видит ни
 * чужой адресации, ни списков тарифов и тенантов: наружу уходят только текст и даты.
 */
function addressedTo(tenantId: string): SQL {
  return sql`${platformAnnouncements.publishedAt} is not null and ${platformAnnouncements.publishedAt} <= now() and ${platformAnnouncements.archivedAt} is null
    and (
      ${platformAnnouncements.audience} = 'all'
      or (${platformAnnouncements.audience} = 'tenants' and ${tenantId}::uuid = any(${platformAnnouncements.tenantIds}))
      or (${platformAnnouncements.audience} = 'plans' and (select t.plan from tenants t where t.id = ${tenantId}::uuid) = any(${platformAnnouncements.planCodes}))
    )`
}

export interface FeedItem { id: string, title: string, body: string, publishedAt: Date, read: boolean }

/** `GET /platform-announcements`: лента тенанта (последние 50) и число непрочитанных человеком. */
export async function tenantFeed(ctx: Ctx): Promise<{ items: FeedItem[], unread: number }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select({
      id: platformAnnouncements.id, title: platformAnnouncements.title, body: platformAnnouncements.body, publishedAt: platformAnnouncements.publishedAt,
      // Отметки под RLS тенанта: видны только свои
      read: sql<boolean>`exists (select 1 from platform_announcement_reads r where r.announcement_id = ${platformAnnouncements.id} and r.user_id = ${ctx.actorId}::uuid)`,
    }).from(platformAnnouncements).where(addressedTo(ctx.tenantId)).orderBy(desc(platformAnnouncements.publishedAt)).limit(50)
    const items = rows.map(r => ({ ...r, publishedAt: r.publishedAt! }))
    return { items, unread: items.filter(i => !i.read).length }
  })
}

/**
 * `POST /platform-announcements/:id/read`. Не адресованное этому тенанту (чужое, черновик,
 * снятое) — `not_found`, как чужой ресурс (CLAUDE.md п. 15): существование не подтверждается.
 */
export async function markRead(ctx: Ctx, id: string): Promise<'ok' | 'not_found'> {
  if (!UUID_RE.test(id)) return 'not_found'
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [a] = await tx.select({ id: platformAnnouncements.id }).from(platformAnnouncements)
      .where(sql`${platformAnnouncements.id} = ${id}::uuid and ${addressedTo(ctx.tenantId)}`)
    if (!a) return 'not_found'
    await tx.insert(platformAnnouncementReads).values({ tenantId: ctx.tenantId, announcementId: id, userId: ctx.actorId }).onConflictDoNothing()
    return 'ok'
  })
}
