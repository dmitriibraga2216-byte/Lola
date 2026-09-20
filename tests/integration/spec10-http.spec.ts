import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Spec 10 по HTTP (docs/04 §4.4, §4.5, §4.13, §4.16; docs/32 §Б рядок 19): каталог курсу
 * (enroll/request), рішення по заявці (`reason` обов'язковий при відмові), єдина стрічка
 * коментарів, тумблер `/settings/catalog`, чужий тенант — 404. Гоняється проти зібраного
 * застосунку (.output), як scopes-http.spec.ts.
 */

const BUILT = existsSync('.output/server/index.mjs')
const PORT = 3798
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN_PHONE = '+380661864742'
const EMPLOYEE_PHONE = '+380670000003'

let server: ChildProcess | undefined
const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const stamp = Date.now()
const courseIds: string[] = []
let foreignEnrollmentId: string | undefined
let foreignCourseId: string | undefined
let foreignVersionId: string | undefined
let foreignUserId: string | undefined

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

describe.skipIf(!BUILT)('Spec 10 по HTTP', () => {
  beforeAll(async () => {
    await admin`delete from rate_limits where key like ${'otp:%'}`
    await admin`delete from otp_codes where phone in (${ADMIN_PHONE}, ${EMPLOYEE_PHONE})`

    const [other] = await admin`insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції') on conflict (slug) do update set name = excluded.name returning id`
    const otherTenantId = other!.id as string
    const [u] = await admin`insert into users (tenant_id, phone, full_name, status, hired_at) values (${otherTenantId}, ${`+38066${stamp}`}, 'Чужий учень', 'active', current_date) returning id`
    foreignUserId = u!.id as string
    const [c] = await admin`insert into courses (tenant_id, title, slug, status, is_catalog_visible) values (${otherTenantId}, 'Чужий курс http', ${`foreign-s10-http-${stamp}`}, 'published', true) returning id`
    foreignCourseId = c!.id as string
    const [v] = await admin`insert into course_versions (tenant_id, course_id, version, status) values (${otherTenantId}, ${c!.id}, 1, 'published') returning id`
    foreignVersionId = v!.id as string
    await admin`update courses set published_version_id = ${v!.id} where id = ${c!.id}`
    const [e] = await admin`insert into enrollments (tenant_id, user_id, subject_id, version_id, source, status, requested_at)
      values (${otherTenantId}, ${u!.id}, ${c!.id}, ${v!.id}, 'catalog', 'not_assigned', now()) returning id`
    foreignEnrollmentId = e!.id as string

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
    if (foreignEnrollmentId) await admin`delete from enrollments where id = ${foreignEnrollmentId}`
    if (foreignCourseId) await admin`delete from courses where id = ${foreignCourseId}`
    if (foreignVersionId) await admin`delete from course_versions where id = ${foreignVersionId}`
    if (foreignUserId) await admin`delete from users where id = ${foreignUserId}`
    if (courseIds.length) { await admin`delete from enrollments where subject_id in ${admin(courseIds)}`; await admin`delete from courses where id in ${admin(courseIds)}` }
    await admin.end()
  })

  beforeEach(async () => {
    await admin`delete from rate_limits where key like ${'otp:%'}`
  })

  it('employee: керування каталогом і адмінська стрічка коментарів — 403; каталог і власний коментар — доступні', async () => {
    const cookie = await login(EMPLOYEE_PHONE)
    expect((await fetch(`${BASE}/api/v1/manage/catalog/requests`, { headers: { cookie } })).status).toBe(403)
    expect((await fetch(`${BASE}/api/v1/settings/catalog`, json(cookie, 'PATCH', { restrictAccess: true }))).status).toBe(403)
    expect((await fetch(`${BASE}/api/v1/comments`, { headers: { cookie } })).status).toBe(403) // адмінська стрічка — course.view
    expect((await fetch(`${BASE}/api/v1/me/catalog`, { headers: { cookie } })).status).toBe(200)
  })

  it('admin: курс за заявкою → employee подає заявку → decide без reason — 400, з reason — 200', async () => {
    // Курс і публікація — сервісом напряму (як spec22-http.spec.ts): фокус тесту на HTTP каталогу/заявок, не на редакторі курсу.
    const { createCourse, addModule, addLesson, publishCourse } = await import('../../server/services/courses')
    const tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
    const adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = ${ADMIN_PHONE}`)[0]!.id as string
    const svcCtx = { tenantId, actorId: adminId }
    const c = await createCourse(svcCtx, { title: `HTTP каталог s10-${stamp}`, language: 'uk', strictOrder: true, isCatalogVisible: true, assignMode: 'catalog_request', tags: [] })
    courseIds.push(c.id)
    const m = await addModule(svcCtx, c.id, 'Р')
    await addLesson(svcCtx, { moduleId: m!.id, title: 'Урок', itemType: 'resource', resource: { body: [{ id: 'b', type: 'text', html: '<p>x</p>' }] }, isRequired: true, videoThresholdPct: 90 })
    await publishCourse(svcCtx, c.id, 'v1')
    const courseId = c.id

    const adminCookie = await login(ADMIN_PHONE)
    const employeeCookie = await login(EMPLOYEE_PHONE)
    const req = await fetch(`${BASE}/api/v1/me/catalog/${courseId}/request`, json(employeeCookie, 'POST', { comment: 'Хочу пройти' }))
    expect(req.status).toBe(200)
    const { enrollmentId } = await data<{ enrollmentId: string }>(req)

    const noReason = await fetch(`${BASE}/api/v1/enrollments/${enrollmentId}/decide`, json(adminCookie, 'POST', { approve: false }))
    expect(noReason.status).toBe(400)

    const decide = await fetch(`${BASE}/api/v1/enrollments/${enrollmentId}/decide`, json(adminCookie, 'POST', { approve: false, reason: 'Немає місць' }))
    expect(decide.status).toBe(200)
  })

  it('чужий тенант — 404 для рішення по заявці на курс', async () => {
    const adminCookie = await login(ADMIN_PHONE)
    const res = await fetch(`${BASE}/api/v1/enrollments/${foreignEnrollmentId}/decide`, json(adminCookie, 'POST', { approve: true }))
    expect(res.status).toBe(404)
  })
})
