import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Spec 22 по HTTP (по образцу scopes-http): отчёт по типу контента и сводный мастер — только со скоупом report.team,
 * журналы — audit.view, чужая точка — 404, обращение к заданию по HTTP пишет request_context с IP (CLAUDE.md п. 14),
 * переключатель «Повідомляти на E-mail» — settings.tenant и событие безопасности.
 */
const BUILT = existsSync('.output/server/index.mjs')
const PORT = 3790
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN_PHONE = '+380661864742'
const EMPLOYEE_PHONE = '+380670000003'
let server: ChildProcess | undefined
const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const stamp = Date.now()
let tenantId: string, employeeId: string, courseId: string, taskId: string, enrollmentId: string, otherLocationId: string, otherTenantId: string

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
const json = (cookie: string, method: string, body?: unknown) => ({ method, headers: { 'cookie': cookie, 'x-csrf-token': csrfOf(cookie), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const data = async <T>(res: Response) => ((await res.json()) as { data: T }).data

describe.skipIf(!BUILT)('Spec 22 по HTTP', () => {
  beforeAll(async () => {
    await admin`delete from rate_limits where key like ${'otp:%'}`
    await admin`delete from otp_codes where phone in (${ADMIN_PHONE}, ${EMPLOYEE_PHONE})`
    tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
    const adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = ${ADMIN_PHONE}`)[0]!.id as string
    employeeId = (await admin`select id from users where tenant_id = ${tenantId} and phone = ${EMPLOYEE_PHONE}`)[0]!.id as string
    const [other] = await admin`insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції') on conflict (slug) do update set name = excluded.name returning id`
    otherTenantId = other!.id as string
    const [ou] = await admin`insert into org_units (tenant_id, name, path) values (${otherTenantId}, ${`Чужий ${stamp}`}, ${`s22_${stamp}`}) returning id`
    otherLocationId = (await admin`insert into locations (tenant_id, org_unit_id, name) values (${otherTenantId}, ${ou!.id}, ${`Чужа точка ${stamp}`}) returning id`)[0]!.id as string
    // Курс с уроком и назначение сотруднику — через сервисы
    const { createCourse, addModule, addLesson, publishCourse } = await import('../../server/services/courses')
    const { createAssignment } = await import('../../server/services/assignments')
    const ctx = { tenantId, actorId: adminId }
    courseId = (await createCourse(ctx, { title: `HTTP s22 ${stamp}`, language: 'uk', strictOrder: true, isCatalogVisible: false, tags: [] })).id
    const m = await addModule(ctx, courseId, 'Р')
    await addLesson(ctx, { moduleId: m!.id, title: 'Урок', itemType: 'resource', resource: { body: [{ id: 'b', type: 'text', html: '<p>x</p>' }] }, isRequired: true, videoThresholdPct: 90 })
    await publishCourse(ctx, courseId, 'v1')
    const r = await createAssignment(ctx, { subjectType: 'course', subjectId: courseId, lockVersion: false, audience: { rules: [{ type: 'user', ids: [employeeId] }], match: 'any' }, dueMode: 'none', dueDays: 14, isMandatory: false, autoSync: false, tags: [], status: 'active', reminders: { notifyOnAssign: false } })
    if (!r.ok) throw new Error(r.code)
    taskId = r.assignmentId
    enrollmentId = (await admin`select id from enrollments where assignment_id = ${taskId}`)[0]!.id as string

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
    await admin`delete from assignments where id = ${taskId}`
    await admin`delete from enrollments where subject_id = ${courseId}`
    await admin`delete from courses where id = ${courseId}`
    await admin`delete from locations where id = ${otherLocationId}`
    await admin`delete from org_units where tenant_id = ${otherTenantId} and path = ${`s22_${stamp}`}`
    await admin`update tenants set settings = settings - 'security' where id = ${tenantId}`
    await admin`delete from security_log where tenant_id = ${tenantId} and event = 'settings.security_changed' and created_at > now() - interval '10 minutes'`
    await admin.end()
  })
  beforeEach(async () => { await admin`delete from rate_limits where key like ${'otp:%'}` })
  afterEach(async () => { await admin`delete from rate_limits where key like ${'otp:%'}` })

  it('employee: отчёты, мастер, журналы и настройка — 403; открытие своего курса пишет обращение с IP', async () => {
    const cookie = await login(EMPLOYEE_PHONE)
    expect((await fetch(`${BASE}/api/v1/reports/tasks/course?taskId=${taskId}`, { headers: { cookie } })).status).toBe(403)
    expect((await fetch(`${BASE}/api/v1/reports/summary`, json(cookie, 'POST', { step: 'users' }))).status).toBe(403)
    expect((await fetch(`${BASE}/api/v1/logs/task-access`, { headers: { cookie } })).status).toBe(403)
    expect((await fetch(`${BASE}/api/v1/settings/security`, json(cookie, 'PATCH', { emailAlerts: true }))).status).toBe(403)
    expect((await fetch(`${BASE}/api/v1/learning/enrollments/${enrollmentId}`, { headers: { cookie } })).status).toBe(200)
    const [row] = await admin`select request_context from task_access_log where enrollment_id = ${enrollmentId} order by created_at desc limit 1`
    expect((row!.request_context as { ip: string | null }).ip).toBeTruthy()
  })

  it('admin: отчёт по курсу из четырёх частей с каркасом; чужая точка — 404; неподдерживаемый тип — 422', async () => {
    const cookie = await login(ADMIN_PHONE)
    const res = await fetch(`${BASE}/api/v1/reports/tasks/course?taskId=${taskId}&context=standalone`, { headers: { cookie } })
    expect(res.status).toBe(200)
    const r = await data<{ overview: { assigned: number }, accesses: unknown[], stats: { notOpened: number }, rows: Record<string, unknown>[] }>(res)
    expect(r.overview.assigned).toBe(1)
    expect(r.accesses.length).toBe(1)
    for (const k of ['full_name', 'position', 'city', 'unit', 'tags', 'assigned_at', 'completed_at', 'status', 'result', 'context']) expect(k in r.rows[0]!).toBe(true)
    expect((await fetch(`${BASE}/api/v1/reports/tasks/course?taskId=${taskId}&locationId=${otherLocationId}`, { headers: { cookie } })).status).toBe(404)
    expect((await fetch(`${BASE}/api/v1/reports/tasks/poll`, { headers: { cookie } })).status).toBe(422)
    expect((await fetch(`${BASE}/api/v1/reports/tasks/nope`, { headers: { cookie } })).status).toBe(404)
    const xlsx = await fetch(`${BASE}/api/v1/reports/tasks/course?taskId=${taskId}&format=xlsx`, { headers: { cookie } })
    expect(xlsx.status).toBe(200)
    expect(xlsx.headers.get('content-type')).toContain('spreadsheetml')
  })

  it('admin: сводный мастер по шагам; чужая точка в выборке — 404', async () => {
    const cookie = await login(ADMIN_PHONE)
    const users = await data<{ count: number, rows: unknown[] }>(await fetch(`${BASE}/api/v1/reports/summary`, json(cookie, 'POST', { step: 'users', userFilter: { userIds: [employeeId] } })))
    expect(users.count).toBe(1)
    const tasks = await data<{ rows: { id: string }[] }>(await fetch(`${BASE}/api/v1/reports/summary`, json(cookie, 'POST', { step: 'tasks', taskFilter: { assignmentIds: [taskId] } })))
    expect(tasks.rows.map(t => t.id)).toEqual([taskId])
    const result = await data<{ rows: { tasks: Record<string, { status: string }> }[] }>(await fetch(`${BASE}/api/v1/reports/summary`, json(cookie, 'POST', { step: 'result', userFilter: { userIds: [employeeId] }, taskFilter: { assignmentIds: [taskId] } })))
    expect(result.rows[0]!.tasks[taskId]!.status).toBe('not_started')
    expect((await fetch(`${BASE}/api/v1/reports/summary`, json(cookie, 'POST', { step: 'users', userFilter: { locationIds: [otherLocationId] } }))).status).toBe(404)
    expect((await fetch(`${BASE}/api/v1/reports/summary`, json(cookie, 'POST', { step: 'nope' }))).status).toBe(400)
  })

  it('admin: три журнала и выгрузка xlsx; переключатель E-mail — событие безопасности с контекстом', async () => {
    const cookie = await login(ADMIN_PHONE)
    for (const kind of ['task-status', 'task-access', 'org-conflicts']) {
      const res = await fetch(`${BASE}/api/v1/logs/${kind}?userId=${employeeId}`, { headers: { cookie } })
      expect(res.status, kind).toBe(200)
      const r = await data<{ kind: string, rows: Record<string, unknown>[] }>(res)
      expect(r.kind).toBe(kind)
      if (r.rows.length) for (const k of ['full_name', 'position', 'city', 'unit', 'tags', 'ip', 'geo', 'client']) expect(k in r.rows[0]!, `${kind}.${k}`).toBe(true)
    }
    const access = await data<{ rows: { ip: string | null, action: string }[] }>(await fetch(`${BASE}/api/v1/logs/task-access?userId=${employeeId}&contentId=${courseId}`, { headers: { cookie } }))
    expect(access.rows.length).toBeGreaterThanOrEqual(1)
    expect(access.rows[0]!.ip).toBeTruthy()
    const xlsx = await fetch(`${BASE}/api/v1/logs/task-access?format=xlsx`, { headers: { cookie } })
    expect(xlsx.status).toBe(200)
    expect(xlsx.headers.get('content-type')).toContain('spreadsheetml')

    const before = await data<{ emailAlerts: boolean }>(await fetch(`${BASE}/api/v1/settings/security`, { headers: { cookie } }))
    expect(before.emailAlerts).toBe(false)
    const after = await data<{ emailAlerts: boolean }>(await fetch(`${BASE}/api/v1/settings/security`, json(cookie, 'PATCH', { emailAlerts: true })))
    expect(after.emailAlerts).toBe(true)
    const [ev] = await admin`select severity, request_context from security_log where tenant_id = ${tenantId} and event = 'settings.security_changed' order by created_at desc limit 1`
    expect(ev!.severity).toBe('critical')
    expect((ev!.request_context as { ip: string | null }).ip).toBeTruthy()
    const sec = await data<{ rows: { event: string, severity: string }[] }>(await fetch(`${BASE}/api/v1/logs/security?severity=critical&type=settings.`, { headers: { cookie } }))
    expect(sec.rows[0]).toMatchObject({ event: 'settings.security_changed', severity: 'critical' })
  })
})
