import { and, desc, eq, isNull, lt } from 'drizzle-orm'
import {
  comments, courses, locations, notices, programs, quizzes, resources, roles, userPlacements, userRoles, users,
} from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import type { CommentSourceType } from '../../shared/schemas/catalog'

interface Ctx { tenantId: string, actorId: string }

/**
 * Єдина стрічка коментарів (docs/02, docs/10 §14.2): комментарий — канал контролю якості
 * контенту (розбіжність матеріалу з практикою, прохання про повторну спробу), а не «балачка».
 * Маршрутизація [решение]: автору матеріалу; немає автора — керівнику точки автора коментаря;
 * немає й керівника — будь-якому адміністратору тенанта. Інакше скарга нікуди не доходить.
 */
async function contentAuthor(tx: TenantTx, sourceType: CommentSourceType, sourceId: string): Promise<string | null> {
  switch (sourceType) {
    case 'course': {
      const [c] = await tx.select({ createdBy: courses.createdBy }).from(courses).where(eq(courses.id, sourceId))
      return c?.createdBy ?? null
    }
    case 'program': {
      const [p] = await tx.select({ authorIds: programs.authorIds }).from(programs).where(eq(programs.id, sourceId))
      return p?.authorIds?.[0] ?? null
    }
    case 'knowledge': {
      const [r] = await tx.select({ authorIds: resources.authorIds }).from(resources).where(eq(resources.id, sourceId))
      return r?.authorIds?.[0] ?? null
    }
    case 'notice': {
      const [n] = await tx.select({ authorId: notices.authorId }).from(notices).where(eq(notices.id, sourceId))
      return n?.authorId ?? null
    }
    case 'task': {
      // sourceId — тест/завдання всередині курсу (мокап Comments: «Завдання: …»); автор — хто створив тест.
      const [q] = await tx.select({ authorIds: quizzes.authorIds }).from(quizzes).where(eq(quizzes.id, sourceId))
      return q?.authorIds?.[0] ?? null
    }
    default:
      return null
  }
}

async function managerOf(tx: TenantTx, userId: string): Promise<string | null> {
  const [row] = await tx.select({ managerId: locations.managerId }).from(userPlacements)
    .innerJoin(locations, eq(locations.id, userPlacements.locationId))
    .where(and(eq(userPlacements.userId, userId), eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt)))
  return row?.managerId ?? null
}

async function anyAdmin(tx: TenantTx, tenantId: string): Promise<string | null> {
  const [row] = await tx.select({ userId: userRoles.userId }).from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(roles.tenantId, tenantId), eq(roles.code, 'admin')))
    .limit(1)
  return row?.userId ?? null
}

async function resolveRouting(tx: TenantTx, ctx: Ctx, sourceType: CommentSourceType, sourceId: string): Promise<string | null> {
  const author = await contentAuthor(tx, sourceType, sourceId)
  if (author && author !== ctx.actorId) return author
  const manager = await managerOf(tx, ctx.actorId)
  if (manager && manager !== ctx.actorId) return manager
  const admin = await anyAdmin(tx, ctx.tenantId)
  return admin && admin !== ctx.actorId ? admin : null
}

async function sourceTitle(tx: TenantTx, sourceType: CommentSourceType, sourceId: string): Promise<string | null> {
  switch (sourceType) {
    case 'course': return (await tx.select({ title: courses.title }).from(courses).where(eq(courses.id, sourceId)))[0]?.title ?? null
    case 'program': return (await tx.select({ title: programs.title }).from(programs).where(eq(programs.id, sourceId)))[0]?.title ?? null
    case 'knowledge': return null // заголовок береться з поточної версії ресурсу на клієнті
    case 'notice': return (await tx.select({ title: notices.title }).from(notices).where(eq(notices.id, sourceId)))[0]?.title ?? null
    case 'task': return (await tx.select({ title: quizzes.title }).from(quizzes).where(eq(quizzes.id, sourceId)))[0]?.title ?? null
    default: return null
  }
}

/** Новий коментар (докс/10 §14.2): маршрутизація рахується сервером одразу при створенні. */
export async function createComment(ctx: Ctx, input: { sourceType: CommentSourceType, sourceId: string, body: string }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const routedTo = await resolveRouting(tx, ctx, input.sourceType, input.sourceId)
    const [row] = await tx.insert(comments).values({
      tenantId: ctx.tenantId,
      authorId: ctx.actorId,
      body: input.body,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      routedTo,
    }).returning()

    if (routedTo) {
      const title = await sourceTitle(tx, input.sourceType, input.sourceId)
      await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: routedTo, code: 'comment_routed', payload: { title, sourceType: input.sourceType }, dedupKey: `comment_routed:${row!.id}`, refType: 'comment', refId: row!.id })
    }
    return row!
  })
}

/** Стрічка для адміну/автора (мокап Comments): фільтри — джерело, стан прочитання. */
export async function listComments(ctx: Ctx, filter: { sourceType?: CommentSourceType, isRead?: 'read' | 'unread', cursor?: string, limit: number }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select({
      id: comments.id,
      body: comments.body,
      sourceType: comments.sourceType,
      sourceId: comments.sourceId,
      isRead: comments.isRead,
      routedTo: comments.routedTo,
      replyToId: comments.replyToId,
      createdAt: comments.createdAt,
      authorId: comments.authorId,
      authorName: users.fullName,
    })
      .from(comments)
      .innerJoin(users, eq(users.id, comments.authorId))
      .where(and(
        isNull(comments.replyToId), // відповіді показуються всередині картки, не окремим рядком
        ...(filter.sourceType ? [eq(comments.sourceType, filter.sourceType)] : []),
        ...(filter.isRead === 'read' ? [eq(comments.isRead, true)] : []),
        ...(filter.isRead === 'unread' ? [eq(comments.isRead, false)] : []),
        ...(filter.cursor ? [lt(comments.createdAt, new Date(filter.cursor))] : []),
      ))
      .orderBy(desc(comments.createdAt))
      .limit(filter.limit)

    const titles = new Map<string, string | null>()
    for (const r of rows) {
      const key = `${r.sourceType}:${r.sourceId}`
      if (!titles.has(key)) titles.set(key, await sourceTitle(tx, r.sourceType as CommentSourceType, r.sourceId))
    }
    return rows.map(r => ({ ...r, sourceTitle: titles.get(`${r.sourceType}:${r.sourceId}`) ?? null }))
  })
}

/** Позначити прочитаним (мокап Comments, колонка «Прочитані»). */
export async function markCommentRead(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await tx.update(comments).set({ isRead: true, readBy: ctx.actorId, readAt: new Date(), updatedAt: new Date() })
      .where(eq(comments.id, id)).returning({ id: comments.id })
    return !!row
  })
}

export type ReplyResult = { ok: true, id: string } | { ok: false, code: 'not_found' }

/** Відповідь прямо зі стрічки (docs/10 §14.2 — наше рішення, якого нема в еталоні). */
export async function replyToComment(ctx: Ctx, id: string, body: string): Promise<ReplyResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [parent] = await tx.select().from(comments).where(eq(comments.id, id))
    if (!parent) return { ok: false as const, code: 'not_found' as const }

    const [row] = await tx.insert(comments).values({
      tenantId: ctx.tenantId,
      authorId: ctx.actorId,
      body,
      sourceType: parent.sourceType,
      sourceId: parent.sourceId,
      routedTo: parent.authorId,
      replyToId: parent.id,
    }).returning({ id: comments.id })

    await tx.update(comments).set({ isRead: true, readBy: ctx.actorId, readAt: new Date(), updatedAt: new Date() }).where(and(eq(comments.id, id), eq(comments.isRead, false)))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'comment.reply', entity: 'comment', entityId: id, after: { replyId: row!.id } })
    if (parent.authorId !== ctx.actorId) {
      await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: parent.authorId, code: 'comment_replied', payload: { body }, dedupKey: `comment_replied:${row!.id}`, refType: 'comment', refId: row!.id })
    }
    return { ok: true as const, id: row!.id }
  })
}
