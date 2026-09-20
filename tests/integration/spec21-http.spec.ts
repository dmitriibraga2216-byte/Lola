import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Spec 21 по HTTP (по образцу scopes-http.spec.ts): скоупы объявлений, 404 для не назначенного и чужого,
 * подтверждение и охват, закладки, поиск по источникам, гостевая страница без входа.
 * Гоняется против собранного приложения (.output); локально пропускается, если сборки нет.
 */
const BUILT = existsSync('.output/server/index.mjs')
const PORT = 3790
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN_PHONE = '+380661864742'
const EMPLOYEE_PHONE = '+380670000003'
const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
let server: ChildProcess | undefined
let tenantId: string
let employeeId: string
let otherTenantId: string
let foreignNoticeId: string
const stamp = Date.now()
const created: { table: string, id: string }[] = []

async function login(phone: string): Promise<string> {
  const req = await fetch(`${BASE}/api/v1/auth/otp/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) })
  const body = await req.json() as { data: { devCode?: string } }
  if (!body.data?.devCode) throw new Error(`Нет devCode для ${phone}: ${JSON.stringify(body)}`)
  const ver = await fetch(`${BASE}/api/v1/auth/otp/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, code: body.data.devCode }) })
  if (!ver.ok) throw new Error(`verify ${phone} → ${ver.status}`)
  return ver.headers.getSetCookie().map(c => c.split(';')[0]!).join('; ')
}
const csrfOf = (cookie: string) => cookie.split('; ').find(c => c.startsWith('lola_csrf='))?.split('=')[1] ?? ''
const json = (cookie: string, method: string, body?: unknown) => ({ method, headers: { 'cookie': cookie, 'x-csrf-token': csrfOf(cookie), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const data = async <T>(res: Response) => ((await res.json()) as { data: T }).data

describe.skipIf(!BUILT)('Spec 21 по HTTP', () => {
  beforeAll(async () => {
    await admin`delete from rate_limits where key like ${'otp:%'}`
    await admin`delete from otp_codes where phone in (${ADMIN_PHONE}, ${EMPLOYEE_PHONE})`
    tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
    employeeId = (await admin`select id from users where tenant_id = ${tenantId} and phone = ${EMPLOYEE_PHONE}`)[0]!.id as string
    const [other] = await admin`insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції') on conflict (slug) do update set name = excluded.name returning id`
    otherTenantId = other!.id as string
    foreignNoticeId = (await admin`insert into notices (tenant_id, title, body, kind, status) values (${otherTenantId}, ${`Чуже ${stamp}`}, '[]', 'acknowledge', 'published') returning id`)[0]!.id as string
    created.push({ table: 'notices', id: foreignNoticeId })
    await admin`update notices set status = 'archived' where tenant_id = ${tenantId} and status = 'published'` // чтобы чужие объявления не мешали подсчёту

    server = spawn('node', ['.output/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), NITRO_PORT: String(PORT), OTP_DEBUG: '1', NUXT_DATABASE_URL: process.env.DATABASE_URL }, stdio: 'ignore' })
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${BASE}/health`)).ok) return }
      catch { /* ещё поднимается */ }
      await new Promise(r => setTimeout(r, 500))
    }
    throw new Error('Собранное приложение не поднялось за 30 секунд')
  }, 90_000)

  afterAll(async () => {
    server?.kill()
    await admin`delete from assignments where subject_type = 'notice' and title like ${`HTTP-21 %`}`
    for (const c of created.reverse()) await admin.unsafe(`delete from ${c.table} where id = '${c.id}'`)
    await admin`delete from task_access_log where user_id = ${employeeId} and content_type in ('notice', 'news')`
    await admin`delete from notifications where user_id = ${employeeId} and code like 'notice_%'`
    await admin.end()
  })
  beforeEach(async () => { await admin`delete from rate_limits where key like ${'otp:%'}` })
  afterEach(async () => { await admin`delete from rate_limits where key like ${'otp:%'}` })

  it('гостевая страница без входа: по slug — три блока и ничего лишнего; неизвестный slug — 404', async () => {
    const ok = await fetch(`${BASE}/api/v1/public/guest-page?slug=kappi`)
    expect(ok.status).toBe(200)
    const g = await data<{ name: string, slug: string, blocks: { welcome: unknown[], supportContact: object, policyUrl: string | null } }>(ok)
    expect(Object.keys(g).sort()).toEqual(['blocks', 'name', 'passwordLogin', 'slug']) // passwordLogin — единственный флаг политик наружу (Spec 16)
    expect(Object.keys(g.blocks).sort()).toEqual(['policyUrl', 'supportContact', 'welcome'])
    expect((await fetch(`${BASE}/api/v1/public/guest-page?slug=no-such-space`)).status).toBe(404)
    expect((await fetch(`${BASE}/api/v1/public/guest-page`)).status).toBe(404) // без Host-поддомена и slug — тоже 404
  })

  it('объявление: employee не создаёт (403); не назначенное — 404; после назначения — видно, подтверждается, охват считает', async () => {
    const adm = await login(ADMIN_PHONE)
    const emp = await login(EMPLOYEE_PHONE)
    expect((await fetch(`${BASE}/api/v1/notices`, json(emp, 'POST', { title: 'HTTP-21 employee', body: [{ id: 'b', type: 'text', html: '<p>x</p>' }] }))).status).toBe(403)
    expect((await fetch(`${BASE}/api/v1/notices`, { headers: { cookie: emp } })).status).toBe(403)

    const n = await data<{ id: string }>(await fetch(`${BASE}/api/v1/notices`, json(adm, 'POST', { title: `HTTP-21 ${stamp}`, body: [{ id: 'b', type: 'text', html: '<p>Нові правила.</p>' }], kind: 'acknowledge', publish: true })))
    created.push({ table: 'notices', id: n.id })
    expect((await fetch(`${BASE}/api/v1/notices/${n.id}`, { headers: { cookie: emp } })).status).toBe(404) // не назначено — не существует для человека
    expect((await fetch(`${BASE}/api/v1/notices/${n.id}/acknowledge`, json(emp, 'POST'))).status).toBe(404)
    expect((await fetch(`${BASE}/api/v1/notices/${foreignNoticeId}`, { headers: { cookie: adm } })).status).toBe(404) // чужой тенант — 404, не 403
    expect((await fetch(`${BASE}/api/v1/notices/${foreignNoticeId}/coverage`, { headers: { cookie: adm } })).status).toBe(404)

    // Назначение через /tasks с типом notice; срок — в назначении
    const task = await fetch(`${BASE}/api/v1/tasks`, json(adm, 'POST', { title: `HTTP-21 ${stamp}`, subjectType: 'notice', subjectId: n.id, audience: { rules: [{ type: 'user', ids: [employeeId] }], match: 'any' }, dueMode: 'relative', dueDays: 3 }))
    expect(task.status).toBe(200)
    const pending = await data<{ id: string }[]>(await fetch(`${BASE}/api/v1/notices/pending`, { headers: { cookie: emp } }))
    expect(pending.map(p => p.id)).toContain(n.id)
    const view = await fetch(`${BASE}/api/v1/notices/${n.id}`, { headers: { cookie: emp } })
    expect(view.status).toBe(200)
    expect((await data<{ dueAt: string | null }>(view)).dueAt).toBeTruthy()
    const ack = await fetch(`${BASE}/api/v1/notices/${n.id}/acknowledge`, json(emp, 'POST'))
    expect(ack.status).toBe(200)
    const cov = await data<{ total: number, acked: number, readers: { id: string }[] }>(await fetch(`${BASE}/api/v1/notices/${n.id}/coverage`, { headers: { cookie: adm } }))
    expect(cov).toMatchObject({ total: 1, acked: 1 })
    expect(cov.readers[0]?.id).toBe(employeeId)
    expect((await data<{ reminded: number, total: number }>(await fetch(`${BASE}/api/v1/notices/${n.id}/remind`, json(adm, 'POST')))).total).toBe(0)
    expect((await fetch(`${BASE}/api/v1/notices/${n.id}/remind`, json(emp, 'POST'))).status).toBe(403)
    // request_context записан вместе с подтверждением (CLAUDE.md п. 14)
    const [row] = await admin`select request_context from notice_acks where notice_id = ${n.id} and user_id = ${employeeId}`
    expect(row!.request_context).toBeTruthy()
  })

  it('закладки и поиск по источникам: `in=notices` — только назначенное; закладка на чужое — 404', async () => {
    const emp = await login(EMPLOYEE_PHONE)
    const hits = await data<{ kind: string, id: string, bookmarked: boolean }[]>(await fetch(`${BASE}/api/v1/knowledge/search?q=HTTP-21&in=notices`, { headers: { cookie: emp } }))
    expect(hits.every(h => h.kind === 'notice')).toBe(true)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    const mark = await fetch(`${BASE}/api/v1/knowledge/${hits[0]!.id}/bookmark`, json(emp, 'POST', { contentType: 'notice' }))
    expect(await data<{ bookmarked: boolean }>(mark)).toEqual({ ok: true, bookmarked: true })
    expect((await data<{ contentId: string }[]>(await fetch(`${BASE}/api/v1/knowledge/bookmarks`, { headers: { cookie: emp } }))).map(b => b.contentId)).toContain(hits[0]!.id)
    expect((await fetch(`${BASE}/api/v1/knowledge/${foreignNoticeId}/bookmark`, json(emp, 'POST', { contentType: 'notice' }))).status).toBe(404)
    expect((await fetch(`${BASE}/api/v1/knowledge/search?q=x&in=forum`, { headers: { cookie: emp } })).status).toBe(400)
    await admin`delete from bookmarks where user_id = ${employeeId} and content_id = ${hits[0]!.id}`
  })

  it('дни рождения, контакты, события — доступны сотруднику; гостевые блоки правит только settings.tenant', async () => {
    const emp = await login(EMPLOYEE_PHONE)
    expect((await fetch(`${BASE}/api/v1/birthdays`, { headers: { cookie: emp } })).status).toBe(200)
    const c = await data<{ showPersonal: boolean, items: Record<string, unknown>[] }>(await fetch(`${BASE}/api/v1/contacts`, { headers: { cookie: emp } }))
    expect(c.showPersonal).toBe(false)
    expect(c.items.every(i => !('email' in i))).toBe(true)
    expect((await fetch(`${BASE}/api/v1/events`, { headers: { cookie: emp } })).status).toBe(200)
    expect((await fetch(`${BASE}/api/v1/guest-blocks`, json(emp, 'PUT', { welcome: [], supportContact: {}, policyUrl: null }))).status).toBe(403)
    expect((await fetch(`${BASE}/api/v1/me/birthday-consent`, json(emp, 'PATCH', { birthdayConsent: true }))).status).toBe(200)
  })
})
