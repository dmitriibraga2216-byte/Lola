import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Spec 18 по HTTP (docs/04, docs/18 §10): «Анонс» обов'язковий при створенні заняття/вебінару,
 * сесія на призначенні, запис на сесію, відмітка присутності (в тому числі заднім числом —
 * причина обов'язкова), чужий тенант — 404. Гоняється проти зібраного застосунку (.output),
 * як scopes-http.spec.ts.
 */

const BUILT = existsSync('.output/server/index.mjs')
const PORT = 3794
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN_PHONE = '+380661864742'
const EMPLOYEE_PHONE = '+380670000003'

let server: ChildProcess | undefined
const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const stamp = Date.now()
const meetupIds: string[] = []
let otherTenantId: string | undefined

async function login(phone: string): Promise<string> {
  const reqRes = await fetch(`${BASE}/api/v1/auth/otp/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) })
  const reqBody = await reqRes.json() as { data: { devCode?: string } }
  if (!reqBody.data?.devCode) throw new Error(`Нет devCode для ${phone}: ${JSON.stringify(reqBody)}`)
  const verifyRes = await fetch(`${BASE}/api/v1/auth/otp/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, code: reqBody.data.devCode }) })
  if (!verifyRes.ok) throw new Error(`verify ${phone} → ${verifyRes.status}`)
  const jar = verifyRes.headers.getSetCookie().map(c => c.split(';')[0]!)
  if (!jar.some(c => c.startsWith('lola_sid='))) throw new Error('Нет cookie сессии')
  return jar.join('; ')
}
const csrfOf = (cookie: string) => cookie.split('; ').find(c => c.startsWith('lola_csrf='))?.split('=')[1] ?? ''
const json = (cookie: string, method: string, body?: unknown) => ({
  method,
  headers: { 'cookie': cookie, 'x-csrf-token': csrfOf(cookie), 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})
const data = async <T>(res: Response) => ((await res.json()) as { data: T }).data
const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()

describe.skipIf(!BUILT)('Spec 18 по HTTP', () => {
  beforeAll(async () => {
    await admin`delete from rate_limits where key like ${'otp:%'}`
    await admin`delete from otp_codes where phone in (${ADMIN_PHONE}, ${EMPLOYEE_PHONE})`
    const [other] = await admin`insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції') on conflict (slug) do update set name = excluded.name returning id`
    otherTenantId = other!.id as string

    server = spawn('node', ['.output/server/index.mjs'], {
      env: { ...process.env, PORT: String(PORT), NITRO_PORT: String(PORT), OTP_DEBUG: '1', NUXT_DATABASE_URL: process.env.DATABASE_URL },
      stdio: 'ignore',
    })
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${BASE}/health`)).ok) return
      }
      catch { /* ещё поднимается */ }
      await new Promise(r => setTimeout(r, 500))
    }
    throw new Error('Собранное приложение не поднялось за 30 секунд')
  }, 60_000)

  afterAll(async () => {
    server?.kill()
    if (meetupIds.length) await admin`delete from meetups where id in ${admin(meetupIds)}`
    await admin.end()
  })

  beforeEach(async () => {
    await admin`delete from rate_limits where key like ${'otp:%'}`
  })

  it('«Анонс» обов\'язковий для meetup|webinar; сесія, запис, чужий тенант — 404', async () => {
    const cookie = await login(ADMIN_PHONE)
    const empCookie = await login(EMPLOYEE_PHONE)
    const meRes = await data<{ user: { id: string } }>(await fetch(`${BASE}/api/v1/auth/me`, { headers: { cookie } }))
    const empRes = await data<{ user: { id: string } }>(await fetch(`${BASE}/api/v1/auth/me`, { headers: { cookie: empCookie } }))

    const noAnnouncement = await fetch(`${BASE}/api/v1/meetups`, json(cookie, 'POST', { kind: 'meetup', title: `HTTP-заняття ${stamp}`, startsAt: hours(500), endsAt: hours(501), trainerIds: [meRes.user.id] }))
    expect(noAnnouncement.status).toBe(422)

    const created = await fetch(`${BASE}/api/v1/meetups`, json(cookie, 'POST', { kind: 'meetup', title: `HTTP-заняття ${stamp}`, announcement: [{ id: 'a', type: 'text', html: '<p>Анонс</p>' }], startsAt: hours(500), endsAt: hours(501), trainerIds: [meRes.user.id] }))
    expect(created.status).toBe(200)
    const meetup = await data<{ id: string }>(created)
    meetupIds.push(meetup.id)

    const session = await data<{ id: string }>(await fetch(`${BASE}/api/v1/meetups/${meetup.id}/sessions`, json(cookie, 'POST', { startsAt: hours(2), endsAt: hours(4), trainerIds: [meRes.user.id], capacity: 5, enrollDeadlineHours: 0 })))
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/)

    // Записывается сотрудник
    const reg = await fetch(`${BASE}/api/v1/meetup-sessions/${session.id}/register`, json(empCookie, 'POST', {}))
    expect(reg.status).toBe(200)
    expect((await data<{ status: string }>(reg)).status).toBe('registered')

    // Відмітка заднім числом — сесія «завершилась»
    await admin`update meetup_sessions set starts_at = now() - interval '3 hours', ends_at = now() - interval '2 hours' where id = ${session.id}`
    const noReason = await fetch(`${BASE}/api/v1/meetup-sessions/${session.id}/attendance`, json(cookie, 'POST', { userId: empRes.user.id, status: 'attended' }))
    expect(noReason.status).toBe(422)
    const withReason = await fetch(`${BASE}/api/v1/meetup-sessions/${session.id}/attendance`, json(cookie, 'POST', { userId: empRes.user.id, status: 'attended', reason: 'Був присутній, забули відмітити' }))
    expect(withReason.status).toBe(200)
    expect(await data<{ retroactive: boolean }>(withReason)).toMatchObject({ retroactive: true })
    const [audit] = await admin`select action from audit_log where action = 'meetup_session.attendance.retroactive' order by created_at desc limit 1`
    expect(audit).toBeTruthy()

    // Чужой тенант — 404, не 403 (CLAUDE.md п. 15)
    const [foreign] = await admin`insert into meetups (tenant_id, kind, title, announcement, starts_at, ends_at, trainer_ids, qr_secret) values (${otherTenantId!}, 'meetup', 'Чужа картка', '[]'::jsonb, now(), now() + interval '1 hour', '{}', 'x') returning id`
    expect((await fetch(`${BASE}/api/v1/meetups/${foreign!.id as string}`, { headers: { cookie } })).status).toBe(404)
    expect((await fetch(`${BASE}/api/v1/meetups/${foreign!.id as string}/sessions`, { headers: { cookie } })).status).toBe(200) // список пустой, не падает
    expect(await data<unknown[]>(await fetch(`${BASE}/api/v1/meetups/${foreign!.id as string}/sessions`, { headers: { cookie } }))).toEqual([])
    await admin`delete from meetups where id = ${foreign!.id as string}`
  })
})
