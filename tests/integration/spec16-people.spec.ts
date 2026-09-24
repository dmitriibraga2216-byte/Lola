import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Spec 16 (docs/16, docs/32 §Б.14): пароль (политики, вход, блокировка, события), метки со scope,
 * группы «з оргструктури» (is_org_derived), конфликт «людина у двох підрозділах» при импорте и его разрешение,
 * «Не перезаписувати під час імпорту», коды событий журнала безопасности Г-16.2, 404 чужого тенанта.
 */
const PW = await import('../../server/services/password')
const TG = await import('../../server/services/tags')
const G = await import('../../server/services/groups')
const P = await import('../../server/services/people')
const J = await import('../../server/services/journals')
const L = await import('../../server/services/logs')
const { validateImport, applyImport } = await import('../../server/services/importPeople')
const { updatePolicies } = await import('../../server/services/settings')
const { SECURITY_EVENTS } = await import('../../shared/enums')
const { severityOf } = await import('../../server/services/securityLog')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
let tenantId: string, adminId: string, lazarevaId: string, posId: string, unitKappiId: string, unitKitchenId: string, kitchenLocId: string
let originalSettings: unknown
const PHONE_PREFIX = '+38093'
const EMAIL = `s16-${Date.now()}@example.test`
const userIds: string[] = []
const ctx = () => ({ tenantId, actorId: adminId })

async function makePerson(name: string, opts: { email?: string, locationId?: string, orgUnitId?: string, externalId?: string, tags?: string[] } = {}) {
  const phone = `${PHONE_PREFIX}${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, phone, email, full_name, status, external_id, tags) values (${tenantId}, ${phone}, ${opts.email ?? null}, ${name}, 'active', ${opts.externalId ?? null}, ${opts.tags ?? []}) returning id`
  const id = u!.id as string
  userIds.push(id)
  await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, org_unit_id, is_primary) values (${tenantId}, ${id}, ${opts.locationId ?? lazarevaId}, ${posId}, ${opts.orgUnitId ?? unitKappiId}, true)`
  return { id, phone }
}
const lastEvents = async (userId: string) => (await admin`select event, severity, meta from security_log where user_id = ${userId} order by created_at desc, id desc`).map(r => ({ event: r.event as string, severity: r.severity as string, meta: r.meta as Record<string, unknown> }))

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  originalSettings = (await admin`select settings from tenants where id = ${tenantId}`)[0]!.settings
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  unitKappiId = (await admin`select id from org_units where tenant_id = ${tenantId} and name = 'Каппі'`)[0]!.id as string
  unitKitchenId = (await admin`insert into org_units (tenant_id, name, path, parent_id) values (${tenantId}, ${`Цех-s16-${Date.now()}`}, ${`kappi.s16_${Date.now()}`}, ${unitKappiId}) returning id`)[0]!.id as string
  kitchenLocId = (await admin`insert into locations (tenant_id, name, org_unit_id) values (${tenantId}, ${`Точка-s16-${Date.now()}`}, ${unitKitchenId}) returning id`)[0]!.id as string
  posId = (await admin`insert into positions (tenant_id, name) values (${tenantId}, ${`Посада-s16-${Date.now()}`}) returning id`)[0]!.id as string
})

afterAll(async () => {
  await admin`update tenants set settings = ${admin.json(originalSettings as never)} where id = ${tenantId}`
  const imported = await admin`select id from users where tenant_id = ${tenantId} and (phone like ${`${PHONE_PREFIX}%`} or external_id like 'S16-%')`
  const ids = [...new Set([...userIds, ...imported.map(r => r.id as string)])]
  if (ids.length) {
    await admin`delete from notifications where user_id in ${admin(ids)}`
    await admin`delete from org_conflicts where user_id in ${admin(ids)}`
    await admin`delete from users where id in ${admin(ids)}`
  }
  await admin`delete from org_conflicts where tenant_id = ${tenantId} and kind = 'unit_missing' and details->>'orgUnit' like 'Нема-%'`
  await admin`delete from import_jobs where tenant_id = ${tenantId} and file_name like 's16-%'`
  await admin`delete from user_groups where tenant_id = ${tenantId} and (org_unit_id = ${unitKitchenId} or location_id = ${kitchenLocId} or name like 's16-%')`
  await admin`delete from locations where id = ${kitchenLocId}`
  await admin`delete from org_units where id = ${unitKitchenId}`
  await admin`delete from positions where id = ${posId}`
  await admin`delete from tags where tenant_id = ${tenantId} and name like 's16-%'`
  await admin`delete from rate_limits where key like 'pwd:%'`
  await admin.end()
})

describe('пароль (docs/01 §1.5, docs/16 §14.4–14.5, docs/24 §3.4.1 «Паролі»)', () => {
  it('политика: короткий и слабый пароль отклоняются, хеш не отдаётся, событие password.reset_by_admin', async () => {
    const { id } = await makePerson('Пароль Тест', { email: EMAIL })
    const short = await PW.setPasswordByAdmin(ctx(), id, { password: 'Ab1' })
    expect(short).toMatchObject({ ok: false, code: 'too_short' })
    const weak = await PW.setPasswordByAdmin(ctx(), id, { password: '123456789012' })
    expect(weak).toMatchObject({ ok: false, code: 'weak' })
    const ok = await PW.setPasswordByAdmin(ctx(), id, { password: 'Correct-Horse-7', mustChange: false })
    expect(ok).toEqual({ ok: true })
    const person = await P.getPerson(ctx(), id)
    expect(person).not.toHaveProperty('passwordHash')
    expect(person).toMatchObject({ hasPassword: true, mustChangePassword: false })
    expect((await lastEvents(id))[0]).toMatchObject({ event: 'password.reset_by_admin', severity: 'info' })
    const [audit] = await admin`select 1 from audit_log where entity_id = ${id} and action = 'people.password_reset'`
    expect(audit).toBeTruthy()
  })

  it('вход выключен политикой → disabled; включён → сессия; неверный пароль → login.failed; N неудач → блокировка и login.blocked', async () => {
    const [u] = await admin`select id from users where tenant_id = ${tenantId} and email = ${EMAIL}`
    const id = u!.id as string
    expect(await PW.loginWithPassword(EMAIL, 'Correct-Horse-7')).toMatchObject({ ok: false, code: 'disabled' })

    await updatePolicies(ctx(), { passwords: { loginEnabled: true }, auth: { loginAttempts: 3, limitLoginAttempts: true } })
    const good = await PW.loginWithPassword(EMAIL, 'Correct-Horse-7')
    expect(good.ok).toBe(true)
    if (good.ok) expect(good.users[0]).toMatchObject({ user_id: id, tenant_id: tenantId, mustChangePassword: false })

    expect(await PW.loginWithPassword(EMAIL, 'wrong-1')).toMatchObject({ ok: false, code: 'invalid' })
    expect((await lastEvents(id))[0]).toMatchObject({ event: 'login.failed', severity: 'warning', meta: { method: 'password' } })
    await PW.loginWithPassword(EMAIL, 'wrong-2')
    expect(await PW.loginWithPassword(EMAIL, 'wrong-3')).toMatchObject({ ok: false, code: 'blocked' })
    expect((await lastEvents(id))[0]).toMatchObject({ event: 'login.blocked', severity: 'warning' })
    // Правильный пароль во время блокировки тоже не пускает
    expect(await PW.loginWithPassword(EMAIL, 'Correct-Horse-7')).toMatchObject({ ok: false, code: 'blocked' })
    await admin`delete from rate_limits where key like 'pwd:%'`
  })

  it('maxAgeDays: просроченный пароль требует смены; changeOwnPassword с неверным текущим — отказ, верный — password.changed', async () => {
    const [u] = await admin`select id from users where tenant_id = ${tenantId} and email = ${EMAIL}`
    const id = u!.id as string
    await updatePolicies(ctx(), { passwords: { maxAgeDays: 1 } })
    await admin`update users set password_changed_at = now() - interval '3 days' where id = ${id}`
    const r = await PW.loginWithPassword(EMAIL, 'Correct-Horse-7')
    expect(r.ok && r.users[0]!.mustChangePassword).toBe(true)
    expect(await PW.changeOwnPassword({ tenantId, actorId: id }, { currentPassword: 'nope', password: 'Another-Pass-9' })).toMatchObject({ ok: false, code: 'wrong_current' })
    expect(await PW.changeOwnPassword({ tenantId, actorId: id }, { currentPassword: 'Correct-Horse-7', password: 'Another-Pass-9' })).toEqual({ ok: true })
    expect((await lastEvents(id))[0]).toMatchObject({ event: 'password.changed' })
    const r2 = await PW.loginWithPassword(EMAIL, 'Another-Pass-9')
    expect(r2.ok && r2.users[0]!.mustChangePassword).toBe(false)
    await updatePolicies(ctx(), { passwords: { maxAgeDays: null } })
  })
})

describe('метки со scope (docs/16 §14.2)', () => {
  it('область обязательна, имя ≤ 40 без <>, уникальность в паре (scope, name); использование считается по таблицам области', async () => {
    const a = await TG.createTag(ctx(), { name: 's16-зал', scope: 'user' })
    expect(a.ok).toBe(true)
    expect(await TG.createTag(ctx(), { name: 'S16-Зал', scope: 'user' })).toMatchObject({ ok: false, code: 'duplicate' })
    const sameNameOtherScope = await TG.createTag(ctx(), { name: 's16-зал', scope: 'course' })
    expect(sameNameOtherScope.ok).toBe(true)
    const { id } = await makePerson('Мітка Тест', { tags: ['s16-зал'] })
    const list = await TG.listTags(ctx(), 'user')
    expect(list.find(t => t.name === 's16-зал')?.usage).toBeGreaterThanOrEqual(1)
    expect((await TG.listTags(ctx(), 'course')).find(t => t.name === 's16-зал')?.usage).toBe(0)
    // Используемую нельзя удалить; переименование сохраняет связи
    expect(await TG.deleteTag(ctx(), (a as { tag: { id: string } }).tag.id)).toMatchObject({ ok: false, code: 'in_use' })
    expect(await TG.updateTag(ctx(), (a as { tag: { id: string } }).tag.id, { name: 's16-зала' })).toMatchObject({ ok: true })
    const [u] = await admin`select tags from users where id = ${id}`
    expect(u!.tags).toContain('s16-зала')
    // Метка человека, которой нет в справочнике, заводится в области user
    await P.updatePerson(ctx(), id, { tags: ['s16-нова', 's16-зала'] })
    expect((await admin`select scope from tags where tenant_id = ${tenantId} and name = 's16-нова'`)[0]!.scope).toBe('user')
    // Zod: угловые скобки и > 40 знаков — отказ
    const { tagCreateSchema } = await import('../../shared/schemas/people')
    expect(tagCreateSchema.safeParse({ name: '<iframe>', scope: 'user' }).success).toBe(false)
    expect(tagCreateSchema.safeParse({ name: 'x'.repeat(41), scope: 'user' }).success).toBe(false)
    expect(tagCreateSchema.safeParse({ name: 'ok', scope: 'people' }).success).toBe(false)
  })
})

describe('группы «з оргструктури» (docs/16 §3.3, §14.1)', () => {
  it('пересборка создаёт группу на подразделение и точку с людьми, производную нельзя править и удалять', async () => {
    // docs/33 D-022: пересборка строит производные группы только при orgStructure.mode ≠ user_groups (import/hybrid)
    await updatePolicies(ctx(), { orgStructure: { mode: 'hybrid' } })
    const { id } = await makePerson('Група Орг', { locationId: kitchenLocId, orgUnitId: unitKitchenId })
    await G.rebuildOrgGroups(tenantId)
    const [unitGroup] = await admin`select * from user_groups where tenant_id = ${tenantId} and org_unit_id = ${unitKitchenId}`
    const [locGroup] = await admin`select * from user_groups where tenant_id = ${tenantId} and location_id = ${kitchenLocId}`
    expect(unitGroup!.is_org_derived).toBe(true)
    expect(unitGroup!.members).toContain(id)
    expect(locGroup!.members).toContain(id)
    // Родительское подразделение получает людей потомков
    const [parent] = await admin`select members from user_groups where tenant_id = ${tenantId} and org_unit_id = ${unitKappiId}`
    expect(parent!.members).toContain(id)
    expect(await G.upsertGroup(ctx(), { id: unitGroup!.id as string, name: 's16-x', kind: 'static', members: [] })).toEqual({ error: 'org_derived' })
    expect(await G.deleteGroup(ctx(), unitGroup!.id as string)).toMatchObject({ ok: false, code: 'org_derived' })
    // Смена размещения пересобирает: человек ушёл на Лазареву — из группы цеха выбыл
    await P.addPlacement(ctx(), id, { locationId: lazarevaId, positionId: posId, isPrimary: true })
    await G.rebuildOrgGroups(tenantId)
    const [after] = await admin`select members from user_groups where id = ${unitGroup!.id}`
    expect(after!.members).not.toContain(id)
  })
})

describe('импорт: конфликт «людина у двох підрозділах», unit_missing, «Не перезаписувати» (docs/16 §7, §14, Г-16.1)', () => {
  const row = (ext: string, extra: Record<string, string> = {}) => ({ 'Зовнішній ID': ext, 'Прізвище': 'Імпорт', 'Імʼя': ext, 'Телефон': `${PHONE_PREFIX}${ext.replace(/\D/g, '').padStart(7, '1')}`, 'Посада': 'Бариста', 'Підрозділ': 'Каппі', 'Точка': 'Лазарева', 'Мітки': 's16-імпорт', ...extra })

  it('double_unit при разрешённых нескольких подразделениях: старое размещение остаётся открытым, пишется конфликт; разрешение закрывает одно', async () => {
    const ext = 'S16-001'
    const first = await validateImport(ctx(), 's16-a.csv', [row(ext)])
    await applyImport(ctx(), first.jobId)
    const [u] = await admin`select id from users where tenant_id = ${tenantId} and external_id = ${ext}`
    const id = u!.id as string
    // Без политики — импорт в другой цех закрыл бы старое размещение (placement_replaced)
    await updatePolicies(ctx(), { orgStructure: { mode: 'hybrid', allowMultipleUnits: true } })
    const [kitchen] = await admin`select name from org_units where id = ${unitKitchenId}`
    const [loc] = await admin`select name from locations where id = ${kitchenLocId}`
    const second = await validateImport(ctx(), 's16-b.csv', [row(ext, { 'Підрозділ': kitchen!.name as string, 'Точка': loc!.name as string })])
    expect(second.stats.update).toBe(1)
    await applyImport(ctx(), second.jobId)
    const open = await admin`select id, is_primary, org_unit_id from user_placements where user_id = ${id} and ended_at is null order by created_at`
    expect(open.length).toBe(2)
    expect(open.filter(p => p.is_primary).length).toBe(1)
    const conflicts = await admin`select * from org_conflicts where user_id = ${id} and kind = 'double_unit'`
    expect(conflicts.length).toBe(1)
    expect(conflicts[0]).toMatchObject({ source: 'import', import_job_id: second.jobId })
    expect('request_context' in conflicts[0]!).toBe(true)
    // Журнал показывает «Не вирішено»; разрешение закрывает старое размещение
    const openRows = await L.readLog(ctx(), 'org-conflicts', { state: 'open', userId: id })
    expect(openRows.some(r => r.id === conflicts[0]!.id)).toBe(true)
    const oldPlacement = open.find(p => !p.is_primary)!
    expect(await J.resolveOrgConflict(ctx(), conflicts[0]!.id as string, { action: 'close_placement' })).toMatchObject({ ok: false, code: 'placement_required' })
    expect(await J.resolveOrgConflict(ctx(), conflicts[0]!.id as string, { action: 'close_placement', placementId: oldPlacement.id as string, comment: 'переведений' })).toEqual({ ok: true })
    const [closed] = await admin`select ended_at from user_placements where id = ${oldPlacement.id}`
    expect(closed!.ended_at).not.toBeNull()
    const [resolved] = await admin`select resolved_at, resolved_by, details from org_conflicts where id = ${conflicts[0]!.id}`
    expect(resolved!.resolved_at).not.toBeNull()
    expect((resolved!.details as { resolution: { action: string } }).resolution.action).toBe('close_placement')
    expect(await J.resolveOrgConflict(ctx(), conflicts[0]!.id as string, { action: 'acknowledge' })).toMatchObject({ ok: false, code: 'already_resolved' })
    expect((await L.readLog(ctx(), 'org-conflicts', { state: 'open', userId: id })).length).toBe(0)
    const [audit] = await admin`select 1 from audit_log where action = 'org_conflict.resolve' and entity_id = ${conflicts[0]!.id}`
    expect(audit).toBeTruthy()
  })

  it('unit_missing: подразделение не из справочника при createRefs=false — строка протокола, импорт продолжается', async () => {
    const name = `Нема-${Date.now()}`
    const r = await validateImport(ctx(), 's16-c.csv', [row('S16-002', { 'Підрозділ': name }), row('S16-003')], { options: { createRefs: false } })
    expect(r.stats.create).toBe(1)
    expect(r.rows[0]!.unknownUnit).toBe(name)
    await applyImport(ctx(), r.jobId)
    const [c] = await admin`select * from org_conflicts where tenant_id = ${tenantId} and kind = 'unit_missing' and details->>'orgUnit' = ${name}`
    expect(c).toMatchObject({ source: 'import', import_job_id: r.jobId })
    expect(await admin`select 1 from users where tenant_id = ${tenantId} and external_id = 'S16-003'`).toHaveLength(1)
  })

  it('«Не перезаписувати»: поля из политики импорт не трогает, остальные обновляет; метки из файла заводятся в области user', async () => {
    const ext = 'S16-003'
    const [u] = await admin`select id from users where tenant_id = ${tenantId} and external_id = ${ext}`
    await admin`update users set tags = array['s16-ручна'], email = 'keep-s16@example.test' where id = ${u!.id}`
    await updatePolicies(ctx(), { users: { importKeepFields: ['tags', 'email', 'position'] } })
    const r = await validateImport(ctx(), 's16-d.csv', [row(ext, { 'Email': 'new-s16@example.test', 'Прізвище': 'Оновлений', 'Посада': 'Касир', 'Мітки': 's16-з-файлу' })])
    await applyImport(ctx(), r.jobId)
    const [after] = await admin`select tags, email, last_name from users where id = ${u!.id}`
    expect(after!.tags).toEqual(['s16-ручна'])
    expect(after!.email).toBe('keep-s16@example.test')
    expect(after!.last_name).toBe('Оновлений')
    const placements = await admin`select p.name from user_placements up join positions p on p.id = up.position_id where up.user_id = ${u!.id} and up.ended_at is null and up.is_primary`
    expect(placements[0]!.name).toBe('Бариста')
    await updatePolicies(ctx(), { users: { importKeepFields: [] } })
    const r2 = await validateImport(ctx(), 's16-e.csv', [row(ext, { 'Email': 'new-s16@example.test', 'Мітки': 's16-з-файлу' })])
    await applyImport(ctx(), r2.jobId)
    const [after2] = await admin`select tags, email from users where id = ${u!.id}`
    expect(after2!.tags).toEqual(['s16-з-файлу'])
    expect(after2!.email).toBe('new-s16@example.test')
    expect((await admin`select scope from tags where tenant_id = ${tenantId} and name = 's16-з-файлу'`)[0]!.scope).toBe('user')
  })
})

describe('журнал безопасности Г-16.2 (docs/16 §15)', () => {
  it('коды событий — ровно список docs/02; уровни по градации; писатели людей пишут user.*, roles.changed, contacts.changed, session.revoked', async () => {
    expect([...SECURITY_EVENTS]).toEqual(['login.success', 'login.failed', 'login.blocked', 'otp.sent', 'otp.failed', 'session.revoked', 'user.created', 'user.blocked', 'user.unblocked', 'user.archived', 'password.changed', 'password.reset_by_admin', 'roles.changed', 'contacts.changed', 'impersonation.started', 'impersonation.ended', 'export.personal_data', 'settings.security_changed', 'api_token.created', 'api_token.revoked',
      // PR-39 (docs/24 §3.4.2): второй фактор входа — зарегистрированы в docs/02 вместе с кодом
      'two_factor.enabled', 'two_factor.disabled', 'two_factor.reset', 'two_factor.failed', 'two_factor.recovery_used'])
    expect(severityOf('impersonation.started')).toBe('critical')
    expect(severityOf('two_factor.reset')).toBe('critical')
    expect(severityOf('two_factor.failed')).toBe('warning')
    expect(severityOf('two_factor.enabled')).toBe('info')
    expect(severityOf('export.personal_data')).toBe('critical')
    expect(severityOf('login.blocked')).toBe('warning')
    expect(severityOf('otp.failed')).toBe('warning')
    expect(severityOf('user.blocked')).toBe('info')
    // Старых кодов в журнале не осталось (миграция 0038)
    const old = await admin`select count(*)::int as n from security_log where event in ('login.otp', 'logout', 'logout.all', 'telegram.linked', 'impersonation.start')`
    expect(old[0]!.n).toBe(0)
    const unknown = await admin`select distinct event from security_log where tenant_id = ${tenantId} and event <> all(${SECURITY_EVENTS as unknown as string[]})`
    expect(unknown.map(r => r.event)).toEqual([])

    const created = await P.createPerson(ctx(), { lastName: 'Журнал', firstName: 'Безпеки', phone: `${PHONE_PREFIX}0000099`, tags: [] })
    userIds.push(created.id)
    expect((await lastEvents(created.id))[0]).toMatchObject({ event: 'user.created' })
    await P.updatePerson(ctx(), created.id, { email: 'contacts-s16@example.test' })
    expect((await lastEvents(created.id))[0]).toMatchObject({ event: 'contacts.changed', meta: { fields: ['email'] } })
    await P.setBlocked(ctx(), created.id, true)
    expect((await lastEvents(created.id))[0]).toMatchObject({ event: 'user.blocked' })
    await P.setBlocked(ctx(), created.id, false)
    expect((await lastEvents(created.id))[0]).toMatchObject({ event: 'user.unblocked' })
    await P.assignRole(ctx(), created.id, { roleCode: 'mentor', scopeType: 'location', scopeId: lazarevaId })
    expect((await lastEvents(created.id))[0]).toMatchObject({ event: 'roles.changed', meta: { action: 'assign', roleCode: 'mentor' } })
    await P.removeRole(ctx(), created.id, 'mentor', 'тест')
    expect((await lastEvents(created.id))[0]).toMatchObject({ event: 'roles.changed', meta: { action: 'revoke' } })
    await admin`insert into sessions (tenant_id, user_id, token_hash, expires_at) values (${tenantId}, ${created.id}, ${`s16-${Date.now()}`}, now() + interval '1 day')`
    expect(await P.closeSessions(ctx(), created.id)).toBe(1)
    expect((await lastEvents(created.id))[0]).toMatchObject({ event: 'session.revoked', meta: { reason: 'admin' } })
    await P.archivePerson(ctx(), created.id, { reason: 'dismissal' })
    expect((await lastEvents(created.id)).map(e => e.event).slice(0, 2)).toEqual(expect.arrayContaining(['user.archived']))
    // Фильтр журнала по подразделению (мокап SecurityLog) и по человеку
    const rows = await L.readLog(ctx(), 'security', { userId: created.id, type: 'user.' })
    expect(rows.length).toBeGreaterThanOrEqual(3)
    expect(rows.every(r => String(r.event).startsWith('user.'))).toBe(true)
  })

  it('чужой тенант: пароль и метка чужого человека — not_found, конфликт чужого тенанта — not_found', async () => {
    const [other] = await admin`insert into tenants (slug, name, status) values (${`s16-other-${Date.now()}`}, 'Інший', 'active') returning id`
    const otherId = other!.id as string
    try {
      const [u] = await admin`select id from users where tenant_id = ${tenantId} and email = ${EMAIL}`
      const foreign = { tenantId: otherId, actorId: adminId }
      expect(await PW.setPasswordByAdmin(foreign, u!.id as string, { password: 'Correct-Horse-7' })).toMatchObject({ ok: false, code: 'not_found' })
      const [c] = await admin`select id from org_conflicts where tenant_id = ${tenantId} limit 1`
      if (c) expect(await J.resolveOrgConflict(foreign, c.id as string, { action: 'acknowledge' })).toMatchObject({ ok: false, code: 'not_found' })
      const [tag] = await admin`select id from tags where tenant_id = ${tenantId} and name like 's16-%' limit 1`
      expect(await TG.updateTag(foreign, tag!.id as string, { name: 's16-чужа' })).toMatchObject({ ok: false, code: 'not_found' })
      expect(await withTenant(otherId, null, tx => TG.usageOf(tx, 'user', 's16-зала'))).toBe(0)
    }
    finally {
      await admin`delete from tenants where id = ${otherId}`
    }
  })
})
