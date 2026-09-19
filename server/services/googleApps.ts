import { and, eq, sql } from 'drizzle-orm'
import { meetups, webinars } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { SECRET_KEYS, getSecret } from './secrets'
import { providerFetch } from './oauth'
import { applyImport, validateImport } from './importPeople'

/**
 * Применения подключённых провайдеров (docs/09 §9.1, docs/18 §3.3):
 * Google Calendar — событие на каждое занятие, Meet/Zoom — ссылка вебинара,
 * Google Workspace Directory — импорт людей через тот же валидатор, что и файл.
 */

interface Ctx { tenantId: string, actorId: string }

const CAL = 'https://www.googleapis.com/calendar/v3'

async function calendarId(tenantId: string): Promise<string> {
  return (await getSecret(tenantId, 'google', SECRET_KEYS.google.CALENDAR_ID)) ?? 'primary'
}

/** Создать/обновить событие календаря для занятия; для вебинара с provider=meet — Meet-ссылка через conferenceData. */
export async function syncMeetupToCalendar(tenantId: string, meetupId: string): Promise<{ ok: true, eventId: string, joinUrl?: string } | { ok: false, error: string }> {
  const [m] = await withTenant(tenantId, null, tx => tx.select().from(meetups).where(eq(meetups.id, meetupId)))
  if (!m) return { ok: false, error: 'not_found' }
  const [w] = m.kind === 'webinar' ? await withTenant(tenantId, null, tx => tx.select().from(webinars).where(eq(webinars.meetupId, meetupId))) : []
  const wantMeet = w?.provider === 'meet' && !w.joinUrl
  const body: Record<string, unknown> = {
    summary: m.title, location: [m.room, m.address].filter(Boolean).join(', ') || undefined,
    start: { dateTime: m.startsAt.toISOString(), timeZone: m.timezone }, end: { dateTime: m.endsAt.toISOString(), timeZone: m.timezone },
    ...(wantMeet ? { conferenceData: { createRequest: { requestId: meetupId, conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : {}),
  }
  const cal = encodeURIComponent(await calendarId(tenantId))
  const url = m.externalEventId ? `${CAL}/calendars/${cal}/events/${m.externalEventId}?conferenceDataVersion=1` : `${CAL}/calendars/${cal}/events?conferenceDataVersion=1`
  const r = await providerFetch(tenantId, 'google', url, { method: m.externalEventId ? 'PATCH' : 'POST', body: JSON.stringify(body) })
  if (!r.ok) return { ok: false, error: r.error }
  const ev = r.json as { id: string, hangoutLink?: string }
  await withTenant(tenantId, null, async (tx) => {
    await tx.update(meetups).set({ externalEventId: ev.id }).where(eq(meetups.id, meetupId))
    if (wantMeet && ev.hangoutLink && w) await tx.update(webinars).set({ joinUrl: ev.hangoutLink, externalMeetingId: ev.id }).where(eq(webinars.id, w.id))
  })
  return { ok: true, eventId: ev.id, joinUrl: ev.hangoutLink }
}

export async function removeMeetupFromCalendar(tenantId: string, meetupId: string): Promise<boolean> {
  const [m] = await withTenant(tenantId, null, tx => tx.select({ externalEventId: meetups.externalEventId }).from(meetups).where(eq(meetups.id, meetupId)))
  if (!m?.externalEventId) return false
  const cal = encodeURIComponent(await calendarId(tenantId))
  const r = await providerFetch(tenantId, 'google', `${CAL}/calendars/${cal}/events/${m.externalEventId}`, { method: 'DELETE' })
  if (r.ok) await withTenant(tenantId, null, tx => tx.update(meetups).set({ externalEventId: null }).where(eq(meetups.id, meetupId)))
  return r.ok
}

/** Zoom-встреча для вебинара: join_url участникам, start_url тренеру. */
export async function createZoomMeeting(tenantId: string, meetupId: string): Promise<{ ok: true, joinUrl: string } | { ok: false, error: string }> {
  const [m] = await withTenant(tenantId, null, tx => tx.select().from(meetups).where(and(eq(meetups.id, meetupId), eq(meetups.kind, 'webinar'))))
  const [w] = m ? await withTenant(tenantId, null, tx => tx.select().from(webinars).where(eq(webinars.meetupId, meetupId))) : []
  if (!m || !w) return { ok: false, error: 'not_found' }
  const r = await providerFetch(tenantId, 'zoom', 'https://api.zoom.us/v2/users/me/meetings', { method: 'POST', body: JSON.stringify({ topic: m.title, type: 2, start_time: m.startsAt.toISOString(), duration: Math.round((m.endsAt.getTime() - m.startsAt.getTime()) / 60_000), timezone: m.timezone, settings: { join_before_host: false, waiting_room: true } }) })
  if (!r.ok) return { ok: false, error: r.error }
  const j = r.json as { id: number, join_url: string, start_url: string }
  await withTenant(tenantId, null, tx => tx.update(webinars).set({ joinUrl: j.join_url, hostUrl: j.start_url, externalMeetingId: String(j.id), provider: 'zoom' }).where(eq(webinars.id, w.id)))
  return { ok: true, joinUrl: j.join_url }
}

/** Участие из Zoom-отчёта (docs/18 §7.6): минуты по e-mail участника → recordParticipation. */
export async function fetchZoomAttendance(tenantId: string, meetupId: string): Promise<{ userId: string, minutes: number }[] | null> {
  const [w] = await withTenant(tenantId, null, tx => tx.select().from(webinars).where(eq(webinars.meetupId, meetupId)))
  if (!w?.externalMeetingId) return null
  const r = await providerFetch(tenantId, 'zoom', `https://api.zoom.us/v2/report/meetings/${w.externalMeetingId}/participants?page_size=300`)
  if (!r.ok) return null
  const j = r.json as { participants?: { user_email?: string, duration?: number }[] }
  const byEmail = new Map<string, number>()
  for (const p of j.participants ?? []) if (p.user_email) byEmail.set(p.user_email.toLowerCase(), (byEmail.get(p.user_email.toLowerCase()) ?? 0) + Math.round((p.duration ?? 0) / 60))
  if (!byEmail.size) return []
  const rows = await withTenant(tenantId, null, tx => tx.execute(sql`select id, lower(email) as email from users where lower(email) in (${sql.join([...byEmail.keys()].map(e => sql`${e}`), sql`, `)})`)) as unknown as { id: string, email: string }[]
  return rows.map(u => ({ userId: u.id, minutes: byEmail.get(u.email) ?? 0 }))
}

/** Импорт людей из Google Workspace Directory: тот же валидатор и протокол, что у файла (docs/09 §9.1). */
export async function importFromWorkspace(ctx: Ctx, opts: { domain?: string, apply?: boolean, defaultPosition: string, defaultOrgUnit: string, defaultLocation: string }) {
  const users: { fullName: string, phone: string, email: string, externalId: string, orgUnit: string }[] = []
  let pageToken: string | undefined
  do {
    const q = new URLSearchParams({ customer: 'my_customer', maxResults: '200', ...(opts.domain ? { domain: opts.domain } : {}), ...(pageToken ? { pageToken } : {}) })
    const r = await providerFetch(ctx.tenantId, 'google', `https://admin.googleapis.com/admin/directory/v1/users?${q}`)
    if (!r.ok) return { ok: false as const, error: r.error }
    const j = r.json as { users?: { id: string, primaryEmail: string, name: { fullName: string }, phones?: { value: string, primary?: boolean }[], orgUnitPath?: string, suspended?: boolean }[], nextPageToken?: string }
    for (const u of j.users ?? []) {
      if (u.suspended) continue
      const phone = (u.phones?.find(p => p.primary) ?? u.phones?.[0])?.value ?? ''
      users.push({ fullName: u.name.fullName, phone, email: u.primaryEmail, externalId: `google:${u.id}`, orgUnit: (u.orgUnitPath ?? '/').split('/').filter(Boolean).pop() ?? opts.defaultOrgUnit })
    }
    pageToken = j.nextPageToken
  } while (pageToken)
  const raw = users.map(u => ({ 'ПІБ': u.fullName, 'Телефон': u.phone, 'Email': u.email, 'Посада': opts.defaultPosition, 'Підрозділ': u.orgUnit || opts.defaultOrgUnit, 'Точка': opts.defaultLocation, 'Зовнішній ID': u.externalId }))
  const validated = await validateImport(ctx, `google-workspace-${Date.now()}.json`, raw)
  const applied = opts.apply ? await applyImport(ctx, validated.jobId) : null
  return { ok: true as const, fetched: users.length, jobId: validated.jobId, stats: applied?.stats ?? validated.stats, errors: validated.rows.filter(r => r.errors.length).slice(0, 50).map(r => ({ row: r.fullName, errors: r.errors })) }
}
