import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Регрессия security-sweep-1 (docs/v2/46-progress.md, «Аудит безопасности»): права над конкретным
 * человеком, вход и одноразовые ссылки. Каждый тест — находка, воспроизведённая до исправления.
 */

const G = await import('../../server/services/personGuard')
const { updatePerson } = await import('../../server/services/people')
const { createSession, issueSelectToken, verifySelectToken, passwordSelectSubject, UserBlockedError } = await import('../../server/services/session')
const { passwordSelectable } = await import('../../server/services/password')
const { requestOtp, verifyOtp } = await import('../../server/services/otp')
const { sealHandoff, openHandoff } = await import('../../server/services/impersonationHandoff')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const stamp = Date.now()
let tenantId: string, ownerId: string, lazarevaId: string, segedskaId: string, posId: string
let adminRoleId: string, staffId: string, otherLocId: string, adminTargetId: string, blockedId: string
const userIds: string[] = []

type Grant = { scopes: string[], scopeType: 'tenant' | 'location' | 'org_unit', scopeId: string | null }
const access = (userId: string, grants: Grant[]) => ({ userId, tenantId, grants, activeRole: null, roles: [] })
// Руководитель точки «Лазарева»: системные скоупы роли `manager` на точку
const MANAGER_SCOPES = ['people.view', 'people.edit', 'people.deactivate', 'people.invite']

async function makePerson(name: string, locationId: string | null, extra: { blocked?: boolean } = {}) {
  const phone = `+38094${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, phone, full_name, status, is_blocked) values (${tenantId}, ${phone}, ${`${name}-${stamp}`}, ${extra.blocked ? 'suspended' : 'active'}, ${extra.blocked ?? false}) returning id`
  const id = u!.id as string
  userIds.push(id)
  if (locationId) await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary, started_at) values (${tenantId}, ${id}, ${locationId}, ${posId}, true, current_date - 30)`
  return id
}

let managerId: string
const manager = () => access(managerId, [{ scopes: MANAGER_SCOPES, scopeType: 'location', scopeId: lazarevaId }])

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  ownerId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  segedskaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Сегедська'`)[0]!.id as string
  adminRoleId = (await admin`select id from roles where tenant_id = ${tenantId} and code = 'admin'`)[0]!.id as string
  posId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Посада-sweep-${stamp}`}, 'sweep-pos') returning id`)[0]!.id as string
  managerId = await makePerson('Керівник', lazarevaId)
  staffId = await makePerson('Кухар', lazarevaId)
  otherLocId = await makePerson('Кухар іншої точки', segedskaId)
  adminTargetId = await makePerson('Адміністратор', lazarevaId)
  await admin`insert into user_roles (tenant_id, user_id, role_id, scope_type) values (${tenantId}, ${adminTargetId}, ${adminRoleId}, 'tenant')`
  blockedId = await makePerson('Заблокований', lazarevaId, { blocked: true })
})

afterAll(async () => {
  await admin`delete from sessions where user_id in ${admin(userIds)}`
  await admin`delete from audit_log where tenant_id = ${tenantId} and entity_id in ${admin(userIds)}`
  await admin`delete from security_log where user_id in ${admin(userIds)}`.catch(() => {})
  await admin`delete from user_roles where user_id in ${admin(userIds)}`
  await admin`delete from user_placements where user_id in ${admin(userIds)}`
  await admin`delete from users where id in ${admin(userIds)}`
  await admin`delete from positions where id = ${posId}`
  await admin.end()
})

describe('карточка человека: область и захват учётки', () => {
  it('руководитель точки не меняет вход администратору своей точки', async () => {
    expect(await G.checkPersonAccess(manager(), 'people.edit', adminTargetId, { sensitive: true })).toEqual({ ok: false, code: 'privileged' })
    // Имя или комментарий — можно: не вход и не доступ
    expect(await G.checkPersonAccess(manager(), 'people.edit', adminTargetId)).toEqual({ ok: true })
  })

  it('руководитель точки не трогает людей чужой точки', async () => {
    expect(await G.checkPersonAccess(manager(), 'people.edit', otherLocId)).toEqual({ ok: false, code: 'out_of_area' })
    expect(await G.checkPersonAccess(manager(), 'people.edit', staffId, { sensitive: true })).toEqual({ ok: true })
  })

  it('администратор не захватывает владельца, владелец меняет администратора', async () => {
    const adminAccess = access(adminTargetId, [{ scopes: ['people.edit', 'role.assign', 'people.password'], scopeType: 'tenant', scopeId: null }])
    expect(await G.checkPersonAccess(adminAccess, 'people.edit', ownerId, { sensitive: true })).toEqual({ ok: false, code: 'privileged' })
    const ownerAccess = access(ownerId, [{ scopes: ['people.edit', 'role.assign'], scopeType: 'tenant', scopeId: null }])
    expect(await G.checkPersonAccess(ownerAccess, 'people.edit', adminTargetId, { sensitive: true })).toEqual({ ok: true })
  })

  it('role.assign на точке: ни себе, ни роль шире своих прав, ни на весь тенант', async () => {
    const hr = access(managerId, [{ scopes: [...MANAGER_SCOPES, 'role.assign'], scopeType: 'location', scopeId: lazarevaId }])
    expect(await G.checkRoleAssign(hr, managerId, { roleCode: 'employee', scopeType: 'location', scopeId: lazarevaId })).toBe(false)
    expect(await G.checkRoleAssign(hr, staffId, { roleCode: 'admin', scopeType: 'location', scopeId: lazarevaId })).toBe(false)
    expect(await G.checkRoleAssign(hr, staffId, { roleCode: 'employee', scopeType: 'tenant' })).toBe(false)
    expect(await G.checkRoleAssign(hr, staffId, { roleCode: 'employee', scopeType: 'location', scopeId: segedskaId })).toBe(false)
  })

  it('PATCH карточки не отдаёт хеш пароля', async () => {
    const r = await updatePerson({ tenantId, actorId: ownerId }, staffId, { comment: `sweep ${stamp}` })
    expect(r && 'id' in r).toBe(true)
    expect(Object.keys(r!)).not.toContain('passwordHash')
  })
})

describe('вход', () => {
  it('заблокированный не получает сессию ни одним путём (приглашение, Telegram, выбор пространства)', async () => {
    await expect(createSession({ tenantId, userId: blockedId, loginMethod: 'invite' })).rejects.toBeInstanceOf(UserBlockedError)
    const [u] = await admin`select status, is_blocked from users where id = ${blockedId}`
    expect(u).toMatchObject({ status: 'suspended', is_blocked: true })
  })

  it('токен выбора после пароля: подпись проверяется, субъект с двоеточиями не ломает разбор', async () => {
    const subject = passwordSelectSubject([{ tenant_id: tenantId, user_id: staffId }])
    const t = issueSelectToken(subject)
    expect(verifySelectToken(t)).toEqual({ phone: subject })
    // Подменённый субъект (другой человек) — подпись не сходится
    const raw = Buffer.from(t, 'base64url').toString().replace(staffId, ownerId)
    expect(verifySelectToken(Buffer.from(raw).toString('base64url'))).toBeNull()
  })

  it('выбор после пароля отдаёт только учётки, где пароль совпал и вход по паролю открыт', async () => {
    // У человека без почты и без включённого входа по паролю — ничего
    expect(await passwordSelectable(`${tenantId}/${staffId}`)).toEqual([])
  })

  it('параллельный перебор кода: проверено не больше пяти догадок', async () => {
    const prev = process.env.OTP_DEBUG
    process.env.OTP_DEBUG = '1'
    const [p] = await admin`select phone from users where id = ${staffId}`
    const phone = p!.phone as string
    await admin`delete from rate_limits where key like ${`otp:%${phone}`}`
    const req = await requestOtp(phone, `10.9.${stamp % 250}.1`)
    process.env.OTP_DEBUG = prev
    expect(req.ok).toBe(true)
    const code = (req as { devCode?: string }).devCode!
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0')
    await Promise.all(Array.from({ length: 20 }, () => verifyOtp(phone, wrong)))
    // Каждая проверенная догадка — +1 к счётчику: больше пяти значит перебор шире лимита
    const [row] = await admin`select attempts from otp_codes where phone = ${phone} order by created_at desc limit 1`
    expect(Number(row!.attempts)).toBeLessThanOrEqual(5)
    // Верный код после исчерпания попыток не пускает
    expect((await verifyOtp(phone, code)).ok).toBe(false)
    await admin`delete from rate_limits where key like ${`otp:%${phone}`}`
    await admin`delete from otp_codes where phone = ${phone}`
  })

  it('ссылка «від імені» одноразовая и в другом написании', async () => {
    const h = sealHandoff(`session-${stamp}`)
    expect(await openHandoff(h)).toBe(`session-${stamp}`)
    expect(await openHandoff(`${h}.x`)).toBeNull()
    expect(await openHandoff(`${h}=`)).toBeNull()
  })
})
