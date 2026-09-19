import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Приёмка этапа 1 (docs/07-stages.md): «employee не открывает админку
 * ни по прямой ссылке, ни по API». Гоняется против собранного приложения
 * (.output), поэтому в CI build идёт до тестов; локально пропускается,
 * если сборки нет.
 */

const BUILT = existsSync('.output/server/index.mjs')
const PORT = 3789
const BASE = `http://127.0.0.1:${PORT}`

const ADMIN_PHONE = '+380661864742'
const EMPLOYEE_PHONE = '+380670000003' // Кухар Тестовий, роль employee
const CHEF_PHONE = '+380670000002' // Шеф Лазарева: mentor + employee на точке

let server: ChildProcess | undefined

async function login(phone: string): Promise<string> {
  const reqRes = await fetch(`${BASE}/api/v1/auth/otp/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  })
  const reqBody = await reqRes.json() as { data: { devCode?: string } }
  if (!reqBody.data?.devCode) throw new Error(`Нет devCode для ${phone}: ${JSON.stringify(reqBody)}`)

  const verifyRes = await fetch(`${BASE}/api/v1/auth/otp/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code: reqBody.data.devCode }),
  })
  if (!verifyRes.ok) throw new Error(`verify ${phone} → ${verifyRes.status}`)
  const cookies = verifyRes.headers.getSetCookie()
  const sid = cookies.find(c => c.startsWith('lola_sid='))
  if (!sid) throw new Error('Нет cookie сессии')
  return sid.split(';')[0]!
}

describe.skipIf(!BUILT)('скоупы по HTTP: employee не проходит в админку', () => {
  beforeAll(async () => {
    // Сбросить rate-лимиты и старые коды между прогонами
    const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
    await admin`delete from rate_limits where key like ${'otp:%'}`
    await admin`delete from otp_codes where phone in (${ADMIN_PHONE}, ${EMPLOYEE_PHONE})`
    await admin.end()

    server = spawn('node', ['.output/server/index.mjs'], {
      env: {
        ...process.env,
        PORT: String(PORT),
        NITRO_PORT: String(PORT),
        OTP_DEBUG: '1',
        NUXT_DATABASE_URL: process.env.DATABASE_URL,
      },
      stdio: 'ignore',
    })

    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`${BASE}/health`)
        if (res.ok) return
      }
      catch { /* ещё поднимается */ }
      await new Promise(r => setTimeout(r, 500))
    }
    throw new Error('Собранное приложение не поднялось за 30 секунд')
  }, 60_000)

  afterAll(() => {
    server?.kill()
  })

  // Каждый тест логинится заново — сбрасываем лимит OTP, иначе шестой вход упирается в rate_limited
  beforeEach(async () => {
    const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
    await admin`delete from rate_limits where key like ${'otp:%'}`
    await admin.end()
  })

  it('без сессии — 401', async () => {
    const res = await fetch(`${BASE}/api/v1/people`)
    expect(res.status).toBe(401)
  })

  it('employee: люди, аудит, журнал безопасности, импорт — всё 403', async () => {
    const cookie = await login(EMPLOYEE_PHONE)
    for (const path of ['/api/v1/people', '/api/v1/audit', '/api/v1/security-log', '/api/v1/refs/cities']) {
      const res = await fetch(`${BASE}${path}`, { headers: { cookie } })
      expect(res.status, path).toBe(403)
    }
  })

  it('admin: список людей — 200 с данными', async () => {
    const cookie = await login(ADMIN_PHONE)
    const res = await fetch(`${BASE}/api/v1/people`, { headers: { cookie } })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: unknown[] }
    expect(body.data.length).toBeGreaterThan(0)
  })

  it('CLAUDE.md п. 14: сессия и журнал безопасности пишут единый request_context (ip, браузер) и severity', async () => {
    const cookie = await login(ADMIN_PHONE)
    const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
    try {
      const [s] = await admin`select request_context from sessions where token_hash is not null order by created_at desc limit 1`
      const rc = s!.request_context as { ip?: string, user_agent?: string, browser?: string | null, device?: string | null } | null
      expect(rc, 'sessions.request_context').not.toBeNull()
      expect(rc!.ip).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/)
      expect(rc!.user_agent).toBeTruthy()
      // Формат docs/02: ip, geo, user_agent, browser, os, device — одинаково во всех журналах
      expect(Object.keys(rc!).sort()).toEqual(['browser', 'device', 'geo', 'ip', 'os', 'user_agent'])
      const [sec] = await admin`select request_context, severity from security_log where event = 'login.otp' order by created_at desc limit 1`
      expect((sec!.request_context as { ip?: string } | null)?.ip).toBeTruthy()
      expect(sec!.severity).toBe('info')
      // Журнал по API отдаёт тот же контекст колонками мокапа: ip, geo, client, severity
      const res = await fetch(`${BASE}/api/v1/logs/security?type=login`, { headers: { cookie } })
      expect(res.status).toBe(200)
      const row = ((await res.json()) as { data: { rows: Record<string, unknown>[] } }).data.rows[0]!
      expect(row).toMatchObject({ severity: 'info', event: 'login.otp' })
      expect(row).toHaveProperty('ip')
      expect(row).toHaveProperty('client')
    }
    finally {
      await admin.end()
    }
  })

  it('журнал безопасности: неверный код и блокировка по попыткам — warning', async () => {
    const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
    try {
      await admin`delete from otp_codes where phone = ${ADMIN_PHONE}`
      const reqRes = await fetch(`${BASE}/api/v1/auth/otp/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: ADMIN_PHONE }) })
      expect(reqRes.ok).toBe(true)
      let last = 0
      for (let i = 0; i < 6; i++) {
        const r = await fetch(`${BASE}/api/v1/auth/otp/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: ADMIN_PHONE, code: '000000' }) })
        last = r.status
        if (last === 429) break
      }
      expect(last).toBe(429)
      const rows = await admin`select event, severity from security_log where event in ('login.failed', 'login.blocked') and created_at > now() - interval '1 minute' order by created_at desc limit 10`
      expect(rows.some(r => r.event === 'login.failed' && r.severity === 'warning')).toBe(true)
      expect(rows.some(r => r.event === 'login.blocked' && r.severity === 'warning')).toBe(true)
      await admin`delete from rate_limits where key like ${'otp:%'}`
    }
    finally {
      await admin.end()
    }
  })

  it('CLAUDE.md п. 15: файл чужого тенанта — 404, не 403', async () => {
    const cookie = await login(ADMIN_PHONE)
    const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
    try {
      const [other] = await admin`insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції') on conflict (slug) do update set name = excluded.name returning id`
      const [m] = await admin`insert into media_assets (tenant_id, key, original_name, kind, mime, bytes, status) values (${other!.id}, ${`${other!.id}/2026/09/foreign.jpg`}, 'foreign.jpg', 'image', 'image/jpeg', 10, 'ready') returning id`
      const res = await fetch(`${BASE}/api/v1/media/${m!.id}`, { headers: { cookie } })
      expect(res.status).toBe(404)
      const res2 = await fetch(`${BASE}/api/v1/media/${m!.id}?redirect=1`, { headers: { cookie }, redirect: 'manual' })
      expect(res2.status).toBe(404)
      await admin`delete from media_assets where id = ${m!.id}`
    }
    finally {
      await admin.end()
    }
  })

  it('CLAUDE.md п. 15: отчёт по чужой точке и страница чужого курса — 404, не 403', async () => {
    const cookie = await login(ADMIN_PHONE)
    const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
    try {
      const [other] = await admin`insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції') on conflict (slug) do update set name = excluded.name returning id`
      const cleanup = async () => { await admin`delete from courses where tenant_id = ${other!.id}`; await admin`delete from locations where tenant_id = ${other!.id}`; await admin`delete from org_units where tenant_id = ${other!.id}` }
      await cleanup()
      const [unit] = await admin`insert into org_units (tenant_id, name, path) values (${other!.id}, 'Чужий підрозділ', 'foreign') returning id`
      const [loc] = await admin`insert into locations (tenant_id, org_unit_id, name) values (${other!.id}, ${unit!.id}, 'Чужа точка') returning id`
      const [course] = await admin`insert into courses (tenant_id, title, slug) values (${other!.id}, 'Чужий курс', 'foreign-course') returning id`
      // Отчёт с фильтром по чужой точке
      const rep = await fetch(`${BASE}/api/v1/reports/readiness?locationId=${loc!.id}`, { headers: { cookie } })
      expect(rep.status).toBe(404)
      // Данные страницы чужого курса
      const crs = await fetch(`${BASE}/api/v1/courses/${course!.id}`, { headers: { cookie } })
      expect(crs.status).toBe(404)
      await cleanup()
    }
    finally {
      await admin.end()
    }
  })

  it('активная роль (docs/01 §1.9.2): /auth/me отдаёт её, /me/role/switch — только среди своих, права — по активной', async () => {
    const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
    try {
      await admin`delete from otp_codes where phone = ${CHEF_PHONE}`
      // Полный вход: нужны обе cookie (сессия + CSRF) для мутации
      const reqRes = await fetch(`${BASE}/api/v1/auth/otp/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: CHEF_PHONE }) })
      const { data } = await reqRes.json() as { data: { devCode: string } }
      const verifyRes = await fetch(`${BASE}/api/v1/auth/otp/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: CHEF_PHONE, code: data.devCode }) })
      const jar = verifyRes.headers.getSetCookie().map(c => c.split(';')[0]!)
      const cookie = jar.join('; ')
      const csrf = jar.find(c => c.startsWith('lola_csrf='))!.split('=')[1]!
      const headers = { 'cookie': cookie, 'x-csrf-token': csrf, 'Content-Type': 'application/json' }

      const me = await (await fetch(`${BASE}/api/v1/auth/me`, { headers })).json() as { data: { activeRole: { code: string }, roles: { id: string, code: string }[], scopes: string[] } }
      expect(me.data.activeRole.code).toBe('mentor') // по умолчанию — самая широкая
      expect(me.data.roles.map(r => r.code).sort()).toEqual(['employee', 'mentor'])
      expect(me.data.scopes).toContain('people.view')
      expect((await fetch(`${BASE}/api/v1/people`, { headers })).status).toBe(200)

      const employee = me.data.roles.find(r => r.code === 'employee')!
      const sw = await fetch(`${BASE}/api/v1/me/role/switch`, { method: 'POST', headers, body: JSON.stringify({ roleId: employee.id }) })
      expect(sw.status).toBe(200)
      expect((await sw.json() as { data: { activeRole: { code: string }, changed: boolean } }).data).toMatchObject({ activeRole: { code: 'employee' }, changed: true })
      const me2 = await (await fetch(`${BASE}/api/v1/auth/me`, { headers })).json() as { data: { activeRole: { code: string }, scopes: string[] } }
      expect(me2.data.activeRole.code).toBe('employee')
      expect(me2.data.scopes).not.toContain('people.view')
      expect((await fetch(`${BASE}/api/v1/people`, { headers })).status).toBe(403) // объединение ролей не действует

      const [adminRole] = await admin`select r.id from roles r join tenants t on t.id = r.tenant_id where t.slug = 'kappi' and r.code = 'admin'`
      const foreign = await fetch(`${BASE}/api/v1/me/role/switch`, { method: 'POST', headers, body: JSON.stringify({ roleId: adminRole!.id }) })
      expect(foreign.status).toBe(403)
      expect((await foreign.json() as { error: { code: string } }).error.code).toBe('forbidden')
      const bad = await fetch(`${BASE}/api/v1/me/role/switch`, { method: 'POST', headers, body: JSON.stringify({ roleId: 'not-a-uuid' }) })
      expect(bad.status).toBe(400)

      // Аудит: обе роли и request_context (CLAUDE.md п. 14)
      const [chef] = await admin`select u.id from users u join tenants t on t.id = u.tenant_id where t.slug = 'kappi' and u.phone = ${CHEF_PHONE}`
      const [ev] = await admin`select before, after, actor_roles, request_context from audit_log where action = 'role.switch' and actor_id = ${chef!.id} order by created_at desc limit 1`
      expect(ev!.before).toMatchObject({ code: 'mentor' })
      expect(ev!.after).toMatchObject({ code: 'employee' })
      expect((ev!.actor_roles as string[]).sort()).toEqual(['employee', 'mentor'])
      expect((ev!.request_context as { ip: string }).ip).toBeTruthy()
    }
    finally {
      await admin.end()
    }
  })

  it('мутация без CSRF-заголовка отклоняется', async () => {
    const cookie = await login(ADMIN_PHONE)
    const res = await fetch(`${BASE}/api/v1/people`, {
      method: 'POST',
      headers: { 'cookie': cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName: 'CSRF Тест' }),
    })
    expect(res.status).toBe(403)
  })

  it('Spec 15 (docs/04 §4.9): /tasks — 11 типов контента, PUT params по типу, аудитория с CSV, чужой тенант — 404', async () => {
    const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
    try {
      await admin`delete from otp_codes where phone = ${ADMIN_PHONE}`
      const reqRes = await fetch(`${BASE}/api/v1/auth/otp/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: ADMIN_PHONE }) })
      const { data } = await reqRes.json() as { data: { devCode: string } }
      const verifyRes = await fetch(`${BASE}/api/v1/auth/otp/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: ADMIN_PHONE, code: data.devCode }) })
      const jar = verifyRes.headers.getSetCookie().map(c => c.split(';')[0]!)
      const cookie = jar.join('; ')
      const csrf = jar.find(c => c.startsWith('lola_csrf='))!.split('=')[1]!
      const headers = { 'cookie': cookie, 'x-csrf-token': csrf, 'Content-Type': 'application/json' }
      const [t] = await admin`select id from tenants where slug = 'kappi'`
      const [emp] = await admin`select id from users where tenant_id = ${t!.id} and phone = ${EMPLOYEE_PHONE}`

      // employee не проходит
      await admin`delete from rate_limits where key like ${'otp:%'}`
      const empCookie = await login(EMPLOYEE_PHONE)
      expect((await fetch(`${BASE}/api/v1/tasks`, { headers: { cookie: empCookie } })).status).toBe(403)

      // «Обрати з існуючих» для всех 11 типов; неизвестный тип — 400
      for (const type of ['course', 'training_program', 'resource', 'test', 'complex_test', 'workshop', 'poll', 'assessment', 'check_list', 'meetup', 'webinar']) {
        expect((await fetch(`${BASE}/api/v1/tasks/content?type=${type}`, { headers })).status, type).toBe(200)
      }
      expect((await fetch(`${BASE}/api/v1/tasks/content?type=poll360`, { headers })).status).toBe(400)

      // Назначение теста через /tasks; параметры по типу контента
      const [quiz] = await admin`insert into quizzes (tenant_id, title, kind) values (${t!.id}, ${`HTTP тест ${Date.now()}`}, 'quiz') returning id`
      const created = await fetch(`${BASE}/api/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ subjectType: 'test', subjectId: quiz!.id, audience: { rules: [{ type: 'user', ids: [emp!.id] }], match: 'any' }, dueMode: 'none', reminders: { notifyOnAssign: false } }) })
      expect(created.status).toBe(200)
      const { data: task } = await created.json() as { data: { assignmentId: string } }
      const okParams = await fetch(`${BASE}/api/v1/tasks/${task.assignmentId}/params`, { method: 'PUT', headers, body: JSON.stringify({ questionsMode: 'one_per_group', attemptsAllowed: 2, passScore: 90, viaCatalog: true }) })
      expect(okParams.status).toBe(200)
      expect((await okParams.json() as { data: { params: { passScore: number }, method: { viaCatalog: boolean } } }).data).toMatchObject({ params: { passScore: 90, attemptsAllowed: 2 }, method: { viaCatalog: true } })
      const badParams = await fetch(`${BASE}/api/v1/tasks/${task.assignmentId}/params`, { method: 'PUT', headers, body: JSON.stringify({ strictOrder: true }) })
      expect(badParams.status).toBe(400) // ключ курса у теста
      expect((await fetch(`${BASE}/api/v1/tasks/${task.assignmentId}/reminders`, { method: 'PUT', headers, body: JSON.stringify({ beforeDueDays: [5, 1] }) })).status).toBe(200)
      const card = await (await fetch(`${BASE}/api/v1/tasks/${task.assignmentId}`, { headers })).json() as { data: { content: { title: string } | null, assignedCount: number } }
      expect(card.data.content?.title).toContain('HTTP тест')
      expect(card.data.assignedCount).toBe(1)

      // Аудитория: вкладка «Призначено», CSV-предпросмотр без применения, снятие
      const aud = await (await fetch(`${BASE}/api/v1/tasks/${task.assignmentId}/audience?tab=assigned`, { headers })).json() as { data: { items: { userId: string, via: string }[] } }
      expect(aud.data.items.find(i => i.userId === emp!.id)?.via).toBe('manual')
      const form = new FormData()
      form.set('file', new Blob([`phone\n${EMPLOYEE_PHONE}\n+380000000000\n`], { type: 'text/csv' }), 'people.csv')
      const csv = await fetch(`${BASE}/api/v1/tasks/${task.assignmentId}/audience/import`, { method: 'POST', headers: { 'cookie': cookie, 'x-csrf-token': csrf }, body: form })
      expect(csv.status).toBe(200)
      expect((await csv.json() as { data: { stats: { alreadyAssigned: number, notFound: number } } }).data.stats).toMatchObject({ alreadyAssigned: 1, notFound: 1 })
      expect((await fetch(`${BASE}/api/v1/tasks/${task.assignmentId}/audience/${emp!.id}`, { method: 'DELETE', headers })).status).toBe(200)
      const aud2 = await (await fetch(`${BASE}/api/v1/tasks/${task.assignmentId}/audience?tab=assigned`, { headers })).json() as { data: { items: { userId: string }[] } }
      expect(aud2.data.items.some(i => i.userId === emp!.id)).toBe(false)

      // Баннер и справочник параметров
      expect((await fetch(`${BASE}/api/v1/tasks/changed`, { headers })).status).toBe(200)
      expect((await fetch(`${BASE}/api/v1/task-parameters`, { method: 'POST', headers, body: JSON.stringify({ name: `HTTP параметр ${Date.now()}`, kind: 'select', options: [] }) })).status).toBe(400) // select без вариантов

      // Чужой тенант — 404, не 403 (CLAUDE.md п. 15)
      const [other] = await admin`insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції') on conflict (slug) do update set name = excluded.name returning id`
      const [fq] = await admin`insert into quizzes (tenant_id, title, kind) values (${other!.id}, 'Чужий тест', 'quiz') returning id`
      const [fa] = await admin`insert into assignments (tenant_id, title, subject_type, subject_id, audience) values (${other!.id}, 'Чуже призначення', 'test', ${fq!.id}, '{"rules":[],"match":"any"}') returning id`
      expect((await fetch(`${BASE}/api/v1/tasks/${fa!.id}`, { headers })).status).toBe(404)
      expect((await fetch(`${BASE}/api/v1/tasks/${fa!.id}/params`, { method: 'PUT', headers, body: '{}' })).status).toBe(404)
      expect((await fetch(`${BASE}/api/v1/tasks/${fa!.id}/audience`, { headers })).status).toBe(404)

      await admin`delete from assignments where id in (${task.assignmentId}, ${fa!.id})`
      await admin`delete from quizzes where id in (${quiz!.id}, ${fq!.id})`
      await admin`delete from import_jobs where kind = 'task_audience' and tenant_id = ${t!.id}`
    }
    finally {
      await admin.end()
    }
  })

  it('Spec 12 (docs/04 §4.6–4.8): группы, импорт из банка, очередь ответов с фильтрами, запросы попыток, пересчёт, чужой тенант — 404', async () => {
    const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
    try {
      await admin`delete from otp_codes where phone in (${ADMIN_PHONE}, ${EMPLOYEE_PHONE}, ${CHEF_PHONE})`
      const session = async (phone: string) => {
        await admin`delete from rate_limits where key like ${'otp:%'}`
        const reqRes = await fetch(`${BASE}/api/v1/auth/otp/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) })
        const { data } = await reqRes.json() as { data: { devCode: string } }
        const verifyRes = await fetch(`${BASE}/api/v1/auth/otp/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, code: data.devCode }) })
        const jar = verifyRes.headers.getSetCookie().map(c => c.split(';')[0]!)
        const csrf = jar.find(c => c.startsWith('lola_csrf='))!.split('=')[1]!
        return { 'cookie': jar.join('; '), 'x-csrf-token': csrf, 'Content-Type': 'application/json' }
      }
      const headers = await session(ADMIN_PHONE)
      const [t] = await admin`select id from tenants where slug = 'kappi'`
      const [emp] = await admin`select id from users where tenant_id = ${t!.id} and phone = ${EMPLOYEE_PHONE}`
      const stamp = Date.now()

      // Банк, тест, группа, вопрос в группе с grader_hint
      const bank = await (await fetch(`${BASE}/api/v1/question-banks`, { method: 'POST', headers, body: JSON.stringify({ name: `HTTP банк ${stamp}` }) })).json() as { data: { id: string } }
      const quiz = await (await fetch(`${BASE}/api/v1/quizzes`, { method: 'POST', headers, body: JSON.stringify({ title: `HTTP спека 12 ${stamp}` }) })).json() as { data: { id: string } }
      const group = await fetch(`${BASE}/api/v1/tests/${quiz.data.id}/question-groups`, { method: 'POST', headers, body: JSON.stringify({ title: 'Каса' }) })
      expect(group.status).toBe(200)
      const { data: g } = await group.json() as { data: { id: string } }
      const q = await fetch(`${BASE}/api/v1/questions`, { method: 'POST', headers, body: JSON.stringify({
        bankId: bank.data.id, kind: 'free', questionGroupId: g.id, stem: [{ id: 's', type: 'text', html: '<p>Дії при розбіжності каси?</p>' }],
        graderHint: 'Достатньо двох із трьох', attachFiles: true, tags: ['каса'], points: 2,
      }) })
      expect(q.status).toBe(200)
      const { data: question } = await q.json() as { data: { id: string, questionGroupId: string, scoringMethod: string } }
      expect(question).toMatchObject({ questionGroupId: g.id, scoringMethod: 'formula' })
      // Неизвестный код типа — 400 (коды только из docs/02)
      expect((await fetch(`${BASE}/api/v1/questions`, { method: 'POST', headers, body: JSON.stringify({ bankId: bank.data.id, kind: 'text_long', stem: [{ id: 's', type: 'text', html: '<p>x</p>' }] }) })).status).toBe(400)
      // Ссылка из банка
      const imp = await fetch(`${BASE}/api/v1/tests/${quiz.data.id}/questions/import`, { method: 'POST', headers, body: JSON.stringify({ mode: 'link', questionIds: [question.id] }) })
      expect(imp.status).toBe(200)
      expect((await (await fetch(`${BASE}/api/v1/tests/${quiz.data.id}/question-groups`, { headers })).json() as { data: unknown[] }).data.length).toBe(1)
      expect((await fetch(`${BASE}/api/v1/quizzes/${quiz.data.id}`, { method: 'PATCH', headers, body: JSON.stringify({ status: 'published' }) })).status).toBe(200)
      // Назначение с одной попыткой
      const task = await (await fetch(`${BASE}/api/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ subjectType: 'test', subjectId: quiz.data.id, audience: { rules: [{ type: 'user', ids: [emp!.id] }], match: 'any' }, dueMode: 'none', reminders: { notifyOnAssign: false }, params: { attemptsAllowed: 1, passScore: 50 } }) })).json() as { data: { assignmentId: string } }

      // Ученик: попытка через /tests/:id/attempts, файл к ответу, отправка, запрос ещё одной попытки
      const empHeaders = await session(EMPLOYEE_PHONE)
      const start = await fetch(`${BASE}/api/v1/tests/${quiz.data.id}/attempts`, { method: 'POST', headers: empHeaders, body: '{}' })
      expect(start.status).toBe(200)
      const { data: att } = await start.json() as { data: { attemptId: string } }
      const state = await (await fetch(`${BASE}/api/v1/attempts/${att.attemptId}`, { headers: empHeaders })).json() as { data: unknown }
      expect(JSON.stringify(state)).not.toContain('Достатньо двох') // grader_hint ученику не отдаётся
      expect((await fetch(`${BASE}/api/v1/attempts/${att.attemptId}/answers/${question.id}`, { method: 'PUT', headers: empHeaders, body: JSON.stringify({ answer: { text: 'Скласти акт' } }) })).status).toBe(200)
      const [media] = await admin`insert into media_assets (tenant_id, key, original_name, kind, mime, bytes, status, uploaded_by) values (${t!.id}, ${`t/${t!.id}/http-${stamp}.png`}, 'photo.png', 'image', 'image/png', 10, 'ready', ${emp!.id}) returning id`
      expect((await fetch(`${BASE}/api/v1/attempts/${att.attemptId}/answers/${question.id}/files`, { method: 'POST', headers: empHeaders, body: JSON.stringify({ mediaId: media!.id, name: 'photo.png', kind: 'photo', bytes: 10 }) })).status).toBe(200)
      expect((await fetch(`${BASE}/api/v1/attempts/${att.attemptId}/submit`, { method: 'POST', headers: empHeaders })).status).toBe(200)
      expect((await fetch(`${BASE}/api/v1/tests/${quiz.data.id}/attempt-requests`, { method: 'POST', headers: empHeaders, body: JSON.stringify({ reason: 'коротко' }) })).status).toBe(400)
      const req = await fetch(`${BASE}/api/v1/tests/${quiz.data.id}/attempt-requests`, { method: 'POST', headers: empHeaders, body: JSON.stringify({ reason: 'Впав інтернет на точці, не встиг' }) })
      expect(req.status).toBe(200)
      const { data: request } = await req.json() as { data: { id: string } }
      expect((await fetch(`${BASE}/api/v1/tests/${quiz.data.id}/attempt-requests`, { method: 'POST', headers: empHeaders, body: JSON.stringify({ reason: 'Ще раз прошу спробу' }) })).status).toBe(409)
      // Ученик не видит очередь и не решает запросы
      expect((await fetch(`${BASE}/api/v1/review/answers`, { headers: empHeaders })).status).toBe(403)
      expect((await fetch(`${BASE}/api/v1/attempt-requests`, { headers: empHeaders })).status).toBe(403)

      // Наставник: очередь ответов по метке, подсказка видна, зачёт; запрос — «Дати спробу»
      const chef = await session(CHEF_PHONE)
      const queue = await (await fetch(`${BASE}/api/v1/review/answers?checked=unchecked&tags=каса&outsideCourses=true`, { headers: chef })).json() as { data: { answerId: string, attemptId: string, question: { graderHint: string }, files: unknown[] }[] }
      const item = queue.data.find(i => i.attemptId === att.attemptId)
      expect(item?.question.graderHint).toBe('Достатньо двох із трьох')
      expect(item?.files.length).toBe(1)
      const otherTag = await (await fetch(`${BASE}/api/v1/review/answers?checked=unchecked&tags=бар`, { headers: chef })).json() as { data: { attemptId: string }[] }
      expect(otherTag.data.some(i => i.attemptId === att.attemptId)).toBe(false)
      expect((await fetch(`${BASE}/api/v1/review/answers/${item!.answerId}/grade`, { method: 'POST', headers: chef, body: JSON.stringify({ isCorrect: true, score: 2 }) })).status).toBe(200)
      const pending = await (await fetch(`${BASE}/api/v1/attempt-requests`, { headers: chef })).json() as { data: { id: string, status: string, attemptsUsed: number }[] }
      expect(pending.data.find(r => r.id === request.id)).toMatchObject({ status: 'pending', attemptsUsed: 1 })
      expect((await fetch(`${BASE}/api/v1/attempt-requests/${request.id}/decide`, { method: 'POST', headers: chef, body: JSON.stringify({ approved: true, comment: 'Добре' }) })).status).toBe(200)
      expect((await fetch(`${BASE}/api/v1/attempt-requests/${request.id}/decide`, { method: 'POST', headers: chef, body: JSON.stringify({ approved: false }) })).status).toBe(409)
      // Лишняя попытка сверх лимита назначения
      expect((await fetch(`${BASE}/api/v1/tests/${quiz.data.id}/attempts`, { method: 'POST', headers: empHeaders, body: '{}' })).status).toBe(200)

      // «Перерахувати»: методист, по попытке и по тесту; наставнику без question.manage — 403
      expect((await fetch(`${BASE}/api/v1/attempts/${att.attemptId}/recalculate`, { method: 'POST', headers: chef, body: '{}' })).status).toBe(403)
      const rc = await fetch(`${BASE}/api/v1/attempts/${att.attemptId}/recalculate`, { method: 'POST', headers, body: JSON.stringify({ comment: 'Перевірка ключа' }) })
      expect(rc.status).toBe(200)
      expect((await rc.json() as { data: { after: { status: string } } }).data.after.status).toBe('passed')
      expect((await fetch(`${BASE}/api/v1/tests/${quiz.data.id}/recalculate`, { method: 'POST', headers, body: '{}' })).status).toBe(200)
      const results = await (await fetch(`${BASE}/api/v1/attempts/${att.attemptId}/results`, { headers })).json() as { data: { reason: string }[] }
      expect(results.data.map(r => r.reason)).toEqual(['submit', 'review', 'recalculate', 'recalculate'])

      // Чужой тенант — 404, не 403 (CLAUDE.md п. 15)
      const [other] = await admin`insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції') on conflict (slug) do update set name = excluded.name returning id`
      const [fq] = await admin`insert into quizzes (tenant_id, title, kind) values (${other!.id}, 'Чужий тест', 'quiz') returning id`
      const [fg] = await admin`insert into question_groups (tenant_id, quiz_id, title) values (${other!.id}, ${fq!.id}, 'Чужа група') returning id`
      expect((await fetch(`${BASE}/api/v1/tests/${fq!.id}/question-groups`, { headers })).status).toBe(404)
      expect((await fetch(`${BASE}/api/v1/question-groups/${fg!.id}`, { method: 'PATCH', headers, body: JSON.stringify({ title: 'x' }) })).status).toBe(404)
      expect((await fetch(`${BASE}/api/v1/tests/${fq!.id}/recalculate`, { method: 'POST', headers, body: '{}' })).status).toBe(404)
      expect((await fetch(`${BASE}/api/v1/questions`, { method: 'POST', headers, body: JSON.stringify({ bankId: bank.data.id, kind: 'single', questionGroupId: fg!.id, stem: [{ id: 's', type: 'text', html: '<p>x</p>' }], options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], answer: { correctId: 'a' } }) })).status).toBe(404)

      await admin`delete from attempt_requests where quiz_id = ${quiz.data.id}`
      await admin`delete from attempts where quiz_id = ${quiz.data.id}`
      await admin`delete from assignments where id = ${task.data.assignmentId}`
      await admin`delete from quizzes where id in (${quiz.data.id}, ${fq!.id})`
      await admin`delete from question_banks where id = ${bank.data.id}`
      await admin`delete from media_assets where id = ${media!.id}`
    }
    finally {
      await admin.end()
    }
  })
})
