import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { assignWithParams } from './_assign'

/**
 * `docs/v2/35-billing-limits.md` §13 к. 5 и к. 7 по HTTP против собранного приложения (.output),
 * как `spec10-http.spec.ts`: тенант в `readonly` — создание трека `409 tenant.readonly`, сотрудник
 * проходит назначенный материал до конца; ручки самообслуживания смены тарифа (§10) — скоупы,
 * валидация, `404` на тариф вне каталога.
 *
 * Состояние подписки ставится **до** старта сервера: `effectiveLimits()` кеширует его в процессе на
 * 60 секунд, и переход, сделанный задачей в другом процессе, сервер увидел бы только через минуту.
 */

const BUILT = existsSync('.output/server/index.mjs')
const PORT = 3835
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN_PHONE = '+380661864742' // admin + owner
const EMPLOYEE_PHONE = '+380670000003'

let server: ChildProcess | undefined
const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const stamp = Date.now()
let tenantId: string
let resourceId: string
let assignmentId: string

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
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string, message: string, details?: Record<string, unknown> } }).error

describe.skipIf(!BUILT)('35 к. 5, к. 7 по HTTP', () => {
  beforeAll(async () => {
    await admin`delete from rate_limits where key like ${'otp:%'}`
    await admin`delete from otp_codes where phone in (${ADMIN_PHONE}, ${EMPLOYEE_PHONE})`
    tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
    const adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = ${ADMIN_PHONE}`)[0]!.id as string
    const employeeId = (await admin`select id from users where tenant_id = ${tenantId} and phone = ${EMPLOYEE_PHONE}`)[0]!.id as string

    // Назначенный материал — до перехода в readonly (сервисом: фокус теста на запрете, а не на редакторе)
    const { createResource, publishResource } = await import('../../server/services/resources')
    const ctx = { tenantId, actorId: adminId }
    const r = await createResource(ctx, { kind: 'link', title: `K5 readonly ${stamp}`, externalUrl: 'https://example.com/k5', language: 'uk', tags: [], categoryIds: [], allowPrint: true, body: [] } as never)
    resourceId = r.id
    expect((await publishResource(ctx, r.id, { notifyAssigned: false })).ok).toBe(true)
    assignmentId = await assignWithParams(ctx, 'resource', r.id, {}, [employeeId])

    // Дано: paid_until 9 дней назад, grace истёк — задача переводит в readonly
    const { graceScan, addDays, todayIn } = await import('../../server/services/subscriptionStatus')
    const today = todayIn('Europe/Kyiv')
    await admin`insert into tenant_limits (tenant_id, status, paid_until) values (${tenantId}, 'active', ${addDays(today, -9)})
      on conflict (tenant_id) do update set status = 'active', paid_until = excluded.paid_until, grace_until = null`
    const steps = await graceScan(tenantId)
    expect(steps.map(s => s.to)).toEqual(['grace', 'readonly'])

    server = spawn('node', ['.output/server/index.mjs'], {
      env: { ...process.env, PORT: String(PORT), NITRO_PORT: String(PORT), OTP_DEBUG: '1', WORKER_ENABLED: '0', NUXT_DATABASE_URL: process.env.DATABASE_URL },
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
  }, 90_000)

  afterAll(async () => {
    server?.kill()
    await admin`delete from tenant_limits where tenant_id = ${tenantId}`
    await admin`delete from notifications where tenant_id = ${tenantId} and code in ('plan_grace_started', 'plan_readonly')`
    await admin`delete from audit_log where tenant_id = ${tenantId} and action = 'billing.subscription_status'`
    if (assignmentId) {
      await admin`delete from enrollments where assignment_id = ${assignmentId}`
      await admin`delete from assignments where id = ${assignmentId}`
    }
    if (resourceId) await admin`delete from resources where id = ${resourceId}`
    await admin.end()
  })

  beforeEach(async () => {
    await admin`delete from rate_limits where key like ${'otp:%'}`
  })

  it('к. 5: в readonly создание трека — 409 tenant.readonly, чтение и экран тарифа доступны', async () => {
    const cookie = await login(ADMIN_PHONE)
    const res = await fetch(`${BASE}/api/v1/courses`, json(cookie, 'POST', { title: `K5 курс ${stamp}`, language: 'uk', strictOrder: true, tags: [] }))
    expect(res.status).toBe(409)
    expect(await errorOf(res)).toMatchObject({ code: 'tenant.readonly' })
    expect((await fetch(`${BASE}/api/v1/courses`, { headers: { cookie } })).status).toBe(200)
    const summary = await fetch(`${BASE}/api/v1/billing/summary`, { headers: { cookie } })
    expect(summary.status).toBe(200)
    expect(((await summary.json()) as { data: { subscription: { status: string } } }).data.subscription.status).toBe('readonly')
  })

  it('к. 5: в readonly прохождение назначенного — успешно: open → tick → «Я ознайомився» → complete', async () => {
    const cookie = await login(EMPLOYEE_PHONE)
    const ref = { assignmentId }
    const base = `${BASE}/api/v1/learning/resources/${resourceId}`
    expect((await fetch(`${base}/open`, json(cookie, 'POST', { ...ref, device: 'desktop' }))).status).toBe(200)
    expect((await fetch(`${base}/tick`, json(cookie, 'POST', { ...ref, seconds: 15 }))).status).toBe(200)
    expect((await fetch(`${base}/acknowledge`, json(cookie, 'POST', ref))).status).toBe(200)
    const done = await fetch(`${base}/complete`, json(cookie, 'POST', ref))
    expect(done.status).toBe(200)
    const [log] = await admin`select status from task_status_log where content_id = ${resourceId} and content_type = 'resource' order by created_at desc limit 1`
    expect(log).toMatchObject({ status: 'done' })
  })

  it('к. 7: ручки смены тарифа — скоупы, подтверждение, тариф вне каталога', async () => {
    const employee = await login(EMPLOYEE_PHONE)
    expect((await fetch(`${BASE}/api/v1/billing/plans`, { headers: { cookie: employee } })).status).toBe(403)
    expect((await fetch(`${BASE}/api/v1/billing/plan-change/preflight`, json(employee, 'POST', { planCode: 'trial', billingPeriod: 'month' }))).status).toBe(403)

    // Смена тарифа — скоуп `billing.manage` владельца (§2); права — по активной роли (docs/01 §1.9.2),
    // переключение роли в readonly разрешено: это не изменение данных тенанта
    const owner = await login(ADMIN_PHONE)
    const [ownerRole] = await admin`select id from roles where tenant_id = ${tenantId} and code = 'owner'`
    expect((await fetch(`${BASE}/api/v1/me/role/switch`, json(owner, 'POST', { roleId: ownerRole!.id }))).status).toBe(200)
    const plans = await fetch(`${BASE}/api/v1/billing/plans`, { headers: { cookie: owner } })
    expect(plans.status).toBe(200)
    const cat = ((await plans.json()) as { data: { plans: { code: string, direction: string }[], nextPeriodStart: string } }).data
    expect(cat.plans.length).toBeGreaterThan(0)
    expect(cat.nextPeriodStart).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    const noConfirm = await fetch(`${BASE}/api/v1/billing/plan-change`, json(owner, 'POST', { planCode: 'trial', billingPeriod: 'month' }))
    expect(noConfirm.status).toBe(422)
    expect((await errorOf(noConfirm)).message).toBe('Підтвердьте, що ознайомились із новими лімітами')
    const unknown = await fetch(`${BASE}/api/v1/billing/plan-change/preflight`, json(owner, 'POST', { planCode: `nope-${stamp}`, billingPeriod: 'month' }))
    expect(unknown.status).toBe(404)
    expect((await fetch(`${BASE}/api/v1/billing/plan-change/${crypto.randomUUID()}`, json(owner, 'DELETE'))).status).toBe(404)
  })
})
