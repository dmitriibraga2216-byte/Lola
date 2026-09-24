import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import {
  assignments, lessonProgress, locations, meetupSessionRegistrations, meetupSessions, meetups, users,
} from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import { completeLesson } from './learning'
import { frameFirst, frameJoins, frameSelect, frameTail, frameWhere, periodSql } from './reportFrame'
import type { SessionAttendanceInput, SessionCreateInput } from '../../shared/schemas/meetupSessions'
import { managerIdsOf } from './orgManager'

/**
 * Сесії очних занять і вебінарів на призначенні (docs/18 §14.1, §15 Г-18.1, Г-18.2; docs/29 Б.3).
 * Картка (`meetups`) лишається матеріалом (назва, опис, анонс); дата, місце, вмістимість, черга,
 * відмітка присутності і зачёт по перегляду — тут, і прив'язані до `taskId` (призначення), не до
 * картки. Один запис — `withTenant`, аудит іде автоматично з `request_context` (CLAUDE.md п. 14).
 */

interface Ctx { tenantId: string, actorId: string }

const H = 3_600_000
const RETROACTIVE_WINDOW_MS = 7 * 24 * H
const DEFAULT_WEBINAR_MIN_WATCH_PCT = 80 // docs/18 Г-18.2

function enrollOpen(s: { startsAt: Date, enrollDeadlineHours: number, status: string }): boolean {
  return s.status === 'planned' && Date.now() < s.startsAt.getTime() - s.enrollDeadlineHours * H
}

// ── CRUD сесії ──────────────────────────────────────────────────────────

export type CreateSessionResult
  = | { ok: true, session: typeof meetupSessions.$inferSelect }
    | { ok: false, code: 'meetup_not_found' | 'task_mismatch' }

export async function createSession(ctx: Ctx, meetupId: string, input: SessionCreateInput): Promise<CreateSessionResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [m] = await tx.select({ id: meetups.id, kind: meetups.kind, status: meetups.status }).from(meetups)
      .where(and(eq(meetups.id, meetupId), inArray(meetups.kind, ['meetup', 'webinar'])))
    if (!m) return { ok: false as const, code: 'meetup_not_found' as const }
    if (input.taskId) {
      const [a] = await tx.select({ id: assignments.id, subjectId: assignments.subjectId }).from(assignments).where(eq(assignments.id, input.taskId))
      if (!a || a.subjectId !== meetupId) return { ok: false as const, code: 'task_mismatch' as const }
    }
    let timezone = input.timezone
    if (!timezone && input.locationId) {
      const [l] = await tx.select({ tz: locations.timezone }).from(locations).where(eq(locations.id, input.locationId))
      timezone = l?.tz
    }
    const [session] = await tx.insert(meetupSessions).values({
      tenantId: ctx.tenantId, meetupId, taskId: input.taskId ?? null,
      startsAt: new Date(input.startsAt), endsAt: new Date(input.endsAt), timezone: timezone ?? 'Europe/Kyiv',
      locationId: input.locationId ?? null, room: input.room ?? null, address: input.address ?? null, trainerIds: input.trainerIds,
      joinUrl: input.joinUrl ?? null, hostUrl: input.hostUrl ?? null, provider: input.provider ?? null,
      capacity: input.capacity ?? null, waitlistEnabled: input.waitlistEnabled ?? true,
      enrollDeadlineHours: input.enrollDeadlineHours ?? 2, cancelDeadlineHours: input.cancelDeadlineHours ?? 24,
      attendanceMode: input.attendanceMode ?? 'manual', qrSecret: randomBytes(24).toString('base64url'),
      createdBy: ctx.actorId,
    }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'meetup_session.create', entity: 'meetup_session', entityId: session!.id, after: { meetupId, startsAt: input.startsAt } })
    return { ok: true as const, session: session!, meetupKind: m.kind, webinarProvider: input.provider }
  }).then(async (r) => {
    // docs/33 D-029: Calendar/Zoom-синк — на сесію, а не на картку (docs/09 §9.1, docs/18 §3.3)
    if (r.ok) setImmediate(() => syncExternal(ctx.tenantId, r.session.id, r.meetupKind === 'webinar' ? (r.webinarProvider ?? undefined) : undefined).catch(() => {}))
    return r
  })
}

async function syncExternal(tenantId: string, sessionId: string, webinarProvider?: string) {
  const { createZoomMeetingForSession, syncSessionToCalendar } = await import('./googleApps')
  const { getSecret, SECRET_KEYS } = await import('./secrets')
  if (webinarProvider === 'zoom' && await getSecret(tenantId, 'zoom', SECRET_KEYS.zoom.REFRESH_TOKEN)) await createZoomMeetingForSession(tenantId, sessionId)
  if (await getSecret(tenantId, 'google', SECRET_KEYS.google.REFRESH_TOKEN)) await syncSessionToCalendar(tenantId, sessionId)
}

export async function updateSession(ctx: Ctx, id: string, input: Partial<SessionCreateInput>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(meetupSessions).where(eq(meetupSessions.id, id))
    if (!before || before.status === 'finished' || before.status === 'cancelled') return null
    const patch: Record<string, unknown> = { updatedAt: new Date() }
    for (const k of ['timezone', 'locationId', 'room', 'address', 'trainerIds', 'joinUrl', 'hostUrl', 'provider', 'capacity', 'waitlistEnabled', 'enrollDeadlineHours', 'cancelDeadlineHours', 'attendanceMode'] as const) {
      if (input[k] !== undefined) patch[k] = input[k]
    }
    if (input.startsAt) patch.startsAt = new Date(input.startsAt)
    if (input.endsAt) patch.endsAt = new Date(input.endsAt)
    const [after] = await tx.update(meetupSessions).set(patch).where(eq(meetupSessions.id, id)).returning()
    const moved = after!.startsAt.getTime() !== before.startsAt.getTime() || after!.endsAt.getTime() !== before.endsAt.getTime() || after!.locationId !== before.locationId || after!.room !== before.room
    if (moved) {
      const [m] = await tx.select({ title: meetups.title }).from(meetups).where(eq(meetups.id, before.meetupId))
      const regs = await tx.select({ userId: meetupSessionRegistrations.userId }).from(meetupSessionRegistrations)
        .where(and(eq(meetupSessionRegistrations.sessionId, id), inArray(meetupSessionRegistrations.status, ['registered', 'waitlist'])))
      for (const r of regs) await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: r.userId, code: 'meetup_changed', payload: { title: m?.title ?? '', starts: after!.startsAt.toISOString() }, dedupKey: `ms_changed:${id}:${r.userId}:${after!.updatedAt.getTime()}` })
    }
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'meetup_session.update', entity: 'meetup_session', entityId: id, before: { startsAt: before.startsAt, locationId: before.locationId }, after: { startsAt: after!.startsAt, locationId: after!.locationId } })
    return { after: after!, moved }
  }).then((r) => {
    // docs/33 D-029: дата/місце змінились — пересинхронізувати подію в календарі на сесії
    if (r && r.moved) setImmediate(() => syncExternal(ctx.tenantId, id).catch(() => {}))
    return r ? r.after : null
  })
}

export async function cancelSession(ctx: Ctx, id: string, input: { reason: string, notify?: boolean }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [s] = await tx.select().from(meetupSessions).where(and(eq(meetupSessions.id, id), inArray(meetupSessions.status, ['planned', 'ongoing'])))
    if (!s) return null
    const [m] = await tx.select({ title: meetups.title }).from(meetups).where(eq(meetups.id, s.meetupId))
    await tx.update(meetupSessions).set({ status: 'cancelled', cancelReason: input.reason, updatedAt: new Date() }).where(eq(meetupSessions.id, id))
    const regs = await tx.select({ userId: meetupSessionRegistrations.userId }).from(meetupSessionRegistrations)
      .where(and(eq(meetupSessionRegistrations.sessionId, id), inArray(meetupSessionRegistrations.status, ['registered', 'waitlist'])))
    await tx.update(meetupSessionRegistrations).set({ status: 'cancelled', cancelReason: 'Сесію скасовано', updatedAt: new Date() })
      .where(and(eq(meetupSessionRegistrations.sessionId, id), inArray(meetupSessionRegistrations.status, ['registered', 'waitlist'])))
    if (input.notify !== false) {
      for (const r of regs) await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: r.userId, code: 'meetup_cancelled', payload: { title: m?.title ?? '', reason: input.reason, alternative: '' }, dedupKey: `ms_cancel:${id}:${r.userId}` })
    }
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'meetup_session.cancel', entity: 'meetup_session', entityId: id, after: { reason: input.reason, registrations: regs.length } })
    return { cancelled: regs.length }
  }).then((r) => {
    // docs/33 D-029: прибрати подію з календаря — тепер на сесії, а не на картці
    if (r) setImmediate(() => import('./googleApps').then(g => g.removeSessionFromCalendar(ctx.tenantId, id)).catch(() => {}))
    return r
  })
}

/** Список сесій заняття/вебінару (docs/18 §5.1), опційно — тільки одного призначення. */
export async function listSessions(ctx: Ctx, meetupId: string, filter: { taskId?: string } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.execute(sql`
      select s.id, s.meetup_id, s.task_id, s.starts_at, s.ends_at, s.timezone, s.status, s.capacity, s.room, s.address, s.trainer_ids, s.enroll_deadline_hours, s.attendance_mode,
             l.name as location,
             (select count(*)::int from meetup_session_registrations r where r.session_id = s.id and r.status in ('registered','attended')) as registered,
             (select count(*)::int from meetup_session_registrations r where r.session_id = s.id and r.status = 'waitlist') as waitlist,
             (select r.status from meetup_session_registrations r where r.session_id = s.id and r.user_id = ${ctx.actorId}::uuid) as my_status,
             (select r.waitlist_position from meetup_session_registrations r where r.session_id = s.id and r.user_id = ${ctx.actorId}::uuid) as my_waitlist_position
      from meetup_sessions s left join locations l on l.id = s.location_id
      where s.meetup_id = ${meetupId}::uuid ${filter.taskId ? sql`and s.task_id = ${filter.taskId}::uuid` : sql``}
      order by s.starts_at
    `) as unknown as Record<string, unknown>[]
    const trainerIds = [...new Set(rows.flatMap(r => r.trainer_ids as string[]))]
    const trainers = trainerIds.length ? await tx.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, trainerIds)) : []
    const tn = new Map(trainers.map(t => [t.id, t.fullName]))
    return rows.map(r => ({ ...r, id: String(r.id), trainers: (r.trainer_ids as string[]).map(id => tn.get(id) ?? '?'), seatsLeft: r.capacity != null ? Math.max(0, Number(r.capacity) - Number(r.registered)) : null, enrollOpen: enrollOpen({ startsAt: new Date(r.starts_at as string), enrollDeadlineHours: Number(r.enroll_deadline_hours), status: r.status as string }) }))
  })
}

/**
 * Розклад по всіх сесіях тенанту (docs/18 §5.1, docs/33 D-029) — той самий вигляд рядка, що й
 * `meetups.ts#schedule`, для об'єднання в один список на екрані «Розклад» (`GET /meetups`):
 * події (`kind=event`) і немігровані картки без сесій йдуть з картки, а meetup|webinar із
 * сесіями — по рядку на кожну сесію (`meetupId` — для переходу на картку).
 */
export async function scheduleSessions(ctx: Ctx, filter: { from?: string, to?: string, mine?: boolean, kind?: string, locationId?: string } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const from = filter.from ? new Date(filter.from) : new Date(Date.now() - 7 * 86_400_000)
    const to = filter.to ? new Date(filter.to) : new Date(Date.now() + 60 * 86_400_000)
    const rows = await tx.execute(sql`
      select s.id, s.meetup_id, m.kind, m.title, s.starts_at, s.ends_at, s.timezone, s.status, s.capacity, s.room, s.address, s.trainer_ids, s.enroll_deadline_hours, s.attendance_mode,
             l.name as location,
             (select count(*)::int from meetup_session_registrations r where r.session_id = s.id and r.status in ('registered','attended')) as registered,
             (select count(*)::int from meetup_session_registrations r where r.session_id = s.id and r.status = 'waitlist') as waitlist,
             (select r.status from meetup_session_registrations r where r.session_id = s.id and r.user_id = ${ctx.actorId}::uuid) as my_status,
             (select r.waitlist_position from meetup_session_registrations r where r.session_id = s.id and r.user_id = ${ctx.actorId}::uuid) as my_waitlist_position
      from meetup_sessions s join meetups m on m.id = s.meetup_id left join locations l on l.id = s.location_id
      where s.starts_at >= ${from.toISOString()}::timestamptz and s.starts_at <= ${to.toISOString()}::timestamptz
        ${filter.kind ? sql`and m.kind = ${filter.kind}` : sql``}
        ${filter.locationId ? sql`and s.location_id = ${filter.locationId}::uuid` : sql``}
        ${filter.mine ? sql`and exists (select 1 from meetup_session_registrations r where r.session_id = s.id and r.user_id = ${ctx.actorId}::uuid and r.status in ('registered','waitlist','attended'))` : sql``}
      order by s.starts_at
    `) as unknown as Record<string, unknown>[]
    const trainerIds = [...new Set(rows.flatMap(r => r.trainer_ids as string[]))]
    const trainers = trainerIds.length ? await tx.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, trainerIds)) : []
    const tn = new Map(trainers.map(t => [t.id, t.fullName]))
    return rows.map(r => ({
      ...r, id: String(r.id), meetupId: String(r.meetup_id),
      trainers: (r.trainer_ids as string[]).map(id => tn.get(id) ?? '?'),
      seatsLeft: r.capacity != null ? Math.max(0, Number(r.capacity) - Number(r.registered)) : null,
      enrollOpen: enrollOpen({ startsAt: new Date(r.starts_at as string), enrollDeadlineHours: Number(r.enroll_deadline_hours), status: r.status as string }),
    }))
  })
}

export async function getSession(ctx: Ctx, id: string, opts: { manage?: boolean } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [s] = await tx.select().from(meetupSessions).where(eq(meetupSessions.id, id))
    if (!s) return null
    const [m] = await tx.select({ id: meetups.id, title: meetups.title, kind: meetups.kind, description: meetups.description, announcement: meetups.announcement, registrationRequired: meetups.registrationRequired }).from(meetups).where(eq(meetups.id, s.meetupId))
    if (!m) return null
    const [loc] = s.locationId ? await tx.select({ name: locations.name, address: locations.address }).from(locations).where(eq(locations.id, s.locationId)) : []
    const trainers = s.trainerIds.length ? await tx.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, s.trainerIds)) : []
    const regs = await tx.select().from(meetupSessionRegistrations).innerJoin(users, eq(users.id, meetupSessionRegistrations.userId))
      .where(eq(meetupSessionRegistrations.sessionId, id)).orderBy(asc(meetupSessionRegistrations.registeredAt))
    const flatRegs = regs.map(r => ({ ...r.meetup_session_registrations, fullName: r.users.fullName }))
    const mine = flatRegs.find(r => r.userId === ctx.actorId) ?? null
    const registered = flatRegs.filter(r => ['registered', 'attended'].includes(r.status)).length
    const isTrainer = s.trainerIds.includes(ctx.actorId)
    const full = !!opts.manage || isTrainer
    return {
      ...s, qrSecret: undefined, meetup: m, location: loc ?? null, trainers,
      registered, waitlist: flatRegs.filter(r => r.status === 'waitlist').length, seatsLeft: s.capacity != null ? Math.max(0, s.capacity - registered) : null,
      mine, enrollOpen: enrollOpen(s), canCancel: Date.now() < s.startsAt.getTime() - s.cancelDeadlineHours * H, isTrainer,
      participants: full ? flatRegs : undefined,
    }
  })
}

// ── Запис, черга, відміна (docs/18 §7.1–7.3) ────────────────────────────

export type RegisterResult
  = | { ok: true, status: 'registered' | 'waitlist', waitlistPosition?: number }
    | { ok: false, code: 'not_found' | 'closed' | 'full' | 'already' | 'announcement_only' }

export async function registerSession(ctx: Ctx, sessionId: string, userId: string, opts: { enrollmentId?: string, lessonId?: string, guestsCount?: number } = {}): Promise<RegisterResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [s] = await tx.select().from(meetupSessions).where(eq(meetupSessions.id, sessionId))
    if (!s) return { ok: false as const, code: 'not_found' as const }
    const [m] = await tx.select({ registrationRequired: meetups.registrationRequired, title: meetups.title }).from(meetups).where(eq(meetups.id, s.meetupId))
    if (!m) return { ok: false as const, code: 'not_found' as const }
    if (m.registrationRequired === false) return { ok: false as const, code: 'announcement_only' as const }
    const byOther = userId !== ctx.actorId
    if (!byOther && !enrollOpen(s)) return { ok: false as const, code: 'closed' as const }
    if (byOther && !['planned', 'ongoing'].includes(s.status)) return { ok: false as const, code: 'closed' as const }
    const [existing] = await tx.select().from(meetupSessionRegistrations).where(and(eq(meetupSessionRegistrations.sessionId, sessionId), eq(meetupSessionRegistrations.userId, userId)))
    if (existing && existing.status !== 'cancelled') return { ok: false as const, code: 'already' as const }
    const guests = Math.max(0, Math.min(10, opts.guestsCount ?? 0))
    const [cnt] = await tx.select({ n: sql<number>`coalesce(sum(1 + guests_count), 0)::int` }).from(meetupSessionRegistrations)
      .where(and(eq(meetupSessionRegistrations.sessionId, sessionId), inArray(meetupSessionRegistrations.status, ['registered', 'attended'])))
    const hasSeat = s.capacity == null || cnt!.n + guests < s.capacity
    if (!hasSeat && !s.waitlistEnabled) return { ok: false as const, code: 'full' as const }
    let waitlistPosition: number | undefined
    if (!hasSeat) {
      const [wl] = await tx.select({ n: sql<number>`coalesce(max(waitlist_position), 0)::int` }).from(meetupSessionRegistrations)
        .where(and(eq(meetupSessionRegistrations.sessionId, sessionId), eq(meetupSessionRegistrations.status, 'waitlist')))
      waitlistPosition = wl!.n + 1
    }
    const values = { status: hasSeat ? 'registered' : 'waitlist', registeredAt: new Date(), registeredBy: ctx.actorId, waitlistPosition: waitlistPosition ?? null, cancelReason: null, enrollmentId: opts.enrollmentId ?? null, lessonId: opts.lessonId ?? null, guestsCount: guests, updatedAt: new Date() }
    if (existing) await tx.update(meetupSessionRegistrations).set(values).where(eq(meetupSessionRegistrations.id, existing.id))
    else await tx.insert(meetupSessionRegistrations).values({ tenantId: ctx.tenantId, sessionId, userId, ...values })
    await enqueueNotification(tx, { tenantId: ctx.tenantId, userId, code: hasSeat ? 'meetup_registered' : 'meetup_waitlisted', payload: { title: m.title, starts: s.startsAt.toISOString(), position: waitlistPosition ?? '' }, dedupKey: `ms_reg:${sessionId}:${userId}:${hasSeat ? 'r' : 'w'}` })
    return { ok: true as const, status: hasSeat ? 'registered' as const : 'waitlist' as const, waitlistPosition }
  })
}

export type UnregisterResult = { ok: true } | { ok: false, code: 'not_found' | 'cancel_deadline_passed' }

export async function unregisterSession(ctx: Ctx, sessionId: string, userId: string, reason?: string): Promise<UnregisterResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [s] = await tx.select().from(meetupSessions).where(eq(meetupSessions.id, sessionId))
    const [r] = await tx.select().from(meetupSessionRegistrations).where(and(eq(meetupSessionRegistrations.sessionId, sessionId), eq(meetupSessionRegistrations.userId, userId), inArray(meetupSessionRegistrations.status, ['registered', 'waitlist'])))
    if (!s || !r) return { ok: false as const, code: 'not_found' as const }
    if (userId === ctx.actorId && Date.now() >= s.startsAt.getTime() - s.cancelDeadlineHours * H) return { ok: false as const, code: 'cancel_deadline_passed' as const }
    await tx.update(meetupSessionRegistrations).set({ status: 'cancelled', cancelReason: reason ?? null, waitlistPosition: null, updatedAt: new Date() }).where(eq(meetupSessionRegistrations.id, r.id))
    if (r.status === 'registered') await promoteWaitlist(tx, ctx.tenantId, s)
    return { ok: true as const }
  })
}

async function promoteWaitlist(tx: TenantTx, tenantId: string, s: typeof meetupSessions.$inferSelect): Promise<string | null> {
  const [cnt] = await tx.select({ n: sql<number>`count(*)::int` }).from(meetupSessionRegistrations).where(and(eq(meetupSessionRegistrations.sessionId, s.id), inArray(meetupSessionRegistrations.status, ['registered', 'attended'])))
  if (s.capacity != null && cnt!.n >= s.capacity) return null
  const [next] = await tx.select().from(meetupSessionRegistrations).where(and(eq(meetupSessionRegistrations.sessionId, s.id), eq(meetupSessionRegistrations.status, 'waitlist'))).orderBy(asc(meetupSessionRegistrations.waitlistPosition), asc(meetupSessionRegistrations.registeredAt)).limit(1)
  if (!next) return null
  await tx.update(meetupSessionRegistrations).set({ status: 'registered', waitlistPosition: null, updatedAt: new Date() }).where(eq(meetupSessionRegistrations.id, next.id))
  await tx.execute(sql`update meetup_session_registrations set waitlist_position = waitlist_position - 1 where session_id = ${s.id}::uuid and status = 'waitlist' and waitlist_position > ${next.waitlistPosition ?? 0}`)
  const [m] = await tx.select({ title: meetups.title }).from(meetups).where(eq(meetups.id, s.meetupId))
  await enqueueNotification(tx, { tenantId, userId: next.userId, code: 'meetup_seat_freed', payload: { title: m?.title ?? '', starts: s.startsAt.toISOString() }, dedupKey: `ms_seat:${s.id}:${next.userId}` })
  return next.userId
}

export async function registerOthers(ctx: Ctx, sessionId: string, userIds: string[]) {
  const out: Record<string, RegisterResult> = {}
  for (const u of userIds) out[u] = await registerSession(ctx, sessionId, u)
  return out
}

// ── QR (docs/18 §5.3–5.4, §7.5) ─────────────────────────────────────────

const QR_WINDOW_SEC = 30

function qrToken(s: { id: string, qrSecret: string }, windowIdx: number): string {
  return createHmac('sha256', s.qrSecret).update(`${s.id}:${windowIdx}`).digest('base64url').slice(0, 20)
}

export async function currentQr(ctx: Ctx, sessionId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [s] = await tx.select({ id: meetupSessions.id, qrSecret: meetupSessions.qrSecret, attendanceMode: meetupSessions.attendanceMode }).from(meetupSessions).where(eq(meetupSessions.id, sessionId))
    if (!s || s.attendanceMode === 'manual') return null
    const idx = Math.floor(Date.now() / 1000 / QR_WINDOW_SEC)
    return { token: `${sessionId}.${idx}.${qrToken(s, idx)}`, expiresInSec: QR_WINDOW_SEC - (Math.floor(Date.now() / 1000) % QR_WINDOW_SEC) }
  })
}

export type CheckinResult = { ok: true, checkedInAt: Date, title: string } | { ok: false, code: 'bad_token' | 'expired' | 'not_registered' | 'outside_window' | 'already', sessionId?: string, seatsLeft?: number | null }

export async function checkin(ctx: Ctx, token: string): Promise<CheckinResult> {
  const [sessionId, idxStr, sig] = token.split('.')
  if (!sessionId || !idxStr || !sig) return { ok: false, code: 'bad_token' }
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [s] = await tx.select().from(meetupSessions).where(eq(meetupSessions.id, sessionId))
    if (!s) return { ok: false as const, code: 'bad_token' as const }
    const idx = Number(idxStr)
    const expected = qrToken(s, idx)
    const a = Buffer.from(sig), b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'meetup_session.checkin.rejected', entity: 'meetup_session', entityId: sessionId, after: { reason: 'bad_token' } })
      return { ok: false as const, code: 'bad_token' as const }
    }
    const nowIdx = Math.floor(Date.now() / 1000 / QR_WINDOW_SEC)
    if (nowIdx - idx > 1 || idx > nowIdx) {
      await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'meetup_session.checkin.rejected', entity: 'meetup_session', entityId: sessionId, after: { reason: 'expired', ageSec: (nowIdx - idx) * QR_WINDOW_SEC } })
      return { ok: false as const, code: 'expired' as const }
    }
    const now = Date.now()
    if (now < s.startsAt.getTime() - 30 * 60_000 || now > s.endsAt.getTime() + 30 * 60_000) return { ok: false as const, code: 'outside_window' as const }
    const [r] = await tx.select().from(meetupSessionRegistrations).where(and(eq(meetupSessionRegistrations.sessionId, sessionId), eq(meetupSessionRegistrations.userId, ctx.actorId)))
    const [m] = await tx.select({ title: meetups.title }).from(meetups).where(eq(meetups.id, s.meetupId))
    if (!r || !['registered', 'waitlist'].includes(r.status)) {
      if (r?.status === 'attended') return { ok: false as const, code: 'already' as const }
      const [cnt] = await tx.select({ n: sql<number>`count(*)::int` }).from(meetupSessionRegistrations).where(and(eq(meetupSessionRegistrations.sessionId, sessionId), inArray(meetupSessionRegistrations.status, ['registered', 'attended'])))
      return { ok: false as const, code: 'not_registered' as const, sessionId, seatsLeft: s.capacity != null ? Math.max(0, s.capacity - cnt!.n) : null }
    }
    await markAttendance(tx, ctx, s, r, 'attended', 'qr')
    return { ok: true as const, checkedInAt: new Date(), title: m?.title ?? '' }
  })
}

// ── Присутність: негайно і заднім числом (docs/18 §7.5, Г-18.1) ─────────

async function markAttendance(tx: TenantTx, ctx: Ctx, s: typeof meetupSessions.$inferSelect, r: typeof meetupSessionRegistrations.$inferSelect, status: 'attended' | 'missed' | 'excused', method: 'manual' | 'qr' | 'auto', extra: { reason?: string, retroactive?: boolean } = {}) {
  const now = new Date()
  await tx.update(meetupSessionRegistrations).set({
    status,
    checkedInAt: status === 'attended' ? now : r.checkedInAt,
    checkInMethod: status === 'attended' ? method : r.checkInMethod,
    checkedInBy: method === 'manual' ? ctx.actorId : null,
    cancelReason: extra.reason ?? r.cancelReason,
    waitlistPosition: null,
    markedRetroactively: !!extra.retroactive,
    retroactiveReason: extra.retroactive ? (extra.reason ?? null) : r.retroactiveReason,
    updatedAt: now,
  }).where(eq(meetupSessionRegistrations.id, r.id))
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorId: ctx.actorId,
    action: extra.retroactive ? 'meetup_session.attendance.retroactive' : 'meetup_session.attendance',
    entity: 'meetup_session_registration',
    entityId: r.id,
    before: { status: r.status },
    after: { status, method, by: ctx.actorId, reason: extra.reason ?? null },
  })
  // Зачёт у курсі (docs/29 Б.3): заняття як урок засчитывается при attended — прогрес уроку
  // ставимо напряму в тій самій транзакції (як тест/практикум, attempts.ts onAttemptPassed),
  // а completeLesson викликаємо окремо лише щоб перерахувати прогрес курсу і статус запису.
  if (status === 'attended' && r.enrollmentId && r.lessonId) {
    const enrollmentId = r.enrollmentId, lessonId = r.lessonId
    await tx.insert(lessonProgress).values({ tenantId: ctx.tenantId, enrollmentId, lessonId, status: 'completed', completedAt: now })
      .onConflictDoUpdate({ target: [lessonProgress.tenantId, lessonProgress.enrollmentId, lessonProgress.lessonId], set: { status: 'completed', completedAt: now } })
    setImmediate(() => completeLesson({ tenantId: ctx.tenantId, actorId: r.userId }, enrollmentId, lessonId).catch(() => {}))
  }
  if (status === 'attended' || status === 'missed') {
    const [m] = await tx.select({ kind: meetups.kind }).from(meetups).where(eq(meetups.id, s.meetupId))
    const itemType = m?.kind === 'webinar' ? 'webinar' : 'meetup'
    // docs/33 D-020: сесія самостійного заняття — єдиний хук; у складі курсу фіксує курс
    if (!r.lessonId) {
      const { onTaskCompleted } = await import('./taskCompletion')
      await onTaskCompleted(tx, ctx.tenantId, r.userId, { contentType: itemType, contentId: s.meetupId, status: status === 'attended' ? 'done' : 'failed', enrollmentId: r.enrollmentId, sourceKind: 'meetup_attendance', sourceId: r.id, actorId: ctx.actorId === r.userId ? null : ctx.actorId })
    }
    setImmediate(() => {
      import('./programs').then(p => p.onItemResult(ctx.tenantId, r.userId, itemType, s.meetupId, { passed: status === 'attended' })).catch(() => {})
      import('./trajectories').then(t => t.onTaskResult(ctx.tenantId, r.userId, itemType, s.meetupId, { passed: status === 'attended' })).catch(() => {})
    })
  }
}

/** Хто може відмічати заднім числом: тренер сесії, керівник точки або має `meetup.manage`. */
async function canMarkRetroactively(tx: TenantTx, ctx: Ctx, s: typeof meetupSessions.$inferSelect, allowByScope: boolean): Promise<boolean> {
  if (allowByScope) return true
  if (!s.locationId) return false
  const [loc] = await tx.select({ managerId: locations.managerId }).from(locations).where(eq(locations.id, s.locationId))
  return loc?.managerId === ctx.actorId
}

export type SetAttendanceResult
  = | { ok: true, status: string, retroactive: boolean }
    | { ok: false, code: 'not_found' | 'reason_required' | 'window_passed' | 'forbidden' }

/**
 * Відмітка присутності (docs/18 §7.5): негайно (сесія ще не завершилась) — ставить тренер без
 * додаткових умов; заднім числом (сесія вже завершилась) — обов'язкова причина ≥10 символів,
 * не пізніше 7 днів після `endsAt`, і тільки керівнику точки або тому, хто має `meetup.manage`
 * (Г-18.1). Кожна відмітка — в аудит з `request_context` (CLAUDE.md п. 14).
 */
export async function setAttendance(ctx: Ctx, sessionId: string, input: SessionAttendanceInput, opts: { allowRetroactiveByScope?: boolean } = {}): Promise<SetAttendanceResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [s] = await tx.select().from(meetupSessions).where(eq(meetupSessions.id, sessionId))
    if (!s) return { ok: false as const, code: 'not_found' as const }
    const [r] = await tx.select().from(meetupSessionRegistrations).where(and(eq(meetupSessionRegistrations.sessionId, sessionId), eq(meetupSessionRegistrations.userId, input.userId)))
    if (!r) return { ok: false as const, code: 'not_found' as const }
    const now = Date.now()
    const retroactive = now > s.endsAt.getTime()
    if (retroactive) {
      if (!(input.reason ?? '').trim() || input.reason!.trim().length < 10) return { ok: false as const, code: 'reason_required' as const }
      if (now > s.endsAt.getTime() + RETROACTIVE_WINDOW_MS) return { ok: false as const, code: 'window_passed' as const }
      if (!(await canMarkRetroactively(tx, ctx, s, !!opts.allowRetroactiveByScope))) return { ok: false as const, code: 'forbidden' as const }
    }
    if (input.status === 'excused' && !(input.reason ?? '').trim()) return { ok: false as const, code: 'reason_required' as const }
    await markAttendance(tx, ctx, s, r, input.status, 'manual', { reason: input.reason, retroactive })
    return { ok: true as const, status: input.status, retroactive }
  })
}

// ── Вебінар: тіки перегляду і зачёт по webinarMinWatchPct (docs/18 Г-18.2) ─

export const TICK_MAX_SECONDS = 20
export const TICK_MIN_INTERVAL_MS = 10_000

export type TickResult = { ok: true, secondsWatched: number, watchPct: number, attended: boolean } | { ok: false, code: 'not_found' }

/**
 * Тік перегляду вебінару: клієнт присилає скільки секунд минуло з попереднього тіку, сервер сам
 * рахує (як у lessonProgress.tickLesson) — не більше 20 с за тік, не частіше разу на 10 с.
 * Поріг зачёта — `webinarMinWatchPct` з params призначення (`meetup_sessions.task_id`),
 * інакше 80% за замовчуванням (Г-18.2).
 */
export async function tickWatch(ctx: Ctx, sessionId: string, seconds: number): Promise<TickResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [s] = await tx.select().from(meetupSessions).where(eq(meetupSessions.id, sessionId))
    if (!s) return { ok: false as const, code: 'not_found' as const }
    const [r] = await tx.select().from(meetupSessionRegistrations).where(and(eq(meetupSessionRegistrations.sessionId, sessionId), eq(meetupSessionRegistrations.userId, ctx.actorId)))
    if (!r) return { ok: false as const, code: 'not_found' as const }
    const now = new Date()
    const since = r.lastTickAt ?? r.registeredAt
    const elapsedSec = Math.round((now.getTime() - since.getTime()) / 1000)
    const tooSoon = !!r.lastTickAt && now.getTime() - r.lastTickAt.getTime() < TICK_MIN_INTERVAL_MS
    const addSeconds = tooSoon ? 0 : Math.max(0, Math.min(seconds, TICK_MAX_SECONDS, elapsedSec))
    const secondsWatched = r.secondsWatched + addSeconds
    const durationSec = Math.max(1, Math.round((s.endsAt.getTime() - s.startsAt.getTime()) / 1000))
    const watchPct = Math.min(100, Math.round((secondsWatched / durationSec) * 10_000) / 100)
    let threshold = DEFAULT_WEBINAR_MIN_WATCH_PCT
    if (s.taskId) {
      const [a] = await tx.select({ params: assignments.params }).from(assignments).where(eq(assignments.id, s.taskId))
      const pct = (a?.params as Record<string, unknown> | undefined)?.webinarMinWatchPct
      if (typeof pct === 'number') threshold = pct
    }
    const attended = watchPct >= threshold
    await tx.update(meetupSessionRegistrations).set({ secondsWatched, watchPct: String(watchPct), lastTickAt: now, updatedAt: now }).where(eq(meetupSessionRegistrations.id, r.id))
    if (attended && r.status !== 'attended') await markAttendance(tx, ctx, s, { ...r, secondsWatched, watchPct: String(watchPct) }, 'attended', 'auto')
    return { ok: true as const, secondsWatched, watchPct, attended }
  })
}

/** Дані участі від провайдера чи вручну (docs/18 §7.6): хвилини перераховуються у watch_pct. */
export async function recordParticipation(ctx: Ctx, sessionId: string, rows: { userId: string, minutes: number, joinedAt?: string, leftAt?: string }[], _source: 'provider' | 'manual' = 'manual') {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [s] = await tx.select().from(meetupSessions).where(eq(meetupSessions.id, sessionId))
    if (!s) return null
    const durationSec = Math.max(1, Math.round((s.endsAt.getTime() - s.startsAt.getTime()) / 1000))
    let threshold = DEFAULT_WEBINAR_MIN_WATCH_PCT
    if (s.taskId) {
      const [a] = await tx.select({ params: assignments.params }).from(assignments).where(eq(assignments.id, s.taskId))
      const pct = (a?.params as Record<string, unknown> | undefined)?.webinarMinWatchPct
      if (typeof pct === 'number') threshold = pct
    }
    let attendedN = 0
    for (const p of rows) {
      const seconds = p.minutes * 60
      const watchPct = Math.min(100, Math.round((seconds / durationSec) * 10_000) / 100)
      const attended = watchPct >= threshold
      const [r] = await tx.select().from(meetupSessionRegistrations).where(and(eq(meetupSessionRegistrations.sessionId, sessionId), eq(meetupSessionRegistrations.userId, p.userId)))
      if (!r) continue
      await tx.update(meetupSessionRegistrations).set({ secondsWatched: seconds, watchPct: String(watchPct), updatedAt: new Date() }).where(eq(meetupSessionRegistrations.id, r.id))
      await markAttendance(tx, ctx, s, { ...r, secondsWatched: seconds, watchPct: String(watchPct) }, attended ? 'attended' : 'missed', 'auto')
      if (attended) attendedN++
    }
    return { threshold, attended: attendedN, total: rows.length }
  })
}

// ── Фонові задачі (docs/18 §11) ──────────────────────────────────────────

export async function statusScan(tenantId: string): Promise<{ started: number, finished: number, missed: number }> {
  return withTenant(tenantId, null, async (tx) => {
    const now = new Date()
    const started = await tx.update(meetupSessions).set({ status: 'ongoing', updatedAt: now }).where(and(eq(meetupSessions.status, 'planned'), lte(meetupSessions.startsAt, now))).returning({ id: meetupSessions.id })
    const toFinish = await tx.select().from(meetupSessions).where(and(eq(meetupSessions.status, 'ongoing'), lte(meetupSessions.endsAt, new Date(now.getTime() - H))))
    let missed = 0
    for (const s of toFinish) {
      await tx.update(meetupSessions).set({ status: 'finished', updatedAt: now }).where(eq(meetupSessions.id, s.id))
      const noShow = await tx.update(meetupSessionRegistrations).set({ status: 'missed', updatedAt: now }).where(and(eq(meetupSessionRegistrations.sessionId, s.id), inArray(meetupSessionRegistrations.status, ['registered', 'waitlist']))).returning({ userId: meetupSessionRegistrations.userId })
      missed += noShow.length
      const [m] = await tx.select({ title: meetups.title }).from(meetups).where(eq(meetups.id, s.meetupId))
      if (noShow.length) {
        const names = await tx.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, noShow.map(n => n.userId)))
        const byManager = new Map<string, string[]>()
        // П-16.4: «не прийшов» уходит руководителю человека, а не руководителю его точки.
        for (const [uid, mgr] of await managerIdsOf(tx, noShow.map(n => n.userId))) byManager.set(mgr, [...(byManager.get(mgr) ?? []), names.find(n => n.id === uid)?.fullName ?? '?'])
        for (const n of noShow) await enqueueNotification(tx, { tenantId, userId: n.userId, code: 'meetup_missed', payload: { title: m?.title ?? '' }, dedupKey: `ms_missed:${s.id}:${n.userId}` })
        for (const [mgr, list] of byManager) await enqueueNotification(tx, { tenantId, userId: mgr, code: 'meetup_missed_manager', payload: { title: m?.title ?? '', names: list.join(', ') }, dedupKey: `ms_missed_m:${s.id}:${mgr}` })
      }
    }
    return { started: started.length, finished: toFinish.length, missed }
  })
}

export async function reminderScan(tenantId: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const now = Date.now()
    const upcoming = await tx.select().from(meetupSessions).where(and(eq(meetupSessions.status, 'planned'), gte(meetupSessions.startsAt, new Date(now)), lte(meetupSessions.startsAt, new Date(now + 25 * H))))
    let n = 0
    for (const s of upcoming) {
      const [m] = await tx.select({ title: meetups.title, kind: meetups.kind }).from(meetups).where(eq(meetups.id, s.meetupId))
      const left = s.startsAt.getTime() - now
      const kind = left <= 24 * H && left > 23 * H ? 'day' : (m?.kind === 'webinar' ? left <= 15 * 60_000 : left <= H) && left > 0 ? 'hour' : null
      if (!kind) continue
      const regs = await tx.select({ userId: meetupSessionRegistrations.userId }).from(meetupSessionRegistrations).where(and(eq(meetupSessionRegistrations.sessionId, s.id), eq(meetupSessionRegistrations.status, 'registered')))
      for (const r of regs) {
        if (await enqueueNotification(tx, { tenantId, userId: r.userId, code: kind === 'day' ? 'meetup_reminder_day' : 'meetup_reminder_hour', payload: { title: m?.title ?? '', starts: s.startsAt.toISOString(), room: s.room ?? '' }, dedupKey: `ms_rem_${kind}:${s.id}:${r.userId}`, urgent: kind === 'hour' })) n++
      }
    }
    return n
  })
}

// ── Звіт (docs/18 §9, Г-18.2) ─────────────────────────────────────────────

export interface SessionReportFilter { from?: string, to?: string, scope?: string[] | null, meetupId?: string, sessionId?: string }

/**
 * Звіт по сесіях занять і вебінарів (docs/18 §9, Г-18.2; docs/33 D-030) — на єдиному каркасі звітів (docs/22 §13.3).
 * `sessions` — зведення по сесіях (як і раніше); `people` — рядки «людина × сесія»: перші колонки — каркас
 * (ПІБ · Посада · Місто · Підрозділ · Мітки · Призначено · Завершено · Стан · Результат), далі Г-18.2:
 * очне — Сесія (дата і місце) · Статус реєстрації · Присутність · Хто відмітив · Час відмітки;
 * вебінар — Сесія · Час входу · Час виходу · Хвилин у трансляції · Доля від тривалості.
 * Стан каркаса: attended → done, missed → failed, решта — not_started; результат — доля перегляду вебінару.
 * «Запізнився» в реєстрації немає (Г-18.1: статуси registered|waitlist|attended|missed|cancelled|excused) — не показуємо.
 */
export async function attendanceReport(ctx: Ctx, filter: SessionReportFilter = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const bySession = sql`${filter.meetupId ? sql`and s.meetup_id = ${filter.meetupId}::uuid` : sql``} ${filter.sessionId ? sql`and s.id = ${filter.sessionId}::uuid` : sql``}`
    const where = sql`s.status in ('finished','ongoing','cancelled') ${periodSql(sql`s.starts_at`, filter)} ${bySession}`
    const rows = await tx.execute(sql`
      select s.id, m.title, m.kind, s.starts_at, s.status, s.trainer_ids,
             (select count(*)::int from meetup_session_registrations r where r.session_id = s.id and r.status in ('registered','attended','missed','excused')) as registered,
             (select count(*)::int from meetup_session_registrations r where r.session_id = s.id and r.status = 'attended') as attended,
             (select string_agg(u.full_name, ', ') from meetup_session_registrations r join users u on u.id = r.user_id where r.session_id = s.id and r.status = 'missed') as missed_names
      from meetup_sessions s join meetups m on m.id = s.meetup_id where ${where} order by s.starts_at desc limit 300
    `) as unknown as Record<string, unknown>[]
    const people = await tx.execute(sql`
      select ${frameSelect()},
             ${frameTail({
               assignedAt: sql`r.registered_at`,
               completedAt: sql`case when r.status = 'attended' then coalesce(r.checked_in_at, r.updated_at) end`,
               status: sql`case r.status when 'attended' then 'done' when 'missed' then 'failed' else 'not_started' end`,
               result: sql`case when m.kind = 'webinar' then round(r.watch_pct)::int end`,
             })},
             s.id as session_id, m.id as meetup_id, m.title as session_title, m.kind, s.starts_at as session_at, s.ends_at as session_ends_at,
             nullif(concat_ws(', ', sl.name, s.room, s.address), '') as session_place,
             case r.status when 'waitlist' then 'waitlist' when 'cancelled' then 'not_registered' else 'registered' end as registration_status,
             case r.status when 'attended' then 'came' when 'missed' then 'missed' end as presence,
             mb.full_name as marked_by, r.checked_in_at as marked_at, r.check_in_method,
             case when m.kind = 'webinar' then r.registered_at end as joined_at, case when m.kind = 'webinar' then r.last_tick_at end as left_at,
             case when m.kind = 'webinar' then round(r.seconds_watched / 60.0)::int end as minutes_watched, r.watch_pct
      from meetup_session_registrations r
      join meetup_sessions s on s.id = r.session_id join meetups m on m.id = s.meetup_id
      join users u on u.id = r.user_id ${frameJoins()}
      left join locations sl on sl.id = s.location_id
      left join users mb on mb.id = r.checked_in_by
      where ${where} ${frameWhere({ scope: filter.scope ?? null })}
      order by s.starts_at desc, u.full_name limit 5000
    `) as unknown as Record<string, unknown>[]
    return { sessions: rows, people }
  })
}

/** Рядки «людина × сесія» для вивантаження: каркас першими (docs/22 §13.3). */
export async function attendanceReportRows(ctx: Ctx, filter: SessionReportFilter = {}) {
  const r = await attendanceReport(ctx, filter)
  return frameFirst(r.people.map(({ session_id: _s, meetup_id: _m, ...rest }) => rest))
}

export function toIcs(s: { id: string, title: string, startsAt: Date, endsAt: Date, room?: string | null, address?: string | null, location?: { name: string } | null }): string {
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const where = [s.location?.name, s.room, s.address].filter(Boolean).join(', ')
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Lola LMS//UK', 'BEGIN:VEVENT', `UID:${s.id}@lola`, `DTSTAMP:${fmt(new Date())}`, `DTSTART:${fmt(s.startsAt)}`, `DTEND:${fmt(s.endsAt)}`, `SUMMARY:${s.title.replace(/[,;]/g, ' ')}`, where ? `LOCATION:${where.replace(/[,;]/g, ' ')}` : '', 'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n')
}
