import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Spec 24 по HTTP (по образцу scopes-http.spec.ts): скоупы настроек, модуль выключен → 403 module.disabled и скрыт
 * в /auth/me, impersonation по cookie — плашка в /auth/me, запрещённое действие → 403 impersonation_forbidden,
 * переводы поверх локали, чужой тенант — 404, RLS новых таблиц.
 */
const BUILT = existsSync('.output/server/index.mjs')
const PORT = 3793
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN_PHONE = '+380661864742'
const EMPLOYEE_PHONE = '+380670000003'
const OPS_EMAIL = 'ops-s24-http@lola.local'
const OPS_PASSWORD = 'test-password-123'
const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
let server: ChildProcess | undefined
let tenantId: string
let employeeId: string
let originalSettings: unknown
let otherTenantId: string
let foreignScaleId: string

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
const errCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code

describe.skipIf(!BUILT)('Spec 24 по HTTP', () => {
  beforeAll(async () => {
    await admin`delete from rate_limits where key like ${'otp:%'} or key like ${'ops:%'}`
    await admin`delete from otp_codes where phone in (${ADMIN_PHONE}, ${EMPLOYEE_PHONE})`
    tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
    employeeId = (await admin`select id from users where tenant_id = ${tenantId} and phone = ${EMPLOYEE_PHONE}`)[0]!.id as string
    originalSettings = (await admin`select settings from tenants where id = ${tenantId}`)[0]!.settings
    const [other] = await admin`insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції') on conflict (slug) do update set name = excluded.name returning id`
    otherTenantId = other!.id as string
    foreignScaleId = (await admin`insert into scales (tenant_id, name, kind) values (${otherTenantId}, ${`Чужа ${Date.now()}`}, 'levels') returning id`)[0]!.id as string
    await admin`delete from platform_admins where email = ${OPS_EMAIL}`

    server = spawn('node', ['.output/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), NITRO_PORT: String(PORT), OTP_DEBUG: '1', NUXT_DATABASE_URL: process.env.DATABASE_URL, PLATFORM_ADMIN_EMAIL: OPS_EMAIL, PLATFORM_ADMIN_PASSWORD: OPS_PASSWORD }, stdio: 'ignore' })
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${BASE}/health`)).ok) return }
      catch { /* ещё поднимается */ }
      await new Promise(r => setTimeout(r, 500))
    }
    throw new Error('Собранное приложение не поднялось за 30 секунд')
  }, 90_000)

  afterAll(async () => {
    server?.kill()
    await admin`update tenants set settings = ${admin.json(originalSettings as never)} where id = ${tenantId}`
    await admin`delete from scales where id = ${foreignScaleId}`
    await admin`delete from translations where tenant_id = ${tenantId} and key = 'common.save'`
    await admin`delete from sessions where tenant_id = ${tenantId} and impersonator_admin_id is not null`
    await admin`delete from notifications where tenant_id = ${tenantId} and code = 'impersonation_started'`
    await admin`delete from platform_sessions where admin_id in (select id from platform_admins where email = ${OPS_EMAIL})`
    await admin`delete from platform_admins where email = ${OPS_EMAIL}`
    await admin.end()
  })
  beforeEach(async () => { await admin`delete from rate_limits where key like ${'otp:%'} or key like ${'ops:%'}` })
  afterEach(async () => { await admin`delete from rate_limits where key like ${'otp:%'} or key like ${'ops:%'}` })

  it('скоупы: employee не читает и не пишет настройки (403), admin — читает с дефолтами', async () => {
    const emp = await login(EMPLOYEE_PHONE)
    expect((await fetch(`${BASE}/api/v1/settings/policies`, { headers: { cookie: emp } })).status).toBe(403)
    expect((await fetch(`${BASE}/api/v1/settings/tenant`, { headers: { cookie: emp } })).status).toBe(403)
    expect((await fetch(`${BASE}/api/v1/settings/policies`, json(emp, 'PATCH', { session: { lengthDays: 5 } }))).status).toBe(403)
    const adm = await login(ADMIN_PHONE)
    const p = await data<{ session: { lengthDays: number }, dataProtection: { disablePrint: boolean } }>(await fetch(`${BASE}/api/v1/settings/policies`, { headers: { cookie: adm } }))
    expect(p.session.lengthDays).toBeGreaterThanOrEqual(1)
    expect(typeof p.dataProtection.disablePrint).toBe('boolean')
    // Ошибки объясняют, что делать: slug с заглавной, акцент не из палитры
    const bad = await fetch(`${BASE}/api/v1/settings/tenant`, json(adm, 'PATCH', { accent: '#123456' }))
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { message: string } }).error.message).toContain('бренд')
  })

  it('модуль выключен → 403 module.disabled на его маршрутах, отчёты живы, в /auth/me модуль false; включён → снова 200', async () => {
    const adm = await login(ADMIN_PHONE)
    expect((await fetch(`${BASE}/api/v1/workshops`, { headers: { cookie: adm } })).status).toBe(200)
    const off = await fetch(`${BASE}/api/v1/settings/modules`, json(adm, 'PATCH', { workshops: false }))
    expect(off.status).toBe(200)
    const blocked = await fetch(`${BASE}/api/v1/workshops`, { headers: { cookie: adm } })
    expect(blocked.status).toBe(403)
    expect(await errCode(blocked)).toBe('module.disabled')
    expect((await fetch(`${BASE}/api/v1/reports/summary`, { headers: { cookie: adm } })).status).not.toBe(403)
    const me = await data<{ tenant: { modules: Record<string, boolean>, accent: string } }>(await fetch(`${BASE}/api/v1/auth/me`, { headers: { cookie: adm } }))
    expect(me.tenant.modules.workshops).toBe(false)
    expect(me.tenant.modules.wiki).toBe(false)
    expect(['sun', 'teal', 'coral', 'ink']).toContain(me.tenant.accent)
    await fetch(`${BASE}/api/v1/settings/modules`, json(adm, 'PATCH', { workshops: true }))
    expect((await fetch(`${BASE}/api/v1/workshops`, { headers: { cookie: adm } })).status).toBe(200)
  })

  it('impersonation: оператор входит с причиной — /auth/me показывает плашку, запрещённое действие → 403, выход → impersonation.ended', async () => {
    const opsLogin = await fetch(`${BASE}/api/v1/platform/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: OPS_EMAIL, password: OPS_PASSWORD }) })
    expect(opsLogin.status).toBe(200)
    const opsCookie = opsLogin.headers.getSetCookie().map(c => c.split(';')[0]!).join('; ')
    const noReason = await fetch(`${BASE}/api/v1/platform/tenants/${tenantId}/impersonate`, { method: 'POST', headers: { 'cookie': opsCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: employeeId, reason: 'коротко' }) })
    expect(noReason.status).toBe(400)
    const imp = await fetch(`${BASE}/api/v1/platform/tenants/${tenantId}/impersonate`, { method: 'POST', headers: { 'cookie': opsCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: employeeId, reason: 'Розбір скарги користувача — HTTP-тест' }) })
    expect(imp.status).toBe(200)
    const sess = imp.headers.getSetCookie().map(c => c.split(';')[0]!).join('; ')
    const me = await data<{ user: { id: string }, impersonated: boolean, impersonation: { operator: string, expiresAt: string } | null }>(await fetch(`${BASE}/api/v1/auth/me`, { headers: { cookie: sess } }))
    expect(me.user.id).toBe(employeeId)
    expect(me.impersonated).toBe(true)
    expect(me.impersonation?.operator).toBe(OPS_EMAIL)
    expect(new Date(me.impersonation!.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(60 * 60_000)
    // Запрещено (docs/29 Б.13): переключение роли, выгрузка; чтение — можно
    const sw = await fetch(`${BASE}/api/v1/me/role/switch`, json(sess, 'POST', { roleId: '00000000-0000-0000-0000-000000000000' }))
    expect(sw.status).toBe(403)
    expect(await errCode(sw)).toBe('impersonation_forbidden')
    expect((await fetch(`${BASE}/api/v1/people/export`, { headers: { cookie: sess } })).status).toBe(403)
    expect((await fetch(`${BASE}/api/v1/learning/catalog`, { headers: { cookie: sess } })).status).not.toBe(403)
    const stop = await fetch(`${BASE}/api/v1/auth/impersonation/stop`, json(sess, 'POST'))
    expect(stop.status).toBe(200)
    expect((await fetch(`${BASE}/api/v1/auth/me`, { headers: { cookie: sess } })).status).toBe(401)
    const [end] = await admin`select meta from security_log where tenant_id = ${tenantId} and event = 'impersonation.ended' order by created_at desc limit 1`
    expect((end!.meta as { subject: { id: string } }).subject.id).toBe(employeeId)
  })

  it('переводы: PUT — и клиент получает переопределение поверх локали; employee тоже получает, но не пишет', async () => {
    const adm = await login(ADMIN_PHONE)
    const put = await fetch(`${BASE}/api/v1/settings/translations`, json(adm, 'PUT', { locale: 'uk', key: 'common.save', value: 'Зберегти (HTTP)' }))
    expect(put.status).toBe(200)
    const emp = await login(EMPLOYEE_PHONE)
    const over = await data<Record<string, string>>(await fetch(`${BASE}/api/v1/translations/uk`, { headers: { cookie: emp } }))
    expect(over['common.save']).toBe('Зберегти (HTTP)')
    expect((await fetch(`${BASE}/api/v1/settings/translations`, json(emp, 'PUT', { locale: 'uk', key: 'common.save', value: 'x' }))).status).toBe(403)
    expect((await fetch(`${BASE}/api/v1/translations/uk`)).status).toBe(401)
    expect((await fetch(`${BASE}/api/v1/settings/translations?locale=uk&key=common.save`, json(adm, 'DELETE'))).status).toBe(200)
    expect((await data<Record<string, string>>(await fetch(`${BASE}/api/v1/translations/uk`, { headers: { cookie: adm } })))['common.save']).toBeUndefined()
  })

  it('чужой тенант: шкала другого простору — 404, не 403; usage/roles/scales отдают только своё', async () => {
    const adm = await login(ADMIN_PHONE)
    expect((await fetch(`${BASE}/api/v1/scales/${foreignScaleId}`, { headers: { cookie: adm } })).status).toBe(404)
    expect((await fetch(`${BASE}/api/v1/scales/${foreignScaleId}`, json(adm, 'DELETE'))).status).toBe(404)
    const scales = await data<{ id: string }[]>(await fetch(`${BASE}/api/v1/scales`, { headers: { cookie: adm } }))
    expect(scales.some(s => s.id === foreignScaleId)).toBe(false)
    const usage = await fetch(`${BASE}/api/v1/settings/usage`, { headers: { cookie: adm } })
    expect(usage.status).toBe(200)
    const roles = await data<{ code: string, peopleCount: number }[] & { groups: unknown[] }>(await fetch(`${BASE}/api/v1/settings/roles`, { headers: { cookie: adm } }))
    expect(roles.some(r => r.code === 'admin')).toBe(true)
  })
})
