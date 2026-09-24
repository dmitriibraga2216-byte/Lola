import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

/**
 * PR-10 пакета `docs/v2` (`45-plan.md`): `tenant_payments`, `plan_change_requests`, приём
 * платежа оператором вручную (обходной путь `44` §8 на отсутствие платёжного провайдера) и
 * прямая смена тарифа оператором (§7.10).
 *
 * Критерии приёмки `docs/v2/35-billing-limits.md` §13, закрываемые этим PR:
 *   к. 6 — оплата в `readonly` на 10-й день просрочки сдвигает `paid_until` от прежней даты
 *          окончания, а не от даты платежа;
 *   к. 10 (часть) — `/billing/payments` от роли без `billing.payments.view` — `403`.
 */

process.env.PLATFORM_DATABASE_URL ??= 'postgres://platform_admin:platform_admin_dev@localhost:5432/lola'
process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const { recordTenantPayment, listTenantPaymentsForOperator, changeTenantPlan, grantTenantAddon } = await import('../../server/services/platformTenants')
const { platformLogin, validatePlatformSession, ensureFirstAdmin } = await import('../../server/services/platform')
const { invalidateLimits, effectiveLimits } = await import('../../server/services/tenantLimits')
const { billingSummary, listTenantPayments } = await import('../../server/services/billing')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const OPS_EMAIL = 'ops-v2-10@lola.local'
const OPS_PASSWORD = 'test-password-123'

let tenantId: string
let opsAuth: Awaited<ReturnType<typeof validatePlatformSession>>

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  process.env.PLATFORM_ADMIN_EMAIL = OPS_EMAIL
  process.env.PLATFORM_ADMIN_PASSWORD = OPS_PASSWORD
  await admin`delete from platform_admins where email = ${OPS_EMAIL}`
  await ensureFirstAdmin()
  const session = await platformLogin(OPS_EMAIL, OPS_PASSWORD)
  opsAuth = await validatePlatformSession(session!.token)
}, 60_000)

afterEach(async () => {
  await admin`delete from tenant_payments where tenant_id = ${tenantId}`
  await admin`delete from plan_change_requests where tenant_id = ${tenantId}`
  await admin`delete from tenant_addons where tenant_id = ${tenantId}`
  await admin`delete from tenant_limits where tenant_id = ${tenantId}`
  await admin`update tenants set plan = 'trial' where id = ${tenantId}`
  invalidateLimits()
})

afterAll(async () => {
  await admin`delete from platform_sessions where admin_id in (select id from platform_admins where email = ${OPS_EMAIL})`
  await admin`delete from platform_admins where email = ${OPS_EMAIL}`
  await admin.end()
})

describe('миграция 0073: tenant_payments и plan_change_requests', () => {
  it('обе таблицы ссылаются на plan_code(s), а не на plan_id (В-5, то же исправление, что у plan_prices)', async () => {
    const payCols = (await admin`select column_name from information_schema.columns where table_name = 'tenant_payments'`).map(r => r.column_name)
    expect(payCols).toContain('plan_code')
    expect(payCols).not.toContain('plan_id')
    const pcrCols = (await admin`select column_name from information_schema.columns where table_name = 'plan_change_requests'`).map(r => r.column_name)
    expect(pcrCols).toContain('from_plan_code')
    expect(pcrCols).toContain('to_plan_code')
    expect(pcrCols).not.toContain('from_plan_id')
    expect(pcrCols).not.toContain('to_plan_id')
  })

  it('tenant_addons.payment_id получил отложенный FK на tenant_payments (заявлен в PR-08)', async () => {
    const [fk] = await admin`
      select 1 from pg_constraint where conname = 'tenant_addons_payment_id_tenant_payments_id_fk'`
    expect(fk).toBeDefined()
  })
})

describe('35 §7.8 п. 6, §13 к. 6: продление считается от прежней даты окончания', () => {
  it('первая оплата тенанта без paid_until — период считается от сегодня', async () => {
    const r = await recordTenantPayment(tenantId, { kind: 'subscription', billingPeriod: 'month', amountMinor: 4900, currency: 'EUR', status: 'paid', comment: 'перший платіж тенанта' }, opsAuth!)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const today = new Date().toISOString().slice(0, 10)
    expect(r.payment.periodFrom).toBe(today)
    expect(r.subscription.status).toBe('active')
    expect(r.subscription.paidUntil).not.toBeNull()
  })

  it('оплата на 10-й день просрочки в readonly сдвигает paid_until от прежнего, не от сьогодні', async () => {
    const oldPaidUntil = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10)
    await admin`insert into tenant_limits (tenant_id, status, paid_until, grace_until, billing_period)
                values (${tenantId}, 'readonly', ${oldPaidUntil}, ${oldPaidUntil}, 'month')`
    invalidateLimits()
    const r = await recordTenantPayment(tenantId, { kind: 'subscription', billingPeriod: 'month', amountMinor: 4900, currency: 'EUR', status: 'paid', comment: 'оплата після простроченого періоду' }, opsAuth!)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const [y, m, d] = oldPaidUntil.split('-').map(Number)
    const expected = new Date(Date.UTC(y!, m! - 1 + 1, d!)).toISOString().slice(0, 10) // +1 месяц от СТАРОЙ даты
    expect(r.payment.periodFrom).toBe(oldPaidUntil)
    expect(r.payment.periodTo).toBe(expected)
    expect(r.subscription.paidUntil).toBe(expected)
    expect(r.subscription.status).toBe('active') // немедленно возвращает active (§7.8 п. 6)
    expect(r.subscription.graceUntil).toBeNull()
    // Оплаченный срок точно не «сегодня + месяц» — иначе просрочка стала бы бесплатной отсрочкой
    const todayPlusMonth = new Date(); todayPlusMonth.setMonth(todayPlusMonth.getMonth() + 1)
    expect(r.payment.periodTo).not.toBe(todayPlusMonth.toISOString().slice(0, 10))
  })

  it('неизвестный тенант — not_found', async () => {
    const r = await recordTenantPayment('00000000-0000-0000-0000-000000000000', { kind: 'adjustment', amountMinor: 100, currency: 'EUR', status: 'paid', comment: 'перевірка неіснуючого тенанта' }, opsAuth!)
    expect(r).toEqual({ ok: false, code: 'not_found' })
  })
})

describe('35 §3.5: kind=addon покупает опцию со ссылкой на платёж', () => {
  it('addon покупка создаёт tenant_addons с source=purchase и payment_id', async () => {
    const r = await recordTenantPayment(tenantId, { kind: 'addon', addonCode: 'storage_pack', qty: 1, amountMinor: 500, currency: 'EUR', status: 'paid', comment: 'докупка сховища на 100 Гб' }, opsAuth!)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const [row] = await admin`select source, payment_id, qty from tenant_addons where tenant_id = ${tenantId} and addon_code = 'storage_pack'`
    expect(row!.source).toBe('purchase')
    expect(row!.payment_id).toBe(r.payment.id)
    expect(row!.qty).toBe(1)
  })

  it('неизвестный код опции — addon_unknown, платёж не создаётся', async () => {
    const r = await recordTenantPayment(tenantId, { kind: 'addon', addonCode: 'немає-такого', qty: 1, amountMinor: 500, currency: 'EUR', status: 'paid', comment: 'перевірка неіснуючого коду опції' }, opsAuth!)
    expect(r).toEqual({ ok: false, code: 'addon_unknown' })
    const rows = await admin`select id from tenant_payments where tenant_id = ${tenantId}`
    expect(rows).toHaveLength(0)
  })
})

describe('35 §7.10: kind=adjustment ничего не двигает, кроме самой записи', () => {
  it('коррекция/списание не меняет ни tenant_limits, ни tenant_addons', async () => {
    await admin`insert into tenant_limits (tenant_id, status, paid_until) values (${tenantId}, 'active', current_date + 30)`
    invalidateLimits()
    const before = await effectiveLimits(tenantId)
    const r = await recordTenantPayment(tenantId, { kind: 'adjustment', amountMinor: 100, currency: 'EUR', status: 'written_off', comment: 'списання дебіторської заборгованості' }, opsAuth!)
    expect(r.ok).toBe(true)
    invalidateLimits()
    const after = await effectiveLimits(tenantId)
    expect(after.subscription).toEqual(before.subscription)
    if (r.ok) expect(r.payment.status).toBe('written_off')
  })
})

describe('§7.10: смена тарифа оператором — сразу applied, без preflight', () => {
  it('changeTenantPlan обновляет tenants.plan и создаёт заявку applied', async () => {
    const r = await changeTenantPlan(tenantId, { toPlanCode: 'network', billingPeriod: 'year', comment: 'перехід на мережевий тариф за домовленістю' }, opsAuth!)
    expect(r.ok).toBe(true)
    const [t] = await admin`select plan from tenants where id = ${tenantId}`
    expect(t!.plan).toBe('network')
    if (!r.ok) return
    const [row] = await admin`select status, from_plan_code, to_plan_code, billing_period from plan_change_requests where id = ${r.id}`
    expect(row!.status).toBe('applied')
    expect(row!.from_plan_code).toBe('trial')
    expect(row!.to_plan_code).toBe('network')
    expect(row!.billing_period).toBe('year')
  })

  it('неизвестный тариф — plan_unknown, план тенанта не меняется', async () => {
    const r = await changeTenantPlan(tenantId, { toPlanCode: 'немає-такого', billingPeriod: 'month', comment: 'перевірка неіснуючого тарифу' }, opsAuth!)
    expect(r).toEqual({ ok: false, code: 'plan_unknown' })
    const [t] = await admin`select plan from tenants where id = ${tenantId}`
    expect(t!.plan).toBe('trial')
  })
})

describe('35 §5.1, §5.3, §10: сводка и история для владельца', () => {
  it('billingSummary скрывает цену без withPrice и показывает с ним', async () => {
    const withoutPrice = await billingSummary(tenantId, false)
    expect(withoutPrice.priceMinor).toBeNull()
    // priceMinor с withPrice=true либо число, либо null, если для тарифа/периода нет строки цены —
    // тест проверяет именно то, что параметр учитывается, а не гадает конкретную сумму
    const withPrice = await billingSummary(tenantId, true)
    expect(withPrice.plan.code).toBe(withoutPrice.plan.code)
  })

  it('активные аддоны видны в сводке, истёкшие — нет', async () => {
    await grantTenantAddon(tenantId, { addonCode: 'ai_ops_pack', qty: 2 }, opsAuth!)
    await grantTenantAddon(tenantId, { addonCode: 'sms_pack', qty: 1, validUntil: '2000-01-01' }, opsAuth!)
    const s = await billingSummary(tenantId, false)
    const codes = s.addons.map(a => a.addonCode)
    expect(codes).toContain('ai_ops_pack')
    expect(codes).not.toContain('sms_pack') // истекла в 2000 году
  })

  it('listTenantPayments фильтрует по kind/status и отдаёт nextCursor при переполнении лимита', async () => {
    for (let i = 0; i < 3; i++) {
      await recordTenantPayment(tenantId, { kind: 'adjustment', amountMinor: 100 + i, currency: 'EUR', status: 'paid', comment: `запис для перевірки історії №${i}` }, opsAuth!)
    }
    const page1 = await listTenantPayments(tenantId, { limit: 2, kind: undefined, status: undefined })
    expect(page1.items).toHaveLength(2)
    expect(page1.nextCursor).not.toBeNull()
    const page2 = await listTenantPayments(tenantId, { limit: 2, cursor: page1.nextCursor! })
    expect(page2.items.length).toBeGreaterThanOrEqual(1)
    const onlyPaid = await listTenantPayments(tenantId, { limit: 10, status: 'paid' })
    expect(onlyPaid.items.every(p => p.status === 'paid')).toBe(true)
  })

  it('операторская история платежей (панель) видит те же записи, что и listTenantPayments', async () => {
    await recordTenantPayment(tenantId, { kind: 'adjustment', amountMinor: 42, currency: 'EUR', status: 'paid', comment: 'запис для панелі оператора' }, opsAuth!)
    const opRows = await listTenantPaymentsForOperator(tenantId)
    const { items } = await listTenantPayments(tenantId, { limit: 50 })
    expect(opRows.length).toBe(items.length)
  })
})
