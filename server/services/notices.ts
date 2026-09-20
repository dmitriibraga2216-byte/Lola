import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { assignments, noticeAcks, notices, simpleNotices, users } from '../db/schema'
import type { TenantTx } from '../utils/withTenant'
import { withTenant } from '../utils/withTenant'
import { currentRequestContext } from '../utils/requestContext'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import { sanitizeBody } from './sanitize'
import { resolveAudience } from './audience'
import { logTaskAccess } from './journals'
import { emitWebhook } from './webhooks'
import type { ContentBlock } from '../../shared/schemas/content'
import type { Audience } from '../../shared/schemas/assignments'
import type { NoticeInput, SimpleNoticeInput } from '../../shared/schemas/hub'

interface Ctx { tenantId: string, actorId: string }

/**
 * Объявления (docs/21 §14.5, docs/02 «Корпоративный хаб»): назначаемая сущность, а не лента.
 * Контент типа `notice` назначается через `assignments` — там аудитория, срок подтверждения
 * (`due_at`), напоминания и режим назначения (CLAUDE.md п. 11). Здесь — карточка, охват,
 * подтверждение «Ознайомлений» (= прохождение) и «Нагадати тим, хто не підтвердив».
 */

const day = () => new Date().toISOString().slice(0, 10)

/** Активные назначения объявления: аудитория и ближайший срок. */
async function noticeAssignments(tx: TenantTx, noticeId: string) {
  return tx.select({ id: assignments.id, audience: assignments.audience, exclude: assignments.exclude, dueAt: assignments.dueAt, dueMode: assignments.dueMode, dueDays: assignments.dueDays, startsAt: assignments.startsAt, createdAt: assignments.createdAt, status: assignments.status })
    .from(assignments).where(and(eq(assignments.subjectType, 'notice'), eq(assignments.subjectId, noticeId), inArray(assignments.status, ['active', 'paused'])))
}

/** Кому объявление назначено: объединение аудиторий активных назначений (docs/15 §7.1 — «призначено» = раскрытая аудитория). */
export async function noticeAudience(tx: TenantTx, noticeId: string): Promise<{ userIds: Set<string>, dueAt: Date | null }> {
  const rows = await noticeAssignments(tx, noticeId)
  const userIds = new Set<string>()
  let dueAt: Date | null = null
  for (const a of rows) {
    if (a.status !== 'active') continue
    const ids = await resolveAudience(tx, a.audience as Audience, a.exclude as Audience)
    for (const id of ids) userIds.add(id)
    const due = a.dueMode === 'absolute' ? a.dueAt : a.dueMode === 'relative' && a.dueDays ? new Date((a.startsAt ?? a.createdAt).getTime() + a.dueDays * 86_400_000) : null
    if (due && (!dueAt || due < dueAt)) dueAt = due
  }
  return { userIds, dueAt }
}

/** Признак периода показа (docs/32 В.4: scheduled/active/expired — признаки, не статусы). */
export function noticePhase(n: { status: string, startsAt: Date | null, endsAt: Date | null }): 'draft' | 'scheduled' | 'active' | 'expired' | 'archived' {
  if (n.status === 'draft') return 'draft'
  if (n.status === 'archived') return 'archived'
  const now = Date.now()
  if (n.startsAt && n.startsAt.getTime() > now) return 'scheduled'
  if (n.endsAt && n.endsAt.getTime() < now) return 'expired'
  return 'active'
}

/** Список для админки (мокап Notices): тип, режим призначення, «Ознайомились N із M». */
export async function listNotices(ctx: Ctx, opts: { status?: string } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select({
      id: notices.id, title: notices.title, kind: notices.kind, startsAt: notices.startsAt, endsAt: notices.endsAt, status: notices.status, publishedAt: notices.publishedAt, createdAt: notices.createdAt,
      priority: notices.priority, showMode: notices.showMode, blockUntilAck: notices.blockUntilAck, viewsCount: notices.viewsCount, authorName: users.fullName,
      acks: sql<number>`(select count(*)::int from ${noticeAcks} a where a.notice_id = ${notices.id})`,
      assignMode: sql<string | null>`(select case when bool_or(x.automation_rule_id is not null) then 'automation' when bool_or(x.via_catalog) then 'catalog_free' else 'manual' end from ${assignments} x where x.subject_type = 'notice' and x.subject_id = ${notices.id} and x.status in ('active', 'paused'))`,
    })
      .from(notices).leftJoin(users, eq(users.id, notices.authorId))
      .where(and(isNull(notices.deletedAt), ...(opts.status ? [eq(notices.status, opts.status)] : [])))
      .orderBy(desc(notices.createdAt)).limit(200)
    const out = []
    for (const r of rows) {
      const { userIds } = await noticeAudience(tx, r.id)
      out.push({ ...r, total: userIds.size, phase: noticePhase(r) })
    }
    return out
  })
}

export async function getNotice(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [n] = await tx.select().from(notices).where(and(eq(notices.id, id), isNull(notices.deletedAt)))
    if (!n) return null
    const [author] = n.authorId ? await tx.select({ fullName: users.fullName }).from(users).where(eq(users.id, n.authorId)) : []
    return { ...n, authorName: author?.fullName ?? null, phase: noticePhase(n) }
  })
}

export async function createNotice(ctx: Ctx, input: NoticeInput) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const publish = input.publish ?? false
    const [n] = await tx.insert(notices).values({
      tenantId: ctx.tenantId,
      title: input.title,
      body: sanitizeBody(input.body as ContentBlock[]),
      attachments: input.attachments ?? [],
      kind: input.kind,
      startsAt: input.startsAt ? new Date(input.startsAt) : null,
      endsAt: input.endsAt ? new Date(input.endsAt) : null,
      showMode: input.showMode ?? 'modal',
      priority: input.priority ?? 'normal',
      blockUntilAck: input.blockUntilAck ?? false,
      ackText: input.ackText ?? null,
      status: publish ? 'published' : 'draft',
      publishedAt: publish ? new Date() : null,
      authorId: ctx.actorId,
    }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'notice.create', entity: 'notice', entityId: n!.id, after: { title: input.title, kind: input.kind, publish } })
    return n!
  })
}

export async function updateNotice(ctx: Ctx, id: string, input: Partial<NoticeInput> & { status?: 'draft' | 'published' | 'archived' }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(notices).where(and(eq(notices.id, id), isNull(notices.deletedAt)))
    if (!before) return null
    const status = input.status ?? (input.publish ? 'published' : undefined)
    const publishing = status === 'published' && before.status !== 'published'
    const [n] = await tx.update(notices).set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: sanitizeBody(input.body as ContentBlock[]) } : {}),
      ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.startsAt !== undefined ? { startsAt: input.startsAt ? new Date(input.startsAt) : null } : {}),
      ...(input.endsAt !== undefined ? { endsAt: input.endsAt ? new Date(input.endsAt) : null } : {}),
      ...(input.showMode !== undefined ? { showMode: input.showMode } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.blockUntilAck !== undefined ? { blockUntilAck: input.blockUntilAck } : {}),
      ...(input.ackText !== undefined ? { ackText: input.ackText } : {}),
      ...(status ? { status } : {}),
      ...(publishing ? { publishedAt: new Date() } : {}),
      updatedAt: new Date(),
    }).where(eq(notices.id, id)).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'notice.update', entity: 'notice', entityId: id, before: { title: before.title, status: before.status }, after: { title: n!.title, status: n!.status } })
    return n!
  })
}

export async function deleteNotice(ctx: Ctx, id: string): Promise<boolean> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [n] = await tx.update(notices).set({ deletedAt: new Date(), updatedAt: new Date() }).where(and(eq(notices.id, id), isNull(notices.deletedAt))).returning({ id: notices.id, title: notices.title })
    if (!n) return false
    await tx.update(assignments).set({ status: 'archived', updatedAt: new Date() }).where(and(eq(assignments.subjectType, 'notice'), eq(assignments.subjectId, id)))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'notice.delete', entity: 'notice', entityId: id, before: { title: n.title } })
    return true
  })
}

/**
 * Просмотр учеником: объявление доступно тому, кому назначено (или автору). Счётчик просмотров —
 * серверный, раз на человека в день (по журналу task_access_log), чужой тенант / не назначено — null (404).
 */
export async function viewNotice(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [n] = await tx.select().from(notices).where(and(eq(notices.id, id), isNull(notices.deletedAt), eq(notices.status, 'published')))
    if (!n) return null
    const { userIds, dueAt } = await noticeAudience(tx, id)
    if (!userIds.has(ctx.actorId) && n.authorId !== ctx.actorId) return null
    await countView(tx, ctx, 'notice', id, n.title)
    const [ack] = await tx.select({ ackedAt: noticeAcks.ackedAt }).from(noticeAcks).where(and(eq(noticeAcks.noticeId, id), eq(noticeAcks.userId, ctx.actorId)))
    return { ...n, dueAt, ackedAt: ack?.ackedAt ?? null, phase: noticePhase(n) }
  })
}

/**
 * views_count идемпотентно: +1 только при первом открытии человеком за день. Источник истины —
 * журнал обращений (docs/22 §13.4), который пишется при каждом открытии.
 */
export async function countView(tx: TenantTx, ctx: Ctx, contentType: 'notice' | 'news' | 'simple_notice' | 'article', contentId: string, title?: string | null): Promise<boolean> {
  const [seen] = await tx.execute(sql`select 1 from task_access_log where user_id = ${ctx.actorId}::uuid and content_type = ${contentType} and content_id = ${contentId}::uuid and action = 'open' and created_at >= date_trunc('day', now()) limit 1`) as unknown as unknown[]
  await logTaskAccess(tx, { tenantId: ctx.tenantId, userId: ctx.actorId, contentType, contentId, title })
  if (seen) return false
  const table = contentType === 'notice' ? sql`notices` : contentType === 'news' ? sql`news` : contentType === 'simple_notice' ? sql`simple_notices` : sql`knowledge_articles`
  const col = contentType === 'article' ? sql`view_count` : sql`views_count`
  await tx.execute(sql`update ${table} set ${col} = ${col} + 1 where id = ${contentId}::uuid`)
  return true
}

export type AckResult = { ok: true, ackedAt: Date } | { ok: false, code: 'not_found' | 'not_assigned' }

/** «Ознайомлений» — один тап (docs/21 §14.5), отметка с датой и устройством; повтор — идемпотентен. */
export async function acknowledge(ctx: Ctx, id: string): Promise<AckResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [n] = await tx.select({ id: notices.id, title: notices.title, kind: notices.kind }).from(notices).where(and(eq(notices.id, id), isNull(notices.deletedAt), eq(notices.status, 'published')))
    if (!n) return { ok: false as const, code: 'not_found' as const }
    const { userIds } = await noticeAudience(tx, id)
    if (!userIds.has(ctx.actorId)) return { ok: false as const, code: 'not_assigned' as const }
    const [row] = await tx.insert(noticeAcks).values({ tenantId: ctx.tenantId, noticeId: id, userId: ctx.actorId, requestContext: currentRequestContext() })
      .onConflictDoNothing().returning({ ackedAt: noticeAcks.ackedAt })
    if (row) {
      await emitWebhook(tx, ctx.tenantId, 'notice.acknowledged', { noticeId: id, userId: ctx.actorId, title: n.title, ackedAt: row.ackedAt.toISOString() })
      return { ok: true as const, ackedAt: row.ackedAt }
    }
    const [existing] = await tx.select({ ackedAt: noticeAcks.ackedAt }).from(noticeAcks).where(and(eq(noticeAcks.noticeId, id), eq(noticeAcks.userId, ctx.actorId)))
    return { ok: true as const, ackedAt: existing!.ackedAt }
  })
}

/** Охват (`GET /notices/:id/coverage`): аудитория назначений против подтверждений, по точкам и поимённо. */
export async function coverage(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [n] = await tx.select().from(notices).where(and(eq(notices.id, id), isNull(notices.deletedAt)))
    if (!n) return null
    const { userIds, dueAt } = await noticeAudience(tx, id)
    const ids = [...userIds]
    if (!ids.length) return { notice: n, dueAt, total: 0, acked: 0, byLocation: [], notAcked: [], readers: [] }
    const rows = await tx.execute(sql`
      select u.id, u.full_name, l.name as location, p.name as position, a.acked_at
      from users u
      left join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null
      left join locations l on l.id = up.location_id
      left join positions p on p.id = up.position_id
      left join notice_acks a on a.notice_id = ${id}::uuid and a.user_id = u.id
      where u.id in (${sql.join(ids.map(x => sql`${x}::uuid`), sql`, `)})
      order by l.name nulls last, u.full_name
    `) as unknown as { id: string, full_name: string, location: string | null, position: string | null, acked_at: string | null }[]
    const byLoc = new Map<string, { location: string, total: number, acked: number }>()
    for (const r of rows) {
      const k = r.location ?? '—'
      const e = byLoc.get(k) ?? { location: k, total: 0, acked: 0 }
      e.total++
      if (r.acked_at) e.acked++
      byLoc.set(k, e)
    }
    const person = (r: typeof rows[number]) => ({ id: r.id, fullName: r.full_name, location: r.location, position: r.position, ackedAt: r.acked_at })
    return {
      notice: n, dueAt, total: rows.length, acked: rows.filter(r => r.acked_at).length,
      byLocation: [...byLoc.values()].map(x => ({ ...x, pct: Math.round(x.acked / x.total * 100) })),
      notAcked: rows.filter(r => !r.acked_at).map(person),
      readers: rows.filter(r => r.acked_at).map(person),
    }
  })
}

/** «Нагадати тим, хто не підтвердив»: уведомление `notice_not_acknowledged` каждому без подтверждения, раз в день. */
export async function remind(ctx: Ctx, id: string): Promise<{ ok: true, reminded: number, total: number } | { ok: false, code: 'not_found' }> {
  const cov = await coverage(ctx, id)
  if (!cov) return { ok: false, code: 'not_found' }
  let reminded = 0
  await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    for (const u of cov.notAcked) {
      if (await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: u.id, code: 'notice_not_acknowledged', payload: { title: cov.notice.title, noticeId: id, due: cov.dueAt?.toISOString() ?? '' }, dedupKey: `notice_rem:${id}:${u.id}:${day()}`, refType: 'notice', refId: id })) reminded++
    }
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'notice.remind', entity: 'notice', entityId: id, after: { reminded, notAcked: cov.notAcked.length } })
  })
  return { ok: true, reminded, total: cov.notAcked.length }
}

/** `notice_assigned` (docs/23 §13: обязательное) — всем из аудитории нового назначения объявления. */
export async function notifyAssigned(tenantId: string, assignmentId: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const [a] = await tx.select({ id: assignments.id, subjectId: assignments.subjectId, subjectType: assignments.subjectType, audience: assignments.audience, exclude: assignments.exclude, dueAt: assignments.dueAt, status: assignments.status }).from(assignments).where(eq(assignments.id, assignmentId))
    if (!a || a.subjectType !== 'notice' || a.status !== 'active') return 0
    const [n] = await tx.select({ title: notices.title, status: notices.status }).from(notices).where(eq(notices.id, a.subjectId))
    if (!n || n.status !== 'published') return 0
    const ids = await resolveAudience(tx, a.audience as Audience, a.exclude as Audience)
    let sent = 0
    for (const userId of ids) {
      if (await enqueueNotification(tx, { tenantId, userId, code: 'notice_assigned', payload: { title: n.title, noticeId: a.subjectId, due: a.dueAt?.toISOString() ?? '' }, dedupKey: `notice_assigned:${a.id}:${userId}`, refType: 'notice', refId: a.subjectId })) sent++
    }
    return sent
  })
}

/**
 * Что показать человеку при входе (docs/21 §5.4, §7.4): опубликованные объявления в периоде показа,
 * назначенные ему и не подтверждённые. Модальные — до «Ознайомився»; с block_until_ack — перекрывают интерфейс.
 */
export async function pendingForUser(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select().from(notices)
      .where(and(isNull(notices.deletedAt), eq(notices.status, 'published'),
        sql`(${notices.startsAt} is null or ${notices.startsAt} <= now())`, sql`(${notices.endsAt} is null or ${notices.endsAt} > now())`,
        sql`not exists (select 1 from ${noticeAcks} a where a.notice_id = ${notices.id} and a.user_id = ${ctx.actorId}::uuid)`))
      .orderBy(desc(notices.priority), desc(notices.publishedAt)).limit(20)
    const out = []
    for (const n of rows) {
      const { userIds, dueAt } = await noticeAudience(tx, n.id)
      if (!userIds.has(ctx.actorId)) continue
      out.push({ id: n.id, title: n.title, body: n.body, kind: n.kind, showMode: n.showMode, priority: n.priority, blockUntilAck: n.blockUntilAck, ackText: n.ackText, attachments: n.attachments, publishedAt: n.publishedAt, endsAt: n.endsAt, dueAt })
    }
    return out
  })
}

/** «Мої оголошення» в кабинете: назначенные человеку, с отметкой подтверждения. */
export async function listMine(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select({ id: notices.id, title: notices.title, kind: notices.kind, priority: notices.priority, publishedAt: notices.publishedAt, endsAt: notices.endsAt, startsAt: notices.startsAt, status: notices.status, ackedAt: noticeAcks.ackedAt })
      .from(notices).leftJoin(noticeAcks, and(eq(noticeAcks.noticeId, notices.id), eq(noticeAcks.userId, ctx.actorId)))
      .where(and(isNull(notices.deletedAt), eq(notices.status, 'published'))).orderBy(desc(notices.publishedAt)).limit(100)
    const out = []
    for (const n of rows) {
      const { userIds, dueAt } = await noticeAudience(tx, n.id)
      if (!userIds.has(ctx.actorId)) continue
      out.push({ ...n, dueAt, phase: noticePhase(n) })
    }
    return out
  })
}

/**
 * Ежедневно (due.scan): просроченные по сроку назначения и не подтверждённые — напоминание человеку,
 * руководителю точки — список (announcement_overdue_manager). Дедуп на день.
 */
export async function noticeScan(tenantId: string): Promise<{ reminded: number, escalated: number }> {
  const out = { reminded: 0, escalated: 0 }
  const items = await withTenant(tenantId, null, tx => tx.select({ id: notices.id, title: notices.title }).from(notices)
    .where(and(isNull(notices.deletedAt), eq(notices.status, 'published'), sql`(${notices.endsAt} is null or ${notices.endsAt} > now())`)))
  const d = day()
  for (const n of items) {
    const cov = await coverage({ tenantId, actorId: null as unknown as string }, n.id)
    if (!cov || !cov.notAcked.length || !cov.dueAt || cov.dueAt.getTime() > Date.now()) continue
    await withTenant(tenantId, null, async (tx) => {
      for (const u of cov.notAcked) {
        if (await enqueueNotification(tx, { tenantId, userId: u.id, code: 'notice_not_acknowledged', payload: { title: n.title, noticeId: n.id, due: cov.dueAt!.toISOString() }, dedupKey: `notice_rem:${n.id}:${u.id}:${d}`, refType: 'notice', refId: n.id })) out.reminded++
      }
      const mgrs = await tx.execute(sql`select distinct l.manager_id, l.name from users u join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null join locations l on l.id = up.location_id where l.manager_id is not null and u.id in (${sql.join(cov.notAcked.map(x => sql`${x.id}::uuid`), sql`, `)})`) as unknown as { manager_id: string, name: string }[]
      for (const m of mgrs) {
        const names = cov.notAcked.filter(x => x.location === m.name).map(x => x.fullName).join(', ')
        if (await enqueueNotification(tx, { tenantId, userId: m.manager_id, code: 'announcement_overdue_manager', payload: { title: n.title, names }, dedupKey: `ann_over:${n.id}:${m.manager_id}:${d}` })) out.escalated++
      }
    })
  }
  return out
}

// ── Прості оголошення (docs/21 §14.5): без назначения и подтверждения ─────────────────

export async function listSimpleNotices(ctx: Ctx, opts: { activeOnly?: boolean } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({ id: simpleNotices.id, title: simpleNotices.title, body: simpleNotices.body, publishedAt: simpleNotices.publishedAt, endsAt: simpleNotices.endsAt, status: simpleNotices.status, viewsCount: simpleNotices.viewsCount, createdAt: simpleNotices.createdAt })
      .from(simpleNotices)
      .where(and(isNull(simpleNotices.deletedAt), ...(opts.activeOnly ? [eq(simpleNotices.status, 'published'), sql`(${simpleNotices.endsAt} is null or ${simpleNotices.endsAt} > now())`] : [])))
      .orderBy(desc(simpleNotices.publishedAt), desc(simpleNotices.createdAt)).limit(100)
  })
}

/** Открытие плашки учеником — просмотр считается раз на человека в день. */
export async function viewSimpleNotice(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [n] = await tx.select().from(simpleNotices).where(and(eq(simpleNotices.id, id), isNull(simpleNotices.deletedAt), eq(simpleNotices.status, 'published')))
    if (!n) return null
    await countView(tx, ctx, 'simple_notice', id, n.title)
    return n
  })
}

export async function createSimpleNotice(ctx: Ctx, input: SimpleNoticeInput) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [n] = await tx.insert(simpleNotices).values({
      tenantId: ctx.tenantId, title: input.title, body: sanitizeBody(input.body as ContentBlock[]),
      endsAt: input.endsAt ? new Date(input.endsAt) : null,
      status: input.publish ? 'published' : 'draft', publishedAt: input.publish ? new Date() : null, authorId: ctx.actorId,
    }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'simple_notice.create', entity: 'simple_notice', entityId: n!.id, after: { title: input.title } })
    return n!
  })
}

export async function updateSimpleNotice(ctx: Ctx, id: string, input: Partial<SimpleNoticeInput> & { status?: 'draft' | 'published' | 'archived' }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(simpleNotices).where(and(eq(simpleNotices.id, id), isNull(simpleNotices.deletedAt)))
    if (!before) return null
    const status = input.status ?? (input.publish ? 'published' : undefined)
    const [n] = await tx.update(simpleNotices).set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: sanitizeBody(input.body as ContentBlock[]) } : {}),
      ...(input.endsAt !== undefined ? { endsAt: input.endsAt ? new Date(input.endsAt) : null } : {}),
      ...(status ? { status } : {}),
      ...(status === 'published' && before.status !== 'published' ? { publishedAt: new Date() } : {}),
      updatedAt: new Date(),
    }).where(eq(simpleNotices.id, id)).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'simple_notice.update', entity: 'simple_notice', entityId: id, before: { status: before.status }, after: { status: n!.status } })
    return n!
  })
}

export async function deleteSimpleNotice(ctx: Ctx, id: string): Promise<boolean> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [n] = await tx.update(simpleNotices).set({ deletedAt: new Date() }).where(and(eq(simpleNotices.id, id), isNull(simpleNotices.deletedAt))).returning({ id: simpleNotices.id })
    if (!n) return false
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'simple_notice.delete', entity: 'simple_notice', entityId: id })
    return true
  })
}
