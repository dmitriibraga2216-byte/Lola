import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Бонуси і магазин по HTTP (по образцу spec21-http.spec.ts): скоупы и коды ответов ручек
 * `/me/bonuses`, `/me/gift-store`, `/gift-store/*`, `/bonuses/*`, `/settings/rewards`; модуль
 * гасит магазин (403 `module.disabled`), но не правила; чужой тенант — 404.
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
let adminId: string
let otherTenantId: string
const stamp = Date.now()
const itemIds: string[] = []
let foreignItemId: string
let foreignOrderId: string
let foreignUserId: string
/** Книга человека до теста: после — удаляем только своё, цепочка остатков остаётся целой (ledgerDrift). */
let ledgerIdBefore = 0
let settingsBefore: unknown

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
const code = async (res: Response) => ((await res.json()) as { error?: { code: string } }).error?.code

describe.skipIf(!BUILT)('Бонуси і магазин по HTTP (gamification)', () => {
  beforeAll(async () => {
    await admin`delete from rate_limits where key like ${'otp:%'}`
    await admin`delete from otp_codes where phone in (${ADMIN_PHONE}, ${EMPLOYEE_PHONE})`
    tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
    employeeId = (await admin`select id from users where tenant_id = ${tenantId} and phone = ${EMPLOYEE_PHONE}`)[0]!.id as string
    adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = ${ADMIN_PHONE}`)[0]!.id as string
    const [other] = await admin`insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції') on conflict (slug) do update set name = excluded.name returning id`
    otherTenantId = other!.id as string
    // Чужой тенант: товар и заказ его человека — для проверки 404 (CLAUDE.md п. 15)
    foreignUserId = (await admin`insert into users (tenant_id, phone, full_name, status) values (${otherTenantId}, ${`+38097${String(stamp).slice(-7)}`}, 'Чужий покупець', 'active') returning id`)[0]!.id as string
    foreignItemId = (await admin`insert into shop_items (tenant_id, title, price_bonuses, is_active) values (${otherTenantId}, ${`Чужий подарунок ${stamp}`}, 1, true) returning id`)[0]!.id as string
    foreignOrderId = (await admin`insert into shop_orders (tenant_id, user_id, item_id, price_bonuses, reserved_until) values (${otherTenantId}, ${foreignUserId}, ${foreignItemId}, 1, now() + interval '14 days') returning id`)[0]!.id as string
    settingsBefore = (await admin`select settings from tenants where id = ${tenantId}`)[0]!.settings
    await admin`update tenants set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{modules}', coalesce(settings->'modules', '{}'::jsonb) || '{"bonuses": true}'::jsonb) where id = ${tenantId}`
    ledgerIdBefore = Number((await admin`select coalesce(max(id), 0) as id from points_ledger where user_id = ${employeeId}`)[0]!.id)

    server = spawn('node', ['.output/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), NITRO_PORT: String(PORT), OTP_DEBUG: '1', NUXT_DATABASE_URL: process.env.DATABASE_URL, WORKER_ENABLED: '0' }, stdio: 'ignore' })
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${BASE}/health`)).ok) return }
      catch { /* ещё поднимается */ }
      await new Promise(r => setTimeout(r, 500))
    }
    throw new Error('Собранное приложение не поднялось за 30 секунд')
  }, 90_000)

  afterAll(async () => {
    server?.kill()
    await admin`update tenants set settings = ${admin.json((settingsBefore ?? {}) as never)} where id = ${tenantId}`
    await admin`delete from points_ledger where user_id = ${employeeId} and id > ${ledgerIdBefore}`
    await admin`delete from shop_orders where user_id in (${employeeId}, ${foreignUserId})`
    if (itemIds.length) await admin`delete from shop_items where id in ${admin(itemIds)}`
    await admin`delete from shop_items where id = ${foreignItemId}`
    await admin`delete from users where id = ${foreignUserId}`
    await admin`delete from notifications where user_id = ${employeeId} and code like 'bonus_%'`
    await admin.end()
  })
  beforeEach(async () => { await admin`delete from rate_limits where key like ${'otp:%'}` })
  afterEach(async () => { await admin`delete from rate_limits where key like ${'otp:%'}` })

  it('сотрудник: витрина и заказ без особого права; каталог и чужие заказы — 403; свой заказ отменяет сам', async () => {
    const adm = await login(ADMIN_PHONE)
    const emp = await login(EMPLOYEE_PHONE)
    // Ручное начисление — чтобы хватило на подарок независимо от сида
    const grant = await fetch(`${BASE}/api/v1/bonuses/adjust`, json(adm, 'POST', { userId: employeeId, delta: 25, comment: `HTTP-gam ${stamp} старт` }))
    expect(grant.status).toBe(200)
    const created = await fetch(`${BASE}/api/v1/gift-store/items`, json(adm, 'POST', { title: `HTTP-подарунок ${stamp}`, priceBonuses: 7, stock: 2, isActive: true }))
    expect(created.status).toBe(200)
    const itemId = (await data<{ id: string }>(created)).id
    itemIds.push(itemId)

    const shop = await fetch(`${BASE}/api/v1/me/gift-store`, { headers: { cookie: emp } })
    expect(shop.status).toBe(200)
    const sc = await data<{ balance: number, items: { id: string, blocked: string | null }[] }>(shop)
    expect(sc.items.find(i => i.id === itemId)).toMatchObject({ blocked: null })
    expect((await fetch(`${BASE}/api/v1/gift-store/items`, { headers: { cookie: emp } })).status).toBe(403)
    expect((await fetch(`${BASE}/api/v1/gift-store/orders`, { headers: { cookie: emp } })).status).toBe(403)
    expect((await fetch(`${BASE}/api/v1/bonuses/adjust`, json(emp, 'POST', { userId: adminId, delta: 5, comment: 'Спроба' }))).status).toBe(403)

    const ordered = await fetch(`${BASE}/api/v1/gift-store/items/${itemId}/order`, json(emp, 'POST'))
    expect(ordered.status).toBe(200)
    const o = await data<{ order: { id: string, status: string }, balance: number }>(ordered)
    expect(o.order.status).toBe('reserved')
    expect(o.balance).toBe(sc.balance - 7)
    const mine = await data<{ balance: number, rows: { event: string, delta: number }[] }>(await fetch(`${BASE}/api/v1/me/bonuses`, { headers: { cookie: emp } }))
    expect(mine.balance).toBe(o.balance)
    expect(mine.rows[0]).toMatchObject({ event: 'purchase', delta: -7 })

    const cancelled = await fetch(`${BASE}/api/v1/gift-store/orders/${o.order.id}/status`, json(emp, 'POST', { status: 'cancelled' }))
    expect(cancelled.status).toBe(200)
    expect((await data<{ status: string, cancelledBy: string }>(cancelled))).toMatchObject({ status: 'cancelled', cancelledBy: 'self' })
    expect(await code(await fetch(`${BASE}/api/v1/gift-store/orders/${o.order.id}/status`, json(emp, 'POST', { status: 'cancelled' })))).toBe('forbidden')
  })

  it('ответственный: очередь «До видачі», выдача, отмена только с причиной; себе бонусы — 409; нехватка — 409', async () => {
    const adm = await login(ADMIN_PHONE)
    const emp = await login(EMPLOYEE_PHONE)
    const itemId = itemIds[0]!
    const o = await data<{ order: { id: string } }>(await fetch(`${BASE}/api/v1/gift-store/items/${itemId}/order`, json(emp, 'POST')))
    const queue = await data<{ rows: { id: string }[], counts: { pending: number } }>(await fetch(`${BASE}/api/v1/gift-store/orders?tab=pending`, { headers: { cookie: adm } }))
    expect(queue.rows.map(r => r.id)).toContain(o.order.id)
    expect(queue.counts.pending).toBeGreaterThanOrEqual(1)
    expect(await code(await fetch(`${BASE}/api/v1/gift-store/orders/${o.order.id}/status`, json(adm, 'POST', { status: 'cancelled' })))).toBe('shop.reason_required')
    const ready = await fetch(`${BASE}/api/v1/gift-store/orders/${o.order.id}/status`, json(adm, 'POST', { status: 'ready' }))
    expect(ready.status).toBe(200)
    const issued = await fetch(`${BASE}/api/v1/gift-store/orders/${o.order.id}/status`, json(adm, 'POST', { status: 'issued' }))
    expect((await data<{ status: string }>(issued)).status).toBe('issued')
    expect(await code(await fetch(`${BASE}/api/v1/gift-store/orders/${o.order.id}/status`, json(adm, 'POST', { status: 'ready' })))).toBe('shop.invalid_transition')

    expect(await code(await fetch(`${BASE}/api/v1/bonuses/adjust`, json(adm, 'POST', { userId: adminId, delta: 5, comment: 'Собі' })))).toBe('bonus.self_grant')
    expect(await code(await fetch(`${BASE}/api/v1/bonuses/adjust`, json(adm, 'POST', { userId: employeeId, delta: -100000 + 1, comment: 'Забагато' })))).toBe('validation_failed')
    expect(await code(await fetch(`${BASE}/api/v1/bonuses/adjust`, json(adm, 'POST', { userId: employeeId, delta: -9999, comment: `HTTP-gam ${stamp} мінус` })))).toBe('bonus.insufficient')
    const pricey = await data<{ id: string }>(await fetch(`${BASE}/api/v1/gift-store/items`, json(adm, 'POST', { title: `Дорогий ${stamp}`, priceBonuses: 9999, isActive: true })))
    itemIds.push(pricey.id)
    expect(await code(await fetch(`${BASE}/api/v1/gift-store/items/${pricey.id}/order`, json(emp, 'POST')))).toBe('shop.insufficient_bonuses')

    const ledger = await fetch(`${BASE}/api/v1/bonuses/ledger?limit=5`, { headers: { cookie: adm } })
    expect(ledger.status).toBe(200)
    expect(((await ledger.json()) as { data: unknown[], meta: { cursor: number | null } }).data.length).toBeGreaterThan(0)
    expect((await fetch(`${BASE}/api/v1/bonuses/balances?q=Кухар`, { headers: { cookie: adm } })).status).toBe(200)
  })

  it('чужой тенант — 404: товар не заказать, заказ не существует', async () => {
    const adm = await login(ADMIN_PHONE)
    const emp = await login(EMPLOYEE_PHONE)
    expect((await fetch(`${BASE}/api/v1/gift-store/items/${foreignItemId}/order`, json(emp, 'POST'))).status).toBe(404)
    expect((await fetch(`${BASE}/api/v1/gift-store/orders/${foreignOrderId}/status`, json(adm, 'POST', { status: 'issued' }))).status).toBe(404)
    expect((await fetch(`${BASE}/api/v1/gift-store/items/${foreignItemId}`, json(adm, 'PATCH', { priceBonuses: 2 }))).status).toBe(404)
  })

  it('модуль выключен — магазин и бонусы 403 module.disabled, правила нарахування работают', async () => {
    const adm = await login(ADMIN_PHONE)
    const emp = await login(EMPLOYEE_PHONE)
    expect((await fetch(`${BASE}/api/v1/settings/modules`, json(adm, 'PATCH', { bonuses: false }))).status).toBe(200)
    try {
      expect(await code(await fetch(`${BASE}/api/v1/me/gift-store`, { headers: { cookie: emp } }))).toBe('module.disabled')
      expect(await code(await fetch(`${BASE}/api/v1/me/bonuses`, { headers: { cookie: emp } }))).toBe('module.disabled')
      expect(await code(await fetch(`${BASE}/api/v1/bonuses/ledger`, { headers: { cookie: adm } }))).toBe('module.disabled')
      const rules = await fetch(`${BASE}/api/v1/settings/rewards`, { headers: { cookie: adm } })
      expect(rules.status).toBe(200)
      expect(await data<{ bonusesEnabled: boolean }>(rules)).toMatchObject({ bonusesEnabled: false })
      expect((await fetch(`${BASE}/api/v1/settings/rewards`, { headers: { cookie: emp } })).status).toBe(403)
    }
    finally {
      await fetch(`${BASE}/api/v1/settings/modules`, json(adm, 'PATCH', { bonuses: true }))
    }
  })
})
