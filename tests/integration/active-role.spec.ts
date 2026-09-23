import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Паритет 4 (docs/32 §Б строка 4, docs/01 §1.9.2–1.9.3, docs/28 «Паритет 4»):
 * активная роль в сессии, переключение среди своих действующих ролей, права по активной роли,
 * срок и причина у назначения роли (29 Б.15), правило «должность → роль».
 */

const { effectiveRoles, defaultRoleOf, rankRole, switchRole, resolveActiveRole } = await import('../../server/services/activeRole')
const { createSession, validateSession } = await import('../../server/services/session')
const { loadAccess, can } = await import('../../server/services/access')
const { assignRole, removeRole, addPlacement, isLastAdmin } = await import('../../server/services/people')
const { getPositionRoleMap, setPositionRoleMap, applyPositionRoles, reapplyPositionRolesNetwork, expireRoles, roleExpiryScan } = await import('../../server/services/positionRoleMap')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
let tenantId: string, adminId: string, lazarevaId: string, segedskaId: string
let userId: string, soloId: string
let posMappedId: string, posPlainId: string
const roleId: Record<string, string> = {}
const ctx = () => ({ tenantId, actorId: adminId })
const PHONE_PREFIX = '+38093'

async function makeUser(name: string) {
  const phone = `${PHONE_PREFIX}${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, phone, full_name, status) values (${tenantId}, ${phone}, ${name}, 'active') returning id`
  return u!.id as string
}
const userRoleRows = (uid: string) => admin`select r.code, ur.scope_type, ur.scope_id, ur.valid_until, ur.reason, ur.is_org_derived from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = ${uid} order by r.code`

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  segedskaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Сегедська'`)[0]!.id as string
  for (const r of await admin`select id, code from roles where tenant_id = ${tenantId}`) roleId[r.code as string] = r.id as string
  userId = await makeUser('Ролі Тестова')
  soloId = await makeUser('Одна Роль')
  posMappedId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Шеф-роль-${Date.now()}`}, 'chef-role-spec') returning id`)[0]!.id as string
  posPlainId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Бариста-роль-${Date.now()}`}, 'barista-role-spec') returning id`)[0]!.id as string
  // admin на всю сеть + employee на точке + истёкший author
  await admin`insert into user_roles (tenant_id, user_id, role_id, scope_type, scope_id) values
    (${tenantId}, ${userId}, ${roleId.admin!}, 'tenant', null),
    (${tenantId}, ${userId}, ${roleId.employee!}, 'location', ${lazarevaId})`
  await admin`insert into user_roles (tenant_id, user_id, role_id, scope_type, scope_id, valid_until, reason) values (${tenantId}, ${userId}, ${roleId.author!}, 'tenant', null, now() - interval '1 day', 'тест: минув')`
  await admin`insert into user_roles (tenant_id, user_id, role_id, scope_type, scope_id) values (${tenantId}, ${soloId}, ${roleId.employee!}, 'location', ${lazarevaId})`
})

afterAll(async () => {
  await admin`delete from position_role_map where tenant_id = ${tenantId} and position_id in (${posMappedId}, ${posPlainId})`
  await admin`delete from sessions where user_id in (${userId}, ${soloId})`
  await admin`delete from audit_log where tenant_id = ${tenantId} and (entity_id in (${userId}, ${soloId}) or actor_id in (${userId}, ${soloId}))`
  await admin`delete from users where id in (${userId}, ${soloId})`
  await admin`delete from positions where id in (${posMappedId}, ${posPlainId})`
  await admin.end()
})

describe('действующие роли и роль по умолчанию', () => {
  it('истёкшая роль не входит в действующие; по умолчанию — самая широкая (admin → … → employee)', async () => {
    const list = await withTenant(tenantId, adminId, tx => effectiveRoles(tx, userId))
    expect(list.map(r => r.code).sort()).toEqual(['admin', 'employee'])
    expect(defaultRoleOf(list)?.code).toBe('admin')
    // `owner` вклинился после `admin` (docs/01 §1.9.4): по широте рабочего интерфейса, а не по старшинству
    expect([rankRole('admin'), rankRole('owner'), rankRole('author'), rankRole('manager'), rankRole('mentor'), rankRole('custom_x'), rankRole('employee')]).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(defaultRoleOf([])).toBeNull()
  })

  it('вход: сессия получает роль по умолчанию, validateSession отдаёт её', async () => {
    const s = await createSession({ tenantId, userId })
    const a = await validateSession(s.token)
    expect(a?.activeRoleId).toBe(roleId.admin)
    const [row] = await admin`select active_role_id from sessions where id = ${s.sessionId}`
    expect(row!.active_role_id).toBe(roleId.admin)
  })
})

describe('переключение активной роли', () => {
  it('своя действующая роль — ок, права меняются, аудит с обеими ролями и request_context', async () => {
    const s = await createSession({ tenantId, userId })
    const a = (await validateSession(s.token))!
    const before = (await loadAccess(a))!
    expect(before.activeRole?.code).toBe('admin')
    expect(before.roles.map(r => r.code).sort()).toEqual(['admin', 'employee'])
    expect(can(before, 'people.view')).toBe(true)

    const r = await switchRole(a, roleId.employee!)
    expect(r).toMatchObject({ ok: true, changed: true, role: { code: 'employee' } })
    const after = (await loadAccess({ ...a, activeRoleId: roleId.employee! }))!
    expect(after.activeRole?.code).toBe('employee')
    expect(can(after, 'people.view')).toBe(false) // объединение ролей не действует (docs/01 §1.9.2)
    expect(can(after, 'learn.view', { locationId: lazarevaId })).toBe(true)
    expect(can(after, 'learn.view', { locationId: segedskaId })).toBe(false)

    const [audit] = await admin`select before, after, actor_role_id, actor_roles, request_context from audit_log where action = 'role.switch' and entity_id = ${s.sessionId}`
    expect(audit!.before).toMatchObject({ code: 'admin' })
    expect(audit!.after).toMatchObject({ code: 'employee' })
    expect(audit!.actor_role_id).toBe(roleId.admin)
    expect((audit!.actor_roles as string[]).sort()).toEqual(['admin', 'employee'])
    expect('request_context' in audit!).toBe(true) // вне HTTP-запроса контекст null — это норма (docs/28 Паритет 3)

    // та же роль — без изменений и без второй записи
    const again = await switchRole({ ...a, activeRoleId: roleId.employee! }, roleId.employee!)
    expect(again).toMatchObject({ ok: true, changed: false })
    expect((await admin`select count(*)::int as n from audit_log where action = 'role.switch' and entity_id = ${s.sessionId}`)[0]!.n).toBe(1)
  })

  it('чужая, снятая или истёкшая роль — forbidden (403 по docs/04); без сессии (API-токен) — no_session', async () => {
    const s = await createSession({ tenantId, userId })
    const a = (await validateSession(s.token))!
    expect(await switchRole(a, roleId.author!)).toEqual({ ok: false, code: 'forbidden' }) // истёкшая
    expect(await switchRole(a, roleId.mentor!)).toEqual({ ok: false, code: 'forbidden' }) // не выдана
    expect(await switchRole(a, '00000000-0000-0000-0000-000000000000')).toEqual({ ok: false, code: 'forbidden' })
    expect(await switchRole({ ...a, sessionId: 'token:abc' }, roleId.employee!)).toEqual({ ok: false, code: 'no_session' })
    const [row] = await admin`select active_role_id from sessions where id = ${s.sessionId}`
    expect(row!.active_role_id).toBe(roleId.admin)
  })

  it('роль снята после входа — сессия откатывается к роли по умолчанию и это записывается', async () => {
    const s = await createSession({ tenantId, userId })
    await admin`update sessions set active_role_id = ${roleId.author!} where id = ${s.sessionId}` // как будто автор истёк после выбора
    const a = (await validateSession(s.token))!
    expect(a.activeRoleId).toBe(roleId.author)
    const access = (await loadAccess(a))!
    expect(access.activeRole?.code).toBe('admin')
    const [row] = await admin`select active_role_id from sessions where id = ${s.sessionId}`
    expect(row!.active_role_id).toBe(roleId.admin)
    const resolved = await withTenant(tenantId, userId, tx => effectiveRoles(tx, userId).then(list => resolveActiveRole(tx, a, list)))
    expect(resolved?.code).toBe('admin')
  })
})

describe('срок и причина у роли (29 Б.15, docs/16 §6.2)', () => {
  it('назначение с датой и причиной; повторное — редактирование (role.update); снятие — с причиной в аудит', async () => {
    const r1 = await assignRole(ctx(), soloId, { roleCode: 'mentor', scopeType: 'location', scopeId: lazarevaId, validUntil: '2099-12-31', reason: 'заміна на час відпустки' })
    expect(r1).toBeTruthy()
    let rows = await userRoleRows(soloId)
    const mentor = rows.find(r => r.code === 'mentor')!
    expect(mentor.reason).toBe('заміна на час відпустки')
    expect(new Date(mentor.valid_until as string).getUTCFullYear()).toBe(2099)
    expect(mentor.is_org_derived).toBe(false)

    await assignRole(ctx(), soloId, { roleCode: 'mentor', scopeType: 'location', scopeId: lazarevaId, validUntil: null, reason: 'безстроково' })
    rows = await userRoleRows(soloId)
    expect(rows.filter(r => r.code === 'mentor')).toHaveLength(1)
    expect(rows.find(r => r.code === 'mentor')!.valid_until).toBeNull()
    const [upd] = await admin`select before, after from audit_log where action = 'role.update' and entity_id = ${soloId} order by created_at desc limit 1`
    expect(upd!.before).toMatchObject({ roleCode: 'mentor', reason: 'заміна на час відпустки' })
    expect(upd!.after).toMatchObject({ reason: 'безстроково', validUntil: null })

    const rm = await removeRole(ctx(), soloId, 'mentor', 'відпустка закінчилась')
    expect(rm).toEqual({ ok: true })
    const [rev] = await admin`select before, after from audit_log where action = 'role.revoke' and entity_id = ${soloId} order by created_at desc limit 1`
    expect(rev!.after).toEqual({ reason: 'відпустка закінчилась' })
    expect(rev!.before).toMatchObject({ roleCode: 'mentor' })
  })

  it('истёкшая роль не даёт прав; ежедневное снятие удаляет её с событием role.expire', async () => {
    await assignRole(ctx(), soloId, { roleCode: 'author', scopeType: 'tenant', validUntil: '2000-01-01', reason: 'тест' })
    const list = await withTenant(tenantId, adminId, tx => effectiveRoles(tx, soloId))
    expect(list.map(r => r.code)).toEqual(['employee'])
    const n = await expireRoles(tenantId)
    expect(n).toBeGreaterThanOrEqual(1)
    const rows = await userRoleRows(soloId)
    expect(rows.map(r => r.code)).toEqual(['employee'])
    const [ev] = await admin`select before from audit_log where action = 'role.expire' and entity_id = ${soloId} order by created_at desc limit 1`
    expect(ev!.before).toMatchObject({ roleCode: 'author', reason: 'тест' })
  })

  it('за 7 дней до истечения — предупреждение role_expiring, дедуп на день (docs/28 D-002)', async () => {
    await assignRole(ctx(), soloId, { roleCode: 'author', scopeType: 'tenant', validUntil: null, reason: null })
    await admin`update user_roles set valid_until = current_date + 7 where user_id = ${soloId} and role_id = ${roleId.author!}`
    const n = await roleExpiryScan(tenantId)
    expect(n).toBeGreaterThanOrEqual(1)
    const [authorRole] = await admin`select name from roles where id = ${roleId.author!}`
    const rows = await admin`select code, payload from notifications where user_id = ${soloId} and code = 'role_expiring'`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.payload).toMatchObject({ name: authorRole!.name })
    const again = await roleExpiryScan(tenantId) // тот же день — dedupKey совпал, дубля нет
    expect(again).toBe(0)
    await admin`delete from notifications where user_id = ${soloId} and code = 'role_expiring'`
    await removeRole(ctx(), soloId, 'author', 'тест: прибрати')
  })

  it('последний администратор считается только по действующим ролям', async () => {
    expect(await withTenant(tenantId, adminId, tx => isLastAdmin(tx, userId))).toBe(false) // есть ещё админ сида
    await admin`update user_roles set valid_until = now() - interval '1 hour' where user_id = ${userId} and role_id = ${roleId.admin!}`
    const [cnt] = await admin`select count(distinct ur.user_id)::int as n from user_roles ur join roles r on r.id = ur.role_id join users u on u.id = ur.user_id where r.code = 'admin' and ur.scope_type = 'tenant' and (ur.valid_until is null or ur.valid_until > now()) and u.status in ('active','invited') and not u.is_blocked and u.tenant_id = ${tenantId}`
    expect(await withTenant(tenantId, adminId, tx => isLastAdmin(tx, adminId))).toBe((cnt!.n as number) === 1)
    await admin`update user_roles set valid_until = null where user_id = ${userId} and role_id = ${roleId.admin!}`
  })
})

describe('position_role_map — правило «должность → роль»', () => {
  it('PUT карты: неизвестная роль — not_found; карта читается с именами', async () => {
    const bad = await setPositionRoleMap(ctx(), [{ positionId: posMappedId, roleCode: 'nope', scopeType: 'location' }])
    expect(bad).toMatchObject({ ok: false, code: 'not_found' })
    const ok = await setPositionRoleMap(ctx(), [
      { positionId: posMappedId, roleCode: 'mentor', scopeType: 'location' },
      { positionId: posMappedId, roleCode: 'author', scopeType: 'tenant' },
    ])
    expect(ok).toEqual({ ok: true, count: 2 })
    const map = await getPositionRoleMap(ctx())
    const mine = map.filter(m => m.positionId === posMappedId)
    expect(mine.map(m => m.roleCode).sort()).toEqual(['author', 'mentor'])
    expect(mine.find(m => m.roleCode === 'mentor')).toMatchObject({ scopeType: 'location', scopeId: null })
  })

  it('смена должности выдаёт производные роли в области размещения и снимает их при уходе с должности; ручные не трогает', async () => {
    await addPlacement(ctx(), soloId, { locationId: segedskaId, positionId: posMappedId, isPrimary: true })
    let rows = await userRoleRows(soloId)
    const mentor = rows.find(r => r.code === 'mentor')!
    expect(mentor).toBeTruthy()
    expect(mentor.is_org_derived).toBe(true)
    expect(mentor.scope_type).toBe('location')
    expect(mentor.scope_id).toBe(segedskaId) // область — точка размещения
    expect(rows.find(r => r.code === 'author')).toMatchObject({ is_org_derived: true, scope_type: 'tenant', scope_id: null })
    expect(rows.find(r => r.code === 'employee')).toMatchObject({ is_org_derived: false }) // ручная роль не тронута
    const [derive] = await admin`select after from audit_log where action = 'role.derive' and entity_id = ${soloId} order by created_at desc limit 1`
    expect((derive!.after as { granted: string[] }).granted.sort()).toEqual(['author', 'mentor'])

    // Повторное применение без изменений — ничего не делает
    const again = await withTenant(tenantId, adminId, tx => applyPositionRoles(tx, ctx(), soloId))
    expect(again).toEqual({ granted: [], revoked: [] })

    // Должность без правила — производные роли снимаются
    await addPlacement(ctx(), soloId, { locationId: segedskaId, positionId: posPlainId, isPrimary: true })
    rows = await userRoleRows(soloId)
    expect(rows.map(r => r.code)).toEqual(['employee'])
  })

  it('«Перезібрати ролі по мережі» застосовує карту одразу до всіх активних розміщень, не чекаючи зміни посади (D-001)', async () => {
    // Розміщення заведене в обхід сервісу (без autoapply з addPlacement) — саме такий випадок і лікує кнопка
    await admin`update user_placements set is_primary = false where user_id = ${soloId} and is_primary`
    await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary) values (${tenantId}, ${soloId}, ${segedskaId}, ${posMappedId}, true)`
    let rows = await userRoleRows(soloId)
    expect(rows.find(r => r.code === 'mentor')).toBeUndefined()

    const result = await reapplyPositionRolesNetwork(ctx())
    expect(result.users).toBeGreaterThanOrEqual(1)
    expect(result.granted).toBeGreaterThanOrEqual(2)

    rows = await userRoleRows(soloId)
    expect(rows.find(r => r.code === 'mentor')).toMatchObject({ is_org_derived: true, scope_type: 'location', scope_id: segedskaId })
    expect(rows.find(r => r.code === 'author')).toMatchObject({ is_org_derived: true, scope_type: 'tenant' })

    // Повторний виклик — без змін конкретно для цієї людини (правило вже застосоване)
    await reapplyPositionRolesNetwork(ctx())
    const again = await userRoleRows(soloId)
    expect(again.map(r => r.code).sort()).toEqual(['author', 'employee', 'mentor'])
  })
})
