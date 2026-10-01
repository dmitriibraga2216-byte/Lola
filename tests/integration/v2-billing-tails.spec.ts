import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { makeEvent, type FakeEvent } from './_nitroGlobals'

/**
 * Хвосты критериев `docs/v2/35-billing-limits.md` §13 (запись `46` «package-criteria-tails»):
 *   к. 9  — опция `term='period'` продлевается вместе с тарифом (`35` §7.8 п. 1, `44` Р-BT.1);
 *   к. 10 — переопределение лимита без причины — `422`, причина лежит в `platform_audit`
 *           (`35` §7.10, §10, `44` Р-BT.2); `/billing/summary` сотруднику — `403`, а не данные.
 * Ручки зовутся обработчиком маршрута напрямую (`_nitroGlobals`), без собранного приложения.
 */

process.env.PLATFORM_DATABASE_URL ??= 'postgres://platform_admin:platform_admin_dev@localhost:5432/lola'
process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const { effectiveLimits, effectiveLimit, invalidateLimits } = await import('../../server/services/tenantLimits')
const { setTenantLimits, grantTenantAddon, recordTenantPayment, listPlatformAudit } = await import('../../server/services/platformTenants')
const { platformLogin, validatePlatformSession, ensureFirstAdmin } = await import('../../server/services/platform')
const limitsPut = (await import('../../server/api/v1/platform/tenants/[id]/limits.put')).default as unknown as (e: FakeEvent) => Promise<unknown>
const summaryGet = (await import('../../server/api/v1/billing/summary.get')).default as unknown as (e: FakeEvent) => Promise<unknown>

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const OPS_EMAIL = 'ops-v2-tails@lola.local'
const OPS_PASSWORD = 'test-password-123'

let tenantId: string
let opsAuth: Awaited<ReturnType<typeof validatePlatformSession>>

const iso = (d: Date) => d.toISOString().slice(0, 10)
const today = () => iso(new Date())

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
  await admin`delete from tenant_addons where tenant_id = ${tenantId}`
  await admin`delete from tenant_limits where tenant_id = ${tenantId}`
  invalidateLimits()
})

afterAll(async () => {
  await admin`delete from platform_audit where admin_email = ${OPS_EMAIL}`
  await admin`delete from platform_sessions where admin_id in (select id from platform_admins where email = ${OPS_EMAIL})`
  await admin`delete from platform_admins where email = ${OPS_EMAIL}`
  await admin.end()
})

/** Подписка, оплаченная до сегодня включительно, и тариф хранилища 100 ГБ (переопределением). */
async function paidThroughToday(autorenew = true) {
  await setTenantLimits(tenantId, { storageGb: 100 }, opsAuth!, 'тариф хранилища для теста к. 9')
  await admin`update tenant_limits set status = 'active', paid_until = current_date, autorenew = ${autorenew} where tenant_id = ${tenantId}`
}
const paySubscription = () => recordTenantPayment(tenantId, { kind: 'subscription', billingPeriod: 'month', amountMinor: 4900, currency: 'EUR', status: 'paid', comment: 'продовження тарифу на місяць' }, opsAuth!)
const addonRow = async (id: string) => (await admin`select to_char(valid_until, 'YYYY-MM-DD') as valid_until from tenant_addons where id = ${id}`)[0]!.valid_until as string | null

describe('35 §13 к. 9: опция «+100 Гб» с term=period продлевается вместе с тарифом', () => {
  it('Дано аддон до конца оплаченного периода, коли тариф продлён, тоді аддон продлён до нового paid_until и лимит 200 Гб', async () => {
    await paidThroughToday()
    const addon = await grantTenantAddon(tenantId, { addonCode: 'storage_pack', qty: 1, validUntil: today(), source: 'purchase' }, opsAuth!)
    expect(addon.ok).toBe(true)
    invalidateLimits()
    expect((await effectiveLimits(tenantId)).storageGb).toBe(200)

    const r = await paySubscription()
    expect(r.ok).toBe(true)
    const paidUntil = r.ok ? r.subscription.paidUntil : null
    expect(paidUntil! > today()).toBe(true)
    expect(await addonRow(addon.ok ? addon.id : '')).toBe(paidUntil)
    invalidateLimits()
    expect((await effectiveLimits(tenantId)).storageGb).toBe(200)
    // Факт продления — в журнале оператора рядом с платежом
    const audit = await listPlatformAudit({ tenantId })
    expect(audit.find(a => a.action === 'tenant.payment')?.after).toMatchObject({ renewedAddons: [addon.ok ? addon.id : ''] })
  })

  it('подарок оператора, истёкшая раньше опция и perpetual не продлеваются', async () => {
    await paidThroughToday()
    const yesterday = iso(new Date(Date.now() - 86_400_000))
    const grant = await grantTenantAddon(tenantId, { addonCode: 'ai_ops_pack', qty: 1, validUntil: today(), source: 'grant' }, opsAuth!)
    const expired = await grantTenantAddon(tenantId, { addonCode: 'sms_pack', qty: 1, validUntil: yesterday, source: 'purchase' }, opsAuth!)
    const forever = await grantTenantAddon(tenantId, { addonCode: 'ai_term', qty: 1, validUntil: null, source: 'purchase' }, opsAuth!)
    expect((await paySubscription()).ok).toBe(true)
    expect(await addonRow(grant.ok ? grant.id : '')).toBe(today())
    expect(await addonRow(expired.ok ? expired.id : '')).toBe(yesterday)
    expect(await addonRow(forever.ok ? forever.id : '')).toBeNull()
  })

  it('без автопродления (autorenew = false) опция живёт до своей даты', async () => {
    await paidThroughToday(false)
    const addon = await grantTenantAddon(tenantId, { addonCode: 'storage_pack', qty: 1, validUntil: today(), source: 'purchase' }, opsAuth!)
    expect((await paySubscription()).ok).toBe(true)
    expect(await addonRow(addon.ok ? addon.id : '')).toBe(today())
  })
})

describe('35 §13 к. 10: переопределение с причиной; /billing/summary сотруднику — 403', () => {
  const putEvent = (body: unknown) => {
    const e = Object.assign(makeEvent({ path: `/api/v1/platform/tenants/${tenantId}/limits`, params: { id: tenantId } }), { _body: body })
    e.context.platform = { ...opsAuth!, twoFactorPending: false }
    return e
  }

  it('без причины — 422 reason_required, лимит не изменился', async () => {
    const e = putEvent({ users: 175 })
    const res = await limitsPut(e) as { error: { code: string } }
    expect(e._status).toBe(422)
    expect(res.error.code).toBe('reason_required')
    const short = putEvent({ users: 175, reason: 'коротко' })
    await limitsPut(short)
    expect(short._status).toBe(422)
    invalidateLimits()
    expect(await effectiveLimit(tenantId, 'users_active')).not.toBe(175)
  })

  it('Дано оператор переопределил users_active в 175 с причиной, тоді значение действует немедленно и причина в platform_audit', async () => {
    const reason = 'Пілот на 175 місць до кінця кварталу'
    const e = putEvent({ users: 175, reason })
    const res = await limitsPut(e) as { data: { overrides: { users: number } } }
    expect(e._status).toBeNull()
    expect(res.data.overrides.users).toBe(175)
    // без ручного сброса кеша: ручка сама его инвалидирует
    expect(await effectiveLimit(tenantId, 'users_active')).toBe(175)
    const audit = await listPlatformAudit({ tenantId })
    expect(audit.find(a => a.action === 'tenant.limits')?.after).toMatchObject({ users: 175, reason })
  })

  it('Дано запрос /billing/summary от роли employee, тоді 403, а не частичные данные', async () => {
    const userOf = async (phone: string) => (await admin`select id from users where tenant_id = ${tenantId} and phone = ${phone}`)[0]!.id as string
    const employee = makeEvent({ path: '/api/v1/billing/summary' })
    employee.context.auth = { tenantId, userId: await userOf('+380670000003') }
    const err = await summaryGet(employee).then(() => null, (e: { statusCode?: number }) => e)
    expect(err?.statusCode).toBe(403)

    const owner = makeEvent({ path: '/api/v1/billing/summary' })
    owner.context.auth = { tenantId, userId: await userOf('+380661864742') }
    const ok = await summaryGet(owner) as { data: { subscription: unknown } }
    expect(ok.data.subscription).toBeTruthy()
  })
})
