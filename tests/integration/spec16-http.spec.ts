import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Spec 16 по HTTP (образец — scopes-http.spec.ts): вход по паролю (выключен политикой → 403, неверный → 401,
 * верный → cookie и `login.success` с method=password), `people.password` — отдельный скоуп, `password_hash`
 * не отдаётся, метки со scope и конфликты — по скоупам, `/me/password` доступен любому. Гоняется против .output.
 */
const BUILT = existsSync('.output/server/index.mjs')
const PORT = 3795
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN_PHONE = '+380661864742'
const EMPLOYEE_PHONE = '+380670000003'
const EMAIL = 's16-http@example.test'
let server: ChildProcess | undefined
let tenantId: string
let employeeId: string
let originalSettings: unknown
const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

async function login(phone: string): Promise<string> {
  const reqRes = await fetch(`${BASE}/api/v1/auth/otp/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) })
  const reqBody = await reqRes.json() as { data: { devCode?: string } }
  if (!reqBody.data?.devCode) throw new Error(`Нет devCode для ${phone}: ${JSON.stringify(reqBody)}`)
  const verifyRes = await fetch(`${BASE}/api/v1/auth/otp/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, code: reqBody.data.devCode }) })
  if (!verifyRes.ok) throw new Error(`verify ${phone} → ${verifyRes.status}`)
  return verifyRes.headers.getSetCookie().map(c => c.split(';')[0]!).join('; ')
}
const csrfOf = (cookie: string) => cookie.split('; ').find(c => c.startsWith('lola_csrf='))?.split('=')[1] ?? ''
/** POST без сессии (вход) и с сессией (cookie + x-csrf-token, как в spec24-http). */
const json = (body: unknown, cookie?: string) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { 'cookie': cookie, 'x-csrf-token': csrfOf(cookie) } : {}) }, body: JSON.stringify(body) })

describe.skipIf(!BUILT)('Spec 16 по HTTP: пароль, скоупы меток и конфликтов', () => {
  beforeAll(async () => {
    tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
    employeeId = (await admin`select id from users where tenant_id = ${tenantId} and phone = ${EMPLOYEE_PHONE}`)[0]!.id as string
    originalSettings = (await admin`select settings from tenants where id = ${tenantId}`)[0]!.settings
    await admin`update users set email = ${EMAIL}, password_hash = null, must_change_password = false where id = ${employeeId}`
    await admin`delete from rate_limits where key like 'otp:%' or key like 'pwd:%'`
    await admin`delete from otp_codes where phone in (${ADMIN_PHONE}, ${EMPLOYEE_PHONE})`
    server = spawn('node', ['.output/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), NITRO_PORT: String(PORT), OTP_DEBUG: '1', NUXT_DATABASE_URL: process.env.DATABASE_URL }, stdio: 'ignore' })
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${BASE}/health`)).ok) return }
      catch { /* ещё поднимается */ }
      await new Promise(r => setTimeout(r, 500))
    }
    throw new Error('Собранное приложение не поднялось за 30 секунд')
  }, 60_000)

  afterAll(async () => {
    server?.kill()
    await admin`update tenants set settings = ${admin.json(originalSettings as never)} where id = ${tenantId}`
    await admin`update users set email = null, password_hash = null, must_change_password = false, password_changed_at = null where id = ${employeeId}`
    await admin`delete from tags where tenant_id = ${tenantId} and name like 's16h-%'`
    await admin`delete from rate_limits where key like 'pwd:%'`
    await admin.end()
  })

  beforeEach(async () => {
    await admin`delete from rate_limits where key like 'otp:%'`
  })

  it('вход по паролю выключен политикой → 403 password_login_disabled; неизвестная почта → 401', async () => {
    const off = await fetch(`${BASE}/api/v1/auth/password/login`, json({ email: EMAIL, password: 'whatever-1' }))
    expect(off.status).toBe(403)
    expect(((await off.json()) as { error: { code: string } }).error.code).toBe('password_login_disabled')
    const none = await fetch(`${BASE}/api/v1/auth/password/login`, json({ email: 'nobody-s16@example.test', password: 'whatever-1' }))
    expect(none.status).toBe(401)
  })

  it('people.password — отдельный скоуп: employee 403, admin ставит пароль; password_hash в карточке нет', async () => {
    const employee = await login(EMPLOYEE_PHONE)
    const denied = await fetch(`${BASE}/api/v1/people/${employeeId}/password`, json({ password: 'Strong-Pass-42' }, employee))
    expect(denied.status).toBe(403)
    const adminCookie = await login(ADMIN_PHONE)
    const short = await fetch(`${BASE}/api/v1/people/${employeeId}/password`, json({ password: 'Ab1' }, adminCookie))
    expect(short.status).toBe(400)
    const ok = await fetch(`${BASE}/api/v1/people/${employeeId}/password`, json({ password: 'Strong-Pass-42', mustChange: true }, adminCookie))
    expect(ok.status).toBe(200)
    const card = await fetch(`${BASE}/api/v1/people/${employeeId}`, { headers: { cookie: adminCookie } })
    const person = ((await card.json()) as { data: Record<string, unknown> }).data
    expect(person).not.toHaveProperty('passwordHash')
    expect(person).toMatchObject({ hasPassword: true, mustChangePassword: true })
    const [row] = await admin`select event, meta from security_log where user_id = ${employeeId} order by created_at desc limit 1`
    expect(row!.event).toBe('password.reset_by_admin')
  })

  it('политика включена: неверный пароль 401, верный — cookie + mustChangePassword, login.success method=password; /me/password снимает флаг', async () => {
    // jsonb_set не создаёт промежуточные ключи — собираем policies.passwords явно
    await admin`update tenants set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('policies', coalesce(settings -> 'policies', '{}'::jsonb) || jsonb_build_object('passwords', coalesce(settings #> '{policies,passwords}', '{}'::jsonb) || '{"loginEnabled": true}'::jsonb)) where id = ${tenantId}`
    const bad = await fetch(`${BASE}/api/v1/auth/password/login`, json({ email: EMAIL, password: 'wrong-pass-1' }))
    expect(bad.status).toBe(401)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('password_invalid')
    const good = await fetch(`${BASE}/api/v1/auth/password/login`, json({ email: EMAIL, password: 'Strong-Pass-42' }))
    expect(good.status).toBe(200)
    expect(((await good.json()) as { data: { mustChangePassword: boolean } }).data.mustChangePassword).toBe(true)
    const cookie = good.headers.getSetCookie().map(c => c.split(';')[0]!).join('; ')
    const me = await fetch(`${BASE}/api/v1/auth/me`, { headers: { cookie } })
    const meBody = (await me.json()) as { data: { user: { id: string, mustChangePassword: boolean, hasPassword: boolean } } }
    expect(meBody.data.user).toMatchObject({ id: employeeId, mustChangePassword: true, hasPassword: true })
    const [sec] = await admin`select event, meta, severity, request_context from security_log where user_id = ${employeeId} and event = 'login.success' order by created_at desc limit 1`
    expect(sec!.meta).toMatchObject({ method: 'password' })
    expect(sec!.severity).toBe('info')
    expect((sec!.request_context as { ip?: string } | null)?.ip).toBeTruthy()
    // Смена своего пароля: неверный текущий — 403, верный — 200 и флаг снят
    const wrong = await fetch(`${BASE}/api/v1/me/password`, json({ currentPassword: 'nope-nope-1', password: 'Another-Pass-9' }, cookie))
    expect(wrong.status).toBe(403)
    const changed = await fetch(`${BASE}/api/v1/me/password`, json({ currentPassword: 'Strong-Pass-42', password: 'Another-Pass-9' }, cookie))
    expect(changed.status).toBe(200)
    const me2 = (await (await fetch(`${BASE}/api/v1/auth/me`, { headers: { cookie } })).json()) as { data: { user: { mustChangePassword: boolean } } }
    expect(me2.data.user.mustChangePassword).toBe(false)
    const [ev] = await admin`select event from security_log where user_id = ${employeeId} order by created_at desc limit 1`
    expect(ev!.event).toBe('password.changed')
  })

  it('метки: чтение по people.view, создание без области — 400, employee — 403; конфликты — только people.edit', async () => {
    const adminCookie = await login(ADMIN_PHONE)
    const noScope = await fetch(`${BASE}/api/v1/tags`, json({ name: 's16h-без-області' }, adminCookie))
    expect(noScope.status).toBe(400)
    const created = await fetch(`${BASE}/api/v1/tags`, json({ name: 's16h-каса', scope: 'question', description: 'Питання про касу' }, adminCookie))
    expect(created.status).toBe(200)
    const list = (await (await fetch(`${BASE}/api/v1/tags?scope=question`, { headers: { cookie: adminCookie } })).json()) as { data: { name: string, scope: string, usage: number }[] }
    expect(list.data.find(t => t.name === 's16h-каса')).toMatchObject({ scope: 'question', usage: 0 })
    const userScope = (await (await fetch(`${BASE}/api/v1/refs/tags?scope=user`, { headers: { cookie: adminCookie } })).json()) as { data: { name: string }[] }
    expect(userScope.data.some(t => t.name === 's16h-каса')).toBe(false)
    const employee = await login(EMPLOYEE_PHONE)
    for (const path of ['/api/v1/tags', '/api/v1/org-conflicts']) {
      const res = await fetch(`${BASE}${path}`, { headers: { cookie: employee } })
      expect(res.status, path).toBe(403)
    }
    const post = await fetch(`${BASE}/api/v1/tags`, json({ name: 's16h-x', scope: 'user' }, employee))
    expect(post.status).toBe(403)
    const conflicts = await fetch(`${BASE}/api/v1/org-conflicts?state=open`, { headers: { cookie: adminCookie } })
    expect(conflicts.status).toBe(200)
    const missing = await fetch(`${BASE}/api/v1/org-conflicts/00000000-0000-0000-0000-000000000000/resolve`, json({ action: 'acknowledge' }, adminCookie))
    expect(missing.status).toBe(404)
  })
})
