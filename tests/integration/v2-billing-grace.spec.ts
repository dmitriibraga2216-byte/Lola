import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { makeEvent } from './_nitroGlobals'

/**
 * `docs/v2/35-billing-limits.md` §13 к. 5 — автопереход подписки `active → grace → readonly`
 * задачей `billing.grace_scan` (§4, §7.8 п. 3–4, §11), уведомление `plan_grace_started` один раз,
 * в `readonly` создание трека — `409`, прохождение назначенного — проходит. Оплата оператором (к. 6)
 * возвращает `active`. Даты ведёт оператор вручную — решение владельца, `docs/v2/44` В-21.
 *
 * Здесь — сервис и сквозной запрет middleware `03.guards` на поддельном событии; то же по HTTP
 * против собранного приложения — `v2-billing-http.spec.ts`.
 */

process.env.PLATFORM_DATABASE_URL ??= 'postgres://platform_admin:platform_admin_dev@localhost:5432/lola'
process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const { graceScan, plannedTransitions, readonlyBlocks, todayIn, addDays, GRACE_DAYS } = await import('../../server/services/subscriptionStatus')
const { invalidateLimits, effectiveLimits } = await import('../../server/services/tenantLimits')
const { recordTenantPayment } = await import('../../server/services/platformTenants')
const { platformLogin, validatePlatformSession, ensureFirstAdmin } = await import('../../server/services/platform')
const guard = (await import('../../server/middleware/03.guards')).default as unknown as (event: unknown) => Promise<void>

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const OPS_EMAIL = 'ops-v2-35-k5@lola.local'

let tenantId: string
let tz: string
let today: string
let opsAuth: Awaited<ReturnType<typeof validatePlatformSession>>

async function setSubscription(status: string, paidUntil: string | null, graceUntil: string | null = null) {
  await admin`insert into tenant_limits (tenant_id, status, paid_until, grace_until) values (${tenantId}, ${status}, ${paidUntil}, ${graceUntil})
    on conflict (tenant_id) do update set status = excluded.status, paid_until = excluded.paid_until, grace_until = excluded.grace_until`
  invalidateLimits(tenantId)
}
const statusRow = async () => (await admin`select status, paid_until::text as paid_until, grace_until::text as grace_until from tenant_limits where tenant_id = ${tenantId}`)[0]!
const notices = async (code: string) => admin`select user_id, payload from notifications where tenant_id = ${tenantId} and code = ${code}`
const recipients = async () => (await admin`
  select distinct ur.user_id from user_roles ur join roles r on r.id = ur.role_id join users a on a.id = ur.user_id
  where a.tenant_id = ${tenantId} and r.code in ('admin', 'owner') and (ur.valid_until is null or ur.valid_until > now())
    and a.status = 'active' and not a.is_blocked and a.kind = 'employee'`).length

/** Запрос через сквозной middleware: `null` — пропущен, иначе ошибка, которую он бросил. */
async function through(method: string, path: string): Promise<{ statusCode: number, data: { code: string, message: string } } | null> {
  const event = makeEvent({ path }) as unknown as { method: string, context: Record<string, unknown> }
  event.method = method
  event.context.auth = { tenantId, userId: '00000000-0000-0000-0000-000000000000' }
  try {
    await guard(event)
    return null
  }
  catch (err) {
    return err as { statusCode: number, data: { code: string, message: string } }
  }
}

beforeAll(async () => {
  const [t] = await admin`select id, timezone from tenants where slug = 'kappi'`
  tenantId = t!.id as string
  tz = t!.timezone as string
  today = todayIn(tz)
  process.env.PLATFORM_ADMIN_EMAIL = OPS_EMAIL
  process.env.PLATFORM_ADMIN_PASSWORD = 'test-password-123'
  await admin`delete from platform_admins where email = ${OPS_EMAIL}`
  await ensureFirstAdmin()
  opsAuth = await validatePlatformSession((await platformLogin(OPS_EMAIL, 'test-password-123'))!.token)
}, 60_000)

afterEach(async () => {
  await admin`delete from notifications where tenant_id = ${tenantId} and code in ('plan_grace_started', 'plan_readonly')`
  await admin`delete from tenant_payments where tenant_id = ${tenantId}`
  await admin`delete from tenant_limits where tenant_id = ${tenantId}`
  invalidateLimits()
})

afterAll(async () => {
  await admin`delete from audit_log where tenant_id = ${tenantId} and action = 'billing.subscription_status'`
  await admin`delete from platform_sessions where admin_id in (select id from platform_admins where email = ${OPS_EMAIL})`
  await admin`delete from platform_admins where email = ${OPS_EMAIL}`
  await admin.end()
})

describe('35 §13 к. 5: дано paid_until вчера и grace_days = 7', () => {
  it('тоді статус grace, grace_until = paid_until + 7, plan_grace_started надіслано один раз — власнику й адміну', async () => {
    expect(GRACE_DAYS).toBe(7)
    const yesterday = addDays(today, -1)
    await setSubscription('active', yesterday)

    const steps = await graceScan(tenantId)
    expect(steps).toEqual([{ from: 'active', to: 'grace', graceUntil: addDays(yesterday, 7) }])
    expect(await statusRow()).toMatchObject({ status: 'grace', paid_until: yesterday, grace_until: addDays(yesterday, 7) })
    expect((await effectiveLimits(tenantId)).subscription.status).toBe('grace')

    const sent = await notices('plan_grace_started')
    expect(sent.length).toBe(await recipients())
    expect(sent.length).toBeGreaterThan(0)
    expect(sent[0]!.payload).toMatchObject({ grace_until: addDays(yesterday, 7), paid_until: yesterday })

    // Повторный прогон задачи, повторная доставка задания — второго письма нет
    expect(await graceScan(tenantId)).toEqual([])
    await graceScan(tenantId)
    expect((await notices('plan_grace_started')).length).toBe(sent.length)
    expect(await notices('plan_readonly')).toHaveLength(0)
  })

  it('два воркера разом — переход и уведомление ровно одни (строка подписки под `for update`)', async () => {
    await setSubscription('active', addDays(today, -1))
    const [a, b] = await Promise.all([graceScan(tenantId), graceScan(tenantId)])
    expect(a.length + b.length).toBe(1)
    expect((await notices('plan_grace_started')).length).toBe(await recipients())
  })

  it('тоді «всё работает»: в grace изменяющий запрос не закрыт, баннер — плашка на экране, а не запрет', async () => {
    await setSubscription('grace', addDays(today, -1), addDays(today, 6))
    expect(await through('POST', '/api/v1/courses')).toBeNull()
    expect(await through('PATCH', '/api/v1/people/x')).toBeNull()
  })

  it('смена статуса пишется в audit_log без актора (переход по сроку) и в журнал оператора', async () => {
    await setSubscription('active', addDays(today, -1))
    await graceScan(tenantId)
    const [row] = await admin`select actor_id, entity, before, after from audit_log
      where tenant_id = ${tenantId} and action = 'billing.subscription_status' order by id desc limit 1`
    expect(row).toMatchObject({ actor_id: null, entity: 'tenant_limits', before: { status: 'active' }, after: { status: 'grace', reason: 'paid_until_passed' } })
    const [op] = await admin`select admin_email, action from platform_audit where subject_tenant_id = ${tenantId} and action = 'tenant.subscription_grace' order by id desc limit 1`
    expect(op).toMatchObject({ admin_email: 'system' })
  })
})

describe('35 §13 к. 5: коли истёк grace_until', () => {
  it('тоді readonly і plan_readonly — один раз; plan_grace_started повторно не шлётся', async () => {
    const paidUntil = addDays(today, -9)
    await setSubscription('grace', paidUntil, addDays(paidUntil, 7))
    const steps = await graceScan(tenantId)
    expect(steps).toEqual([{ from: 'grace', to: 'readonly', graceUntil: addDays(paidUntil, 7) }])
    expect((await statusRow()).status).toBe('readonly')
    expect((await notices('plan_readonly')).length).toBe(await recipients())
    expect(await notices('plan_grace_started')).toHaveLength(0)
    expect(await graceScan(tenantId)).toEqual([])
    expect((await notices('plan_readonly')).length).toBe(await recipients())
  })

  it('задача не шла дольше grace — active → grace → readonly за один прогон, оба уведомления', async () => {
    await setSubscription('active', addDays(today, -20))
    const steps = await graceScan(tenantId)
    expect(steps.map(s => s.to)).toEqual(['grace', 'readonly'])
    expect((await statusRow()).status).toBe('readonly')
    expect((await notices('plan_grace_started')).length).toBe(await recipients())
    expect((await notices('plan_readonly')).length).toBe(await recipients())
  })

  it('тоді создание трека — 409 tenant.readonly с текстом, что делать; GET остаётся', async () => {
    await setSubscription('readonly', addDays(today, -9), addDays(today, -2))
    const err = await through('POST', '/api/v1/courses')
    expect(err).toMatchObject({ statusCode: 409, data: { code: 'tenant.readonly' } })
    expect(err!.data.message).toContain('продовжити тариф')
    expect(await through('GET', '/api/v1/courses')).toBeNull()
    // Остальные запреты §7.8 п. 4: назначения, люди, кандидаты, загрузка файлов
    for (const path of ['/api/v1/assignments', '/api/v1/people', '/api/v1/candidates', '/api/v1/media/upload-url', '/api/v1/courses/x/lessons', '/api/v1/me/catalog/x/enroll', '/api/v1/learning/enroll']) {
      expect((await through('POST', path))?.statusCode, path).toBe(409)
    }
  })

  it('тоді прохождение назначенного — проходит: уроки, материалы, тест, практикум, ручная проверка, вход, выгрузка', async () => {
    await setSubscription('readonly', addDays(today, -9), addDays(today, -2))
    for (const path of [
      '/api/v1/learning/enrollments/e/lessons/l/open',
      '/api/v1/learning/enrollments/e/lessons/l/tick',
      '/api/v1/learning/enrollments/e/lessons/l/complete',
      '/api/v1/learning/resources/r/acknowledge',
      '/api/v1/learning/quizzes/q/attempts',
      '/api/v1/attempts/a/submit',
      '/api/v1/learning/workshops/w/submit',
      '/api/v1/review/submissions/s/grade',
      '/api/v1/auth/otp/verify',
      '/api/v1/exports',
      '/api/v1/billing/plan-change/preflight',
    ]) {
      expect(await through('POST', path), path).toBeNull()
    }
    expect(await through('PUT', '/api/v1/attempts/a/answers/q')).toBeNull()
  })
})

describe('35 §7.8 п. 6, к. 6: оплата возвращает active', () => {
  it('платёж оператора в readonly — active, paid_until от прежней даты; следующий прогон ничего не меняет', async () => {
    const paidUntil = addDays(today, -10)
    await setSubscription('readonly', paidUntil, addDays(paidUntil, 7))
    const r = await recordTenantPayment(tenantId, { kind: 'subscription', billingPeriod: 'month', amountMinor: 4900, currency: 'EUR', status: 'paid', comment: 'оплата після прострочки' }, opsAuth!)
    expect(r.ok).toBe(true)
    expect(await statusRow()).toMatchObject({ status: 'active', grace_until: null })
    expect(await graceScan(tenantId)).toEqual([])
    expect(await through('POST', '/api/v1/courses')).toBeNull()
  })
})

describe('plannedTransitions — правила без базы', () => {
  it('срок не прошёл, trial, readonly, suspended — переходов нет', () => {
    expect(plannedTransitions({ status: 'active', paidUntil: '2026-09-29', graceUntil: null }, '2026-09-29')).toEqual([])
    expect(plannedTransitions({ status: 'active', paidUntil: null, graceUntil: null }, '2026-09-29')).toEqual([])
    expect(plannedTransitions({ status: 'trial', paidUntil: '2026-01-01', graceUntil: null }, '2026-09-29')).toEqual([])
    expect(plannedTransitions({ status: 'readonly', paidUntil: '2026-01-01', graceUntil: '2026-01-08' }, '2026-09-29')).toEqual([])
    expect(plannedTransitions({ status: 'suspended', paidUntil: '2026-01-01', graceUntil: null }, '2026-09-29')).toEqual([])
  })

  it('последний день grace — ещё grace; следующий — readonly', () => {
    expect(plannedTransitions({ status: 'grace', paidUntil: '2026-09-20', graceUntil: '2026-09-27' }, '2026-09-27')).toEqual([])
    expect(plannedTransitions({ status: 'grace', paidUntil: '2026-09-20', graceUntil: '2026-09-27' }, '2026-09-28')).toEqual([{ from: 'grace', to: 'readonly', graceUntil: '2026-09-27' }])
  })

  it('дата оператора позже конца оплаты сохраняется; дата прошлого эпизода — нет', () => {
    expect(plannedTransitions({ status: 'active', paidUntil: '2026-09-28', graceUntil: '2026-10-20' }, '2026-09-29')[0]!.graceUntil).toBe('2026-10-20')
    expect(plannedTransitions({ status: 'active', paidUntil: '2026-09-28', graceUntil: '2026-08-01' }, '2026-09-29')[0]!.graceUntil).toBe('2026-10-05')
  })

  it('«сегодня» — по поясу тенанта; некорректный пояс — UTC', () => {
    const at = new Date('2026-09-29T22:30:00Z')
    expect(todayIn('Europe/Kyiv', at)).toBe('2026-09-30')
    expect(todayIn('UTC', at)).toBe('2026-09-29')
    expect(todayIn('Not/AZone', at)).toBe('2026-09-29')
  })

  it('readonlyBlocks: GET не закрыт, изменение вне списка — закрыто, query не мешает', () => {
    expect(readonlyBlocks('GET', '/api/v1/courses')).toBe(false)
    expect(readonlyBlocks('post', '/api/v1/courses?x=1')).toBe(true)
    expect(readonlyBlocks('POST', '/api/v1/learning/time/beat?x=1')).toBe(false)
    expect(readonlyBlocks('DELETE', '/api/v1/review/routing-rules/x')).toBe(true)
  })
})
