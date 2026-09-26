import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeEvent, type FakeEvent } from './_nitroGlobals'

/**
 * Консоль операторов платформы, первая часть (ops-console-1; docs/25 §7 п. 6–8, решение владельца
 * 26.09.2026):
 *  - отдельный хост `OPS_HOST`: консоль и `/api/v1/platform/*` только на нём, тенантское — только вне
 *    его (404 в обе стороны); cookie оператора на тенантском хосте не читается, тенантская — на хосте консоли;
 *  - роли операторов: право проверяет ручка (`requirePlatform(event, action)`), а не интерфейс;
 *  - второй фактор обязателен: пароль даёт промежуточную сессию, открыт только экран 2FA;
 *  - управление операторами: последний `owner` защищён, себя не меняют; всё — в `platform_audit`.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'
process.env.PLATFORM_DATABASE_URL ??= 'postgres://platform_admin:platform_admin_dev@localhost:5432/lola'

const hostMw = (await import('../../server/middleware/01.host')).default as unknown as (e: FakeEvent) => Promise<unknown>
const sessionMw = (await import('../../server/middleware/01.session')).default as unknown as (e: FakeEvent) => Promise<void>
const { platformLogin, validatePlatformSession, createTenant, updateTenant } = await import('../../server/services/platform')
const TF = await import('../../server/services/platformTwoFactor')
const Ops = await import('../../server/services/platformOperators')
const { listTenantsPage, tenantOverview } = await import('../../server/services/platformConsole')
const { sealHandoff, openHandoff } = await import('../../server/services/impersonationHandoff')
const { totpAt } = await import('../../server/services/totp')
const { requirePlatform } = await import('../../server/utils/platformGuard')
const { hash: argonHash } = await import('@node-rs/argon2')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const OPS_HOST = 'ops.ops1.test'
const PASSWORD = 'ops1-password-123'
const MARK = 'ops1-'
const createdTenants: string[] = []
/** Роли владельцев, которые тест на время понижает, чтобы проверить «последнего владельца» */
let parkedOwners: string[] = []

type Ev = FakeEvent & { method: string, waitUntil: (p: Promise<unknown>) => void }
function ev(path: string, o: { host?: string, ops?: string, sid?: string, method?: string } = {}): Ev {
  const e = makeEvent({ path, headers: o.host ? { host: o.host } : {} }) as Ev
  e.method = o.method ?? 'GET'
  e.waitUntil = (p) => { void p.catch(() => {}) }
  if (o.ops) e._cookies.push({ name: 'lola_ops', value: o.ops })
  if (o.sid) e._cookies.push({ name: 'lola_sid', value: o.sid })
  return e
}
async function thrown(fn: () => unknown): Promise<{ statusCode?: number, data?: { code?: string } } | null> {
  try { await fn(); return null }
  catch (err) { return err as { statusCode?: number, data?: { code?: string } } }
}
function withOpsHost<T>(fn: () => Promise<T>): Promise<T> {
  process.env.OPS_HOST = OPS_HOST
  return fn().finally(() => { delete process.env.OPS_HOST })
}

async function mkOperator(name: string, role: string): Promise<string> {
  const email = `${MARK}${name}@lola.test`
  const [r] = await admin`insert into platform_admins (email, full_name, password_hash, role) values (${email}, ${`ОП ${name}`}, ${await argonHash(PASSWORD)}, ${role})
    on conflict (email) do update set role = excluded.role, is_active = true, totp_confirmed_at = null, totp_secret_encrypted = null, totp_secret_nonce = null returning id`
  return r!.id as string
}
/** Полная сессия: пароль → подключение фактора → первый код */
async function fullSession(name: string): Promise<{ token: string, secret: string }> {
  const email = `${MARK}${name}@lola.test`
  // Фактор — заново при каждом вызове: повторный код того же шага не прошёл бы (`last_used_step`)
  await admin`update platform_admins set totp_confirmed_at = null, totp_secret_encrypted = null, totp_secret_nonce = null, totp_last_used_step = null where email = ${email}`
  const login = await platformLogin(email, PASSWORD)
  const s = (await validatePlatformSession(login!.token))!
  const setup = await TF.startSetup(s, {})
  if (!setup.ok) throw new Error(setup.code)
  const done = await TF.confirmSetup(s, totpAt(setup.secret, Date.now()))
  if (!done.ok || !done.token) throw new Error('confirm')
  return { token: done.token, secret: setup.secret }
}
const auditOf = async (action: string, entityId: string) =>
  (await admin`select count(*)::int as n from platform_audit where action = ${action} and entity_id = ${entityId}`)[0]!.n as number

beforeAll(async () => {
  await admin`delete from rate_limits where key like ${'ops%'}`
})

afterAll(async () => {
  if (parkedOwners.length) await admin`update platform_admins set role = 'owner' where id in ${admin(parkedOwners)}`
  for (const id of createdTenants) {
    await admin`delete from user_placements where tenant_id = ${id}`
    await admin`delete from user_roles where tenant_id = ${id}`
    await admin`update locations set manager_id = null where tenant_id = ${id}`
    await admin`delete from users where tenant_id = ${id}`
    await admin`delete from locations where tenant_id = ${id}`
    await admin`delete from positions where tenant_id = ${id}`
    await admin`delete from org_units where tenant_id = ${id}`
    await admin`delete from roles where tenant_id = ${id}`
    await admin`delete from audit_log where tenant_id = ${id}`
    await admin`delete from tenant_limits where tenant_id = ${id}`
    await admin`delete from limit_notices where tenant_id = ${id}`
    await admin`delete from tenants where id = ${id}`
  }
  await admin`delete from platform_admins where email like ${`${MARK}%`}`
  await admin`delete from rate_limits where key like ${'ops%'} or key like ${'imp:%'}`
  await admin.end()
})

describe('отдельный хост консоли (docs/25 §7 п. 6)', () => {
  it('на хосте консоли тенантские ручки и страницы — 404; корень ведёт в список компаний', () => withOpsHost(async () => {
    for (const path of ['/api/v1/auth/me', '/api/v1/people', '/admin', '/login', '/tg/go', '/c/abc']) {
      const err = await thrown(() => hostMw(ev(path, { host: OPS_HOST })))
      expect(err?.statusCode, path).toBe(404)
    }
    const root = ev('/', { host: `${OPS_HOST}:443` })
    await hostMw(root)
    expect(root._redirect).toBe('/ops/companies')
    for (const path of ['/api/v1/platform/me', '/ops/companies', '/ops', '/_nuxt/app.js', '/health']) {
      const e = ev(path, { host: OPS_HOST.toUpperCase() })
      await hostMw(e)
      expect(e.context.opsHost, path).toBe(true)
    }
  }))

  it('на тенантском хосте консоль и /api/v1/platform/* — 404', () => withOpsHost(async () => {
    for (const host of ['kappi.lmscappi.test', 'lms.lmscappi.test', 'localhost:3000']) {
      for (const path of ['/api/v1/platform/me', '/api/v1/platform/tenants', '/ops', '/ops/login']) {
        const err = await thrown(() => hostMw(ev(path, { host })))
        expect(err?.statusCode, `${host}${path}`).toBe(404)
      }
    }
  }))

  it('без OPS_HOST всё как раньше: /ops и /api/v1/platform на общем хосте', async () => {
    delete process.env.OPS_HOST
    const e = ev('/api/v1/platform/me', { host: 'localhost:3000' })
    await hostMw(e)
    expect(e.context.opsHost).toBeUndefined()
    expect(e._status).toBeNull()
  })

  it('cookie оператора на тенантском хосте не читается; тенантская cookie на хосте консоли — тоже', () => withOpsHost(async () => {
    await mkOperator('host', 'owner')
    const { token } = await fullSession('host')
    // Тенантский хост (01.host не пометил opsHost): платформенная сессия не поднимается
    const onTenant = ev('/api/v1/platform/tenants', { host: 'kappi.lmscappi.test', ops: token })
    await sessionMw(onTenant)
    expect(onTenant.context.platform).toBeUndefined()
    // Хост консоли: поднимается
    const onOps = ev('/api/v1/platform/tenants', { host: OPS_HOST, ops: token })
    onOps.context.opsHost = true
    await sessionMw(onOps)
    expect((onOps.context.platform as { email: string }).email).toBe(`${MARK}host@lola.test`)
    // Тенантская сессия на хосте консоли не читается (и Bearer тоже)
    const tenantPath = ev('/api/v1/auth/me', { host: OPS_HOST, sid: 'any-tenant-session' })
    tenantPath.context.opsHost = true
    await sessionMw(tenantPath)
    expect(tenantPath.context.auth).toBeUndefined()
  }))

  it('вход «від імені» с хоста консоли: ссылка на хост тенанта одноразовая', async () => {
    const h = sealHandoff('session-token-x')
    expect(h).not.toContain('session-token-x')
    expect(await openHandoff(h)).toBe('session-token-x')
    expect(await openHandoff(h)).toBeNull() // второй раз — нет
    expect(await openHandoff(sealHandoff('y', Date.now() - 120_000))).toBeNull() // просрочена
    expect(await openHandoff('garbage.value')).toBeNull()
  })

  it('slug, совпадающий с поддоменом консоли, тенанту не выдаётся', async () => {
    process.env.OPS_HOST = 'ops.lmscappi.test'
    process.env.TENANT_HOST_BASE = 'lmscappi.test'
    try {
      const r = await createTenant({ slug: 'ops', name: 'x', adminPhone: '+380501119901', adminName: 'y' }, { adminId: 'test', email: 'test', fullName: 'test' })
      expect(r).toEqual({ ok: false, code: 'slug_taken' })
    }
    finally {
      delete process.env.OPS_HOST
      delete process.env.TENANT_HOST_BASE
    }
  })
})

describe('второй фактор оператора обязателен (docs/25 §7 п. 8)', () => {
  let secret = ''
  it('пароль даёт промежуточную сессию: открыты только 2FA, me и выход — остальное 401 two_factor_required', async () => {
    await mkOperator('tf', 'owner')
    const login = await platformLogin(`${MARK}tf@lola.test`, PASSWORD)
    expect(login?.twoFactorEnrolled).toBe(false)
    const s = (await validatePlatformSession(login!.token))!
    expect(s.twoFactorPending).toBe(true)
    const [row] = await admin`select expires_at from platform_sessions where id = ${s.sessionId}`
    expect(new Date(row!.expires_at as string).getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000 + 1000)

    const blocked = ev('/api/v1/platform/tenants', { ops: login!.token })
    expect((await thrown(() => sessionMw(blocked)))?.data?.code).toBe('two_factor_required')
    for (const path of ['/api/v1/platform/me', '/api/v1/platform/two-factor', '/api/v1/platform/two-factor/setup', '/api/v1/platform/logout']) {
      const open = ev(path, { ops: login!.token, method: 'POST' })
      await sessionMw(open)
      expect((open.context.platform as { twoFactorPending: boolean }).twoFactorPending, path).toBe(true)
    }
    // Ручка тоже не пустит промежуточную сессию, даже если бы middleware её пропустил
    const e = ev('/api/v1/platform/tenants')
    e.context.platform = s
    expect((await thrown(() => requirePlatform(e as never, 'tenant.read')))?.data?.code).toBe('two_factor_required')

    // Подключение: секрет шифротекстом, коды хешами; вход завершается новым токеном
    const setup = await TF.startSetup(s, {})
    expect(setup.ok).toBe(true)
    if (!setup.ok) return
    secret = setup.secret
    const bad = await TF.confirmSetup(s, '000000')
    expect(bad.ok).toBe(false)
    const done = await TF.confirmSetup(s, totpAt(secret, Date.now()))
    expect(done.ok && done.recoveryCodes.length).toBe(10)
    if (!done.ok) return
    expect(done.token).not.toBe(login!.token)
    expect(await validatePlatformSession(login!.token)).toBeNull()
    const full = (await validatePlatformSession(done.token!))!
    expect(full.twoFactorPending).toBe(false)
    const [a] = await admin`select totp_secret_encrypted from platform_admins where id = ${s.adminId}`
    expect(Buffer.from(a!.totp_secret_encrypted as Buffer).toString()).not.toContain(secret)
    const codes = await admin`select code_hash from platform_admin_recovery_codes where admin_id = ${s.adminId}`
    expect(codes.length).toBe(10)
    expect(codes.every(c => !(done.recoveryCodes as string[]).includes(c.code_hash as string))).toBe(true)
    expect(await auditOf('operator.two_factor_enable', s.adminId)).toBe(1)
    expect(await auditOf('operator.login', s.adminId)).toBe(1)

    // Следующий вход — экран кода; резервный код одноразовый
    const again = await platformLogin(`${MARK}tf@lola.test`, PASSWORD)
    expect(again?.twoFactorEnrolled).toBe(true)
    const s2 = (await validatePlatformSession(again!.token))!
    const byRecovery = await TF.verify(s2, { recoveryCode: done.recoveryCodes[0]! })
    expect(byRecovery.ok).toBe(true)
    const again2 = await platformLogin(`${MARK}tf@lola.test`, PASSWORD)
    const reuse = await TF.verify((await validatePlatformSession(again2!.token))!, { recoveryCode: done.recoveryCodes[0]! })
    expect(reuse.ok).toBe(false)
  })

  it('перебор кода: после пяти неверных — блокировка и отзыв промежуточных сессий', async () => {
    const login = await platformLogin(`${MARK}tf@lola.test`, PASSWORD)
    const s = (await validatePlatformSession(login!.token))!
    let last: Awaited<ReturnType<typeof TF.verify>> | null = null
    for (let i = 0; i < 5; i++) last = await TF.verify(s, { code: '000000' })
    expect(last).toEqual({ ok: false, code: 'blocked' })
    expect(await validatePlatformSession(login!.token)).toBeNull()
    await admin`delete from rate_limits where key like ${`ops2fa:%${s.adminId}`}`
  })
})

describe('роли операторов: право проверяет сервер (docs/25 §7 п. 7)', () => {
  it('ручка отвечает 403 platform.forbidden роли без права и пропускает роль с правом', async () => {
    const suspend = (await import('../../server/api/v1/platform/tenants/[id]/suspend.post')).default as unknown as (e: FakeEvent) => Promise<unknown>
    const purge = (await import('../../server/api/v1/platform/tenants/[id]/purge.post')).default as unknown as (e: FakeEvent) => Promise<unknown>
    const payments = (await import('../../server/api/v1/platform/tenants/[id]/payments.get')).default as unknown as (e: FakeEvent) => Promise<unknown>
    const base = { adminId: '00000000-0000-0000-0000-000000000000', email: 'x', fullName: 'x', sessionId: 'x', twoFactorPending: false, twoFactorEnrolled: true }
    const call = async (role: string, fn: (e: FakeEvent) => Promise<unknown>) => {
      const e = ev('/api/v1/platform/tenants/00000000-0000-0000-0000-000000000000/x', { method: 'POST' })
      e._params = { id: '00000000-0000-0000-0000-000000000000' }
      e._body = {}
      e.context.platform = { ...base, role }
      return thrown(() => fn(e))
    }
    expect((await call('viewer', suspend))?.data?.code).toBe('platform.forbidden')
    expect((await call('support', suspend))?.statusCode).toBe(403)
    expect((await call('billing', suspend))?.statusCode).toBe(403)
    expect((await call('admin', purge))?.data?.code).toBe('platform.forbidden')
    expect((await call('support', payments))?.statusCode).toBe(403)
    // С правом ручка идёт дальше (несуществующий тенант — 404 ответом, не исключением)
    expect(await call('admin', suspend)).toBeNull()
    expect(await call('viewer', payments)).toBeNull()
  })
})

describe('управление операторами (docs/25 §7 п. 7)', () => {
  let ownerId: string
  let ownerSession: Awaited<ReturnType<typeof validatePlatformSession>>

  beforeAll(async () => {
    ownerId = await mkOperator('owner', 'owner')
    const { token } = await fullSession('owner')
    ownerSession = await validatePlatformSession(token)
  })

  it('приглашение: без почты платформы ссылка возвращается владельцу; по ссылке задаётся пароль один раз', async () => {
    delete process.env.SMTP_URL
    const r = await Ops.inviteOperator(ownerSession!, { email: `${MARK}new@lola.test`, fullName: 'Наташа Тест', role: 'support' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.emailSent).toBe(false)
    expect(r.inviteUrl).toMatch(/\/ops\/invite\?t=/)
    expect(await auditOf('operator.invite', r.id)).toBe(1)
    const dup = await Ops.inviteOperator(ownerSession!, { email: `${MARK}new@lola.test`, fullName: 'x', role: 'viewer' })
    expect(dup).toEqual({ ok: false, code: 'email_taken' })
    // До пароля войти нельзя
    expect(await platformLogin(`${MARK}new@lola.test`, PASSWORD)).toBeNull()
    const token = decodeURIComponent(r.inviteUrl!.split('t=')[1]!)
    expect(await Ops.inviteInfo(token)).toEqual({ email: `${MARK}new@lola.test`, fullName: 'Наташа Тест' })
    expect((await Ops.acceptInvite(token, PASSWORD)).ok).toBe(true)
    expect((await Ops.acceptInvite(token, PASSWORD)).ok).toBe(false)
    expect(await auditOf('operator.invite_accept', r.id)).toBe(1)
    const login = await platformLogin(`${MARK}new@lola.test`, PASSWORD)
    expect((await validatePlatformSession(login!.token))?.role).toBe('support')
  })

  it('свою роль менять нельзя; смена роли и деактивация гасят сессии и пишутся в журнал', async () => {
    expect(await Ops.patchOperator(ownerSession!, ownerId, { role: 'viewer' })).toEqual({ ok: false, code: 'self' })
    const id = await mkOperator('victim', 'admin')
    const { token } = await fullSession('victim')
    const r = await Ops.patchOperator(ownerSession!, id, { role: 'billing' })
    expect(r.ok && r.operator.role).toBe('billing')
    expect(await validatePlatformSession(token)).toBeNull()
    expect(await auditOf('operator.role_change', id)).toBe(1)
    const { token: t2 } = await fullSession('victim')
    const off = await Ops.patchOperator(ownerSession!, id, { isActive: false })
    expect(off.ok && off.operator.isActive).toBe(false)
    expect(await validatePlatformSession(t2)).toBeNull()
    expect(await platformLogin(`${MARK}victim@lola.test`, PASSWORD)).toBeNull()
    expect(await auditOf('operator.deactivate', id)).toBe(1)
    await Ops.patchOperator(ownerSession!, id, { isActive: true })
    expect(await auditOf('operator.activate', id)).toBe(1)
  })

  it('последнего активного владельца нельзя понизить или деактивировать', async () => {
    // Остальных владельцев в общей базе теста — на время в admin (вернёт afterAll)
    parkedOwners = (await admin`update platform_admins set role = 'admin' where role = 'owner' and id <> ${ownerId} returning id`).map(r => r.id as string)
    const actor = { adminId: await mkOperator('actor', 'admin'), email: `${MARK}actor@lola.test`, fullName: 'actor' }
    expect(await Ops.patchOperator(actor, ownerId, { role: 'admin' })).toEqual({ ok: false, code: 'last_owner' })
    expect(await Ops.patchOperator(actor, ownerId, { isActive: false })).toEqual({ ok: false, code: 'last_owner' })
    // Второй владелец появился — первого понизить можно
    const second = await mkOperator('owner2', 'owner')
    expect((await Ops.patchOperator(actor, ownerId, { role: 'admin' })).ok).toBe(true)
    expect(await Ops.patchOperator(actor, second, { isActive: false })).toEqual({ ok: false, code: 'last_owner' })
    await admin`update platform_admins set role = 'owner' where id = ${ownerId}`
    await admin`update platform_admins set role = 'owner' where id in ${admin(parkedOwners)}`
    parkedOwners = []
  })

  it('сброс 2FA оператору: только другому, сессии гаснут, в журнал с причиной', async () => {
    const id = await mkOperator('lost', 'viewer')
    const { token } = await fullSession('lost')
    expect(await TF.resetForOperator(ownerSession!, ownerId, 'Сам собі — так не можна')).toEqual({ ok: false, code: 'self' })
    expect((await TF.resetForOperator(ownerSession!, id, 'Втратив телефон і резервні коди')).ok).toBe(true)
    expect(await validatePlatformSession(token)).toBeNull()
    const [a] = await admin`select totp_confirmed_at from platform_admins where id = ${id}`
    expect(a!.totp_confirmed_at).toBeNull()
    const [log] = await admin`select after from platform_audit where action = 'operator.two_factor_reset' and entity_id = ${id}`
    expect((log!.after as { reason: string }).reason).toBe('Втратив телефон і резервні коди')
    const login = await platformLogin(`${MARK}lost@lola.test`, PASSWORD)
    expect(login?.twoFactorEnrolled).toBe(false)
  })

  it('ручка сброса 2FA оператору — только owner', async () => {
    const handler = (await import('../../server/api/v1/platform/operators/[id]/two-factor-reset.post')).default as unknown as (e: FakeEvent) => Promise<unknown>
    const e = ev('/api/v1/platform/operators/x/two-factor-reset', { method: 'POST' })
    e._params = { id: ownerId }
    e._body = { reason: 'Причина достатньої довжини' }
    e.context.platform = { ...ownerSession!, role: 'admin' }
    expect((await thrown(() => handler(e)))?.data?.code).toBe('platform.forbidden')
  })
})

describe('список компаний и обзор карточки (docs/24 §4.1–4.2)', () => {
  it('метки считает сервер; «прострочена оплата» — только с правом на деньги; постранично курсором', async () => {
    const actor = { adminId: '00000000-0000-0000-0000-000000000001', email: 'test', fullName: 'test' }
    const slugs = [0, 1, 2].map(i => `${MARK}${Date.now().toString(36)}${i}`)
    const ids: string[] = []
    for (const [i, slug] of slugs.entries()) {
      const r = await createTenant({ slug, name: `ОпсКонсоль ${i}`, adminPhone: `+38050111990${i + 2}`, adminName: 'Власник' }, actor)
      if (!r.ok) throw new Error(r.code)
      ids.push(r.tenantId)
      createdTenants.push(r.tenantId)
    }
    await admin`update tenants set status = 'suspended' where id = ${ids[0]!}`
    await admin`insert into tenant_limits (tenant_id, status, paid_until) values (${ids[1]!}, 'grace', current_date - 3)
      on conflict (tenant_id) do update set status = 'grace', paid_until = current_date - 3`
    await admin`insert into limit_notices (tenant_id, axis, level, value_at_raise, limit_at_raise) values (${ids[2]!}, 'users_active', 'warn', 9, 10)`

    const all = await listTenantsPage({ q: 'ОпсКонсоль' }, { withBilling: true })
    expect(all.items.map(r => r.id).sort()).toEqual([...ids].sort())
    const byId = Object.fromEntries(all.items.map(r => [r.id, r.flags]))
    expect(byId[ids[0]!]).toEqual(['suspended'])
    expect(byId[ids[1]!]).toEqual(['payment_overdue'])
    expect(byId[ids[2]!]).toEqual(['limit_near'])
    const support = await listTenantsPage({ q: 'ОпсКонсоль' }, { withBilling: false })
    expect(support.items.find(r => r.id === ids[1])!.flags).toEqual([])
    expect((await listTenantsPage({ q: 'ОпсКонсоль', flag: 'limit_near' }, { withBilling: true })).items.map(r => r.id)).toEqual([ids[2]])
    expect((await listTenantsPage({ q: 'ОпсКонсоль', status: 'suspended' }, { withBilling: true })).items.map(r => r.id)).toEqual([ids[0]])

    const p1 = await listTenantsPage({ q: 'ОпсКонсоль', limit: 2 }, { withBilling: true })
    expect(p1.items.length).toBe(2)
    expect(p1.cursor).not.toBeNull()
    const p2 = await listTenantsPage({ q: 'ОпсКонсоль', limit: 2, cursor: p1.cursor! }, { withBilling: true })
    expect(p2.items.length).toBe(1)
    expect(p2.cursor).toBeNull()
    expect(new Set([...p1.items, ...p2.items].map(r => r.id)).size).toBe(3)

    const ov = await tenantOverview(ids[1]!, { withBilling: true })
    expect(ov?.flags).toContain('payment_overdue')
    expect(ov?.subscription?.status).toBe('grace')
    expect(ov?.consumption.some(c => c.axis === 'users_active')).toBe(true)
    const ovSupport = await tenantOverview(ids[1]!, { withBilling: false })
    expect(ovSupport?.subscription).toBeNull()
    expect(ovSupport?.flags).not.toContain('payment_overdue')
    expect(await tenantOverview('00000000-0000-0000-0000-000000000000', { withBilling: true })).toBeNull()
  })
})

describe('карточка компанії, вкладки (ops-console-2, docs/24 §4.2, §4.4–4.5)', () => {
  it('власний домен з PATCH /platform/tenants/:id зʼявляється в tenantOverview() — вкладка «Домен»', async () => {
    const adminId = await mkOperator('domtab', 'owner')
    const actor = { adminId, email: `${MARK}domtab@lola.test`, fullName: 'ОП domtab' }
    const slug = `${MARK}${Date.now().toString(36)}dom`
    const r = await createTenant({ slug, name: 'ОпсКонсоль Домен', adminPhone: '+380501119908', adminName: 'Власник' }, actor)
    if (!r.ok) throw new Error(r.code)
    createdTenants.push(r.tenantId)
    expect((await tenantOverview(r.tenantId, { withBilling: true }))?.tenant.customDomain).toBeNull()
    const upd = await updateTenant(r.tenantId, { customDomain: 'nav.ops-console-2.test' }, actor)
    expect(upd.ok).toBe(true)
    expect((await tenantOverview(r.tenantId, { withBilling: true }))?.tenant.customDomain).toBe('nav.ops-console-2.test')
  })

  it('GET /platform/tenants/:id/lifecycle-stages вимагає tenant.read і повертає можливості етапів — вкладка «Етапи»', async () => {
    const slug = `${MARK}${Date.now().toString(36)}stg`
    const actor = { adminId: '00000000-0000-0000-0000-000000000001', email: 'test', fullName: 'test' }
    const r = await createTenant({ slug, name: 'ОпсКонсоль Етапи', adminPhone: '+380501119909', adminName: 'Власник' }, actor)
    if (!r.ok) throw new Error(r.code)
    createdTenants.push(r.tenantId)
    const handler = (await import('../../server/api/v1/platform/tenants/[id]/lifecycle-stages/index.get')).default as unknown as (e: FakeEvent) => Promise<{ data: { code: string, capabilities: Record<string, boolean> }[] }>
    const base = { adminId: '00000000-0000-0000-0000-000000000000', email: 'x', fullName: 'x', sessionId: 'x', twoFactorPending: false, twoFactorEnrolled: true }
    const e = ev(`/api/v1/platform/tenants/${r.tenantId}/lifecycle-stages`)
    e._params = { id: r.tenantId }
    e.context.platform = { ...base, role: 'viewer' } // читання доступне навіть viewer'у (READ у PLATFORM_MATRIX)
    const res = await handler(e)
    expect(res.data.length).toBeGreaterThan(0)
    expect(res.data.some(s => s.code === 'knowledge' && s.capabilities.ai_generate === true)).toBe(true)
  })
})
