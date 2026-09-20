import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Spec 24 (docs/24, docs/32 §Б.11): единая схема настроек с дефолтами, политики пачкой, модули (403 module.disabled,
 * wiki выключена по умолчанию), редактор ролей с защитами, шкалы range|levels, usage.collect и «Статистика»,
 * переводы поверх словаря, impersonation 60 мин + запреты (docs/29 Б.13), slug (Б.12), акцент (Б.14), категории с порядком.
 */
process.env.PLATFORM_DATABASE_URL ??= 'postgres://platform_admin:platform_admin_dev@localhost:5432/lola'

const st = await import('../../server/services/settings')
const md = await import('../../server/services/modules')
const rl = await import('../../server/services/roles')
const sc = await import('../../server/services/scales')
const us = await import('../../server/services/usage')
const tr = await import('../../server/services/translations')
const im = await import('../../server/services/impersonation')
const ct = await import('../../server/services/categories')
const { tenantSettingsSchema, scaleSchema, policiesPatchSchema, tenantPatchSchema } = await import('../../shared/schemas/settings')
const { loadAccess } = await import('../../server/services/access')
const { validateSession, touchSession } = await import('../../server/services/session')
const { ensureFirstAdmin, platformLogin, validatePlatformSession } = await import('../../server/services/platform')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

let tenantId: string
let adminId: string
let employeeId: string
let originalSettings: unknown
let originalBranding: unknown
let otherTenantId: string
let opsAuth: { adminId: string, email: string, fullName: string }
const cleanup: { table: string, ids: string[] }[] = []
const track = (table: string, id: string) => { (cleanup.find(c => c.table === table) ?? cleanup[cleanup.push({ table, ids: [] }) - 1]!).ids.push(id) }
const ctx = () => ({ tenantId, actorId: adminId })
const auth = (userId: string) => ({ sessionId: 'x', tenantId, userId, impersonatedBy: null, activeRoleId: null })

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  employeeId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380670000003'`)[0]!.id as string
  const [t] = await admin`select settings, branding from tenants where id = ${tenantId}`
  originalSettings = t!.settings; originalBranding = t!.branding
  const [o] = await admin`insert into tenants (slug, name, status) values (${`s24-other-${Date.now()}`}, 'Інший', 'active') returning id`
  otherTenantId = o!.id as string
  process.env.PLATFORM_ADMIN_EMAIL = 'ops-s24@lola.local'
  process.env.PLATFORM_ADMIN_PASSWORD = 'test-password-123'
  await ensureFirstAdmin()
  const login = await platformLogin('ops-s24@lola.local', 'test-password-123')
  opsAuth = (await validatePlatformSession(login!.token))!
})

afterAll(async () => {
  await admin`update tenants set settings = ${admin.json(originalSettings as never)}, branding = ${admin.json(originalBranding as never)} where id = ${tenantId}`
  for (const c of cleanup.reverse()) if (c.ids.length) await admin.unsafe(`delete from ${c.table} where id in (${c.ids.map(i => `'${i}'`).join(',')})`)
  await admin`delete from translations where tenant_id = ${tenantId} and key like 'settings.usage.%'`
  await admin`delete from translations where tenant_id = ${tenantId} and key in ('common.save', 'common.cancel', 'nav.workshops')`
  await admin`delete from scales where tenant_id = ${tenantId} and name like 's24-%'`
  await admin`delete from roles where tenant_id = ${tenantId} and code like 's24_%'`
  await admin`delete from course_categories where tenant_id = ${tenantId} and name like 's24-%'`
  await admin`delete from tenant_usage where tenant_id = ${tenantId}`
  await admin`delete from notifications where tenant_id = ${tenantId} and code = 'impersonation_started'`
  await admin`delete from sessions where tenant_id = ${tenantId} and impersonator_admin_id is not null`
  await admin`delete from tenants where id = ${otherTenantId}`
  await admin`delete from platform_sessions where admin_id in (select id from platform_admins where email = 'ops-s24@lola.local')`
  await admin`delete from platform_admins where email = 'ops-s24@lola.local'`
  await admin.end()
})

describe('настройки: единая схема с дефолтами, политики пачкой, аудит diff', () => {
  it('пустой jsonb даёт полный объект с дефолтами docs/24 §3.4 (сессия 30 дней, OTP 6/5, wiki выключена)', () => {
    const s = tenantSettingsSchema.parse({})
    expect(s.policies.session.lengthDays).toBe(30)
    expect(s.policies.session.otpLength).toBe(6)
    expect(s.policies.passwords.minLength).toBe(12)
    expect(s.policies.roles.defaultRoleCode).toBe('employee')
    expect(s.modules.wiki).toBe(false)
    expect(s.modules.workshops).toBe(true)
    expect(s.quietHours).toEqual({ from: 9, to: 20 })
    expect(s.knowledge.restrictAccess).toBe(true) // Spec 21 сведён сюда
  })

  it('старые разрозненные ключи (security.emailAlerts, policies.dataProtection.disablePrint) читаются той же схемой', async () => {
    const s = await withTenant(tenantId, adminId, tx => st.readSettings(tx, tenantId))
    expect(typeof s.security.emailAlerts).toBe('boolean')
    expect(typeof s.policies.dataProtection.disablePrint).toBe('boolean')
  })

  it('PATCH политик пачкой: только переданные группы, аудит содержит diff, security_log critical', async () => {
    const before = await st.tenantSettings(ctx())
    const r = await st.updatePolicies(ctx(), { session: { lengthDays: 45 }, dataProtection: { disablePrint: true } })
    expect(r.session.lengthDays).toBe(45)
    expect(r.session.otpLength).toBe(before.policies.session.otpLength) // остальное не тронуто
    expect(r.dataProtection.disablePrint).toBe(true)
    const [a] = await admin`select before, after from audit_log where tenant_id = ${tenantId} and action = 'settings.policies' order by created_at desc limit 1`
    expect((a!.after as Record<string, unknown>)['session.lengthDays']).toBe(45)
    expect((a!.before as Record<string, unknown>)['session.lengthDays']).toBe(before.policies.session.lengthDays)
    const [s] = await admin`select severity from security_log where tenant_id = ${tenantId} and event = 'settings.security_changed' order by created_at desc limit 1`
    expect(s!.severity).toBe('critical')
    await st.updatePolicies(ctx(), { session: { lengthDays: before.policies.session.lengthDays }, dataProtection: { disablePrint: false } })
  })

  it('валидация: длина сессии вне 1–90 и лишняя группа отклоняются', () => {
    expect(policiesPatchSchema.safeParse({ session: { lengthDays: 120 } }).success).toBe(false)
    expect(policiesPatchSchema.safeParse({ unknownGroup: {} }).success).toBe(false)
    expect(policiesPatchSchema.safeParse({ passwords: { minLength: 12 } }).success).toBe(true)
  })

  it('тихие часы: окно меньше 4 часов не проходит (docs/24 §6)', () => {
    expect(tenantPatchSchema.safeParse({ quietHours: { from: 10, to: 12 } }).success).toBe(false)
    expect(tenantPatchSchema.safeParse({ quietHours: { from: 8, to: 20 } }).success).toBe(true)
  })
})

describe('модули (docs/24 §3.2, Г-24.2)', () => {
  it('wiki выключена по умолчанию, маршрут /api/v1/wiki попадает под модуль', async () => {
    expect(md.moduleOfRoute('/api/v1/wiki/pages')).toBe('wiki')
    expect(md.moduleOfRoute('/api/v1/reports/summary')).toBeNull() // отчёты не закрываются (docs/24 §7.2)
    expect(md.moduleOfPage('/admin/meetups/complex')).toBe('complexTests')
    expect(md.moduleOfPage('/admin/meetups/123')).toBe('meetups')
    md.invalidateModules(tenantId)
    expect(await md.isModuleEnabled(tenantId, 'wiki')).toBe(false)
  })

  it('выключение модуля пишется в аудит и security_log, кеш сбрасывается', async () => {
    md.invalidateModules(tenantId)
    expect(await md.isModuleEnabled(tenantId, 'workshops')).toBe(true)
    await st.updateModules(ctx(), { workshops: false })
    md.invalidateModules(tenantId)
    expect(await md.isModuleEnabled(tenantId, 'workshops')).toBe(false)
    const [a] = await admin`select after from audit_log where tenant_id = ${tenantId} and action = 'settings.modules' order by created_at desc limit 1`
    expect((a!.after as Record<string, unknown>).workshops).toBe(false)
    await st.updateModules(ctx(), { workshops: true })
    md.invalidateModules(tenantId)
  })
})

describe('редактор ролей (docs/24 §3.5, Г-24.1)', () => {
  let roleId: string
  it('своя роль создаётся, loadAccess даёт её скоупы', async () => {
    const access = (await loadAccess(auth(adminId)))!
    const r = await rl.createRole(ctx(), access, { code: 's24_mentor_local', name: 'Наставник своєї точки', description: null, scopes: ['learn.view', 'review.queue', 'review.grade', 'report.team'], defaultScopeType: 'location' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    roleId = r.role.id
    track('roles', roleId)
    await admin`insert into user_roles (tenant_id, user_id, role_id, scope_type) values (${tenantId}, ${employeeId}, ${roleId}, 'tenant')`
    // Роль по умолчанию для employee — теперь своя роль (ранг 4 выше employee 5)
    const empAccess = (await loadAccess(auth(employeeId)))!
    expect(empAccess.activeRole?.code).toBe('s24_mentor_local')
    expect(empAccess.grants.some(g => g.scopes.includes('review.grade'))).toBe(true)
    const list = await rl.listRoles(ctx())
    expect(list.find(x => x.id === roleId)?.peopleCount).toBe(1)
  })

  it('код занят и системный код — 409; нельзя выдать скоуп, которого нет у редактора', async () => {
    const access = (await loadAccess(auth(adminId)))!
    const dup = await rl.createRole(ctx(), access, { code: 's24_mentor_local', name: 'x', scopes: ['learn.view'], defaultScopeType: 'location' })
    expect(dup.ok === false && dup.code).toBe('code_taken')
    const sys = await rl.createRole(ctx(), access, { code: 'employee', name: 'x', scopes: ['learn.view'], defaultScopeType: 'location' })
    expect(sys.ok === false && sys.code).toBe('code_taken')
    const empAccess = (await loadAccess(auth(employeeId)))!
    const notOwned = await rl.createRole(ctx(), empAccess, { code: 's24_hack', name: 'x', scopes: ['settings.tenant'], defaultScopeType: 'tenant' })
    expect(notOwned.ok === false && notOwned.code).toBe('scope_not_owned')
  })

  it('набор admin не меняется; последняя роль с settings.tenant не лишается его', async () => {
    const access = (await loadAccess(auth(adminId)))!
    const [adminRole] = await admin`select id from roles where tenant_id = ${tenantId} and code = 'admin'`
    const r = await rl.updateRole(ctx(), access, adminRole!.id as string, { scopes: ['learn.view'] })
    expect(r.ok === false && r.code).toBe('admin_role')
    // Пока settings.tenant есть только у admin — снять его у роли, где он единственный, нельзя
    const only = await admin`select count(*)::int as n from roles where tenant_id = ${tenantId} and 'settings.tenant' = any(scopes)`
    if (only[0]!.n === 1) {
      const r2 = await rl.updateRole(ctx(), access, adminRole!.id as string, { name: 'Адміністратор' })
      expect(r2.ok).toBe(true) // имя менять можно
    }
    const r3 = await rl.updateRole(ctx(), access, roleId, { scopes: ['learn.view', 'settings.tenant'] })
    expect(r3.ok).toBe(true)
    const r4 = await rl.updateRole(ctx(), access, roleId, { scopes: ['learn.view'] })
    expect(r4.ok).toBe(true) // settings.tenant остаётся у admin — можно
  })

  it('роль, выданную людям, удалить нельзя; после снятия — можно', async () => {
    const r = await rl.deleteRole(ctx(), roleId)
    expect(r.ok === false && r.code).toBe('role_in_use')
    await admin`delete from user_roles where role_id = ${roleId}`
    const r2 = await rl.deleteRole(ctx(), roleId)
    expect(r2.ok).toBe(true)
    const [sec] = await admin`select meta from security_log where tenant_id = ${tenantId} and event = 'roles.changed' order by created_at desc limit 1`
    expect((sec!.meta as { action: string }).action).toBe('delete')
  })
})

describe('шкалы range|levels (docs/24 Г-24.4)', () => {
  it('range: диапазоны подряд от 0 до 100; levels: числовое значение обязательно', () => {
    expect(scaleSchema.safeParse({ name: 'x', kind: 'range', levels: [{ label: 'a', rangeFrom: 0, rangeTo: 59 }, { label: 'b', rangeFrom: 60, rangeTo: 100 }] }).success).toBe(true)
    expect(scaleSchema.safeParse({ name: 'x', kind: 'range', levels: [{ label: 'a', rangeFrom: 0, rangeTo: 59 }, { label: 'b', rangeFrom: 61, rangeTo: 100 }] }).success).toBe(false) // дыра
    expect(scaleSchema.safeParse({ name: 'x', kind: 'range', levels: [{ label: 'a', rangeFrom: 0, rangeTo: 59 }, { label: 'b', rangeFrom: 60, rangeTo: 90 }] }).success).toBe(false) // не до 100
    expect(scaleSchema.safeParse({ name: 'x', kind: 'levels', levels: [{ label: 'a' }, { label: 'b', value: 2 }] }).success).toBe(false)
    expect(scaleSchema.safeParse({ name: 'x', kind: 'levels', displayAs: 'value', levels: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }] }).success).toBe(true)
  })

  it('создание, уровень по проценту, пересборка, имя занято, удаление', async () => {
    const r = await sc.createScale(ctx(), { name: 's24-Зарахування практикуму', kind: 'range', displayAs: null, levels: [
      { label: 'Не зараховано', rangeFrom: 0, rangeTo: 59, characteristic: 'потрібна нова здача', showInReports: true },
      { label: 'Потребує доопрацювання', rangeFrom: 60, rangeTo: 84, characteristic: null, showInReports: true },
      { label: 'Зараховано', rangeFrom: 85, rangeTo: 100, characteristic: 'закриває завдання', showInReports: true },
    ] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(sc.levelForPercent(r.scale, 85)?.label).toBe('Зараховано')
    expect(sc.levelForPercent(r.scale, 59)?.label).toBe('Не зараховано')
    const dup = await sc.createScale(ctx(), { name: 's24-Зарахування практикуму', kind: 'levels', displayAs: 'label', levels: [{ label: 'a', value: 1, showInReports: true }, { label: 'b', value: 2, showInReports: true }] })
    expect(dup.ok === false && dup.code).toBe('name_taken')
    const upd = await sc.updateScale(ctx(), r.scale.id, { name: 's24-Оцінка 1—5', kind: 'levels', displayAs: 'value', levels: [1, 2, 3, 4, 5].map(v => ({ label: `L${v}`, value: v, showInReports: v > 1 })) })
    expect(upd.ok && upd.scale.levels.length).toBe(5)
    expect(upd.ok && upd.scale.displayAs).toBe('value')
    const list = await sc.listScales(ctx(), 'levels')
    expect(list.some(s => s.id === r.scale.id)).toBe(true)
    expect(await sc.deleteScale(ctx(), r.scale.id)).toBe(true)
    // Чужой тенант: уровни не видны
    expect(await sc.getScale({ tenantId: otherTenantId, actorId: adminId }, r.scale.id)).toBeNull()
  })
})

describe('usage.collect и «Статистика» (docs/24 §4.4.1)', () => {
  it('сбор считает активных без заблокированных, пишет строку; usageView отдаёт последний сбор и лимиты плана', async () => {
    const snap = await us.collectUsage(tenantId)
    const n = (await admin`select count(*)::int as n from users where tenant_id = ${tenantId} and status = 'active' and not is_blocked`)[0]!.n as number
    expect(snap.activeUsers).toBe(n)
    const view = await us.usageView(ctx())
    expect(view.last?.activeUsers).toBe(n)
    expect(view.plan).not.toBeNull()
    expect(view.history.length).toBeGreaterThan(0)
    // Блокировка освобождает место: заблокированный не считается активным
    await admin`update users set is_blocked = true where id = ${employeeId}`
    const snap2 = await us.collectUsage(tenantId)
    await admin`update users set is_blocked = false where id = ${employeeId}`
    expect(snap2.activeUsers).toBe(n - 1)
    expect(snap2.blockedUsers).toBe(snap.blockedUsers + 1)
  })

  it('collectUsageDue не собирает повторно за тот же локальный день', async () => {
    const before = (await admin`select count(*)::int as n from tenant_usage where tenant_id = ${tenantId}`)[0]!.n
    await us.collectUsageDue()
    const after = (await admin`select count(*)::int as n from tenant_usage where tenant_id = ${tenantId}`)[0]!.n
    expect(after).toBe(before) // сегодня уже собирали (тест выше)
  })
})

describe('переводы поверх словаря (docs/24 §3.6, §7.4)', () => {
  it('переопределение, список «только изменённые», кеш и сброс', async () => {
    const dict = tr.defaultDictionary('uk')
    expect(dict['common.save']).toBeTruthy()
    const row = await tr.setTranslation(ctx(), { locale: 'uk', key: 'common.save', value: 'Зберегти!' })
    expect(row.custom).toBe('Зберегти!')
    expect(row.standard).toBe(dict['common.save'])
    expect(row.updatedBy).toBeTruthy()
    const over = await tr.tenantOverrides(tenantId, 'uk')
    expect(over['common.save']).toBe('Зберегти!')
    expect(await tr.tenantOverrides(otherTenantId, 'uk')).toEqual({}) // чужой тенант не видит
    const list = await tr.listTranslations(ctx(), { locale: 'uk', changedOnly: true })
    expect(list.items.map(i => i.key)).toContain('common.save')
    expect(list.changed).toBeGreaterThanOrEqual(1)
    const search = await tr.listTranslations(ctx(), { locale: 'uk', q: 'common.sav' })
    expect(search.items.some(i => i.key === 'common.save')).toBe(true)
    expect(await tr.resetTranslation(ctx(), 'uk', 'common.save')).toBe(true)
    expect((await tr.tenantOverrides(tenantId, 'uk'))['common.save']).toBeUndefined()
  })

  it('импорт: неизвестные ключи пропускаются, равное стандартному — снимает переопределение; экспорт отдаёт свои', async () => {
    const dict = tr.defaultDictionary('uk')
    const r = await tr.importTranslations(ctx(), 'uk', { 'common.cancel': 'Скасувати все', 'nav.workshops': 'Практика', 'common.save': dict['common.save']! })
    expect(r.set).toBe(1)
    expect(r.skipped).toContain('nav.workshops')
    const exp = await tr.exportTranslations(ctx(), 'uk')
    expect(exp['common.cancel']).toBe('Скасувати все')
    expect(await tr.resetAllTranslations(ctx(), 'uk')).toBeGreaterThanOrEqual(1)
    expect(await tr.exportTranslations(ctx(), 'uk')).toEqual({})
  })
})

describe('impersonation: 60 минут, запреты, журнал с обеими сторонами (docs/24 §4.5, docs/29 Б.13)', () => {
  it('старт: сессия ≤ 60 минут, не продлевается, impersonation.started с оператором и человеком, уведомление администратору', async () => {
    const r = await im.startImpersonation(tenantId, employeeId, 'Розбір скарги — тест spec24', opsAuth)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60 * 60_000 + 1000)
    const a = (await validateSession(r.token))!
    expect(a.impersonatorAdminId).toBe(opsAuth.adminId)
    await admin`update sessions set updated_at = now() - interval '2 hours' where id = ${r.sessionId}`
    await touchSession(a)
    const [s] = await admin`select expires_at from sessions where id = ${r.sessionId}`
    expect(new Date(s!.expires_at as string).getTime() - Date.now()).toBeLessThanOrEqual(60 * 60_000 + 1000)
    const [sec] = await admin`select meta, severity from security_log where tenant_id = ${tenantId} and event = 'impersonation.started' order by created_at desc limit 1`
    const meta = sec!.meta as { operator: { id: string, email: string }, subject: { id: string }, reason: string }
    expect(meta.operator.email).toBe('ops-s24@lola.local')
    expect(meta.subject.id).toBe(employeeId)
    expect(sec!.severity).toBe('critical')
    const [n] = await admin`select id from notifications where tenant_id = ${tenantId} and code = 'impersonation_started' and user_id = ${adminId} order by created_at desc limit 1`
    expect(n).toBeDefined()
    // стоп → impersonation.ended, сессия отозвана
    expect(await im.stopImpersonation(a)).toBe(true)
    expect(await validateSession(r.token)).toBeNull()
    const [end] = await admin`select meta from security_log where tenant_id = ${tenantId} and event = 'impersonation.ended' order by created_at desc limit 1`
    expect((end!.meta as { subject: { id: string } }).subject.id).toBe(employeeId)
  })

  it('запреты Б.13: роли, выгрузки, уведомления, GDPR, секреты — чтение разрешено', () => {
    expect(im.forbiddenFor('POST', '/api/v1/people/abc/roles')).toBe('roles')
    expect(im.forbiddenFor('PATCH', '/api/v1/settings/roles/1')).toBe('roles')
    expect(im.forbiddenFor('GET', '/api/v1/settings/roles')).toBeNull()
    expect(im.forbiddenFor('GET', '/api/v1/people/export')).toBe('exports')
    expect(im.forbiddenFor('POST', '/api/v1/reports/summary/export')).toBe('exports')
    expect(im.forbiddenFor('POST', '/api/v1/notifications/broadcast')).toBe('notifications')
    expect(im.forbiddenFor('POST', '/api/v1/people/gdpr-erase')).toBe('gdpr')
    expect(im.forbiddenFor('POST', '/api/v1/settings/integrations/smtp')).toBe('secrets')
    expect(im.forbiddenFor('GET', '/api/v1/settings/integrations')).toBeNull()
    expect(im.forbiddenFor('GET', '/api/v1/courses')).toBeNull()
    expect(im.forbiddenFor('PATCH', '/api/v1/courses/1')).toBeNull()
  })

  it('неактивный человек — отказ', async () => {
    await admin`update users set is_blocked = true where id = ${employeeId}`
    const r = await im.startImpersonation(tenantId, employeeId, 'Розбір скарги — тест spec24', opsAuth)
    await admin`update users set is_blocked = false where id = ${employeeId}`
    expect(r.ok === false && r.code).toBe('inactive')
  })
})

describe('slug (docs/29 Б.12) и акцент (Б.14)', () => {
  it('slug по правилам, уникален; после первого входа сотрудника не меняется', async () => {
    expect(tenantPatchSchema.safeParse({ slug: 'ab' }).success).toBe(false)
    expect(tenantPatchSchema.safeParse({ slug: 'Kappi' }).success).toBe(false)
    expect(tenantPatchSchema.safeParse({ slug: 'kappi-2' }).success).toBe(true)
    // Свежий тенант без сессий сотрудников — менять можно
    const [u] = await admin`insert into users (tenant_id, phone, full_name, status) values (${otherTenantId}, '+380990000024', 'Адмін Інший', 'active') returning id`
    track('users', u!.id as string)
    const octx = { tenantId: otherTenantId, actorId: u!.id as string }
    const taken = await st.updateTenantSpace(octx, { slug: 'kappi' })
    expect(taken.ok === false && taken.code).toBe('slug_taken')
    const ok = await st.updateTenantSpace(octx, { slug: `s24-new-${Date.now() % 100000}` })
    expect(ok.ok).toBe(true)
    // У kappi есть сессии сотрудников → заблокирован
    const space = await st.tenantSpace(ctx())
    expect(space.slugLocked).toBe(true)
    const locked = await st.updateTenantSpace(ctx(), { slug: 'kappi-new' })
    expect(locked.ok === false && locked.code).toBe('slug_locked')
    const [a] = await admin`select after from audit_log where tenant_id = ${otherTenantId} and action = 'settings.tenant' order by created_at desc limit 1`
    expect((a!.after as Record<string, unknown>).slug).toMatch(/^s24-new-/)
  })

  it('акцент — только из палитры, хранится в branding.accent', async () => {
    expect(tenantPatchSchema.safeParse({ accent: '#ff0000' }).success).toBe(false)
    expect(tenantPatchSchema.safeParse({ accent: 'teal' }).success).toBe(true)
    const r = await st.updateTenantSpace(ctx(), { accent: 'teal' })
    expect(r.ok && r.space.accent).toBe('teal')
    const [t] = await admin`select branding from tenants where id = ${tenantId}`
    expect((t!.branding as { accent: string }).accent).toBe('teal')
    expect(st.accentOf({ accent: 'purple' })).toBe('sun') // мусор в БД → дефолт
  })
})

describe('категории каталога с порядком (docs/24 §3.7.1)', () => {
  it('создание, порядок перетаскиванием, удаление с курсами — in_use', async () => {
    const a = await ct.createCategory(ctx(), { name: 's24-Кухня' })
    const b = await ct.createCategory(ctx(), { name: 's24-Офіс' })
    track('course_categories', a.id); track('course_categories', b.id)
    expect(b.sort).toBe(a.sort + 1)
    await ct.reorderCategories(ctx(), [b.id, a.id])
    const list = await ct.listCategories(ctx())
    expect(list.findIndex(c => c.id === b.id)).toBeLessThan(list.findIndex(c => c.id === a.id))
    const [course] = await admin`insert into courses (tenant_id, title, slug, category_id, created_by) values (${tenantId}, 's24 курс', ${`s24-${Date.now()}`}, ${a.id}, ${adminId}) returning id`
    track('courses', course!.id as string)
    const del = await ct.deleteCategory(ctx(), a.id)
    expect(del.ok === false && del.code).toBe('in_use')
    expect((await ct.deleteCategory(ctx(), b.id)).ok).toBe(true)
  })
})
