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
})
