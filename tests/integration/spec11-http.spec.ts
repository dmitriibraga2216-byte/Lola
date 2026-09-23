import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Spec 11 по HTTP (docs/11 §10, docs/04 §4.5, §4.8, §4.15): ресурсы, раздел обязателен (422),
 * лимиты файлов до передачи (400 с текстом), tick {seconds, scrollPct, videoPct}, чужой тенант — 404.
 * Гоняется против собранного приложения (.output), как scopes-http.spec.ts.
 */

const BUILT = existsSync('.output/server/index.mjs')
const PORT = 3791
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN_PHONE = '+380661864742'
const EMPLOYEE_PHONE = '+380670000003'

let server: ChildProcess | undefined
const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const stamp = Date.now()
const created: string[] = []
let foreignResourceId: string | undefined

async function login(phone: string): Promise<string> {
  const reqRes = await fetch(`${BASE}/api/v1/auth/otp/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) })
  const reqBody = await reqRes.json() as { data: { devCode?: string } }
  if (!reqBody.data?.devCode) throw new Error(`Нет devCode для ${phone}: ${JSON.stringify(reqBody)}`)
  const verifyRes = await fetch(`${BASE}/api/v1/auth/otp/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, code: reqBody.data.devCode }) })
  if (!verifyRes.ok) throw new Error(`verify ${phone} → ${verifyRes.status}`)
  // Обе cookie: сессия + CSRF (мутации требуют X-CSRF-Token, docs/04 §4.1)
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

describe.skipIf(!BUILT)('Spec 11 по HTTP', () => {
  beforeAll(async () => {
    await admin`delete from rate_limits where key like ${'otp:%'}`
    await admin`delete from otp_codes where phone in (${ADMIN_PHONE}, ${EMPLOYEE_PHONE})`
    const [other] = await admin`insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції') on conflict (slug) do update set name = excluded.name returning id`
    const [r] = await admin`insert into resources (tenant_id, title, slug, kind, body, status) values (${other!.id}, ${`Чужий ресурс ${stamp}`}, ${`foreign-${stamp}`}, 'article', '[]', 'published') returning id`
    foreignResourceId = r!.id as string

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
    if (created.length) await admin`delete from resources where id in ${admin(created)}`
    if (foreignResourceId) await admin`delete from resources where id = ${foreignResourceId}`
    await admin`delete from courses where title like ${`HTTP s11-${stamp}%`}`
    await admin.end()
  })

  beforeEach(async () => {
    await admin`delete from rate_limits where key like ${'otp:%'}`
  })

  it('employee: библиотека и создание ресурса — 403', async () => {
    const cookie = await login(EMPLOYEE_PHONE)
    expect((await fetch(`${BASE}/api/v1/resources`, { headers: { cookie } })).status).toBe(403)
    expect((await fetch(`${BASE}/api/v1/resources`, json(cookie, 'POST', { title: 'Спроба' }))).status).toBe(403)
    expect((await fetch(`${BASE}/api/v1/resource-categories`, json(cookie, 'POST', { name: 'x' }))).status).toBe(403)
  })

  it('admin: создать → опубликовать {notifyAssigned} → версия 1; список с фильтрами; чужой тенант — 404', async () => {
    const cookie = await login(ADMIN_PHONE)
    const create = await fetch(`${BASE}/api/v1/resources`, json(cookie, 'POST', { title: `HTTP s11-${stamp}`, kind: 'article', body: [{ id: 'b1', type: 'text', html: '<p>Текст</p>' }], tags: ['персонал'] }))
    expect(create.status).toBe(200)
    const r = ((await create.json()) as { data: { id: string, status: string } }).data
    created.push(r.id)
    expect(r.status).toBe('draft')

    const bad = await fetch(`${BASE}/api/v1/resources`, json(cookie, 'POST', { title: 'ab' }))
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { message: string } }).error.message).toBe('Назва від 3 символів')

    const pub = await fetch(`${BASE}/api/v1/resources/${r.id}/publish`, json(cookie, 'POST', { notifyAssigned: true }))
    expect(pub.status).toBe(200)
    expect(((await pub.json()) as { data: { version: number } }).data.version).toBe(1)

    const list = await fetch(`${BASE}/api/v1/resources?status=published&tag=персонал&q=${encodeURIComponent(`s11-${stamp}`)}`, { headers: { cookie } })
    expect(list.status).toBe(200)
    const body = (await list.json()) as { data: { total: number, items: { id: string, usedInCourses: number }[] } }
    expect(body.data.items.map(i => i.id)).toContain(r.id)

    expect((await fetch(`${BASE}/api/v1/resources/${foreignResourceId}`, { headers: { cookie } })).status).toBe(404)
    expect((await fetch(`${BASE}/api/v1/resources/${foreignResourceId}`, json(cookie, 'PATCH', { title: 'Перехоплення' }))).status).toBe(404)
    expect((await fetch(`${BASE}/api/v1/learning/resources/${foreignResourceId}`, { headers: { cookie } })).status).toBe(404)
  })

  it('раздел обязателен: урок без раздела — 422 course.section_required', async () => {
    const cookie = await login(ADMIN_PHONE)
    const course = await fetch(`${BASE}/api/v1/courses`, json(cookie, 'POST', { title: `HTTP s11-${stamp} курс`, code: 'HTTP-01', resultMode: 'avg_score' }))
    expect(course.status).toBe(200)
    const c = ((await course.json()) as { data: { id: string, code: string, resultMode: string } }).data
    expect(c.code).toBe('HTTP-01')
    expect(c.resultMode).toBe('avg_score')

    const res = await fetch(`${BASE}/api/v1/courses/${c.id}/lessons`, json(cookie, 'POST', { moduleId: crypto.randomUUID(), title: 'Урок', resource: { body: [] } }))
    expect(res.status).toBe(422)
    const err = ((await res.json()) as { error: { code: string, message: string } }).error
    expect(err.code).toBe('course.section_required')
    expect(err.message).toContain('розділ')

    const list = await fetch(`${BASE}/api/v1/courses`, { headers: { cookie } })
    const row = ((await list.json()) as { data: { id: string, sections: number, items: number, authorName: string | null }[] }).data.find(x => x.id === c.id)
    expect(row).toMatchObject({ sections: 0, items: 0 })
    expect(row!.authorName).toBeTruthy()
  })

  it('лимиты файлов: отказ до начала передачи с понятным текстом', async () => {
    const cookie = await login(ADMIN_PHONE)
    const origin = 'lesson_attachment' // обязателен с v2 PR-12 (docs/v2/34 §7.1, решение В-17)
    const big = await fetch(`${BASE}/api/v1/media/upload-url`, json(cookie, 'POST', { filename: 'movie.mp4', mime: 'video/mp4', bytes: 600 * 1024 * 1024, origin }))
    expect(big.status).toBe(400)
    const err = ((await big.json()) as { error: { code: string, message: string } }).error
    expect(err.code).toBe('media.too_big')
    expect(err.message).toBe('Файл завеликий. Максимум для відео — 500 МБ')
    const exe = await fetch(`${BASE}/api/v1/media/upload-url`, json(cookie, 'POST', { filename: 'x.exe', mime: 'application/x-msdownload', bytes: 10, origin }))
    expect(((await exe.json()) as { error: { code: string } }).error.code).toBe('media.mime_not_allowed')
    const img = await fetch(`${BASE}/api/v1/media/upload-url`, json(cookie, 'POST', { filename: 'cover.png', mime: 'image/png', bytes: 11 * 1024 * 1024, origin }))
    expect(((await img.json()) as { error: { message: string } }).error.message).toContain('10 МБ')
  })

  it('tick принимает {seconds, scrollPct, videoPct}; мусор — 400; неоткрытый урок — 404', async () => {
    const cookie = await login(ADMIN_PHONE)
    const path = `${BASE}/api/v1/learning/enrollments/${crypto.randomUUID()}/lessons/${crypto.randomUUID()}`
    expect((await fetch(`${path}/tick`, json(cookie, 'POST', { seconds: 15, scrollPct: 200 }))).status).toBe(400)
    expect((await fetch(`${path}/tick`, json(cookie, 'POST', { seconds: 15, scrollPct: 80, videoPct: 10 }))).status).toBe(404)
    expect((await fetch(`${path}/acknowledge`, json(cookie, 'POST'))).status).toBe(404)
    expect((await fetch(`${path}/download`, json(cookie, 'POST'))).status).toBe(404)
  })
})
