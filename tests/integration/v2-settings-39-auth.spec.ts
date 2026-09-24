import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { makeEvent, type FakeEvent } from './_nitroGlobals'

/**
 * PR-39 пакета `docs/v2` (`45-plan.md`): вход и Bearer.
 *
 * **Двухфакторный вход TOTP** (docs/24 §3.4 «Двухфакторность для админов», патч П-24.1 —
 * «включение на уровне тенанта»; docs/34 Q-10 — «новый экран входа и промежуточная сессия»):
 * - промежуточная сессия создаётся в единственной точке — `createSession()` — и открывает только
 *   `/auth/two-factor/*` и выход; всё прочее middleware отвечает `401 two_factor_required`;
 * - верный код даёт полную сессию **с новым токеном**; повтор кода и перебор не проходят;
 * - секрет лежит только шифротекстом, резервные коды — только хешами;
 * - «не запереть единственного администратора»: политику включает только тот, у кого фактор
 *   уже есть; потерявшего всё сбрасывают администратор или оператор платформы.
 *
 * **Bearer и `sessionOnly`** (решение `44` В-20; условие выхода PR-39 — «`/platform/*`
 * недоступен по Bearer со `sessionOnly`-скоупом»): скоуп с флагом токену не выдаётся, а у
 * старого токена с таким скоупом право вычёркивается; `/api/v1/platform/*` по Bearer не
 * открывается вовсе — ни с каким скоупом. Чёрного списка путей нет: проверяется право.
 *
 * Все сценарии второго фактора — в отдельном пространстве: политика «2FA для админов»,
 * включённая в общем тенанте «Каппі», заперла бы входы соседних тестов.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const { createSession, validateSession } = await import('../../server/services/session')
const TF = await import('../../server/services/twoFactor')
const { totpAt } = await import('../../server/services/totp')
const { updatePolicies, TwoFactorEnrollFirstError } = await import('../../server/services/settings')
const { createToken, validateBearer } = await import('../../server/services/apiTokens')
const { can, getAccess, requireScope } = await import('../../server/services/access')
const { requirePlatform } = await import('../../server/utils/platformGuard')
const sessionMiddleware = (await import('../../server/middleware/01.session')).default as unknown as (e: FakeEvent) => Promise<void>

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const SLUG = 'v2-39-auth'
const PHONES = ['+380679390001', '+380679390002', '+380679390003']
let tenantId: string
let adminRoleId: string
/** Администратор, второй администратор, рядовой сотрудник */
let adminA: string, adminB: string, worker: string

type Ev = FakeEvent & { method: string, waitUntil: (p: Promise<unknown>) => void }
function ev(path: string, opts: { sid?: string, bearer?: string, method?: string } = {}): Ev {
  const e = makeEvent({ path, headers: opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {} }) as Ev
  e.method = opts.method ?? 'GET'
  e.waitUntil = (p) => { void p.catch(() => {}) }
  if (opts.sid) e._cookies.push({ name: 'lola_sid', value: opts.sid })
  return e
}

async function thrown(fn: () => Promise<unknown>): Promise<{ statusCode?: number, data?: { code?: string } } | null> {
  try { await fn(); return null }
  catch (err) { return err as { statusCode?: number, data?: { code?: string } } }
}

async function cleanup() {
  const ids = (await admin`select id from users where phone in ${admin(PHONES)}`).map(r => r.id as string)
  if (ids.length) {
    await admin`delete from rate_limits where key like any(${ids.map(id => `2fa:%${id}`)})`
    await admin`delete from user_notes where user_id in ${admin(ids)} or author_id in ${admin(ids)}`
    await admin`delete from user_totp_recovery_codes where user_id in ${admin(ids)}`
    await admin`delete from user_totp where user_id in ${admin(ids)}`
    await admin`delete from sessions where user_id in ${admin(ids)}`
    await admin`delete from user_roles where user_id in ${admin(ids)}`
    await admin`delete from security_log where user_id in ${admin(ids)}`
    await admin`delete from audit_log where actor_id in ${admin(ids)} or entity_id in ${admin(ids)}`
    await admin`delete from api_tokens where created_by in ${admin(ids)}`
    await admin`delete from users where id in ${admin(ids)}`
  }
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(clock)
  const [t] = await admin`insert into tenants (slug, name) values (${SLUG}, 'PR-39: вхід') on conflict (slug) do update set name = excluded.name, settings = '{}'::jsonb, status = 'active' returning id`
  tenantId = t!.id as string
  await cleanup()
  const [r] = await admin`
    insert into roles (tenant_id, code, name, scopes, is_system, default_scope_type)
    values (${tenantId}, 'admin', 'Адміністратор', ${['settings.tenant', 'settings.integrations', 'people.view', 'people.password', 'person.note.read', 'candidate.hire', 'learn.view']}, true, 'tenant')
    on conflict (tenant_id, code) do update set scopes = excluded.scopes returning id`
  adminRoleId = r!.id as string
  const mk = async (phone: string, name: string, isAdmin: boolean) => {
    const [u] = await admin`insert into users (tenant_id, phone, full_name, email, status, kind) values (${tenantId}, ${phone}, ${name}, ${`${phone.slice(1)}@v2-39.test`}, 'active', 'employee') returning id`
    if (isAdmin) await admin`insert into user_roles (tenant_id, user_id, role_id, scope_type) values (${tenantId}, ${u!.id}, ${adminRoleId}, 'tenant')`
    return u!.id as string
  }
  adminA = await mk(PHONES[0]!, 'PR-39 Адмін А', true)
  adminB = await mk(PHONES[1]!, 'PR-39 Адмін Б', true)
  worker = await mk(PHONES[2]!, 'PR-39 Кухар', false)
})

afterAll(async () => {
  vi.useRealTimers()
  await cleanup()
  await admin`update tenants set settings = '{}'::jsonb where id = ${tenantId}`
  await admin.end()
})

/**
 * Часы. Принятый код повторно не проходит (`last_used_step`), а окно — ±30 с, поэтому сценарии
 * подряд в одни и те же 30 секунд упёрлись бы в защиту от повтора. Подменяется только `Date`
 * (таймеры драйвера БД — настоящие): каждый шаг сценария — следующие 30 секунд «приложения».
 * Сдвиг за весь файл — пара минут, промежуточные сессии (10 минут) не истекают раньше времени.
 */
let clock = Date.now()
function tick(): void {
  clock += 30_000
  vi.setSystemTime(clock)
}
/** Код приложения «сейчас» — после сдвига часов на следующий шаг. */
function code(secret: string): string {
  tick()
  return totpAt(secret, Date.now())
}

/** Подключить фактор человеку «с экрана»: ключ → код из «приложения» → десять резервных кодов. */
async function enroll(userId: string): Promise<{ secret: string, recoveryCodes: string[] }> {
  const s = await createSession({ tenantId, userId, loginMethod: 'otp_sms' })
  const auth = (await validateSession(s.token))!
  const setup = await TF.startSetup(auth, {})
  if (!setup.ok) throw new Error(`setup: ${setup.code}`)
  const done = await TF.confirmSetup(auth, code(setup.secret))
  if (!done.ok) throw new Error(`confirm: ${done.code}`)
  return { secret: setup.secret, recoveryCodes: done.recoveryCodes }
}

describe('второй фактор: подключение, хранение, промежуточная сессия', () => {
  let secret = ''
  let recovery: string[] = []

  it('подключение: секрет — только шифротекстом, резервные коды — только argon2-хешами', async () => {
    ({ secret, recoveryCodes: recovery } = await enroll(adminA))
    expect(recovery).toHaveLength(10)
    const [row] = await admin`select secret_encrypted, secret_nonce, confirmed_at, pending_secret_encrypted from user_totp where user_id = ${adminA}`
    expect(row!.confirmed_at).not.toBeNull()
    expect(row!.pending_secret_encrypted).toBeNull()
    // В байтах шифротекста нет ни самого ключа Base32, ни его сырых байт
    const cipher = Buffer.from(row!.secret_encrypted as Uint8Array)
    expect(cipher.toString('latin1')).not.toContain(secret)
    expect(cipher.length).toBeGreaterThan(16) // шифротекст + тег GCM
    const codes = await admin`select code_hash from user_totp_recovery_codes where user_id = ${adminA}`
    expect(codes).toHaveLength(10)
    for (const c of codes) expect(String(c.code_hash)).toMatch(/^\$argon2id\$/)
    expect(codes.map(c => String(c.code_hash)).some(h => recovery.some(r => h.includes(r.replace('-', ''))))).toBe(false)
    const [log] = await admin`select severity from security_log where user_id = ${adminA} and event = 'two_factor.enabled'`
    expect(log!.severity).toBe('info')
  })

  it('вход с подключённым фактором — промежуточная сессия на 10 минут, не полная', async () => {
    const s = await createSession({ tenantId, userId: adminA, loginMethod: 'otp_sms' })
    expect(s.twoFactor).toBe('verify')
    expect(s.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000 + 1000)
    const auth = await validateSession(s.token)
    expect(auth?.twoFactorPending).toBe(true)
    // `login.success` ещё не записан — вход не завершён
    const [ok] = await admin`select count(*)::int as n from security_log where user_id = ${adminA} and event = 'login.success'`
    expect(ok!.n).toBe(0)
  })

  it('middleware: промежуточной сессии открыты только /auth/two-factor и выход — остальное 401 two_factor_required', async () => {
    const s = await createSession({ tenantId, userId: adminA, loginMethod: 'password' })
    const me = ev('/api/v1/auth/me', { sid: s.token })
    const err = await thrown(() => sessionMiddleware(me))
    expect(err?.statusCode).toBe(401)
    expect(err?.data?.code).toBe('two_factor_required')
    expect(me.context.auth).toBeUndefined()

    for (const path of ['/api/v1/auth/two-factor', '/api/v1/auth/two-factor/verify', '/api/v1/auth/logout']) {
      const open = ev(path, { sid: s.token, method: 'POST' })
      await sessionMiddleware(open)
      expect((open.context.auth as { twoFactorPending?: boolean })?.twoFactorPending, path).toBe(true)
    }
    // Похожий путь — не лазейка
    const sneaky = ev('/api/v1/auth/two-factor-bypass', { sid: s.token })
    expect((await thrown(() => sessionMiddleware(sneaky)))?.data?.code).toBe('two_factor_required')
    // Не-API путь с промежуточной cookie — просто без сессии
    const page = ev('/ready', { sid: s.token })
    await sessionMiddleware(page)
    expect(page.context.auth).toBeUndefined()
  })

  it('верный код → полная сессия с НОВЫМ токеном; старый токен промежуточной сессии больше не действует', async () => {
    const s = await createSession({ tenantId, userId: adminA, loginMethod: 'otp_sms' })
    const auth = (await validateSession(s.token))!
    const r = await TF.verifyAtLogin(auth, { code: code(secret) })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.proof).toBe('totp')
    expect(r.token).not.toBe(s.token)
    expect(await validateSession(s.token)).toBeNull()
    const full = await validateSession(r.token)
    expect(full?.twoFactorPending).toBe(false)
    expect(full?.sessionId).toBe(auth.sessionId)
    expect(r.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000)
    const [log] = await admin`select meta from security_log where user_id = ${adminA} and event = 'login.success' order by id desc limit 1`
    expect((log!.meta as { twoFactor?: string }).twoFactor).toBe('totp')
    // Полная сессия проходит middleware на любой путь
    const me = ev('/api/v1/auth/me', { sid: r.token })
    await sessionMiddleware(me)
    expect((me.context.auth as { userId: string }).userId).toBe(adminA)
  })

  it('принятый код повторно не проходит (перехват и повтор)', async () => {
    const s1 = await createSession({ tenantId, userId: adminA, loginMethod: 'otp_sms' })
    const once = code(secret)
    const first = await TF.verifyAtLogin((await validateSession(s1.token))!, { code: once })
    expect(first.ok).toBe(true)
    const s2 = await createSession({ tenantId, userId: adminA, loginMethod: 'otp_sms' })
    const replay = await TF.verifyAtLogin((await validateSession(s2.token))!, { code: once })
    expect(replay.ok).toBe(false)
    if (!replay.ok) expect(replay.code).toBe('invalid')
    await admin`delete from rate_limits where key = ${`2fa:fail:${adminA}`}`
  })

  it('резервный код входит один раз и пишет two_factor.recovery_used', async () => {
    const s1 = await createSession({ tenantId, userId: adminA, loginMethod: 'otp_sms' })
    const r1 = await TF.verifyAtLogin((await validateSession(s1.token))!, { recoveryCode: recovery[0]!.toUpperCase().replace('-', ' ') })
    expect(r1.ok).toBe(true)
    if (r1.ok) {
      expect(r1.proof).toBe('recovery')
      expect(r1.recoveryCodesLeft).toBe(9)
    }
    const s2 = await createSession({ tenantId, userId: adminA, loginMethod: 'otp_sms' })
    const r2 = await TF.verifyAtLogin((await validateSession(s2.token))!, { recoveryCode: recovery[0]! })
    expect(r2.ok).toBe(false)
    const [log] = await admin`select severity from security_log where user_id = ${adminA} and event = 'two_factor.recovery_used'`
    expect(log!.severity).toBe('warning')
    await admin`delete from rate_limits where key = ${`2fa:fail:${adminA}`}`
  })

  it('перебор: после лимита попыток — блокировка, промежуточные сессии закрыты, login.blocked', async () => {
    const s = await createSession({ tenantId, userId: adminA, loginMethod: 'otp_sms' })
    const auth = (await validateSession(s.token))!
    const other = await createSession({ tenantId, userId: adminA, loginMethod: 'otp_sms' })
    const results = []
    for (let i = 0; i < 5; i++) results.push(await TF.verifyAtLogin(auth, { code: '000000' }))
    expect(results.slice(0, 4).map(r => !r.ok && r.code)).toEqual(['invalid', 'invalid', 'invalid', 'invalid'])
    const firstFail = results[0]!
    if (!firstFail.ok && firstFail.code === 'invalid') expect(firstFail.attemptsLeft).toBe(4)
    expect(results[4]).toMatchObject({ ok: false, code: 'blocked' })
    expect(await validateSession(other.token).then(a => a)).toBeNull()
    // Даже верный код во время блокировки не проходит
    const s3 = await createSession({ tenantId, userId: adminA, loginMethod: 'otp_sms' })
    const blocked = await TF.verifyAtLogin((await validateSession(s3.token))!, { code: code(secret) })
    expect(!blocked.ok && blocked.code).toBe('blocked')
    const [log] = await admin`select meta from security_log where user_id = ${adminA} and event = 'login.blocked' order by id desc limit 1`
    expect((log!.meta as { method?: string }).method).toBe('two_factor')
    await admin`delete from rate_limits where key like ${`2fa:%${adminA}`}`
  })

  it('замена устройства — только текущим кодом; старый фактор действует, пока новый не подтверждён', async () => {
    const s = await createSession({ tenantId, userId: adminA, loginMethod: 'otp_sms' })
    const r = await TF.verifyAtLogin((await validateSession(s.token))!, { code: code(secret) })
    if (!r.ok) throw new Error(r.code)
    const full = (await validateSession(r.token))!
    const noCode = await TF.startSetup(full, {})
    expect(!noCode.ok && noCode.code).toBe('code_required')
    const setup = await TF.startSetup(full, { code: code(secret) })
    expect(setup.ok).toBe(true)
    if (!setup.ok) return
    // Пока новый не подтверждён — действует старый
    expect(await TF.secondFactorStep(tenantId, adminA)).toBe('verify')
    const done = await TF.confirmSetup(full, code(setup.secret))
    expect(done.ok).toBe(true)
    if (done.ok) {
      expect(done.session).toBeNull() // полная сессия не пересоздаётся
      recovery = done.recoveryCodes
    }
    secret = setup.secret
    // Старые резервные коды погашены: остались ровно новые десять
    const [n] = await admin`select count(*)::int as n from user_totp_recovery_codes where user_id = ${adminA} and used_at is null`
    expect(n!.n).toBe(10)
  })

  it('«от имени»: оператор платформы второй фактор человека не проходит — он вошёл своим входом', async () => {
    // Сессию «от имени» открывает `startImpersonation` своей вставкой — промежуточной она не
    // бывает по построению (`two_factor_pending` по умолчанию false); точка решения в
    // `createSession` тоже пропускает метод `impersonation`
    const s = await createSession({ tenantId, userId: adminA, loginMethod: 'impersonation' })
    expect(s.twoFactor).toBeNull()
    expect((await validateSession(s.token))?.twoFactorPending).toBe(false)
  })

  it('«від імені» не управляет чужим фактором: /auth/two-factor и /people/:id/two-factor запрещены', async () => {
    const { forbiddenFor } = await import('../../server/services/impersonation')
    expect(forbiddenFor('POST', '/api/v1/auth/two-factor/setup')).toBe('secrets')
    expect(forbiddenFor('DELETE', '/api/v1/auth/two-factor')).toBe('secrets')
    expect(forbiddenFor('DELETE', `/api/v1/people/${worker}/two-factor`)).toBe('secrets')
    expect(forbiddenFor('GET', '/api/v1/auth/two-factor')).toBeNull()
  })

  it('отключить свой фактор — только с кодом', async () => {
    const s = await createSession({ tenantId, userId: adminB, loginMethod: 'otp_sms' })
    expect(s.twoFactor).toBeNull() // у Б фактора нет, политика выключена
    const auth = (await validateSession(s.token))!
    expect(await TF.disableOwn(auth, { code: '123456' })).toEqual({ ok: false, code: 'not_enrolled' })
  })
})

describe('политика «двухфакторность для админов» не запирает администратора', () => {
  let secretB = ''
  it('включить может только тот, у кого фактор уже подключён — иначе 422 two_factor_enroll_first', async () => {
    const err = await thrown(() => updatePolicies({ tenantId, actorId: adminB }, { passwords: { adminTwoFactor: true } }))
    expect(err).toBeInstanceOf(TwoFactorEnrollFirstError)
    expect(err?.statusCode).toBe(422)
    expect(err?.data?.code).toBe('two_factor_enroll_first')
    const [t] = await admin`select settings from tenants where id = ${tenantId}`
    expect(((t!.settings as { policies?: { passwords?: { adminTwoFactor?: boolean } } }).policies?.passwords?.adminTwoFactor) ?? false).toBe(false)

    const policies = await updatePolicies({ tenantId, actorId: adminA }, { passwords: { adminTwoFactor: true } })
    expect(policies.passwords.adminTwoFactor).toBe(true)
  })

  it('администратор без фактора при входе получает шаг «подключить», сотрудник — обычный вход', async () => {
    expect(await TF.secondFactorStep(tenantId, adminB)).toBe('enroll')
    expect(await TF.secondFactorStep(tenantId, worker)).toBeNull()
    const s = await createSession({ tenantId, userId: worker, loginMethod: 'otp_sms' })
    expect(s.twoFactor).toBeNull()
  })

  it('подключение прямо на экране входа завершает вход: промежуточная `enroll` → полная сессия', async () => {
    const s = await createSession({ tenantId, userId: adminB, loginMethod: 'otp_sms' })
    expect(s.twoFactor).toBe('enroll')
    const auth = (await validateSession(s.token))!
    // Код вместо подключения в промежуточной `enroll` не принять: фактора ещё нет
    expect(await TF.verifyAtLogin(auth, { code: '123456' })).toEqual({ ok: false, code: 'not_enrolled' })
    const setup = await TF.startSetup(auth, {})
    if (!setup.ok) throw new Error(setup.code)
    secretB = setup.secret
    const done = await TF.confirmSetup(auth, code(setup.secret))
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(done.session).not.toBeNull()
    expect(await validateSession(s.token)).toBeNull()
    expect((await validateSession(done.session!.token))?.twoFactorPending).toBe(false)
  })

  it('отключить фактор, которого требует политика, нельзя — только заменить', async () => {
    const s = await createSession({ tenantId, userId: adminB, loginMethod: 'otp_sms' })
    expect(s.twoFactor).toBe('verify')
    const pending = (await validateSession(s.token))!
    expect(await TF.twoFactorStatus(pending)).toMatchObject({ step: 'verify', enrolled: true, required: true, recoveryCodesLeft: 10 })
    // Промежуточная сессия не заменяет фактор — сначала код
    expect(await TF.startSetup(pending, {})).toEqual({ ok: false, code: 'verify_first' })
    const r = await TF.verifyAtLogin(pending, { code: code(secretB) })
    if (!r.ok) throw new Error(r.code)
    const full = (await validateSession(r.token))!
    expect(await TF.disableOwn(full, { code: code(secretB) })).toEqual({ ok: false, code: 'required_by_policy' })
    expect((await admin`select 1 from user_totp where user_id = ${adminB} and confirmed_at is not null`).length).toBe(1)
  })

  it('обзор для блока настроек: кто из администраторов подключил фактор', async () => {
    const o = await TF.twoFactorOverview({ tenantId, actorId: adminA })
    expect(o.required).toBe(true)
    const byId = new Map(o.admins.map(a => [a.userId, a]))
    expect(byId.get(adminA)?.enrolled).toBe(true)
    expect(byId.get(adminB)?.enrolled).toBe(true)
    expect(byId.has(worker)).toBe(false)
  })

  it('сброс администратором: не себе; другому — фактор снят, сессии закрыты, two_factor.reset (critical)', async () => {
    expect(await TF.resetByAdmin({ tenantId, actorId: adminA }, adminA)).toEqual({ ok: false, code: 'self' })
    expect(await TF.resetByAdmin({ tenantId, actorId: adminA }, '00000000-0000-0000-0000-000000000000')).toEqual({ ok: false, code: 'not_found' })
    expect(await TF.resetByAdmin({ tenantId, actorId: adminA }, 'не-uuid')).toEqual({ ok: false, code: 'not_found' })
    expect(await TF.resetByPlatform('не-uuid', adminB, 'Помилковий шлях, перевірка', { adminId: 'ops', email: 'ops@lola.local' })).toEqual({ ok: false, code: 'not_found' })
    const live = await createSession({ tenantId, userId: adminB, loginMethod: 'otp_sms' })
    expect(await TF.resetByAdmin({ tenantId, actorId: adminA }, adminB)).toEqual({ ok: true })
    expect(await validateSession(live.token)).toBeNull()
    expect((await admin`select 1 from user_totp where user_id = ${adminB}`).length).toBe(0)
    expect((await admin`select 1 from user_totp_recovery_codes where user_id = ${adminB}`).length).toBe(0)
    const [log] = await admin`select severity, meta from security_log where user_id = ${adminB} and event = 'two_factor.reset' order by id desc limit 1`
    expect(log!.severity).toBe('critical')
    expect((log!.meta as { by?: string }).by).toBe('admin')
    const [audit] = await admin`select 1 from audit_log where entity_id = ${adminB} and action = 'two_factor.reset'`
    expect(audit).toBeDefined()
    // Политика включена — после сброса человек подключает фактор заново на экране входа
    expect(await TF.secondFactorStep(tenantId, adminB)).toBe('enroll')
  })

  it('последний рубеж — оператор платформы: причина в журнале безопасности тенанта', async () => {
    const r = await TF.resetByPlatform(tenantId, adminA, 'Втрачено телефон і резервні коди, заявка #42', { adminId: 'ops', email: 'ops@lola.local' })
    expect(r).toEqual({ ok: true })
    const [log] = await admin`select severity, meta from security_log where user_id = ${adminA} and event = 'two_factor.reset' order by id desc limit 1`
    expect(log!.severity).toBe('critical')
    expect(log!.meta).toMatchObject({ by: 'platform', operator: 'ops@lola.local', reason: 'Втрачено телефон і резервні коди, заявка #42' })
    expect(await TF.secondFactorStep(tenantId, adminA)).toBe('enroll')
    // Чужой тенант — не найдено (оператор ошибся пространством)
    const other = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
    expect(await TF.resetByPlatform(other, adminB, 'Помилковий простір, перевірка', { adminId: 'ops', email: 'ops@lola.local' })).toEqual({ ok: false, code: 'not_found' })
  })

  it('выключить политику можно всегда — критичная смена настроек безопасности', async () => {
    const p = await updatePolicies({ tenantId, actorId: adminA }, { passwords: { adminTwoFactor: false } })
    expect(p.passwords.adminTwoFactor).toBe(false)
    expect(await TF.secondFactorStep(tenantId, adminA)).toBeNull()
  })
})

describe('Bearer: флаг sessionOnly на скоупе (docs/v2/44 В-20)', () => {
  it('скоуп с флагом токену не выдаётся — scope_not_tokenable, запись не создана', async () => {
    const r = await createToken({ tenantId, actorId: adminA }, { name: 'PR-39 нотатки', scopes: ['people.view', 'person.note.read'] })
    expect(r).toEqual({ ok: false, code: 'scope_not_tokenable', scopes: ['person.note.read'] })
    expect((await admin`select 1 from api_tokens where tenant_id = ${tenantId} and name = 'PR-39 нотатки'`).length).toBe(0)
  })

  it('чужое право токену не выдаётся — scope_not_held (нельзя выдать себе скоуп, которого у тебя нет)', async () => {
    const r = await createToken({ tenantId, actorId: adminA }, { name: 'PR-39 гроші', scopes: ['people.view', 'billing.manage'] }, s => s === 'people.view')
    expect(r).toEqual({ ok: false, code: 'scope_not_held', scopes: ['billing.manage'] })
  })

  it('старый токен со скоупом sessionOnly: право вычёркивается — 403, остальные скоупы работают', async () => {
    const raw = `lola_pr39_${Date.now()}`
    const { createHash } = await import('node:crypto')
    await admin`insert into api_tokens (tenant_id, name, token_hash, prefix, scopes, created_by)
      values (${tenantId}, 'PR-39 старий', ${createHash('sha256').update(raw).digest('hex')}, ${raw.slice(0, 12)}, ${['people.view', 'candidate.hire', 'people.password']}, ${adminA})`
    const e = ev('/api/v1/candidates/x/hire', { bearer: raw, method: 'POST' })
    await sessionMiddleware(e)
    expect(e.context.tokenScopes).toEqual(['people.view', 'candidate.hire', 'people.password'])
    const access = (await getAccess(e as never))!
    expect(can(access, 'people.view')).toBe(true)
    expect(can(access, 'candidate.hire')).toBe(false)
    expect(can(access, 'people.password')).toBe(false)
    const err = await thrown(() => requireScope(e as never, 'candidate.hire'))
    expect(err?.statusCode).toBe(403)
    expect(err?.data?.code).toBe('forbidden')
    await expect(requireScope(e as never, 'people.view')).resolves.toBeTruthy()
  })

  it('/api/v1/platform/* по Bearer недоступен — даже токеном со sessionOnly-скоупами: ни контекста тенанта, ни оператора', async () => {
    const raw = `lola_pr39p_${Date.now()}`
    const { createHash } = await import('node:crypto')
    await admin`insert into api_tokens (tenant_id, name, token_hash, prefix, scopes, created_by)
      values (${tenantId}, 'PR-39 платформа', ${createHash('sha256').update(raw).digest('hex')}, ${raw.slice(0, 12)}, ${['settings.tenant', 'tenant.transfer', 'people.password']}, ${adminA})`
    expect((await validateBearer(raw)).ok).toBe(true) // токен сам по себе действителен
    for (const [method, path] of [['GET', '/api/v1/platform/tenants'], ['POST', `/api/v1/platform/tenants/${tenantId}/users/${adminA}/two-factor-reset`], ['POST', '/api/v1/platform/announcements']] as const) {
      const e = ev(path, { bearer: raw, method })
      await sessionMiddleware(e)
      expect(e.context.auth, path).toBeUndefined()
      expect(e.context.tokenScopes, path).toBeUndefined()
      expect(e.context.platform, path).toBeUndefined()
      const err = await thrown(async () => requirePlatform(e as never))
      expect(err?.statusCode, path).toBe(401)
    }
  })

  it('заметки о людях по Bearer закрыты целиком: и чужие (скоуп вычеркнут), и «свои открытые» создателя токена', async () => {
    const { listPersonNotes, noteViewerOf } = await import('../../server/services/personNotes')
    await admin`insert into user_notes (tenant_id, user_id, author_id, body, visibility) values (${tenantId}, ${adminA}, ${adminB}, 'PR-39: відкрита людині нотатка', 'shared_with_person')`
    // Человек в своей сессии свою открытую заметку видит (docs/v2/38 §7.4)
    const person = { userId: adminA, tenantId, grants: [], activeRole: null, roles: [] }
    const own = await listPersonNotes({ tenantId, actorId: adminA }, await noteViewerOf(person), adminA)
    expect(own.ok && own.items.length).toBe(1)
    // Токен, выпущенный этим человеком, — нет: заметки о людях только в сессии (В-20)
    const raw = `lola_pr39n_${Date.now()}`
    const { createHash } = await import('node:crypto')
    await admin`insert into api_tokens (tenant_id, name, token_hash, prefix, scopes, created_by)
      values (${tenantId}, 'PR-39 нотатки', ${createHash('sha256').update(raw).digest('hex')}, ${raw.slice(0, 12)}, ${['people.view', 'person.note.read']}, ${adminA})`
    const e = ev(`/api/v1/people/${adminA}/notes`, { bearer: raw })
    await sessionMiddleware(e)
    const viaToken = (await getAccess(e as never))!
    expect(viaToken.viaToken).toBe(true)
    expect(await listPersonNotes({ tenantId, actorId: adminA }, await noteViewerOf(viaToken), adminA)).toEqual({ ok: false, code: 'forbidden' })
    expect(await listPersonNotes({ tenantId, actorId: adminA }, await noteViewerOf(viaToken), adminB)).toEqual({ ok: false, code: 'forbidden' })
  })

  it('ручки второго фактора по Bearer не открываются: у токена нет человека за экраном', async () => {
    const { sessionAuth } = await import('../../server/utils/sessionAuth')
    const raw = `lola_pr39t_${Date.now()}`
    const { createHash } = await import('node:crypto')
    await admin`insert into api_tokens (tenant_id, name, token_hash, prefix, scopes, created_by)
      values (${tenantId}, 'PR-39 2fa', ${createHash('sha256').update(raw).digest('hex')}, ${raw.slice(0, 12)}, ${['people.view']}, ${adminA})`
    const e = ev('/api/v1/auth/two-factor', { bearer: raw })
    await sessionMiddleware(e)
    const err = await thrown(async () => sessionAuth(e as never, { allowPending: true }))
    expect(err?.statusCode).toBe(401)
    expect(err?.data?.code).toBe('auth_required')
  })
})
