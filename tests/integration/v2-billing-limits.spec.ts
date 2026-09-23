import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { LIMIT_AXES } from '../../shared/enums'
import { tenantLimitsSchema } from '../../shared/schemas/platform'

/**
 * PR-08 пакета `docs/v2` (`45-plan.md`): платформенный слой тарифа и одиннадцать осей лимита
 * явными колонками (решение `44` В-5, патч П-25.1 в редакции «шесть осей → одиннадцать»).
 *
 * Критерии приёмки `docs/v2/35-billing-limits.md` §13, закрываемые этим PR:
 *   к. 7  — переход вниз по тарифу упирается в превышение по оси (здесь — расчётная часть:
 *           эффективный лимит тира против факта; экран и заявка — PR-10);
 *   к. 9  — аддон «+100 ГБ» поднимает лимит хранилища до 200 ГБ (первая половина критерия;
 *           вторая, про `usage_counters` при сбое провайдера, — PR-09);
 *   к. 10 — переопределение оператора действует немедленно и пишется в `platform_audit`.
 *
 * Условие выхода PR-08 (`45` PR-08, сквозная проверка 23 `42` §5): `storage_quota_addons` не
 * существует, а число в баннере лимита и число в расчёте счёта берутся из одной функции.
 */

process.env.PLATFORM_DATABASE_URL ??= 'postgres://platform_admin:platform_admin_dev@localhost:5432/lola'
process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const {
  effectiveLimits, effectiveLimit, invalidateLimits, checkLimit, assertWithinLimit,
  LimitExceededError, AXIS_COLUMN, GIB,
} = await import('../../server/services/tenantLimits')
const { getTenantLimits, setTenantLimits, grantTenantAddon, listPlatformAudit } = await import('../../server/services/platformTenants')
const { platformLogin, validatePlatformSession, ensureFirstAdmin, getTenantCard, listTenants, checkPlanLimit } = await import('../../server/services/platform')
const { usageView } = await import('../../server/services/usage')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const OPS_EMAIL = 'ops-v2-08@lola.local'
const OPS_PASSWORD = 'test-password-123'

let tenantId: string
let adminId: string
let opsAuth: Awaited<ReturnType<typeof validatePlatformSession>>

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  process.env.PLATFORM_ADMIN_EMAIL = OPS_EMAIL
  process.env.PLATFORM_ADMIN_PASSWORD = OPS_PASSWORD
  await admin`delete from platform_admins where email = ${OPS_EMAIL}`
  await ensureFirstAdmin()
  const session = await platformLogin(OPS_EMAIL, OPS_PASSWORD)
  opsAuth = await validatePlatformSession(session!.token)
}, 60_000)

afterEach(async () => {
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

describe('миграция 0059: платформенный слой тарифа на чистой БД', () => {
  it('plans получил восемь колонок пакета и пять новых осей, PK остался по code', async () => {
    const cols = await admin`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'plans'`
    const names = cols.map(c => c.column_name as string)
    for (const c of ['title_uk', 'tier', 'ai_included', 'ai_term_days', 'addons_allowed', 'is_active', 'valid_from', 'valid_to']) {
      expect(names, `plans.${c}`).toContain(c)
    }
    for (const c of ['max_candidates', 'max_ai_generate_ops', 'max_ai_review_ops', 'max_ai_interview_ops', 'max_export_rows']) {
      expect(names, `plans.${c}`).toContain(c)
    }
    // Колонки `id` у тарифа нет и не заводится (В-5): FK ссылаются на `code`
    expect(names).not.toContain('id')
    const [pk] = await admin`
      select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = 'plans'::regclass and i.indisprimary`
    expect(pk!.attname).toBe('code')
  })

  it('plan_prices ссылается на plan_code, а не на plan_id', async () => {
    const cols = await admin`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'plan_prices'`
    const names = cols.map(c => c.column_name as string)
    expect(names).toContain('plan_code')
    expect(names).not.toContain('plan_id')
    const fks = await admin`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'plan_prices'::regclass and contype = 'f'`
    expect(fks.map(f => f.def as string).join(' ')).toMatch(/FOREIGN KEY \(plan_code\) REFERENCES plans\(code\)/)
  })

  it('plan_prices и plan_addons — платформенные: без tenant_id и вне RLS (§3.6)', async () => {
    for (const table of ['plan_prices', 'plan_addons']) {
      const cols = await admin`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${table}`
      expect(cols.map(c => c.column_name), table).not.toContain('tenant_id')
      const [c] = await admin`select relrowsecurity from pg_class where relname = ${table}`
      expect(c!.relrowsecurity, table).toBe(false)
    }
  })

  it('каталог опций засеян пятью кодами §3.4, ai_term — срок, а не ось лимита', async () => {
    const rows = await admin`select code, axis, unit_step, term from plan_addons order by sort`
    expect(rows.map(r => r.code)).toEqual(['storage_pack', 'ai_ops_pack', 'sms_pack', 'candidates_pack', 'ai_term'])
    expect(rows.find(r => r.code === 'storage_pack')!.unit_step).toBe('107374182400') // 100 ГБ в байтах
    expect(rows.find(r => r.code === 'ai_term')!.axis).toBe('ai_term')
    expect(LIMIT_AXES as readonly string[]).not.toContain('ai_term')
  })

  it('storage_quota_addons не существует — один механизм докупки места (Р-6, сквозная 23)', async () => {
    const [r] = await admin`select to_regclass('public.storage_quota_addons') as reg`
    expect(r!.reg).toBeNull()
  })
})

describe('35 §7.1: одиннадцать осей читаются и пишутся', () => {
  it('LIMIT_AXES — ровно одиннадцать значений документа', () => {
    expect(LIMIT_AXES).toHaveLength(11)
    expect([...LIMIT_AXES]).toEqual([
      'users_active', 'candidates_active', 'storage_bytes', 'ai_generate_ops', 'ai_review_ops',
      'ai_interview_ops', 'sms_out', 'telegram_out', 'integrations_active', 'api_rate_rpm', 'export_rows',
    ])
  })

  it('десять осей имеют явную колонку лимита, telegram_out — нет (мягкая ось, В-5)', async () => {
    const cols = (await admin`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'tenant_limits'`)
      .map(c => c.column_name as string)
    const snake = (s: string) => s.replace(/[A-Z]/g, m => `_${m.toLowerCase()}`)
    for (const axis of LIMIT_AXES) {
      const col = AXIS_COLUMN[axis]
      if (axis === 'telegram_out') expect(col).toBeNull()
      else expect(cols, `${axis} → ${col}`).toContain(snake(col!))
    }
  })

  it('переопределение пишется и читается по каждой из десяти тарифных осей', async () => {
    const input = {
      users: 11, storageGb: 12, smsPerMonth: 13, apiPerMinute: 14, webhooks: 15, activeJobs: 16,
      candidates: 17, aiGenerateOps: 18, aiReviewOps: 19, aiInterviewOps: 20, exportRows: 21,
    }
    expect(tenantLimitsSchema.safeParse(input).success).toBe(true)
    const saved = await setTenantLimits(tenantId, input, opsAuth!)
    expect(saved!.overrides).toMatchObject(input)
    invalidateLimits()
    const eff = await effectiveLimits(tenantId)
    expect(eff.axes.users_active).toBe(11)
    expect(eff.axes.storage_bytes).toBe(12 * GIB) // ось в байтах, колонка в ГБ
    expect(eff.axes.sms_out).toBe(13)
    expect(eff.axes.api_rate_rpm).toBe(14)
    expect(eff.axes.integrations_active).toBe(15)
    expect(eff.axes.candidates_active).toBe(17)
    expect(eff.axes.ai_generate_ops).toBe(18)
    expect(eff.axes.ai_review_ops).toBe(19)
    expect(eff.axes.ai_interview_ops).toBe(20)
    expect(eff.axes.export_rows).toBe(21)
    expect(eff.axes.telegram_out).toBeNull() // мягкая ось лимита не имеет
    expect(eff.activeJobs).toBe(16)
  })

  it('осей ровно одиннадцать и ни одна не «забыта»: у каждой есть ответ функции', async () => {
    invalidateLimits()
    for (const axis of LIMIT_AXES) {
      const v = await effectiveLimit(tenantId, axis)
      expect(v === null || typeof v === 'number', axis).toBe(true)
    }
  })
})

describe('35 §7.3: эффективный лимит = тариф + переопределение + доплаты', () => {
  it('без переопределения берётся тариф, с переопределением — оно', async () => {
    invalidateLimits()
    const [plan] = await admin`select max_users from plans where code = (select plan from tenants where id = ${tenantId})`
    const fromPlan = plan!.max_users as number | null
    expect(await effectiveLimit(tenantId, 'users_active')).toBe(fromPlan)
    await setTenantLimits(tenantId, { users: 7 }, opsAuth!)
    expect(await effectiveLimit(tenantId, 'users_active')).toBe(7)
  })

  it('аддон «+100 ГБ» к тарифу 100 ГБ даёт 200 ГБ (§13 к. 9, первая половина)', async () => {
    await setTenantLimits(tenantId, { storageGb: 100 }, opsAuth!)
    invalidateLimits()
    expect(await effectiveLimit(tenantId, 'storage_bytes')).toBe(100 * GIB)
    const granted = await grantTenantAddon(tenantId, { addonCode: 'storage_pack', qty: 1 }, opsAuth!)
    expect(granted.ok).toBe(true)
    const eff = await effectiveLimits(tenantId)
    expect(eff.axes.storage_bytes).toBe(200 * GIB)
    expect(eff.storageGb).toBe(200)
    expect(eff.addons.storage_bytes).toBe(100 * GIB)
  })

  it('две опции по одной оси складываются, истёкшая не учитывается (§7.8 п. 1)', async () => {
    await setTenantLimits(tenantId, { aiGenerateOps: 1000 }, opsAuth!)
    await grantTenantAddon(tenantId, { addonCode: 'ai_ops_pack', qty: 2 }, opsAuth!)
    invalidateLimits()
    expect(await effectiveLimit(tenantId, 'ai_generate_ops')).toBe(3000)
    await admin`update tenant_addons set valid_until = current_date - 1 where tenant_id = ${tenantId}`
    invalidateLimits()
    expect(await effectiveLimit(tenantId, 'ai_generate_ops')).toBe(1000)
  })

  it('доплата к «без обмежень» ничего не меняет: null остаётся null', async () => {
    await admin`delete from tenant_limits where tenant_id = ${tenantId}`
    await grantTenantAddon(tenantId, { addonCode: 'candidates_pack', qty: 3 }, opsAuth!)
    invalidateLimits()
    const [plan] = await admin`select max_candidates from plans where code = (select plan from tenants where id = ${tenantId})`
    if (plan!.max_candidates == null) expect(await effectiveLimit(tenantId, 'candidates_active')).toBeNull()
    else expect(await effectiveLimit(tenantId, 'candidates_active')).toBe((plan!.max_candidates as number) + 300)
  })

  it('опция ai_term продлевает срок ИИ, а не ось: в сумму лимита не попадает (§7.7 п. 6)', async () => {
    await setTenantLimits(tenantId, { aiGenerateOps: 500 }, opsAuth!)
    await grantTenantAddon(tenantId, { addonCode: 'ai_term', qty: 1 }, opsAuth!)
    invalidateLimits()
    expect(await effectiveLimit(tenantId, 'ai_generate_ops')).toBe(500)
  })
})

describe('35 §7.4, §10: превышение по каждой оси даёт понятную ошибку', () => {
  it('checkLimit ловит превышение и отдаёт ось, факт и лимит', async () => {
    await setTenantLimits(tenantId, { users: 5 }, opsAuth!)
    invalidateLimits()
    expect(await checkLimit(tenantId, 'users_active', 4)).toMatchObject({ ok: true, limit: 5, used: 4 })
    expect(await checkLimit(tenantId, 'users_active', 5)).toMatchObject({ ok: false, limit: 5, used: 5 })
    // delta = 0 — «уже превышено» для баннера, delta = 1 — «пройдёт ли следующая операция»
    expect(await checkLimit(tenantId, 'users_active', 5, 0)).toMatchObject({ ok: true })
  })

  it('по каждой из одиннадцати осей ошибка называет ось и объясняет последствие', async () => {
    await setTenantLimits(tenantId, {
      users: 1, storageGb: 1, smsPerMonth: 1, apiPerMinute: 1, webhooks: 1,
      candidates: 1, aiGenerateOps: 1, aiReviewOps: 1, aiInterviewOps: 1, exportRows: 1,
    }, opsAuth!)
    invalidateLimits()
    for (const axis of LIMIT_AXES) {
      // Факт заведомо выше лимита любой оси, включая хранилище (его лимит — в байтах)
      const check = await checkLimit(tenantId, axis, 10 * GIB)
      if (axis === 'telegram_out') {
        expect(check.ok, axis).toBe(true) // мягкая ось не останавливает ничего (docs/25 §10)
        continue
      }
      expect(check.ok, axis).toBe(false)
      const err = new LimitExceededError(check)
      expect(err.statusCode).toBe(409)
      expect(err.code).toBe('limit_exceeded')
      expect(err.details.axis).toBe(axis)
      // Текст — из словаря (CLAUDE.md п. 8): подпись оси и что делать, а не код оси в лицо
      expect(err.message, axis).not.toContain(axis)
      expect(err.message.length, axis).toBeGreaterThan(30)
    }
  })

  it('assertWithinLimit молчит в пределах лимита и падает за ним', async () => {
    await setTenantLimits(tenantId, { exportRows: 10 }, opsAuth!)
    invalidateLimits()
    await expect(assertWithinLimit(tenantId, 'export_rows', 5)).resolves.toBeUndefined()
    await expect(assertWithinLimit(tenantId, 'export_rows', 10)).rejects.toThrow(LimitExceededError)
  })
})

describe('45 PR-08, условие выхода: пять мест считают лимит одной функцией', () => {
  it('баннер экрана потребления и расчёт по осям дают одно число', async () => {
    await setTenantLimits(tenantId, { users: 42, storageGb: 100 }, opsAuth!)
    await grantTenantAddon(tenantId, { addonCode: 'storage_pack', qty: 1 }, opsAuth!)
    invalidateLimits()
    const view = await usageView({ tenantId, actorId: adminId })
    const eff = await effectiveLimits(tenantId)
    expect(view.limits.users).toBe(eff.users)
    expect(view.limits.storageGb).toBe(eff.storageGb)
    expect(view.axes).toEqual(eff.axes)
    // Именно то, что расходилось до PR-08: экран показывал тариф и не знал про «+100 ГБ»
    expect(view.axes.storage_bytes).toBe(200 * GIB)
  })

  it('панель оператора: список, карточка и экран лимитов дают то же число', async () => {
    await setTenantLimits(tenantId, { users: 42, storageGb: 100 }, opsAuth!)
    await grantTenantAddon(tenantId, { addonCode: 'storage_pack', qty: 1 }, opsAuth!)
    invalidateLimits()
    const eff = await effectiveLimits(tenantId)
    const card = await getTenantCard(tenantId)
    expect(card!.users_limit).toBe(eff.users)
    expect(card!.storage_gb_limit).toBe(eff.storageGb)
    expect(card!.has_overrides).toBe(true)
    const row = (await listTenants()).find(r => r.id === tenantId)!
    expect(row.users_limit).toBe(eff.users)
    expect(row.storage_gb_limit).toBe(eff.storageGb)
    const limits = await getTenantLimits(tenantId)
    expect(limits!.effective).toEqual(eff.axes)
  })

  it('жёсткая проверка при операции берёт лимит оттуда же', async () => {
    await setTenantLimits(tenantId, { users: 42 }, opsAuth!)
    invalidateLimits()
    const lim = await checkPlanLimit(tenantId, 'users')
    expect(lim.limit).toBe((await effectiveLimits(tenantId)).users)
    expect(lim.limit).toBe(42)
  })
})

describe('35 §13 к. 10: переопределение оператора действует немедленно и есть в журнале', () => {
  it('175 активных с причиной — значение видно сразу, запись в platform_audit есть', async () => {
    await setTenantLimits(tenantId, { users: 175 }, opsAuth!)
    invalidateLimits()
    expect(await effectiveLimit(tenantId, 'users_active')).toBe(175)
    const audit = await listPlatformAudit({ tenantId })
    expect(audit.find(a => a.action === 'tenant.limits')?.after).toMatchObject({ users: 175 })
  })

  it('доплата оператором пишется в platform_audit с осью и шагом (§7.10)', async () => {
    await grantTenantAddon(tenantId, { addonCode: 'ai_ops_pack', qty: 2, source: 'grant' }, opsAuth!)
    const audit = await listPlatformAudit({ tenantId })
    expect(audit.find(a => a.action === 'tenant.addon_grant')?.after).toMatchObject({ addonCode: 'ai_ops_pack', qty: 2, axis: 'ai_generate_ops', source: 'grant' })
  })

  it('сброс переопределений не стирает оплаченный срок подписки', async () => {
    await setTenantLimits(tenantId, { users: 175 }, opsAuth!)
    await admin`update tenant_limits set status = 'active', paid_until = current_date + 30 where tenant_id = ${tenantId}`
    await setTenantLimits(tenantId, {}, opsAuth!)
    const rows = await admin`select status, paid_until, users from tenant_limits where tenant_id = ${tenantId}`
    expect(rows).toHaveLength(1) // строка жива: в ней срок, а не только переопределения
    expect(rows[0]!.users).toBeNull()
    expect(rows[0]!.status).toBe('active')
  })

  it('без подписки и без переопределений строка по-прежнему удаляется', async () => {
    await setTenantLimits(tenantId, { users: 3 }, opsAuth!)
    await setTenantLimits(tenantId, {}, opsAuth!)
    expect(await admin`select id from tenant_limits where tenant_id = ${tenantId}`).toHaveLength(0)
  })
})

describe('35 §3.6: tenant_addons изолирована RLS', () => {
  it('доплата чужого тенанта не видна: политика с using и with check', async () => {
    const [c] = await admin`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'tenant_addons'`
    expect(c!.relrowsecurity).toBe(true)
    expect(c!.relforcerowsecurity).toBe(true)
    const [p] = await admin`select polqual is not null as u, polwithcheck is not null as w from pg_policy where polrelid = 'tenant_addons'::regclass and polname = 'tenant_isolation'`
    expect(p!.u).toBe(true)
    expect(p!.w).toBe(true)
  })

  it('опция вне каталога тарифа отклоняется с понятным кодом (§6.2)', async () => {
    const r = await grantTenantAddon(tenantId, { addonCode: 'нет-такой', qty: 1 }, opsAuth!)
    expect(r).toEqual({ ok: false, code: 'addon_unknown' })
  })
})
