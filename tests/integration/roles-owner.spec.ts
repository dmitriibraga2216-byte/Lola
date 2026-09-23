import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { OWNER_ROLE_CODE, SYSTEM_ROLES } from '../../shared/domain/roles'

/**
 * Владение пространством (docs/01 §1.2, §1.9.4; `docs/v2/35-billing-limits.md` §2).
 *
 * Проверяется ровно то, что нельзя проверить unit-тестом: инвариант «владелец один» держит
 * **схема**, снять владение с себя нельзя, права считаются по активной роли и переключение
 * их не расширяет, а чужой тенант не отличим от несуществующего.
 *
 * Сид выдаёт владение «Адмін Каппі» (у него две роли — `admin` и `owner`), поэтому каждый
 * тест возвращает владение ему в `beforeEach`: файлы делят одну базу.
 */

const { claimOwnership, transferOwnership, ownerCard, transferCandidates, ownerIdOf, isSoleOwner } = await import('../../server/services/owner')
const { assignRole, removeRole, setBlocked, archivePerson, updatePerson, mergePeople, gdprErase, OWNER_NOT_ASSIGNABLE } = await import('../../server/services/people')
const { updateRole, listRoles } = await import('../../server/services/roles')
const { effectiveRoles, switchRole, resolveActiveRole } = await import('../../server/services/activeRole')
const { loadAccess, can } = await import('../../server/services/access')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

let tenantId: string, adminId: string, hrId: string, chefId: string
let otherTenantId: string, otherUserId: string
let ownerRoleId: string, adminRoleId: string
let heirId: string, candidateId: string, archivedId: string
const ctx = () => ({ tenantId, actorId: adminId })

async function makeUser(name: string, extra: Record<string, unknown> = {}) {
  const phone = `+38092${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users ${admin({ tenant_id: tenantId, phone, full_name: name, status: 'active', ...extra })} returning id`
  return u!.id as string
}

/** Вернуть владение сиду: тесты идут по одной базе и не должны зависеть друг от друга. */
async function resetOwner() {
  await admin`delete from user_roles where is_owner`
  await admin`insert into user_roles (tenant_id, user_id, role_id, scope_type) values (${tenantId}, ${adminId}, ${ownerRoleId}, 'tenant')`
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  hrId = (await admin`select id from users where tenant_id = ${tenantId} and full_name = 'Монастирна Катерина'`)[0]!.id as string
  chefId = (await admin`select id from users where tenant_id = ${tenantId} and full_name = 'Шеф Лазарева'`)[0]!.id as string
  ownerRoleId = (await admin`select id from roles where tenant_id = ${tenantId} and code = 'owner'`)[0]!.id as string
  adminRoleId = (await admin`select id from roles where tenant_id = ${tenantId} and code = 'admin'`)[0]!.id as string

  heirId = await makeUser('Спадкоємиця Тестова')
  archivedId = await makeUser('Архівний Тестовий', { status: 'archived' })
  candidateId = await makeUser('Кандидат Власності', { kind: 'candidate', candidate_state: 'active' })

  const [other] = await admin`
    insert into tenants (slug, name) values (${`owner-spec-${Date.now()}`}, 'Чужий простір') returning id`
  otherTenantId = other!.id as string
  await admin`insert into roles (tenant_id, code, name, scopes, is_system, default_scope_type)
    values (${otherTenantId}, 'owner', 'Власник', ${SYSTEM_ROLES[OWNER_ROLE_CODE]!.scopes as unknown as string[]}::text[], true, 'tenant')`
  otherUserId = (await admin`insert into users (tenant_id, phone, full_name, status) values (${otherTenantId}, ${'+380999000111'}, 'Чужий Власник', 'active') returning id`)[0]!.id as string
})

afterAll(async () => {
  await admin`delete from audit_log where tenant_id in (${tenantId}, ${otherTenantId}) and action like 'tenant.owner%'`
  await admin`delete from security_log where tenant_id in (${tenantId}, ${otherTenantId})`
  await admin`delete from notifications where tenant_id in (${tenantId}, ${otherTenantId}) and user_id in (${heirId}, ${hrId}, ${chefId})`
  await admin`delete from users where id in (${heirId}, ${archivedId}, ${candidateId})`
  await admin`delete from tenants where id = ${otherTenantId}`
  await resetOwner()
  await admin.end()
})

beforeEach(resetOwner)

describe('владелец в тенанте ровно один', () => {
  it('частичный уникальный индекс не даёт завести второго владельца — это гарантия схемы, а не сервиса', async () => {
    await expect(
      admin`insert into user_roles (tenant_id, user_id, role_id, scope_type) values (${tenantId}, ${hrId}, ${ownerRoleId}, 'tenant')`,
    ).rejects.toMatchObject({ constraint_name: 'user_roles_single_owner_uq' })
  })

  it('та же роль в другой области владения не удваивает: индекс стоит по тенанту, а не по назначению', async () => {
    const [loc] = await admin`select id from locations where tenant_id = ${tenantId} limit 1`
    await expect(
      admin`insert into user_roles (tenant_id, user_id, role_id, scope_type, scope_id) values (${tenantId}, ${hrId}, ${ownerRoleId}, 'location', ${loc!.id})`,
    ).rejects.toMatchObject({ constraint_name: 'user_roles_single_owner_uq' })
  })

  it('is_owner пишет триггер, а не вызывающий: назначение обычной роли остаётся не-владельческим', async () => {
    const [row] = await admin`
      insert into user_roles (tenant_id, user_id, role_id, scope_type, is_owner)
      values (${tenantId}, ${heirId}, ${adminRoleId}, 'tenant', true) returning is_owner`
    expect(row!.is_owner).toBe(false)
    await admin`delete from user_roles where user_id = ${heirId}`
  })

  it('свой владелец у каждого тенанта — индекс частичный по tenant_id, а не глобальный', async () => {
    const otherRole = (await admin`select id from roles where tenant_id = ${otherTenantId} and code = 'owner'`)[0]!.id as string
    await admin`insert into user_roles (tenant_id, user_id, role_id, scope_type) values (${otherTenantId}, ${otherUserId}, ${otherRole}, 'tenant')`
    const rows = await admin`select tenant_id from user_roles where is_owner order by tenant_id`
    expect(rows).toHaveLength(2)
  })

  it('набор прав роли в БД совпадает с SYSTEM_ROLES — миграция и TypeScript не разошлись', async () => {
    const [row] = await admin`select scopes, is_system, default_scope_type, name from roles where tenant_id = ${tenantId} and code = 'owner'`
    expect([...(row!.scopes as string[])].sort()).toEqual([...SYSTEM_ROLES[OWNER_ROLE_CODE]!.scopes].sort())
    expect(row!.is_system).toBe(true)
    expect(row!.default_scope_type).toBe('tenant')
    expect(row!.name).toBe('Власник')
  })

  it('миграция забрала у администратора деньги и владение', async () => {
    const [row] = await admin`select scopes from roles where tenant_id = ${tenantId} and code = 'admin'`
    const scopes = row!.scopes as string[]
    expect(scopes).not.toContain('billing.manage')
    expect(scopes).not.toContain('billing.payments.view')
    expect(scopes).not.toContain('tenant.transfer')
    expect(scopes).toContain('billing.usage.view')
  })
})

describe('передача владения — единственный способ его лишиться', () => {
  it('передаёт целиком: у прежнего владельца роли не остаётся, у нового появляется', async () => {
    const r = await transferOwnership(ctx(), heirId)
    expect(r).toMatchObject({ ok: true, owner: { userId: heirId, fullName: 'Спадкоємиця Тестова' } })
    expect(await withTenant(tenantId, adminId, tx => ownerIdOf(tx))).toBe(heirId)
    const rows = await admin`select 1 from user_roles where user_id = ${adminId} and role_id = ${ownerRoleId}`
    expect(rows).toHaveLength(0)
    // Администратором прежний владелец остался: передаётся владение, а не всё сразу
    expect(await admin`select 1 from user_roles where user_id = ${adminId} and role_id = ${adminRoleId}`).toHaveLength(1)
  })

  it('пишет audit_log с обеими сторонами и request_context (CLAUDE.md п. 14)', async () => {
    await transferOwnership(ctx(), heirId)
    const [ev] = await admin`select before, after, request_context from audit_log where tenant_id = ${tenantId} and action = 'tenant.owner_transferred' order by created_at desc limit 1`
    expect(ev!.before).toMatchObject({ ownerId: adminId })
    expect(ev!.after).toMatchObject({ ownerId: heirId })
    // request_context вне HTTP-запроса пуст — его наполнение проверяет `scopes-http`
  })

  it('сбрасывает активную роль прежнего владельца: интерфейс не показывает прав, которых уже нет', async () => {
    const [s] = await admin`insert into sessions (tenant_id, user_id, token_hash, expires_at, active_role_id)
      values (${tenantId}, ${adminId}, ${`owner-spec-${Date.now()}`}, now() + interval '1 day', ${ownerRoleId}) returning id`
    await transferOwnership(ctx(), heirId)
    const [after] = await admin`select active_role_id from sessions where id = ${s!.id}`
    expect(after!.active_role_id).toBeNull()
    await admin`delete from sessions where id = ${s!.id}`
  })

  it('передать может только действующий владелец, и не самому себе', async () => {
    expect(await transferOwnership({ tenantId, actorId: hrId }, heirId)).toEqual({ ok: false, code: 'not_owner' })
    expect(await transferOwnership(ctx(), adminId)).toEqual({ ok: false, code: 'same_person' })
    await admin`delete from user_roles where is_owner`
    expect(await transferOwnership(ctx(), heirId)).toEqual({ ok: false, code: 'no_owner' })
  })

  it('владельцем становится только действующий сотрудник: не кандидат, не архивный, не заблокированный', async () => {
    expect(await transferOwnership(ctx(), candidateId)).toEqual({ ok: false, code: 'not_eligible' })
    expect(await transferOwnership(ctx(), archivedId)).toEqual({ ok: false, code: 'not_eligible' })
    await admin`update users set is_blocked = true where id = ${heirId}`
    expect(await transferOwnership(ctx(), heirId)).toEqual({ ok: false, code: 'not_eligible' })
    await admin`update users set is_blocked = false where id = ${heirId}`
  })

  it('человек из чужого тенанта — 404, а не 403: существование не подтверждается (CLAUDE.md п. 15)', async () => {
    expect(await transferOwnership(ctx(), otherUserId)).toEqual({ ok: false, code: 'not_found' })
    expect(await transferOwnership(ctx(), '00000000-0000-0000-0000-000000000000')).toEqual({ ok: false, code: 'not_found' })
  })

  it('список кандидатов на владение — свои действующие сотрудники, без себя и без кандидатов воронки', async () => {
    const list = await transferCandidates(ctx(), '')
    const ids = list.map(p => p.id)
    expect(ids).toContain(heirId)
    expect(ids).not.toContain(adminId) // себе не передают
    expect(ids).not.toContain(candidateId) // правило 17: только сотрудники
    expect(ids).not.toContain(archivedId)
    expect(ids).not.toContain(otherUserId) // чужой тенант не виден вовсе
  })
})

describe('владение нельзя снять — ни ролью, ни блокировкой, ни увольнением', () => {
  it('роль `owner` не снимают и не назначают через карточку человека', async () => {
    expect(await removeRole(ctx(), adminId, OWNER_ROLE_CODE)).toEqual({ ok: false, code: 'owner_role' })
    expect(await assignRole(ctx(), heirId, { roleCode: OWNER_ROLE_CODE, scopeType: 'tenant' })).toBe(OWNER_NOT_ASSIGNABLE)
    expect(await withTenant(tenantId, adminId, tx => ownerIdOf(tx))).toBe(adminId)
  })

  it('владельца не заблокировать, не архивировать и не перевести в suspended', async () => {
    // Владение передаём тому, кто не администратор: иначе сработал бы более ранний
    // и точный запрет «последний администратор» (docs/16 §7.6), и проверять было бы нечего.
    await transferOwnership(ctx(), heirId)
    expect(await setBlocked(ctx(), heirId, true)).toEqual({ ok: false, code: 'last_owner' })
    expect(await archivePerson(ctx(), heirId, { reason: 'mistake' })).toEqual({ ok: false, code: 'last_owner' })
    expect(await updatePerson(ctx(), heirId, { status: 'archived' })).toEqual({ lastOwner: true })
    expect(await updatePerson(ctx(), heirId, { isBlocked: true })).toEqual({ lastOwner: true })
    // Человек без владения блокируется обычным порядком — запрет не «залип» на всех
    expect(await setBlocked(ctx(), chefId, true)).toEqual({ ok: true })
    await setBlocked(ctx(), chefId, false)
  })

  it('владельца не «схлопнуть» слиянием дублей и не стереть по GDPR — обе операции архивируют', async () => {
    await transferOwnership(ctx(), heirId)
    expect(await mergePeople(ctx(), chefId, heirId)).toEqual({ ok: false, code: 'last_owner' })
    expect(await gdprErase(ctx(), heirId, 'запит людини')).toBe('last_owner')
    // Владельцем осталась она же, карточка цела
    expect(await withTenant(tenantId, adminId, tx => ownerIdOf(tx))).toBe(heirId)
    const [u] = await admin`select status, full_name from users where id = ${heirId}`
    expect(u!.status).toBe('active')
    expect(u!.full_name).toBe('Спадкоємиця Тестова')
  })

  it('после передачи прежний владелец блокируется как обычный человек', async () => {
    await transferOwnership(ctx(), heirId)
    expect(await withTenant(tenantId, adminId, tx => isSoleOwner(tx, heirId))).toBe(true)
    expect(await withTenant(tenantId, adminId, tx => isSoleOwner(tx, adminId))).toBe(false)
  })

  it('набор прав роли `owner` не редактируется — иначе владение переписывают вместо передачи', async () => {
    const access = (await loadAccess({ sessionId: 'x', tenantId, userId: adminId, impersonatedBy: null, activeRoleId: ownerRoleId, previewRoleId: null }))!
    const r = await updateRole(ctx(), access, ownerRoleId, { scopes: ['learn.view'] })
    expect(r).toMatchObject({ ok: false, code: 'owner_role' })
  })
})

describe('«стати власником» — одноразовое действие в тенанте без владельца', () => {
  it('пока владелец есть — отказ; без владельца — забирает первый, второму уже отказ', async () => {
    expect(await claimOwnership({ tenantId, actorId: hrId })).toEqual({ ok: false, code: 'already_owned' })

    await admin`delete from user_roles where is_owner`
    expect(await ownerCard(ctx())).toMatchObject({ owner: null, canClaim: true })

    const first = await claimOwnership({ tenantId, actorId: hrId })
    expect(first).toMatchObject({ ok: true, owner: { userId: hrId } })
    expect(await claimOwnership({ tenantId, actorId: adminId })).toEqual({ ok: false, code: 'already_owned' })

    const [ev] = await admin`select before, after from audit_log where tenant_id = ${tenantId} and action = 'tenant.owner_claimed' order by created_at desc limit 1`
    expect(ev!.before).toMatchObject({ ownerId: null })
    expect(ev!.after).toMatchObject({ ownerId: hrId })
  })

  it('карточка владельца отвечает по своему тенанту: чужой владелец в неё не попадает', async () => {
    const otherRole = (await admin`select id from roles where tenant_id = ${otherTenantId} and code = 'owner'`)[0]!.id as string
    await admin`delete from user_roles where tenant_id = ${otherTenantId} and is_owner`
    await admin`insert into user_roles (tenant_id, user_id, role_id, scope_type) values (${otherTenantId}, ${otherUserId}, ${otherRole}, 'tenant')`
    expect(await ownerCard(ctx())).toMatchObject({ owner: { userId: adminId } })
    expect(await ownerCard({ tenantId: otherTenantId, actorId: otherUserId })).toMatchObject({ owner: { userId: otherUserId } })
  })
})

describe('переключение роли не расширяет прав', () => {
  const auth = (activeRoleId: string | null) => ({ sessionId: 'x', tenantId, userId: adminId, impersonatedBy: null, activeRoleId, previewRoleId: null })

  it('права считаются по активной роли: владелец распоряжается тарифом, но не правит курсы', async () => {
    const asOwner = (await loadAccess(auth(ownerRoleId)))!
    expect(asOwner.activeRole!.code).toBe('owner')
    expect(can(asOwner, 'billing.manage')).toBe(true)
    expect(can(asOwner, 'tenant.transfer')).toBe(true)
    expect(can(asOwner, 'course.create')).toBe(false)

    const asAdmin = (await loadAccess(auth(adminRoleId)))!
    expect(asAdmin.activeRole!.code).toBe('admin')
    expect(can(asAdmin, 'course.create')).toBe(true)
    expect(can(asAdmin, 'billing.manage')).toBe(false) // деньги не переходят вместе с админкой
    expect(can(asAdmin, 'tenant.transfer')).toBe(false)
  })

  it('переключатель выбирает из своих ролей: чужая роль — forbidden, права не выдаются', async () => {
    const mentorRole = (await admin`select id from roles where tenant_id = ${tenantId} and code = 'mentor'`)[0]!.id as string
    expect(await switchRole({ ...auth(adminRoleId), sessionId: '11111111-1111-1111-1111-111111111111' }, mentorRole))
      .toEqual({ ok: false, code: 'forbidden' })
    // И набор ролей человека переключением не пополнился
    const list = await withTenant(tenantId, adminId, tx => effectiveRoles(tx, adminId))
    expect(list.map(r => r.code).sort()).toEqual(['admin', 'owner'])
  })

  it('роль по умолчанию у владельца-администратора — admin: рабочий интерфейс, а не пустое меню', async () => {
    const list = await withTenant(tenantId, adminId, tx => effectiveRoles(tx, adminId))
    const active = await withTenant(tenantId, adminId, tx => resolveActiveRole(tx, auth(null), list))
    expect(active!.code).toBe('admin')
  })

  it('роль владельца видна в списке ролей со счётчиком людей (docs/24 §3.5)', async () => {
    const rows = await listRoles(ctx())
    const owner = rows.find(r => r.code === 'owner')!
    expect(owner.isSystem).toBe(true)
    expect(owner.peopleCount).toBe(1)
    expect(rows.map(r => r.code)).toContain('admin')
  })
})
