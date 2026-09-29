import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * `docs/v2/35-billing-limits.md` §13 к. 7 — переход вниз по тарифу (§5.2, §6.1, §7.6, §10):
 * **дано** 42 активных сотрудника и тир с лимитом 25, **тоді** «Підключити» неактивна и показан
 * текст «заблокуйте 17 співробітників»; **коли** заблокировано 17 и нажато «Перерахувати», **тоді**
 * переход доступен с первого дня следующего периода.
 *
 * Сервер считает N (`blockers[].excess`) и дату (`nextPeriodStart`), экран только показывает.
 * Задача `billing.plan_change_apply` (§11) применяет назначенный переход в эту дату.
 * Ручки и экран — `v2-billing-http.spec.ts`, e2e `billing-plans`.
 */

const { planCatalog, preflightPlanChange, requestPlanChange, cancelPlanChange, applyScheduledPlanChanges, blockersOf, directionOf, nextPeriodStart } = await import('../../server/services/planChange')
const { invalidateLimits, effectiveLimits } = await import('../../server/services/tenantLimits')
const { addDays, todayIn } = await import('../../server/services/subscriptionStatus')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const stamp = Date.now()
const BIG = `k7_big_${stamp}`
const SMALL = `k7_small_${stamp}`
const TOP = `k7_top_${stamp}`
const OFF = `k7_off_${stamp}`

let tenantId: string
let ownerId: string
let originalPlan: string
let today: string
const extraUsers: string[] = []

const ctx = () => ({ tenantId, actorId: ownerId })
const activeEmployees = async () => Number((await admin`select count(*)::int as n from users where tenant_id = ${tenantId} and kind = 'employee' and status = 'active' and not is_blocked`)[0]!.n)
const notices = async (code: string) => admin`select user_id, payload from notifications where tenant_id = ${tenantId} and code = ${code}`

beforeAll(async () => {
  const [t] = await admin`select id, plan, timezone from tenants where slug = 'kappi'`
  tenantId = t!.id as string
  originalPlan = t!.plan as string
  today = todayIn(t!.timezone as string)
  const [o] = await admin`select ur.user_id from user_roles ur join roles r on r.id = ur.role_id join users u on u.id = ur.user_id
    where u.tenant_id = ${tenantId} and r.code = 'owner' limit 1`
  ownerId = o!.user_id as string
  await admin`insert into plans (code, name, title_uk, tier, sort, max_users, max_candidates, max_storage_gb, max_ai_generate_ops) values
    (${TOP}, 'K7 top', 'Мережа 150', 3, 30, 150, 300, 100, 500),
    (${BIG}, 'K7 big', 'Мережа 100', 2, 20, 100, 200, 100, 300),
    (${SMALL}, 'K7 small', 'Старт 25', 1, 10, 25, null, null, 100)`
  await admin`insert into plans (code, name, tier, sort, max_users, is_active) values (${OFF}, 'K7 off', 0, 5, 5, false)`
  await admin`insert into plan_prices (plan_code, billing_period, currency, amount_minor) values
    (${SMALL}, 'month', 'EUR', 10000), (${SMALL}, 'year', 'EUR', 7500), (${BIG}, 'month', 'EUR', 20000)`
}, 60_000)

beforeEach(async () => {
  // Дано: тариф «Мережа 100», оплачено до сегодня + 10 дней, ровно 42 активных сотрудника
  await admin`update tenants set plan = ${BIG} where id = ${tenantId}`
  await admin`insert into tenant_limits (tenant_id, status, paid_until) values (${tenantId}, 'active', ${addDays(today, 10)})
    on conflict (tenant_id) do update set status = 'active', paid_until = excluded.paid_until, users = null, candidates = null, storage_gb = null`
  const need = 42 - await activeEmployees()
  for (let i = 0; i < need; i++) {
    const [u] = await admin`insert into users (tenant_id, phone, full_name, status, hired_at) values (${tenantId}, ${`+38093${String(stamp).slice(-5)}${String(extraUsers.length).padStart(3, '0')}`}, ${`K7 співробітник ${i}`}, 'active', current_date) returning id`
    extraUsers.push(u!.id as string)
  }
  invalidateLimits()
})

afterEach(async () => {
  await admin`delete from plan_change_requests where tenant_id = ${tenantId}`
  await admin`delete from notifications where tenant_id = ${tenantId} and code in ('plan_change_blocked', 'plan_changed')`
  await admin`delete from tenant_limits where tenant_id = ${tenantId}`
  await admin`update users set is_blocked = false where id = any(${extraUsers})`
  await admin`update tenants set plan = ${originalPlan} where id = ${tenantId}`
  invalidateLimits()
})

afterAll(async () => {
  await admin`delete from audit_log where tenant_id = ${tenantId} and action like 'billing.plan_change%'`
  await admin`delete from users where id = any(${extraUsers})`
  await admin`delete from plan_prices where plan_code in (${BIG}, ${SMALL}, ${TOP}, ${OFF})`
  await admin`delete from plans where code in (${BIG}, ${SMALL}, ${TOP}, ${OFF})`
  await admin.end()
})

async function blockSeventeen() {
  await admin`update users set is_blocked = true where id = any(${extraUsers.slice(0, 17)})`
}

describe('35 §13 к. 7: дано 42 активных и тир с лимитом 25', () => {
  it('тоді «Підключити» неактивна: на карточке тира превышение 42 из 25 и N = 17 — считает сервер', async () => {
    expect(await activeEmployees()).toBe(42)
    const cat = await planCatalog(tenantId, true)
    const small = cat.plans.find(p => p.code === SMALL)!
    expect(small.direction).toBe('down')
    expect(small.blockers).toEqual([{ axis: 'users_active', current: 42, newLimit: 25, excess: 17 }])
    expect(cat.plans.find(p => p.code === BIG)!.direction).toBe('current')
    expect(cat.plans.find(p => p.code === TOP)!).toMatchObject({ direction: 'up', blockers: [] })
    // Выключенный тариф в каталог не попадает
    expect(cat.plans.some(p => p.code === OFF)).toBe(false)
  })

  it('тоді предпросмотр — заявка blocked с тем же превышением; «Підключити» — 409 limit_exceeded, перехода нет', async () => {
    const pf = await preflightPlanChange(ctx(), { planCode: SMALL, billingPeriod: 'month' })
    expect(pf).toMatchObject({ ok: true, allowed: false, request: { status: 'blocked', toPlanCode: SMALL, effectiveAt: null } })
    if (!pf.ok) return
    expect(pf.request.blockers).toEqual([{ axis: 'users_active', current: 42, newLimit: 25, excess: 17 }])
    const [row] = await admin`select status, blockers from plan_change_requests where id = ${pf.request.id}`
    expect(row).toMatchObject({ status: 'blocked', blockers: [{ axis: 'users_active', current: 42, new_limit: 25, excess: 17 }] })

    const r = await requestPlanChange(ctx(), { planCode: SMALL, billingPeriod: 'month', confirm: true })
    expect(r).toMatchObject({ ok: false, code: 'limit_exceeded', request: { status: 'blocked', blockers: [{ excess: 17 }] } })
    expect((await admin`select plan from tenants where id = ${tenantId}`)[0]!.plan).toBe(BIG)
  })

  it('plan_change_blocked — владельцу один раз на заявку, а не на каждый пересчёт', async () => {
    await preflightPlanChange(ctx(), { planCode: SMALL, billingPeriod: 'month' })
    await preflightPlanChange(ctx(), { planCode: SMALL, billingPeriod: 'month' })
    const sent = await notices('plan_change_blocked')
    expect(sent.length).toBe(1)
    expect(sent[0]).toMatchObject({ user_id: ownerId, payload: { plan_name: 'Старт 25', axes: 'Співробітників' } })
  })
})

describe('35 §13 к. 7: коли заблоковано 17 і натиснуто «Перерахувати»', () => {
  it('тоді перехід доступний з першого дня наступного періоду — і назначается на эту дату', async () => {
    const first = await preflightPlanChange(ctx(), { planCode: SMALL, billingPeriod: 'month' })
    expect(first.ok && first.request.status).toBe('blocked')

    await blockSeventeen()
    expect(await activeEmployees()).toBe(25)
    const recalc = await preflightPlanChange(ctx(), { planCode: SMALL, billingPeriod: 'month' })
    const nextPeriod = addDays(today, 11)
    expect(recalc).toMatchObject({ ok: true, allowed: true, request: { status: 'preflight', blockers: [], effectiveAt: nextPeriod } })
    // «Перерахувати» — та же заявка, а не вторая (§7.6 п. 4: blocked → preflight)
    if (first.ok && recalc.ok) expect(recalc.request.id).toBe(first.request.id)
    expect((await planCatalog(tenantId, false)).plans.find(p => p.code === SMALL)!.blockers).toEqual([])

    const r = await requestPlanChange(ctx(), { planCode: SMALL, billingPeriod: 'month', confirm: true })
    expect(r).toMatchObject({ ok: true, request: { status: 'scheduled', effectiveAt: nextPeriod } })
    // Тариф сейчас не меняется: деньги за текущий период не возвращаются (§7.6 п. 2)
    expect((await admin`select plan from tenants where id = ${tenantId}`)[0]!.plan).toBe(BIG)
    const [audit] = await admin`select actor_id, after from audit_log where tenant_id = ${tenantId} and action = 'billing.plan_change_scheduled' order by id desc limit 1`
    expect(audit).toMatchObject({ actor_id: ownerId, after: { plan: SMALL, effectiveAt: nextPeriod } })
    expect((await planCatalog(tenantId, false)).request).toMatchObject({ status: 'scheduled', effectiveAt: nextPeriod })

    // billing.plan_change_apply: накануне — ничего, в дату — тариф применён, plan_changed отправлено
    expect(await applyScheduledPlanChanges(tenantId, addDays(nextPeriod, -1))).toMatchObject({ applied: 0 })
    expect(await applyScheduledPlanChanges(tenantId, nextPeriod)).toMatchObject({ applied: 1 })
    expect((await admin`select plan from tenants where id = ${tenantId}`)[0]!.plan).toBe(SMALL)
    expect((await effectiveLimits(tenantId)).users).toBe(25)
    expect((await notices('plan_changed')).length).toBeGreaterThan(0)
    const [applied] = await admin`select status from plan_change_requests where tenant_id = ${tenantId} and status = 'applied'`
    expect(applied).toBeDefined()
    // Повторный прогон — второй раз не применяет
    expect(await applyScheduledPlanChanges(tenantId, nextPeriod)).toMatchObject({ applied: 0 })
  })

  it('первый день следующего периода без paid_until (trial) — после конца календарного окна', async () => {
    await admin`update tenant_limits set paid_until = null, status = 'trial' where tenant_id = ${tenantId}`
    invalidateLimits(tenantId)
    const d = await nextPeriodStart(tenantId, '2026-09-29')
    expect(d).toBe('2026-10-01')
  })
})

describe('заявка: крайние случаи §7.6, §10, §12', () => {
  beforeEach(blockSeventeen)

  it('назначенный переход — второй «Підключити» получает 409 conflict; отмена освобождает', async () => {
    const a = await requestPlanChange(ctx(), { planCode: SMALL, billingPeriod: 'month', confirm: true })
    expect(a.ok).toBe(true)
    expect(await requestPlanChange(ctx(), { planCode: SMALL, billingPeriod: 'year', confirm: true })).toEqual({ ok: false, code: 'conflict' })
    if (!a.ok) return
    const c = await cancelPlanChange(ctx(), a.request.id)
    expect(c).toMatchObject({ ok: true, request: { status: 'cancelled' } })
    expect(await cancelPlanChange(ctx(), a.request.id)).toEqual({ ok: false, code: 'not_applicable' })
    expect(await cancelPlanChange(ctx(), '00000000-0000-0000-0000-000000000000')).toEqual({ ok: false, code: 'not_found' })
    expect((await requestPlanChange(ctx(), { planCode: SMALL, billingPeriod: 'month', confirm: true })).ok).toBe(true)
  })

  it('два «Підключити» разом — проходит ровно один', async () => {
    const [a, b] = await Promise.all([
      requestPlanChange(ctx(), { planCode: SMALL, billingPeriod: 'month', confirm: true }),
      requestPlanChange(ctx(), { planCode: SMALL, billingPeriod: 'year', confirm: true }),
    ])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    expect((await admin`select count(*)::int as n from plan_change_requests where tenant_id = ${tenantId} and status = 'scheduled'`)[0]!.n).toBe(1)
  })

  it('предпросмотр на другой тариф закрывает прежнюю открытую заявку — открытой остаётся одна', async () => {
    await admin`update users set is_blocked = false where id = any(${extraUsers})`
    const a = await preflightPlanChange(ctx(), { planCode: SMALL, billingPeriod: 'month' })
    const b = await preflightPlanChange(ctx(), { planCode: SMALL, billingPeriod: 'year' })
    expect(a.ok && b.ok && a.request.id !== b.request.id).toBe(true)
    const open = await admin`select status from plan_change_requests where tenant_id = ${tenantId} and status in ('preflight', 'blocked')`
    expect(open).toHaveLength(1)
  })

  it('вверх, тот же и выключенный тариф — не самообслуживание', async () => {
    expect(await preflightPlanChange(ctx(), { planCode: TOP, billingPeriod: 'month' })).toEqual({ ok: false, code: 'upgrade_manual' })
    expect(await requestPlanChange(ctx(), { planCode: TOP, billingPeriod: 'month', confirm: true })).toEqual({ ok: false, code: 'upgrade_manual' })
    expect(await preflightPlanChange(ctx(), { planCode: BIG, billingPeriod: 'month' })).toEqual({ ok: false, code: 'same_plan' })
    expect(await preflightPlanChange(ctx(), { planCode: OFF, billingPeriod: 'month' })).toEqual({ ok: false, code: 'not_found' })
    expect(await preflightPlanChange(ctx(), { planCode: 'no-such-plan', billingPeriod: 'month' })).toEqual({ ok: false, code: 'not_found' })
  })

  it('к дате применения снова набрали людей — заявка возвращается в blocked, тариф не меняется', async () => {
    const a = await requestPlanChange(ctx(), { planCode: SMALL, billingPeriod: 'month', confirm: true })
    expect(a.ok).toBe(true)
    await admin`update users set is_blocked = false where id = any(${extraUsers})`
    const r = await applyScheduledPlanChanges(tenantId, addDays(today, 11))
    expect(r).toMatchObject({ applied: 0, blocked: 1 })
    expect((await admin`select plan from tenants where id = ${tenantId}`)[0]!.plan).toBe(BIG)
    expect((await notices('plan_change_blocked')).length).toBe(1)
  })

  it('blocked живёт 30 дней, затем cancelled', async () => {
    await admin`update users set is_blocked = false where id = any(${extraUsers})`
    const a = await preflightPlanChange(ctx(), { planCode: SMALL, billingPeriod: 'month' })
    if (!a.ok) throw new Error('preflight')
    expect((await applyScheduledPlanChanges(tenantId, addDays(today, 30))).expired).toBe(0)
    expect((await applyScheduledPlanChanges(tenantId, addDays(today, 31))).expired).toBe(1)
    expect((await admin`select status from plan_change_requests where id = ${a.request.id}`)[0]!.status).toBe('cancelled')
  })

  it('переопределение оператора и доплаты учитываются в лимите после перехода (§7.3, §7.8 п. 1)', async () => {
    await admin`update users set is_blocked = false where id = any(${extraUsers})`
    await admin`update tenant_limits set users = 50 where tenant_id = ${tenantId}`
    invalidateLimits(tenantId)
    const pf = await preflightPlanChange(ctx(), { planCode: SMALL, billingPeriod: 'month' })
    expect(pf).toMatchObject({ ok: true, allowed: true })
  })

  it('каталог: цены и «Економія» — только владельцу; лимиты по осям с карточки тарифа', async () => {
    const owner = await planCatalog(tenantId, true)
    const small = owner.plans.find(p => p.code === SMALL)!
    expect(small.prices).toEqual({ month: 10000, year: 7500 })
    expect(small.annualSavingPct).toBe(25)
    expect(small.limits).toMatchObject({ users: 25, candidates: null, storageBytes: null, aiGenerateOps: 100 })
    expect(owner.plans.find(p => p.code === BIG)!.limits.storageBytes).toBe(100 * 1024 ** 3)
    const adminView = await planCatalog(tenantId, false)
    expect(adminView.plans.find(p => p.code === SMALL)!).toMatchObject({ prices: null, annualSavingPct: null })
    // Порядок — тир, затем sort
    const codes = owner.plans.map(p => p.code).filter(c => c.startsWith('k7_'))
    expect(codes).toEqual([SMALL, BIG, TOP])
  })
})

describe('правила без базы', () => {
  it('blockersOf: превышение только там, где лимит задан и факт выше; хранилище — в байтах', () => {
    expect(blockersOf({ users_active: 42, candidates_active: 60, storage_bytes: 120 }, { users_active: 25, candidates_active: 50, storage_bytes: 100 })).toEqual([
      { axis: 'users_active', current: 42, newLimit: 25, excess: 17 },
      { axis: 'candidates_active', current: 60, newLimit: 50, excess: 10 },
      { axis: 'storage_bytes', current: 120, newLimit: 100, excess: 20 },
    ])
    expect(blockersOf({ users_active: 25 }, { users_active: 25, candidates_active: null })).toEqual([])
  })

  it('directionOf: тир, затем sort', () => {
    const p = (code: string, tier: number, sort: number) => ({ code, tier, sort })
    expect(directionOf(p('a', 2, 0), p('b', 1, 9))).toBe('down')
    expect(directionOf(p('a', 1, 0), p('b', 2, 0))).toBe('up')
    expect(directionOf(p('a', 0, 5), p('b', 0, 1))).toBe('down')
    expect(directionOf(p('a', 0, 1), p('b', 0, 5))).toBe('up')
    expect(directionOf(p('a', 0, 1), p('a', 0, 1))).toBe('current')
    expect(directionOf(undefined, p('b', 0, 1))).toBe('up')
  })
})
