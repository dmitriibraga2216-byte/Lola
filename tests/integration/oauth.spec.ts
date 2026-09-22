import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const oauth = await import('../../server/services/oauth')
const secrets = await import('../../server/services/secrets')
const apps = await import('../../server/services/googleApps')
const mt = await import('../../server/services/meetups')
const ms = await import('../../server/services/meetupSessions')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
let tenantId: string
let adminId: string

/** Фейковый провайдер: token endpoint, userinfo, Calendar, Directory, Zoom. */
const calls: { url: string, method: string, body?: string }[] = []
let refreshFails = false
function fakeHttp(url: string, init?: RequestInit): Promise<Response> {
  calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : init?.body ? String(init.body) : undefined })
  const json = (o: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } }))
  if (url.startsWith('https://oauth2.googleapis.com/token')) {
    const b = String(init?.body ?? '')
    if (b.includes('grant_type=authorization_code')) return b.includes('code=good') ? json({ access_token: 'at-1', refresh_token: 'rt-secret-123', expires_in: 3600 }) : b.includes('code=noref') ? json({ access_token: 'at-1' }) : json({ error: 'invalid_grant', error_description: 'Код протух' }, 400)
    if (b.includes('grant_type=refresh_token')) return refreshFails ? json({ error: 'invalid_grant', error_description: 'Token has been revoked' }, 400) : json({ access_token: `at-${Date.now()}` })
  }
  if (url.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) return json({ email: 'owner@kappi.ua' })
  if (url.includes('/calendar/v3/calendars/')) return url.includes('/events/') && init?.method === 'DELETE' ? Promise.resolve(new Response(null, { status: 204 })) : json({ id: 'evt-42', hangoutLink: 'https://meet.google.com/abc-defg-hij' })
  if (url.startsWith('https://admin.googleapis.com/admin/directory/v1/users')) return json({ users: [{ id: 'g1', primaryEmail: 'ivan@kappi.ua', name: { fullName: 'Іван Воркспейс' }, phones: [{ value: '+380931112233', primary: true }], orgUnitPath: '/Кухня' }, { id: 'g2', primaryEmail: 'olena@kappi.ua', name: { fullName: 'Олена Воркспейс' }, phones: [{ value: '+380931112244' }], suspended: true }] })
  if (url.startsWith('https://zoom.us/oauth/token')) return json({ access_token: 'zat', refresh_token: 'zrt-777' })
  if (url.startsWith('https://api.zoom.us/v2/users/me/meetings')) return json({ id: 987654, join_url: 'https://zoom.us/j/987654', start_url: 'https://zoom.us/s/987654?zak=x' })
  if (url.startsWith('https://api.zoom.us/v2/users/me')) return json({ email: 'host@kappi.ua' })
  if (url.includes('/report/meetings/')) return json({ participants: [{ user_email: 'ivan@kappi.ua', duration: 45 * 60 }] })
  return json({ error: 'unknown url ' + url }, 404)
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  process.env.GOOGLE_CLIENT_ID = 'test-client'
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret'
  process.env.ZOOM_CLIENT_ID = 'zoom-client'
  process.env.ZOOM_CLIENT_SECRET = 'zoom-secret'
  oauth.setOAuthHttp(fakeHttp)
})
afterEach(() => { calls.length = 0; refreshFails = false })
afterAll(async () => {
  oauth.setOAuthHttp(null)
  await admin`delete from tenant_secrets where tenant_id = ${tenantId} and provider in ('google', 'zoom')`
  await admin`delete from oauth_states where tenant_id = ${tenantId}`
  await admin`delete from meetups where tenant_id = ${tenantId} and title like 'OAuth-%'`
  await admin`delete from users where tenant_id = ${tenantId} and external_id like 'google:%'`
  await admin.end()
})
const ctx = () => ({ tenantId, actorId: adminId })

/** Достаём state из ссылки — как это сделал бы провайдер при редиректе назад. */
const stateOf = (url: string) => new URL(url).searchParams.get('state')!

describe('этап 11: OAuth-подключение (docs/09 §9.2, приёмка этапа 11)', () => {
  it('имена ключей: записали → прочитали → совпало (round-trip констант)', async () => {
    const providers = Object.keys(secrets.SECRET_KEYS)
    for (const [provider, keys] of Object.entries(secrets.SECRET_KEYS)) {
      for (const key of Object.values(keys)) {
        await secrets.setSecret(ctx(), provider as never, key, `v-${key}`)
        expect(await secrets.getSecret(tenantId, provider as never, key)).toBe(`v-${key}`)
      }
    }
    // Чистим за собой все провайдеры, которые тронул цикл выше — не только google/zoom (Spec 23: иначе
    // тестовые значения smtp/telegram остаются в БД и ломают их собственные интеграционные тесты).
    await admin`delete from tenant_secrets where tenant_id = ${tenantId} and provider in ${admin(providers)}`
  })

  it('«не налаштовано» ≠ «не підключено»; auth-url с offline+consent; state в БД, одноразовый, 10 минут', async () => {
    const saved = process.env.GOOGLE_CLIENT_ID
    delete process.env.GOOGLE_CLIENT_ID
    expect((await oauth.oauthStatus(ctx(), 'google')).state).toBe('not_configured')
    expect(await oauth.authUrl(ctx(), 'google')).toEqual({ error: 'not_configured' })
    process.env.GOOGLE_CLIENT_ID = saved
    expect((await oauth.oauthStatus(ctx(), 'google')).state).toBe('not_connected')

    const r = await oauth.authUrl(ctx(), 'google')
    if ('error' in r) throw new Error('no url')
    const u = new URL(r.url)
    expect(u.searchParams.get('access_type')).toBe('offline')
    expect(u.searchParams.get('prompt')).toBe('consent')
    expect(u.searchParams.get('redirect_uri')).toContain('/api/v1/integrations/google/callback')
    const [st] = await admin`select consumed_at, expires_at from oauth_states where tenant_id = ${tenantId} order by created_at desc limit 1`
    expect(st!.consumed_at).toBeNull()
    expect(new Date(st!.expires_at as string).getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000)

    // Неизвестный state; протухший; отказ пользователя
    expect(await oauth.handleCallback('google', { code: 'good', state: 'nope' })).toMatchObject({ ok: false, code: 'bad_state' })
    await admin`update oauth_states set expires_at = now() - interval '1 minute' where tenant_id = ${tenantId}`
    expect(await oauth.handleCallback('google', { code: 'good', state: stateOf(r.url) })).toMatchObject({ ok: false, code: 'state_expired' })
    const r2 = await oauth.authUrl(ctx(), 'google')
    if ('error' in r2) throw new Error('no url')
    expect(await oauth.handleCallback('google', { error: 'access_denied', state: stateOf(r2.url) })).toMatchObject({ ok: false, code: 'provider_error' })
    // state потреблён — повтор отвергается
    expect(await oauth.handleCallback('google', { code: 'good', state: stateOf(r2.url) })).toMatchObject({ ok: false, code: 'state_used' })
  })

  it('подключение: refresh_token в БД зашифрован, панель «Працює», состояние живёт в БД (переживает рестарт), отключение из интерфейса', async () => {
    const r = await oauth.authUrl(ctx(), 'google')
    if ('error' in r) throw new Error('no url')
    const cb = await oauth.handleCallback('google', { code: 'good', state: stateOf(r.url) })
    expect(cb).toMatchObject({ ok: true, provider: 'google', accountLabel: 'owner@kappi.ua' })
    // Без refresh_token (повторное согласие без prompt=consent) — понятная ошибка
    const r3 = await oauth.authUrl(ctx(), 'google')
    if ('error' in r3) throw new Error('no url')
    expect(await oauth.handleCallback('google', { code: 'noref', state: stateOf(r3.url) })).toMatchObject({ ok: false, code: 'no_refresh_token' })

    const [row] = await admin`select value_encrypted, nonce, account_label, status from tenant_secrets where tenant_id = ${tenantId} and provider = 'google' and key = 'refresh_token'`
    expect(row!.account_label).toBe('owner@kappi.ua')
    const stored = Buffer.from(row!.value_encrypted as Uint8Array).toString('utf8')
    expect(stored).not.toContain('rt-secret-123')
    expect(Buffer.from(row!.nonce as Uint8Array).length).toBeGreaterThanOrEqual(12)
    expect(await secrets.getSecret(tenantId, 'google', 'refresh_token')).toBe('rt-secret-123')
    // access_token не хранится
    const [n] = await admin`select count(*)::int as c from tenant_secrets where tenant_id = ${tenantId} and provider = 'google' and key = 'access_token'`
    expect(n!.c).toBe(0)

    // «Рестарт»: новый экземпляр модуля читает состояние из БД
    const fresh = await import('../../server/services/oauth?restart=' + Date.now())
    fresh.setOAuthHttp(fakeHttp)
    expect((await fresh.oauthStatus(ctx(), 'google'))).toMatchObject({ state: 'connected', accountLabel: 'owner@kappi.ua' })
    expect(await fresh.accessToken(tenantId, 'google')).toMatch(/^at-/)
    const [aud] = await admin`select count(*)::int as c from audit_log where tenant_id = ${tenantId} and action = 'integration.oauth_connected'`
    expect(aud!.c).toBeGreaterThanOrEqual(1)

    // «Мовчить»: провайдер отклоняет refresh → failing с текстом, следующий успех возвращает «працює»
    refreshFails = true
    expect(await oauth.accessToken(tenantId, 'google')).toBeNull()
    expect(await oauth.oauthStatus(ctx(), 'google')).toMatchObject({ state: 'failing', lastError: 'Token has been revoked' })
    refreshFails = false
    expect(await oauth.accessToken(tenantId, 'google')).toBeTruthy()
    expect((await oauth.oauthStatus(ctx(), 'google')).state).toBe('connected')

    await oauth.oauthDisconnect(ctx(), 'google')
    expect((await oauth.oauthStatus(ctx(), 'google')).state).toBe('not_connected')
    expect(await secrets.getSecret(tenantId, 'google', 'refresh_token')).toBeNull()
  })

  it('применения: событие в Google Calendar на занятие, Meet-ссылка для вебинара, импорт людей из Workspace, Zoom-встреча и посещаемость', async () => {
    const g = await oauth.authUrl(ctx(), 'google'); if ('error' in g) throw new Error('x')
    await oauth.handleCallback('google', { code: 'good', state: stateOf(g.url) })
    const z = await oauth.authUrl(ctx(), 'zoom'); if ('error' in z) throw new Error('x')
    expect(await oauth.handleCallback('zoom', { code: 'good', state: stateOf(z.url) })).toMatchObject({ ok: true, accountLabel: 'host@kappi.ua' })

    const m = await mt.createMeetup(ctx(), { title: 'OAuth-заняття', startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: new Date(Date.now() + 90_000_000).toISOString(), trainerIds: [adminId], room: 'Клас 1' })
    const cal = await apps.syncMeetupToCalendar(tenantId, m.id)
    expect(cal).toMatchObject({ ok: true, eventId: 'evt-42' })
    const [row] = await admin`select external_event_id from meetups where id = ${m.id}`
    expect(row!.external_event_id).toBe('evt-42')
    const created = calls.find(c => c.url.includes('/calendar/v3/') && c.method === 'POST')
    expect(created!.body).toContain('OAuth-заняття')
    expect(await apps.removeMeetupFromCalendar(tenantId, m.id)).toBe(true)

    const w = await mt.createMeetup(ctx(), { kind: 'webinar', title: 'OAuth-вебінар', startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: new Date(Date.now() + 90_000_000).toISOString(), trainerIds: [adminId], webinar: { provider: 'meet' } })
    expect(await apps.syncMeetupToCalendar(tenantId, w.id)).toMatchObject({ ok: true, joinUrl: 'https://meet.google.com/abc-defg-hij' })
    const [wb] = await admin`select join_url from webinars where meetup_id = ${w.id}`
    expect(wb!.join_url).toBe('https://meet.google.com/abc-defg-hij')

    const zw = await mt.createMeetup(ctx(), { kind: 'webinar', title: 'OAuth-zoom', startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: new Date(Date.now() + 90_000_000).toISOString(), trainerIds: [adminId], webinar: { provider: 'zoom' } })
    expect(await apps.createZoomMeeting(tenantId, zw.id)).toMatchObject({ ok: true, joinUrl: 'https://zoom.us/j/987654' })

    const imp = await apps.importFromWorkspace(ctx(), { apply: true, defaultPosition: 'Бариста', defaultOrgUnit: 'Каппі', defaultLocation: 'Лазарева' })
    expect(imp).toMatchObject({ ok: true, fetched: 1 }) // suspended пропущен
    const [u] = await admin`select full_name, email from users where tenant_id = ${tenantId} and external_id = 'google:g1'`
    expect(u).toMatchObject({ full_name: 'Іван Воркспейс', email: 'ivan@kappi.ua' })

    // Посещаемость из Zoom-отчёта по e-mail
    const att = await apps.fetchZoomAttendance(tenantId, zw.id)
    expect(att).toEqual([{ userId: expect.any(String), minutes: 45 }])
  })

  it('docs/33 D-029: Calendar/Zoom-синк сесії (не картки) — свій event/meeting на кожну сесію, автоматично при створенні', async () => {
    const g = await oauth.authUrl(ctx(), 'google'); if ('error' in g) throw new Error('x')
    await oauth.handleCallback('google', { code: 'good', state: stateOf(g.url) })
    const z = await oauth.authUrl(ctx(), 'zoom'); if ('error' in z) throw new Error('x')
    await oauth.handleCallback('zoom', { code: 'good', state: stateOf(z.url) })

    const m = await mt.createMeetup(ctx(), { title: 'OAuth-заняття (сесія)', announcement: [{ id: 'a', type: 'text', html: '<p>Анонс</p>' }], startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: new Date(Date.now() + 90_000_000).toISOString(), trainerIds: [adminId] })
    // Створення картки НЕ синкає календар для kind=meetup — синк переїхав на сесію
    calls.length = 0
    const r = await ms.createSession(ctx(), m.id, { startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: new Date(Date.now() + 90_000_000).toISOString(), trainerIds: [adminId], room: 'Клас 1' })
    if (!r.ok) throw new Error('no session')
    // Синк іде у фоні (setImmediate) — почекаємо тік
    await new Promise(resolve => setTimeout(resolve, 50))
    const [row] = await admin`select external_event_id from meetup_sessions where id = ${r.session.id}`
    expect(row!.external_event_id).toBe('evt-42')
    const created = calls.find(c => c.url.includes('/calendar/v3/') && c.method === 'POST')
    expect(created!.body).toContain('OAuth-заняття (сесія)')

    // Ручний виклик тих самих сесійних функцій — той самий контракт, що й картковий
    expect(await apps.removeSessionFromCalendar(tenantId, r.session.id)).toBe(true)

    const zw = await mt.createMeetup(ctx(), { kind: 'webinar', title: 'OAuth-zoom (сесія)', announcement: [{ id: 'a', type: 'text', html: '<p>Анонс</p>' }], startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: new Date(Date.now() + 90_000_000).toISOString(), trainerIds: [adminId], webinar: { provider: 'zoom' } })
    const rz = await ms.createSession(ctx(), zw.id, { startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: new Date(Date.now() + 90_000_000).toISOString(), trainerIds: [adminId], provider: 'zoom' })
    if (!rz.ok) throw new Error('no session')
    expect(await apps.createZoomMeetingForSession(tenantId, rz.session.id)).toMatchObject({ ok: true, joinUrl: 'https://zoom.us/j/987654' })
    const [wsess] = await admin`select join_url, external_meeting_id from meetup_sessions where id = ${rz.session.id}`
    expect(wsess).toMatchObject({ join_url: 'https://zoom.us/j/987654', external_meeting_id: '987654' })
    const attSession = await apps.fetchZoomAttendanceForSession(tenantId, rz.session.id)
    expect(attSession).toEqual([{ userId: expect.any(String), minutes: 45 }])

    // Картка-джерело лишається без свого зовнішнього event/meeting — це вела сесія
    const [cardRow] = await admin`select external_event_id from meetups where id = ${m.id}`
    expect(cardRow!.external_event_id).toBeNull()
  })
})
