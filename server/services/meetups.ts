import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import { lessonProgress, locations, meetupRegistrations, meetups, userPlacements, users, webinarParticipations, webinars } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { scopeSql } from './access'
import type { TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import { completeLesson } from './learning'

interface Ctx { tenantId: string, actorId: string }

export interface MeetupInput {
  kind?: 'meetup' | 'webinar' | 'event'
  title: string
  description?: unknown[]
  announcement?: unknown[] // «Анонс» (docs/18 §14): обов'язковий для meetup|webinar, читає людина до запису
  tags?: string[]
  courseId?: string | null
  startsAt: string
  endsAt: string
  timezone?: string
  locationId?: string | null
  room?: string | null
  address?: string | null
  trainerIds: string[]
  capacity?: number | null
  waitlistEnabled?: boolean
  enrollDeadlineHours?: number
  cancelDeadlineHours?: number
  attendanceMode?: 'manual' | 'qr' | 'both'
  requiresFeedback?: boolean
  feedbackSurveyId?: string | null
  materials?: string[]
  coverKey?: string | null
  registrationRequired?: boolean
  status?: 'draft' | 'planned'
  webinar?: { provider?: string, joinUrl?: string | null, hostUrl?: string | null, recordUrl?: string | null, recordAvailableUntil?: string | null, autoAttendance?: boolean, minMinutesForAttendance?: number | null }
}

const H = 3_600_000

// ── CRUD ────────────────────────────────────────────────────────────────

export async function createMeetup(ctx: Ctx, input: MeetupInput) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    let timezone = input.timezone
    if (!timezone && input.locationId) {
      const [l] = await tx.select({ tz: locations.timezone }).from(locations).where(eq(locations.id, input.locationId))
      timezone = l?.tz
    }
    const [m] = await tx.insert(meetups).values({
      tenantId: ctx.tenantId, kind: input.kind ?? 'meetup', title: input.title, description: input.description ?? [], announcement: input.announcement ?? [], tags: input.tags ?? [], courseId: input.courseId ?? null,
      startsAt: new Date(input.startsAt), endsAt: new Date(input.endsAt), timezone: timezone ?? 'Europe/Kyiv', locationId: input.locationId ?? null, room: input.room ?? null, address: input.address ?? null,
      trainerIds: input.trainerIds, capacity: input.capacity ?? null, waitlistEnabled: input.waitlistEnabled ?? true, enrollDeadlineHours: input.enrollDeadlineHours ?? 2, cancelDeadlineHours: input.cancelDeadlineHours ?? 24,
      attendanceMode: input.attendanceMode ?? 'manual', qrSecret: randomBytes(24).toString('base64url'), requiresFeedback: input.requiresFeedback ?? true, feedbackSurveyId: input.feedbackSurveyId ?? null,
      materials: input.materials ?? [], status: input.status ?? 'planned', createdBy: ctx.actorId, coverKey: input.coverKey ?? null, registrationRequired: input.registrationRequired ?? true,
    }).returning()
    if ((input.kind ?? 'meetup') === 'webinar') {
      const w = input.webinar ?? {}
      await tx.insert(webinars).values({ tenantId: ctx.tenantId, meetupId: m!.id, provider: w.provider ?? 'other', joinUrl: w.joinUrl ?? null, hostUrl: w.hostUrl ?? null, recordUrl: w.recordUrl ?? null, recordAvailableUntil: w.recordAvailableUntil ? new Date(w.recordAvailableUntil) : null, autoAttendance: w.autoAttendance ?? false, minMinutesForAttendance: w.minMinutesForAttendance ?? null })
    }
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'meetup.create', entity: 'meetup', entityId: m!.id })
    return m!
  }).then(async (m) => {
    // Интеграции (docs/09 §9.1): событие в Google Calendar, Meet/Zoom-ссылка для вебинара — в фоне, ошибки в last_error провайдера
    setImmediate(() => syncExternal(ctx.tenantId, m.id, input.kind === 'webinar' ? input.webinar?.provider : undefined).catch(() => {}))
    return m
  })
}

async function syncExternal(tenantId: string, meetupId: string, webinarProvider?: string) {
  const { createZoomMeeting, syncMeetupToCalendar } = await import('./googleApps')
  const { getSecret, SECRET_KEYS } = await import('./secrets')
  if (webinarProvider === 'zoom' && await getSecret(tenantId, 'zoom', SECRET_KEYS.zoom.REFRESH_TOKEN)) await createZoomMeeting(tenantId, meetupId)
  if (await getSecret(tenantId, 'google', SECRET_KEYS.google.REFRESH_TOKEN)) await syncMeetupToCalendar(tenantId, meetupId)
}

/** Изменение: если сдвинулись дата/время/место — участникам уходит meetup_changed (docs/18 §8). */
export async function updateMeetup(ctx: Ctx, id: string, input: Partial<MeetupInput>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(meetups).where(eq(meetups.id, id))
    if (!before || before.status === 'finished' || before.status === 'cancelled') return null
    const patch: Record<string, unknown> = { updatedAt: new Date() }
    for (const k of ['title', 'description', 'announcement', 'tags', 'courseId', 'timezone', 'locationId', 'room', 'address', 'trainerIds', 'capacity', 'waitlistEnabled', 'enrollDeadlineHours', 'cancelDeadlineHours', 'attendanceMode', 'requiresFeedback', 'feedbackSurveyId', 'materials', 'status', 'coverKey', 'registrationRequired'] as const) {
      if (input[k] !== undefined) patch[k] = input[k]
    }
    if (input.startsAt) patch.startsAt = new Date(input.startsAt)
    if (input.endsAt) patch.endsAt = new Date(input.endsAt)
    const [after] = await tx.update(meetups).set(patch).where(eq(meetups.id, id)).returning()
    if (input.webinar && before.kind === 'webinar') {
      const w = input.webinar
      await tx.update(webinars).set({ ...(w.provider !== undefined ? { provider: w.provider } : {}), ...(w.joinUrl !== undefined ? { joinUrl: w.joinUrl } : {}), ...(w.hostUrl !== undefined ? { hostUrl: w.hostUrl } : {}), ...(w.recordUrl !== undefined ? { recordUrl: w.recordUrl } : {}), ...(w.recordAvailableUntil !== undefined ? { recordAvailableUntil: w.recordAvailableUntil ? new Date(w.recordAvailableUntil) : null } : {}), ...(w.autoAttendance !== undefined ? { autoAttendance: w.autoAttendance } : {}), ...(w.minMinutesForAttendance !== undefined ? { minMinutesForAttendance: w.minMinutesForAttendance } : {}), updatedAt: new Date() }).where(eq(webinars.meetupId, id))
      if (w.recordUrl && !(await tx.select().from(webinars).where(eq(webinars.meetupId, id)))[0]) { /* noop */ }
    }
    const moved = after!.startsAt.getTime() !== before.startsAt.getTime() || after!.endsAt.getTime() !== before.endsAt.getTime() || after!.locationId !== before.locationId || after!.room !== before.room || after!.address !== before.address
    if (moved) {
      const regs = await tx.select({ userId: meetupRegistrations.userId }).from(meetupRegistrations).where(and(eq(meetupRegistrations.meetupId, id), inArray(meetupRegistrations.status, ['registered', 'waitlist'])))
      for (const r of regs) await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: r.userId, code: 'meetup_changed', payload: { title: after!.title, starts: after!.startsAt.toISOString() }, dedupKey: `mt_changed:${id}:${r.userId}:${after!.updatedAt.getTime()}` })
    }
    if (input.webinar?.recordUrl && before.kind === 'webinar') {
      const regs = await tx.select({ userId: meetupRegistrations.userId }).from(meetupRegistrations).where(and(eq(meetupRegistrations.meetupId, id), inArray(meetupRegistrations.status, ['registered', 'attended', 'missed'])))
      for (const r of regs) await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: r.userId, code: 'webinar_record_ready', payload: { title: after!.title }, dedupKey: `wb_record:${id}:${r.userId}` })
    }
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'meetup.update', entity: 'meetup', entityId: id, before: { startsAt: before.startsAt, locationId: before.locationId }, after: { startsAt: after!.startsAt, locationId: after!.locationId } })
    return { after: after!, moved }
  }).then((r) => {
    if (r && r.moved) setImmediate(() => syncExternal(ctx.tenantId, id).catch(() => {}))
    return r ? r.after : null
  })
}

/** Отмена (docs/18 §6.2, §7.10): снимает регистрации, уведомляет участников и руководителей, предлагает альтернативу. */
export async function cancelMeetup(ctx: Ctx, id: string, input: { reason: string, notify?: boolean, alternativeId?: string | null }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [m] = await tx.select().from(meetups).where(and(eq(meetups.id, id), inArray(meetups.status, ['draft', 'planned', 'ongoing'])))
    if (!m) return null
    await tx.update(meetups).set({ status: 'cancelled', cancelReason: input.reason, updatedAt: new Date() }).where(eq(meetups.id, id))
    const regs = await tx.select({ userId: meetupRegistrations.userId, status: meetupRegistrations.status }).from(meetupRegistrations).where(and(eq(meetupRegistrations.meetupId, id), inArray(meetupRegistrations.status, ['registered', 'waitlist'])))
    await tx.update(meetupRegistrations).set({ status: 'cancelled', cancelReason: 'Заняття скасовано', updatedAt: new Date() }).where(and(eq(meetupRegistrations.meetupId, id), inArray(meetupRegistrations.status, ['registered', 'waitlist'])))
    if (input.notify !== false) {
      const [alt] = input.alternativeId ? await tx.select({ title: meetups.title, startsAt: meetups.startsAt }).from(meetups).where(eq(meetups.id, input.alternativeId)) : []
      const managers = new Set<string>()
      if (regs.length) {
        const pl = await tx.select({ managerId: locations.managerId }).from(userPlacements).innerJoin(locations, eq(locations.id, userPlacements.locationId))
          .where(and(inArray(userPlacements.userId, regs.map(r => r.userId)), eq(userPlacements.isPrimary, true), sql`${userPlacements.endedAt} is null`))
        for (const p of pl) if (p.managerId) managers.add(p.managerId)
      }
      const payload = { title: m.title, reason: input.reason, alternative: alt ? `${alt.title} (${alt.startsAt.toISOString()})` : '' }
      for (const u of new Set([...regs.map(r => r.userId), ...managers])) await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: u, code: 'meetup_cancelled', payload, dedupKey: `mt_cancel:${id}:${u}` })
    }
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'meetup.cancel', entity: 'meetup', entityId: id, after: { reason: input.reason, registrations: regs.length } })
    return { cancelled: regs.length }
  }).then((r) => {
    if (r) setImmediate(() => import('./googleApps').then(g => g.removeMeetupFromCalendar(ctx.tenantId, id)).catch(() => {}))
    return r
  })
}

// ── Расписание и карточка (docs/18 §5.1–5.2) ───────────────────────────

export async function schedule(ctx: Ctx, filter: { from?: string, to?: string, mine?: boolean, kind?: string, locationId?: string } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const from = filter.from ? new Date(filter.from) : new Date(Date.now() - 7 * 86_400_000)
    const to = filter.to ? new Date(filter.to) : new Date(Date.now() + 60 * 86_400_000)
    const rows = await tx.execute(sql`
      select m.id, m.kind, m.title, m.starts_at, m.ends_at, m.timezone, m.status, m.capacity, m.room, m.address, m.trainer_ids, m.enroll_deadline_hours, m.attendance_mode,
             l.name as location,
             (select count(*)::int from meetup_registrations r where r.meetup_id = m.id and r.status in ('registered','attended')) as registered,
             (select count(*)::int from meetup_registrations r where r.meetup_id = m.id and r.status = 'waitlist') as waitlist,
             (select r.status from meetup_registrations r where r.meetup_id = m.id and r.user_id = ${ctx.actorId}::uuid) as my_status,
             (select r.waitlist_position from meetup_registrations r where r.meetup_id = m.id and r.user_id = ${ctx.actorId}::uuid) as my_waitlist_position
      from meetups m left join locations l on l.id = m.location_id
      where m.status <> 'draft' and m.starts_at >= ${from.toISOString()}::timestamptz and m.starts_at <= ${to.toISOString()}::timestamptz
        ${filter.kind ? sql`and m.kind = ${filter.kind}` : sql``}
        ${filter.locationId ? sql`and m.location_id = ${filter.locationId}::uuid` : sql``}
        ${filter.mine ? sql`and exists (select 1 from meetup_registrations r where r.meetup_id = m.id and r.user_id = ${ctx.actorId}::uuid and r.status in ('registered','waitlist','attended'))` : sql``}
      order by m.starts_at
    `) as unknown as Record<string, unknown>[]
    const trainerIds = [...new Set(rows.flatMap(r => r.trainer_ids as string[]))]
    const trainers = trainerIds.length ? await tx.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, trainerIds)) : []
    const tn = new Map(trainers.map(t => [t.id, t.fullName]))
    return rows.map(r => ({ ...(r as Record<string, unknown>), id: String(r.id), trainers: (r.trainer_ids as string[]).map(id => tn.get(id) ?? '?'), seatsLeft: r.capacity != null ? Math.max(0, Number(r.capacity) - Number(r.registered)) : null, enrollOpen: enrollOpen(r as { starts_at: string, enroll_deadline_hours: number, status: string }) }))
  })
}

function enrollOpen(m: { starts_at: string | Date, enroll_deadline_hours: number, status: string }): boolean {
  return m.status === 'planned' && Date.now() < new Date(m.starts_at).getTime() - m.enroll_deadline_hours * H
}

export async function getMeetup(ctx: Ctx, id: string, opts: { manage?: boolean } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [m] = await tx.select().from(meetups).where(eq(meetups.id, id))
    if (!m) return null
    const [loc] = m.locationId ? await tx.select({ name: locations.name, address: locations.address }).from(locations).where(eq(locations.id, m.locationId)) : []
    const trainers = m.trainerIds.length ? await tx.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, m.trainerIds)) : []
    const [w] = m.kind === 'webinar' ? await tx.select().from(webinars).where(eq(webinars.meetupId, id)) : []
    const regs = await tx.select({ id: meetupRegistrations.id, userId: meetupRegistrations.userId, status: meetupRegistrations.status, waitlistPosition: meetupRegistrations.waitlistPosition, checkedInAt: meetupRegistrations.checkedInAt, checkInMethod: meetupRegistrations.checkInMethod, registeredAt: meetupRegistrations.registeredAt, cancelReason: meetupRegistrations.cancelReason, fullName: users.fullName })
      .from(meetupRegistrations).innerJoin(users, eq(users.id, meetupRegistrations.userId)).where(eq(meetupRegistrations.meetupId, id)).orderBy(asc(meetupRegistrations.registeredAt))
    const mine = regs.find(r => r.userId === ctx.actorId) ?? null
    const registered = regs.filter(r => ['registered', 'attended'].includes(r.status)).length
    const isTrainer = m.trainerIds.includes(ctx.actorId)
    const now = Date.now()
    const materialsOpen = now >= m.startsAt.getTime() - 24 * H
    // Ссылка на вебинар — за 15 минут до начала (docs/18 §5.2)
    const joinOpen = m.kind === 'webinar' && now >= m.startsAt.getTime() - 15 * 60_000 && now <= m.endsAt.getTime() + 30 * 60_000
    const full = opts.manage || isTrainer
    return {
      ...m, qrSecret: undefined, location: loc ?? null, trainers, webinar: w ? { ...w, hostUrl: full ? w.hostUrl : undefined, joinUrl: joinOpen || full ? w.joinUrl : null, recordUrl: (w.recordAvailableUntil == null || w.recordAvailableUntil.getTime() > now) ? w.recordUrl : null } : null,
      registered, waitlist: regs.filter(r => r.status === 'waitlist').length, seatsLeft: m.capacity != null ? Math.max(0, m.capacity - registered) : null,
      mine, enrollOpen: enrollOpen({ starts_at: m.startsAt, enroll_deadline_hours: m.enrollDeadlineHours, status: m.status }), canCancel: now < m.startsAt.getTime() - m.cancelDeadlineHours * H,
      materials: materialsOpen || full ? m.materials : [], materialsOpenAt: new Date(m.startsAt.getTime() - 24 * H), isTrainer,
      participants: full ? regs : undefined,
    }
  })
}

// ── Запись, очередь, отмена (docs/18 §7.1–7.3) ─────────────────────────

export type RegisterResult = { ok: true, status: 'registered' | 'waitlist', waitlistPosition?: number, conflict?: string } | { ok: false, code: 'not_found' | 'closed' | 'full' | 'already' }

export async function register(ctx: Ctx, meetupId: string, userId: string, opts: { enrollmentId?: string, lessonId?: string, guestsCount?: number } = {}): Promise<RegisterResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [m] = await tx.select().from(meetups).where(eq(meetups.id, meetupId))
    if (!m) return { ok: false as const, code: 'not_found' as const }
    const byOther = userId !== ctx.actorId
    if (!byOther && !enrollOpen({ starts_at: m.startsAt, enroll_deadline_hours: m.enrollDeadlineHours, status: m.status })) return { ok: false as const, code: 'closed' as const }
    if (byOther && !['planned', 'ongoing'].includes(m.status)) return { ok: false as const, code: 'closed' as const }
    const [existing] = await tx.select().from(meetupRegistrations).where(and(eq(meetupRegistrations.meetupId, meetupId), eq(meetupRegistrations.userId, userId)))
    if (existing && !['cancelled'].includes(existing.status)) return { ok: false as const, code: 'already' as const }
    // Гости на событие (docs/21 §3.4) занимают места вместе с участником
    const guests = m.kind === 'event' ? Math.max(0, Math.min(10, opts.guestsCount ?? 0)) : 0
    const [cnt] = await tx.select({ n: sql<number>`coalesce(sum(1 + guests_count), 0)::int` }).from(meetupRegistrations).where(and(eq(meetupRegistrations.meetupId, meetupId), inArray(meetupRegistrations.status, ['registered', 'attended'])))
    const hasSeat = m.capacity == null || cnt!.n + guests < m.capacity
    if (!hasSeat && !m.waitlistEnabled) return { ok: false as const, code: 'full' as const }
    let waitlistPosition: number | undefined
    if (!hasSeat) {
      const [wl] = await tx.select({ n: sql<number>`coalesce(max(waitlist_position), 0)::int` }).from(meetupRegistrations).where(and(eq(meetupRegistrations.meetupId, meetupId), eq(meetupRegistrations.status, 'waitlist')))
      waitlistPosition = wl!.n + 1
    }
    const values = { status: hasSeat ? 'registered' : 'waitlist', registeredAt: new Date(), registeredBy: ctx.actorId, waitlistPosition: waitlistPosition ?? null, cancelReason: null, enrollmentId: opts.enrollmentId ?? null, lessonId: opts.lessonId ?? null, guestsCount: guests, updatedAt: new Date() }
    if (existing) await tx.update(meetupRegistrations).set(values).where(eq(meetupRegistrations.id, existing.id))
    else await tx.insert(meetupRegistrations).values({ tenantId: ctx.tenantId, meetupId, userId, ...values })
    // Конфликт расписания (docs/18 §7.9): предупреждаем, не запрещаем
    const [conflict] = await tx.select({ title: meetups.title }).from(meetupRegistrations).innerJoin(meetups, eq(meetups.id, meetupRegistrations.meetupId))
      .where(and(eq(meetupRegistrations.userId, userId), inArray(meetupRegistrations.status, ['registered', 'waitlist']), sql`${meetups.id} <> ${meetupId}::uuid`, sql`${meetups.status} in ('planned','ongoing')`, lte(meetups.startsAt, m.endsAt), gte(meetups.endsAt, m.startsAt)))
    await enqueueNotification(tx, { tenantId: ctx.tenantId, userId, code: hasSeat ? 'meetup_registered' : 'meetup_waitlisted', payload: { title: m.title, starts: m.startsAt.toISOString(), position: waitlistPosition ?? '' }, dedupKey: `mt_reg:${meetupId}:${userId}:${hasSeat ? 'r' : 'w'}` })
    return { ok: true as const, status: hasSeat ? 'registered' as const : 'waitlist' as const, waitlistPosition, conflict: conflict?.title }
  })
}

export type UnregisterResult = { ok: true } | { ok: false, code: 'not_found' | 'cancel_deadline_passed' }

export async function unregister(ctx: Ctx, meetupId: string, userId: string, reason?: string): Promise<UnregisterResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [m] = await tx.select().from(meetups).where(eq(meetups.id, meetupId))
    const [r] = await tx.select().from(meetupRegistrations).where(and(eq(meetupRegistrations.meetupId, meetupId), eq(meetupRegistrations.userId, userId), inArray(meetupRegistrations.status, ['registered', 'waitlist'])))
    if (!m || !r) return { ok: false as const, code: 'not_found' as const }
    if (userId === ctx.actorId && Date.now() >= m.startsAt.getTime() - m.cancelDeadlineHours * H) return { ok: false as const, code: 'cancel_deadline_passed' as const }
    await tx.update(meetupRegistrations).set({ status: 'cancelled', cancelReason: reason ?? null, waitlistPosition: null, updatedAt: new Date() }).where(eq(meetupRegistrations.id, r.id))
    if (r.status === 'registered') await promoteWaitlist(tx, ctx.tenantId, m)
    return { ok: true as const }
  })
}

/** Освободилось место → первый из очереди получает его и уведомление (docs/18 §7.2). */
async function promoteWaitlist(tx: TenantTx, tenantId: string, m: typeof meetups.$inferSelect): Promise<string | null> {
  const [cnt] = await tx.select({ n: sql<number>`count(*)::int` }).from(meetupRegistrations).where(and(eq(meetupRegistrations.meetupId, m.id), inArray(meetupRegistrations.status, ['registered', 'attended'])))
  if (m.capacity != null && cnt!.n >= m.capacity) return null
  const [next] = await tx.select().from(meetupRegistrations).where(and(eq(meetupRegistrations.meetupId, m.id), eq(meetupRegistrations.status, 'waitlist'))).orderBy(asc(meetupRegistrations.waitlistPosition), asc(meetupRegistrations.registeredAt)).limit(1)
  if (!next) return null
  await tx.update(meetupRegistrations).set({ status: 'registered', waitlistPosition: null, updatedAt: new Date() }).where(eq(meetupRegistrations.id, next.id))
  await tx.execute(sql`update meetup_registrations set waitlist_position = waitlist_position - 1 where meetup_id = ${m.id}::uuid and status = 'waitlist' and waitlist_position > ${next.waitlistPosition ?? 0}`)
  await enqueueNotification(tx, { tenantId, userId: next.userId, code: 'meetup_seat_freed', payload: { title: m.title, starts: m.startsAt.toISOString() }, dedupKey: `mt_seat:${m.id}:${next.userId}` })
  return next.userId
}

// ── Посещаемость: QR и вручную (docs/18 §5.3–5.4, §7.5) ───────────────

const QR_WINDOW_SEC = 30

function qrToken(m: { id: string, qrSecret: string }, windowIdx: number): string {
  return createHmac('sha256', m.qrSecret).update(`${m.id}:${windowIdx}`).digest('base64url').slice(0, 20)
}

/** Текущий код для экрана тренера: живёт 30 секунд. */
export async function currentQr(ctx: Ctx, meetupId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [m] = await tx.select({ id: meetups.id, qrSecret: meetups.qrSecret, attendanceMode: meetups.attendanceMode }).from(meetups).where(eq(meetups.id, meetupId))
    if (!m || m.attendanceMode === 'manual') return null
    const idx = Math.floor(Date.now() / 1000 / QR_WINDOW_SEC)
    return { token: `${meetupId}.${idx}.${qrToken(m, idx)}`, expiresInSec: QR_WINDOW_SEC - (Math.floor(Date.now() / 1000) % QR_WINDOW_SEC) }
  })
}

export type CheckinResult = { ok: true, checkedInAt: Date, title: string } | { ok: false, code: 'bad_token' | 'expired' | 'not_registered' | 'outside_window' | 'already', meetupId?: string, seatsLeft?: number | null }

/** Отметка по QR (docs/18 §7.5): токен = meetupId.окно.hmac; принимается текущее и предыдущее окно; интервал starts−30м … ends+30м. */
export async function checkin(ctx: Ctx, token: string): Promise<CheckinResult> {
  const [meetupId, idxStr, sig] = token.split('.')
  if (!meetupId || !idxStr || !sig) return { ok: false, code: 'bad_token' }
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [m] = await tx.select().from(meetups).where(eq(meetups.id, meetupId))
    if (!m) return { ok: false as const, code: 'bad_token' as const }
    const idx = Number(idxStr)
    const expected = qrToken(m, idx)
    const a = Buffer.from(sig), b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'meetup.checkin.rejected', entity: 'meetup', entityId: meetupId, after: { reason: 'bad_token' } })
      return { ok: false as const, code: 'bad_token' as const }
    }
    const nowIdx = Math.floor(Date.now() / 1000 / QR_WINDOW_SEC)
    if (nowIdx - idx > 1 || idx > nowIdx) {
      await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'meetup.checkin.rejected', entity: 'meetup', entityId: meetupId, after: { reason: 'expired', ageSec: (nowIdx - idx) * QR_WINDOW_SEC } })
      return { ok: false as const, code: 'expired' as const }
    }
    const now = Date.now()
    if (now < m.startsAt.getTime() - 30 * 60_000 || now > m.endsAt.getTime() + 30 * 60_000) return { ok: false as const, code: 'outside_window' as const }
    const [r] = await tx.select().from(meetupRegistrations).where(and(eq(meetupRegistrations.meetupId, meetupId), eq(meetupRegistrations.userId, ctx.actorId)))
    if (!r || !['registered', 'waitlist'].includes(r.status)) {
      if (r?.status === 'attended') return { ok: false as const, code: 'already' as const }
      const [cnt] = await tx.select({ n: sql<number>`count(*)::int` }).from(meetupRegistrations).where(and(eq(meetupRegistrations.meetupId, meetupId), inArray(meetupRegistrations.status, ['registered', 'attended'])))
      return { ok: false as const, code: 'not_registered' as const, meetupId, seatsLeft: m.capacity != null ? Math.max(0, m.capacity - cnt!.n) : null }
    }
    await markAttendance(tx, ctx, m, r, 'attended', 'qr')
    return { ok: true as const, checkedInAt: new Date(), title: m.title }
  })
}

async function markAttendance(tx: TenantTx, ctx: Ctx, m: typeof meetups.$inferSelect, r: typeof meetupRegistrations.$inferSelect, status: 'attended' | 'missed' | 'excused', method: 'manual' | 'qr' | 'auto', reason?: string) {
  const now = new Date()
  await tx.update(meetupRegistrations).set({ status, checkedInAt: status === 'attended' ? now : r.checkedInAt, checkInMethod: status === 'attended' ? method : r.checkInMethod, checkedInBy: method === 'manual' ? ctx.actorId : null, cancelReason: reason ?? r.cancelReason, waitlistPosition: null, updatedAt: now }).where(eq(meetupRegistrations.id, r.id))
  await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'meetup.attendance', entity: 'meetup_registration', entityId: r.id, before: { status: r.status }, after: { status, method, by: ctx.actorId } })
  // Зачёт в курсе (docs/18 §7.7, docs/29 Б.3): занятие как урок засчитывается при attended —
  // прогресс урока ставим напрямую (как тест/практикум, attempts.ts onAttemptPassed), а
  // completeLesson дальше только пересчитывает прогресс курса.
  if (status === 'attended' && r.enrollmentId && r.lessonId) {
    const enrollmentId = r.enrollmentId, lessonId = r.lessonId
    await tx.insert(lessonProgress).values({ tenantId: ctx.tenantId, enrollmentId, lessonId, status: 'completed', completedAt: now })
      .onConflictDoUpdate({ target: [lessonProgress.tenantId, lessonProgress.enrollmentId, lessonProgress.lessonId], set: { status: 'completed', completedAt: now } })
    setImmediate(() => completeLesson({ tenantId: ctx.tenantId, actorId: r.userId }, enrollmentId, lessonId).catch(() => {}))
  }
  // docs/33 D-020: відмітка відвідування самостійного заняття/вебінару — єдиний хук (attended → done, missed → failed); у складі курсу фіксує курс
  if ((status === 'attended' || status === 'missed') && !r.lessonId) {
    const { onTaskCompleted } = await import('./taskCompletion')
    await onTaskCompleted(tx, ctx.tenantId, r.userId, { contentType: m.kind === 'webinar' ? 'webinar' : 'meetup', contentId: m.id, status: status === 'attended' ? 'done' : 'failed', enrollmentId: r.enrollmentId, sourceKind: 'meetup_attendance', sourceId: r.id, actorId: ctx.actorId === r.userId ? null : ctx.actorId })
  }
  // Занятие как узел программы (docs/17 §7.4)
  if (status === 'attended' || status === 'missed') setImmediate(() => { import('./programs').then(p => p.onItemResult(ctx.tenantId, r.userId, m.kind === 'webinar' ? 'webinar' : 'meetup', m.id, { passed: status === 'attended' })).catch(() => {}); import('./trajectories').then(t => t.onTaskResult(ctx.tenantId, r.userId, m.kind === 'webinar' ? 'webinar' : 'meetup', m.id, { passed: status === 'attended' })).catch(() => {}) })
}

export async function setAttendance(ctx: Ctx, meetupId: string, input: { userId: string, status: 'attended' | 'missed' | 'excused', reason?: string }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [m] = await tx.select().from(meetups).where(eq(meetups.id, meetupId))
    if (!m) return null
    const [r] = await tx.select().from(meetupRegistrations).where(and(eq(meetupRegistrations.meetupId, meetupId), eq(meetupRegistrations.userId, input.userId)))
    if (!r) return null
    await markAttendance(tx, ctx, m, r, input.status, 'manual', input.reason)
    return { status: input.status }
  })
}

export async function registerOthers(ctx: Ctx, meetupId: string, userIds: string[]) {
  const out: Record<string, RegisterResult> = {}
  for (const u of userIds) out[u] = await register(ctx, meetupId, u)
  return out
}

// ── Вебинары: участие (docs/18 §3.3, §7.6) ──────────────────────────────

/** Данные участия (от провайдера через API или вручную): attended = minutes ≥ порога (по умолчанию 70% длительности). */
export async function recordParticipation(ctx: Ctx, meetupId: string, rows: { userId: string, minutes: number, joinedAt?: string, leftAt?: string }[], source: 'provider' | 'manual' = 'manual') {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [m] = await tx.select().from(meetups).where(and(eq(meetups.id, meetupId), eq(meetups.kind, 'webinar')))
    const [w] = m ? await tx.select().from(webinars).where(eq(webinars.meetupId, meetupId)) : []
    if (!m || !w) return null
    const durationMin = Math.round((m.endsAt.getTime() - m.startsAt.getTime()) / 60_000)
    const threshold = w.minMinutesForAttendance ?? Math.ceil(durationMin * 0.7)
    let attendedN = 0
    for (const p of rows) {
      const attended = p.minutes >= threshold
      await tx.insert(webinarParticipations).values({ tenantId: ctx.tenantId, webinarId: w.id, userId: p.userId, minutes: p.minutes, joinedAt: p.joinedAt ? new Date(p.joinedAt) : null, leftAt: p.leftAt ? new Date(p.leftAt) : null, attended, source })
        .onConflictDoUpdate({ target: [webinarParticipations.webinarId, webinarParticipations.userId], set: { minutes: p.minutes, attended, source, updatedAt: new Date() } })
      const [r] = await tx.select().from(meetupRegistrations).where(and(eq(meetupRegistrations.meetupId, meetupId), eq(meetupRegistrations.userId, p.userId)))
      if (r && ['registered', 'waitlist', 'missed'].includes(r.status)) {
        await markAttendance(tx, ctx, m, r, attended ? 'attended' : 'missed', 'auto')
      }
      if (attended) attendedN++
    }
    return { threshold, attended: attendedN, total: rows.length }
  })
}

// ── Фоновые задачи (docs/18 §11) ────────────────────────────────────────

/** planned → ongoing в starts_at; ongoing → finished через час после ends_at, неявки → missed, руководителю список. */
export async function statusScan(tenantId: string): Promise<{ started: number, finished: number, missed: number }> {
  return withTenant(tenantId, null, async (tx) => {
    const now = new Date()
    const started = await tx.update(meetups).set({ status: 'ongoing', updatedAt: now }).where(and(eq(meetups.status, 'planned'), lte(meetups.startsAt, now))).returning({ id: meetups.id })
    const toFinish = await tx.select().from(meetups).where(and(eq(meetups.status, 'ongoing'), lte(meetups.endsAt, new Date(now.getTime() - H))))
    let missed = 0
    for (const m of toFinish) {
      await tx.update(meetups).set({ status: 'finished', updatedAt: now }).where(eq(meetups.id, m.id))
      const noShow = await tx.update(meetupRegistrations).set({ status: 'missed', updatedAt: now }).where(and(eq(meetupRegistrations.meetupId, m.id), inArray(meetupRegistrations.status, ['registered', 'waitlist']))).returning({ userId: meetupRegistrations.userId })
      missed += noShow.length
      if (noShow.length) {
        const names = await tx.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, noShow.map(n => n.userId)))
        const byManager = new Map<string, string[]>()
        const pl = await tx.select({ userId: userPlacements.userId, managerId: locations.managerId }).from(userPlacements).innerJoin(locations, eq(locations.id, userPlacements.locationId)).where(and(inArray(userPlacements.userId, noShow.map(n => n.userId)), eq(userPlacements.isPrimary, true), sql`${userPlacements.endedAt} is null`))
        for (const p of pl) if (p.managerId) byManager.set(p.managerId, [...(byManager.get(p.managerId) ?? []), names.find(n => n.id === p.userId)?.fullName ?? '?'])
        for (const n of noShow) await enqueueNotification(tx, { tenantId, userId: n.userId, code: 'meetup_missed', payload: { title: m.title }, dedupKey: `mt_missed:${m.id}:${n.userId}` })
        for (const [mgr, list] of byManager) await enqueueNotification(tx, { tenantId, userId: mgr, code: 'meetup_missed_manager', payload: { title: m.title, names: list.join(', ') }, dedupKey: `mt_missed_m:${m.id}:${mgr}` })
      }
      if (m.requiresFeedback) {
        const att = await tx.select({ userId: meetupRegistrations.userId }).from(meetupRegistrations).where(and(eq(meetupRegistrations.meetupId, m.id), eq(meetupRegistrations.status, 'attended')))
        for (const a of att) await enqueueNotification(tx, { tenantId, userId: a.userId, code: 'meetup_feedback_request', payload: { title: m.title, meetupId: m.id }, dedupKey: `mt_fb:${m.id}:${a.userId}` })
      }
    }
    return { started: started.length, finished: toFinish.length, missed }
  })
}

/** Напоминания: за сутки и за час (вебинар — за 15 минут). Вызывается каждые 5 минут. */
export async function reminderScan(tenantId: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const now = Date.now()
    const upcoming = await tx.select().from(meetups).where(and(eq(meetups.status, 'planned'), gte(meetups.startsAt, new Date(now)), lte(meetups.startsAt, new Date(now + 25 * H))))
    let n = 0
    for (const m of upcoming) {
      const left = m.startsAt.getTime() - now
      const kind = left <= 24 * H && left > 23 * H ? 'day' : (m.kind === 'webinar' ? left <= 15 * 60_000 : left <= H) && left > 0 ? 'hour' : null
      if (!kind) continue
      const regs = await tx.select({ userId: meetupRegistrations.userId }).from(meetupRegistrations).where(and(eq(meetupRegistrations.meetupId, m.id), eq(meetupRegistrations.status, 'registered')))
      for (const r of regs) {
        if (await enqueueNotification(tx, { tenantId, userId: r.userId, code: kind === 'day' ? 'meetup_reminder_day' : 'meetup_reminder_hour', payload: { title: m.title, starts: m.startsAt.toISOString(), room: m.room ?? '' }, dedupKey: `mt_rem_${kind}:${m.id}:${r.userId}`, urgent: kind === 'hour' })) n++
      }
    }
    return n
  })
}

// ── ics и отчёты (docs/18 §5.1, §9) ─────────────────────────────────────

export function toIcs(m: { id: string, title: string, startsAt: Date, endsAt: Date, room?: string | null, address?: string | null, location?: { name: string } | null }): string {
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const where = [m.location?.name, m.room, m.address].filter(Boolean).join(', ')
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Lola LMS//UK', 'BEGIN:VEVENT', `UID:${m.id}@lola`, `DTSTAMP:${fmt(new Date())}`, `DTSTART:${fmt(m.startsAt)}`, `DTEND:${fmt(m.endsAt)}`, `SUMMARY:${m.title.replace(/[,;]/g, ' ')}`, where ? `LOCATION:${where.replace(/[,;]/g, ' ')}` : '', 'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n')
}

export async function attendanceReport(ctx: Ctx, filter: { from?: string, to?: string, scope?: string[] | null } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    // Область видимости: занятие на точке или без точки (вебинары сети) — по участникам этих точек
    const scope = filter.scope ?? null
    const scoped = scope === null ? sql`` : sql`and (m.location_id in (select x from unnest(array[${sql.join(scope.length ? scope.map(i => sql`${i}::uuid`) : [sql`null::uuid`], sql`, `)}]) x) or (m.location_id is null and exists (select 1 from meetup_registrations rr join user_placements up on up.user_id = rr.user_id and up.is_primary and up.ended_at is null where rr.meetup_id = m.id ${scopeSql(scope, sql`up.location_id`)})))`
    const where = sql`m.status in ('finished','ongoing','cancelled') ${filter.from ? sql`and m.starts_at >= ${filter.from}::date` : sql``} ${filter.to ? sql`and m.starts_at < (${filter.to}::date + 1)` : sql``} ${scoped}`
    const meetupsRows = await tx.execute(sql`
      select m.id, m.kind, m.title, m.starts_at, m.status, m.trainer_ids,
             (select count(*)::int from meetup_registrations r where r.meetup_id = m.id and r.status in ('registered','attended','missed','excused')) as registered,
             (select count(*)::int from meetup_registrations r where r.meetup_id = m.id and r.status = 'attended') as attended,
             (select string_agg(u.full_name, ', ') from meetup_registrations r join users u on u.id = r.user_id where r.meetup_id = m.id and r.status = 'missed') as missed_names
      from meetups m where ${where} order by m.starts_at desc limit 300
    `) as unknown as Record<string, unknown>[]
    const byTrainer = await tx.execute(sql`
      select u.full_name as trainer, count(distinct m.id)::int as meetups,
             round(avg((select count(*) from meetup_registrations r where r.meetup_id = m.id and r.status = 'attended')::numeric / nullif((select count(*) from meetup_registrations r where r.meetup_id = m.id and r.status in ('registered','attended','missed','excused')), 0) * 100), 1) as avg_attendance
      from meetups m cross join unnest(m.trainer_ids) t(id) join users u on u.id = t.id
      where ${where} and m.status = 'finished' group by 1 order by 2 desc
    `) as unknown as Record<string, unknown>[]
    const byPerson = await tx.execute(sql`
      select u.full_name, count(*)::int as missed from meetup_registrations r join users u on u.id = r.user_id join meetups m on m.id = r.meetup_id
      where r.status = 'missed' and ${where} group by 1 having count(*) > 0 order by 2 desc limit 100
    `) as unknown as Record<string, unknown>[]
    return { meetups: meetupsRows, byTrainer, byPerson }
  })
}

