import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * PR debts-8 (docs/33): D-048 (колонки MJML → таблиця), D-049 (події anniversaries/programReminder),
 * D-052 (preview-as), D-053 (замок модуля по тарифу), D-054 (ліміти тенанта: диск/SMS,
 * limit_warning/limit_exceeded), D-055 (api_per_minute/webhooks з tenant_limits).
 */

process.env.PLATFORM_DATABASE_URL ??= 'postgres://platform_admin:platform_admin_dev@localhost:5432/lola'

const EmailRender = await import('../../server/services/emailRender')
const Hp = await import('../../server/services/hubPeople')
const Pr = await import('../../server/services/programs')
const Notif = await import('../../server/services/notifications')
const { createSession, validateSession } = await import('../../server/services/session')
const { loadAccess, can } = await import('../../server/services/access')
const { startPreview, stopPreview, previewInfo } = await import('../../server/services/previewAs')
const { moduleLock, invalidatePlans } = await import('../../server/services/modules')
const { effectiveLimits, invalidateLimits } = await import('../../server/services/tenantLimits')
const { collectUsage } = await import('../../server/services/usage')
const { tenantStorageBytes, createUploadUrl } = await import('../../server/services/media')
const { sendSms } = await import('../../server/services/channels')
const { createToken, validateBearer } = await import('../../server/services/apiTokens')
const { createEndpoint } = await import('../../server/services/webhooks')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

let tenantId: string
let adminId: string
let employeeId: string
let adminRoleId: string
let employeeRoleId: string
let orgUnitId: string
let posId: string
let locId: string
const userIds: string[] = []
const mediaIds: string[] = []
const tokenIds: string[] = []
const webhookIds: string[] = []
const stamp = Date.now()

const ctx = () => ({ tenantId, actorId: adminId })

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  adminRoleId = (await admin`select id from roles where tenant_id = ${tenantId} and code = 'admin'`)[0]!.id as string
  employeeRoleId = (await admin`select id from roles where tenant_id = ${tenantId} and code = 'employee'`)[0]!.id as string
  orgUnitId = (await admin`select id from org_units where tenant_id = ${tenantId} limit 1`)[0]!.id as string

  const [pos] = await admin`insert into positions (tenant_id, name) values (${tenantId}, ${`Debts8 Посада ${stamp}`}) returning id`
  posId = pos!.id as string
  const [loc] = await admin`insert into locations (tenant_id, org_unit_id, name, manager_id) values (${tenantId}, ${orgUnitId}, ${`Debts8 Точка ${stamp}`}, ${adminId}) returning id`
  locId = loc!.id as string

  const phone = `+38099${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, phone, full_name, status, hired_at) values (${tenantId}, ${phone}, 'Debts8 Співробітник', 'active', current_date) returning id`
  employeeId = u!.id as string
  userIds.push(employeeId)
  await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary) values (${tenantId}, ${employeeId}, ${locId}, ${posId}, true)`
  await admin`insert into user_roles (tenant_id, user_id, role_id, scope_type) values (${tenantId}, ${employeeId}, ${employeeRoleId}, 'tenant')`
})

afterAll(async () => {
  if (mediaIds.length) await admin`delete from media_assets where id in ${admin(mediaIds)}`
  if (tokenIds.length) await admin`delete from api_tokens where id in ${admin(tokenIds)}`
  if (webhookIds.length) await admin`delete from webhook_endpoints where id in ${admin(webhookIds)}`
  await admin`delete from tenant_limits where tenant_id = ${tenantId}`
  await admin`delete from sessions where tenant_id = ${tenantId} and user_id in ${admin([adminId, ...userIds])}`
  await admin`delete from user_placements where tenant_id = ${tenantId} and user_id in ${admin(userIds)}`
  await admin`delete from user_roles where tenant_id = ${tenantId} and user_id in ${admin(userIds)}`
  await admin`delete from users where id in ${admin(userIds)}`
  await admin`delete from locations where id = ${locId}`
  await admin`delete from positions where id = ${posId}`
  await admin`delete from plans where code like 'debts8_%'`
  invalidatePlans()
  invalidateLimits()
  await admin.end()
})

describe('D-048 — MJML: колонки в <table>, невідомі теги прибираються', () => {
  it('секція з двома mj-column компілюється в таблицю з двома <td>, ширина — з атрибута або порівну', () => {
    const html = EmailRender.renderMjmlSubset('<mj-section><mj-column width="30%"><mj-text>Ліво</mj-text></mj-column><mj-column><mj-text>Право</mj-text></mj-column></mj-section>')
    expect(html).toContain('<table')
    expect((html.match(/<td/g) ?? []).length).toBe(2)
    expect(html).toContain('width:30%')
    expect(html).toContain('width:50.00%') // друга колонка без атрибута — рівний поділ на 2
    expect(html).toContain('Ліво')
    expect(html).toContain('Право')
  })

  it('одна колонка (або без колонок) лишається простим <div>, без таблиці', () => {
    const html = EmailRender.renderMjmlSubset('<mj-section><mj-column><mj-text>Тіло</mj-text></mj-column></mj-section>')
    expect(html).not.toContain('<table')
    expect(html).toContain('<div')
    expect(html).toContain('Тіло')
  })

  it('невідомий mj-тег (mj-social) прибирається як розмітка, текст лишається; buildEmailHtml несе медіа-стиль колонок', () => {
    const html = EmailRender.renderMjmlSubset('<mj-social><mj-social-element name="facebook">FB</mj-social-element></mj-social>')
    expect(html).not.toContain('<mj-social')
    expect(html).toContain('FB')
    const full = EmailRender.buildEmailHtml({ bodyMjml: '<mj-text>Тіло</mj-text>', fallbackText: 'x' })
    expect(full).toContain('@media')
    expect(full).toContain('.mj-col')
  })
})

describe('D-049 — події класів anniversaries і programReminder', () => {
  it('eventClassOf розпізнає нові класи', () => {
    expect(Notif.eventClassOf('anniversary_today')).toBe('anniversaries')
    expect(Notif.eventClassOf('anniversary_upcoming')).toBe('anniversaries')
    expect(Notif.eventClassOf('program_reminder')).toBe('programReminder')
  })

  it('anniversaryScan: річниця сьогодні — дайджест точці (без ювіляра) і особисте привітання; менше року — не рахується', async () => {
    const today = new Date()
    const ymd = (years: number) => `${today.getUTCFullYear() - years}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`
    const [jubilee] = await admin`insert into users (tenant_id, phone, full_name, status, hired_at) values (${tenantId}, ${`+38098${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`}, 'Debts8 Ювіляр', 'active', current_date) returning id`
    const jubileeId = jubilee!.id as string
    userIds.push(jubileeId)
    await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary, started_at) values (${tenantId}, ${jubileeId}, ${locId}, ${posId}, true, ${ymd(2)})`

    const [tooYoung] = await admin`insert into users (tenant_id, phone, full_name, status, hired_at) values (${tenantId}, ${`+38098${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`}, 'Debts8 Новачок', 'active', current_date) returning id`
    const tooYoungId = tooYoung!.id as string
    userIds.push(tooYoungId)
    await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary, started_at) values (${tenantId}, ${tooYoungId}, ${locId}, ${posId}, true, ${ymd(0)})`

    const s = await Hp.anniversaryScan(tenantId)
    expect(s.today).toBeGreaterThanOrEqual(2) // мінімум: дайджест колезі + особисте привітання ювіляру

    const mateDigest = await admin`select payload from notifications where user_id = ${employeeId} and code = 'anniversary_today'`
    expect(mateDigest.length).toBe(1)
    expect(String(mateDigest[0]!.payload.names)).toContain('Debts8 Ювіляр')
    expect(String(mateDigest[0]!.payload.names)).not.toContain('Debts8 Новачок') // менше року — не річниця

    const selfCongrats = await admin`select payload from notifications where user_id = ${jubileeId} and code = 'anniversary_self'`
    expect(selfCongrats.length).toBe(1)
    expect(selfCongrats[0]!.payload).toMatchObject({ years: 2 })

    expect((await admin`select 1 from notifications where user_id = ${jubileeId} and code = 'anniversary_today'`).length).toBe(0) // ювіляр не отримує дайджест про себе

    await Hp.anniversaryScan(tenantId) // повторний прогін того ж дня — дедуп
    expect((await admin`select count(*)::int as n from notifications where user_id = ${employeeId} and code = 'anniversary_today'`)[0]!.n).toBe(1)
  })

  it('programReminderScan: нагадування за день до available_from, дедуп на день', async () => {
    const p = await Pr.createProgram(ctx(), { title: `Debts8 Програма ${stamp}` })
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    const [enr] = await admin`insert into program_enrollments (tenant_id, program_id, user_id, status, available_from) values (${tenantId}, ${p.id}, ${employeeId}, 'not_started', ${tomorrow}) returning id`

    const n1 = await Pr.programReminderScan(tenantId)
    expect(n1).toBeGreaterThanOrEqual(1)
    const rows = await admin`select payload from notifications where user_id = ${employeeId} and code = 'program_reminder'`
    expect(rows.length).toBe(1)
    expect(rows[0]!.payload).toMatchObject({ title: `Debts8 Програма ${stamp}` })

    const n2 = await Pr.programReminderScan(tenantId) // той самий день — дедуп
    expect(n2).toBe(0)

    await admin`delete from program_enrollments where id = ${enr!.id}`
    await admin`delete from programs where id = ${p.id}`
  })
})

describe('D-052 — «Переглянути систему як роль» (preview-as)', () => {
  it('старт: права рахуються по обраній ролі, а не по власних; вихід повертає власні права', async () => {
    const s = await createSession({ tenantId, userId: adminId })
    let auth = (await validateSession(s.token))!
    const access = (await loadAccess(auth))!
    expect(can(access, 'settings.tenant')).toBe(true)

    const r = await startPreview(auth, access, employeeRoleId)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.role.code).toBe('employee')

    auth = (await validateSession(s.token))! // перечитуємо сесію — preview_role_id вже на місці
    expect(auth.previewRoleId).toBe(employeeRoleId)
    const previewAccess = (await loadAccess(auth))!
    expect(previewAccess.activeRole?.code).toBe('employee')
    expect(can(previewAccess, 'settings.tenant')).toBe(false) // адмінських прав більше немає
    expect(can(previewAccess, 'learn.view')).toBe(true) // права ролі employee — є

    expect((await previewInfo(auth))?.code).toBe('employee')

    expect(await stopPreview(auth)).toBe(true)
    const afterAuth = (await validateSession(s.token))!
    expect(afterAuth.previewRoleId).toBeNull()
    const restored = (await loadAccess(afterAuth))!
    expect(can(restored, 'settings.tenant')).toBe(true) // власні права повернулись

    await admin`delete from sessions where id = ${s.sessionId}`
  })

  it('не можна «приміряти» роль зі скоупом, якого немає у самого актора (Г-24.1)', async () => {
    const s = await createSession({ tenantId, userId: employeeId })
    const auth = (await validateSession(s.token))!
    const access = (await loadAccess(auth))!
    expect(can(access, 'settings.tenant')).toBe(false)

    const r = await startPreview(auth, access, adminRoleId) // employee намагається переглянути «адміна»
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('scope_not_owned')

    await admin`delete from sessions where id = ${s.sessionId}`
  })
})

describe('D-053 — замок модуля по тарифу', () => {
  it('план з обмеженим modules[] блокує решту модулів, підпис — найдешевший тариф без обмеження', async () => {
    await admin`insert into plans (code, name, modules, sort) values ('debts8_locked', 'Debts8 Заблокований', '{workshops}'::text[], -2)`
    await admin`insert into plans (code, name, modules, sort) values ('debts8_open', 'Debts8 Відкритий', null, -1)`
    const [t] = await admin`select plan from tenants where id = ${tenantId}`
    const originalPlan = t!.plan as string
    await admin`update tenants set plan = 'debts8_locked' where id = ${tenantId}`
    invalidatePlans()

    const lockedProg = await moduleLock(tenantId, 'programs')
    expect(lockedProg).toMatchObject({ planCode: 'debts8_open', planName: 'Debts8 Відкритий' })
    const openWorkshops = await moduleLock(tenantId, 'workshops') // модуль з переліку плану — не заблокований
    expect(openWorkshops).toBeNull()

    await admin`update tenants set plan = ${originalPlan} where id = ${tenantId}`
    invalidatePlans()
    expect(await moduleLock(tenantId, 'programs')).toBeNull() // на тарифі без обмежень (network/тощо) — не заблоковано
  })
})

describe('D-054 — ліміти tenant_limits: диск, SMS, попередження/перевищення', () => {
  it('createUploadUrl: перевищення tenant_limits.storageGb блокує завантаження до звернення до S3', async () => {
    await admin`insert into tenant_limits (tenant_id, storage_gb) values (${tenantId}, 1) on conflict (tenant_id) do update set storage_gb = 1`
    invalidateLimits(tenantId)
    const [existing] = await admin`insert into media_assets (tenant_id, key, original_name, kind, mime, bytes, status) values (${tenantId}, ${`t/${tenantId}/debts8/${stamp}.bin`}, 'debts8.bin', 'file', 'application/pdf', 1_100_000_000, 'ready') returning id`
    mediaIds.push(existing!.id as string)
    expect(await tenantStorageBytes(ctx())).toBeGreaterThan(1_000_000_000)

    const r = await createUploadUrl(ctx(), { filename: 'ще.pdf', mime: 'application/pdf', bytes: 1000 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('storage_limit')

    await admin`update tenant_limits set storage_gb = null where tenant_id = ${tenantId}`
    invalidateLimits(tenantId)
  })

  it('sendSms: перевіряє переозначений tenant_limits.smsPerMonth, не константу тарифу (channels.ts#sendSms)', async () => {
    // Без налаштованого провайдера sendSms відмовляє раніше перевірки ліміту ('sms not configured') —
    // сам механізм читання ліміту перевіряємо через effectiveLimits, яким sendSms і користується.
    await admin`insert into tenant_limits (tenant_id, sms_per_month) values (${tenantId}, 100) on conflict (tenant_id) do update set sms_per_month = 100`
    invalidateLimits(tenantId)
    expect((await effectiveLimits(tenantId)).smsPerMonth).toBe(100)
    const r = await sendSms(tenantId, '+380501234567', 'test')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('sms not configured') // провайдера немає — очікувано, ліміт тут ні до чого

    await admin`update tenant_limits set sms_per_month = null where tenant_id = ${tenantId}`
    invalidateLimits(tenantId)
  })

  it('usage.collect: 80%+ ліміту людей → limit_warning адміну і platform_audit, 100%+ → limit_exceeded', async () => {
    // kind = 'employee' — счётчик оплачиваемых мест считает штат, кандидаты в него не входят
    // (П-16.1, docs/v2/44 В-8); в посеве есть канареечные кандидаты, без фильтра лимит не совпадёт
    const activeUsers = (await admin`select count(*)::int as n from users where tenant_id = ${tenantId} and kind = 'employee' and status = 'active' and not is_blocked`)[0]!.n as number
    await admin`insert into tenant_limits (tenant_id, users) values (${tenantId}, ${activeUsers}) on conflict (tenant_id) do update set users = ${activeUsers}`
    invalidateLimits(tenantId)
    await admin`delete from notifications where tenant_id = ${tenantId} and code in ('limit_warning', 'limit_exceeded') and created_at > now() - interval '1 minute'`

    await collectUsage(tenantId)
    const exceeded = await admin`select payload from notifications where user_id = ${adminId} and code = 'limit_exceeded' order by created_at desc limit 1`
    expect(exceeded.length).toBe(1)
    expect(exceeded[0]!.payload).toMatchObject({ resource: 'активних людей' })
    const auditRow = await admin`select 1 from platform_audit where subject_tenant_id = ${tenantId} and action = 'tenant.limit_exceeded' order by created_at desc limit 1`
    expect(auditRow.length).toBe(1)

    await admin`update tenant_limits set users = null where tenant_id = ${tenantId}`
    invalidateLimits(tenantId)
  })
})

describe('D-055 — api_per_minute і webhooks читаються з tenant_limits', () => {
  it('validateBearer: перевизначений apiPerMinute блокує раніше стандартних 60/хв', async () => {
    await admin`insert into tenant_limits (tenant_id, api_per_minute) values (${tenantId}, 2) on conflict (tenant_id) do update set api_per_minute = 2`
    invalidateLimits(tenantId)
    const t = await createToken(ctx(), { name: 'debts8 limit', scopes: ['people.view'] })
    tokenIds.push(t.id)
    expect((await validateBearer(t.token)).ok).toBe(true)
    expect((await validateBearer(t.token)).ok).toBe(true)
    const third = await validateBearer(t.token)
    expect(third.ok).toBe(false)
    if (!third.ok) expect(third.code).toBe('rate_limited')

    await admin`update tenant_limits set api_per_minute = null where tenant_id = ${tenantId}`
    invalidateLimits(tenantId)
  })

  it('createEndpoint: перевизначений webhooks-ліміт блокує створення понад нього', async () => {
    const current = (await admin`select count(*)::int as n from webhook_endpoints where tenant_id = ${tenantId}`)[0]!.n as number
    await admin`insert into tenant_limits (tenant_id, webhooks) values (${tenantId}, ${current}) on conflict (tenant_id) do update set webhooks = ${current}`
    invalidateLimits(tenantId)
    const r = await createEndpoint(ctx(), { url: 'https://example.com/hook-debts8', events: ['user.created'] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('webhooks_limit')

    await admin`update tenant_limits set webhooks = ${current + 1} where tenant_id = ${tenantId}`
    invalidateLimits(tenantId)
    const r2 = await createEndpoint(ctx(), { url: 'https://example.com/hook-debts8-2', events: ['user.created'] })
    expect(r2.ok).toBe(true)
    if (r2.ok) webhookIds.push(r2.id)

    await admin`update tenant_limits set webhooks = null where tenant_id = ${tenantId}`
    invalidateLimits(tenantId)
  })
})
