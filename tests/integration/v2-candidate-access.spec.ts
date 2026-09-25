import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cookieOf, makeEvent, type FakeEvent } from './_nitroGlobals'

/**
 * fix-candidate-access — два дефекта, найденные сводной проверкой PR-40 (#144):
 *
 * 1. **`28` §13 к. 7, §7.7: кандидат с закрытым доступом не входит.** Вход запрещён, если
 *    `candidate_state != 'active'` (отказ, архив, самоотвод) или `access_until` раньше сегодняшнего
 *    дня человека; текст — «Термін доступу завершився». Проверяется **каждый путь входа** — код на
 *    телефон, код на почту, выбор пространства, пароль, ссылка-приглашение, Google, кнопка бота:
 *    все сходятся в `createSession()`, но у браузерных путей (Google, бот) отказ — редирект на экран
 *    входа, у приглашения — до того, как ссылка потрачена. Действующие сессии гаснут, как только
 *    кандидат покидает `active` (§4.2) — любым из пяти путей смены состояния. Сотрудник, нанятый из
 *    кандидатов (`kind = 'employee'`), входит как все: правило про кандидата, не про прошлое человека.
 *    Сессии, пережившие такой переход до исправления, закрывает миграция `0098` (данные, не схема).
 * 2. **`28` §13 к. 10, §2: наставнику телефон и почта — `null`, не маска.** Маска — это часть ПД
 *    (код страны, последние цифры, первая буква и домен почты); наставнику не положено никаких.
 *
 * `_nitroGlobals` (статический импорт выше) кладёт автоимпорты Nitro в globalThis до того, как
 * ниже подгружаются сами маршруты: обработчики зовутся в процессе, без сборки приложения.
 */

process.env.OTP_DEBUG = '1'
process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

type Handler = (event: FakeEvent) => Promise<unknown>

const { requestOtp } = await import('../../server/services/otp')
const { createSession, validateSession } = await import('../../server/services/session')
const { CandidateAccessExpiredError, candidateMayEnter } = await import('../../server/services/candidateAccess')
const { archiveCandidate, rejectCandidate, withdrawCandidate, reopenCandidate, hireCandidate, anonymizeCandidate } = await import('../../server/services/candidateHire')
const { moveStatus, viewerOf } = await import('../../server/services/candidates')
const { bulkStatus } = await import('../../server/services/candidateFunnel')
const { candidateAutoArchive } = await import('../../server/services/candidateJobs')
const { createInvitation } = await import('../../server/services/people')
const { hashPassword } = await import('../../server/services/password')
const oauth = await import('../../server/services/oauth')
const { withTenant } = await import('../../server/utils/withTenant')

const otpVerify = (await import('../../server/api/v1/auth/otp/verify.post')).default as unknown as Handler
const tenantSelect = (await import('../../server/api/v1/auth/tenant/select.post')).default as unknown as Handler
const passwordLogin = (await import('../../server/api/v1/auth/password/login.post')).default as unknown as Handler
const inviteAccept = (await import('../../server/api/v1/auth/invite/accept.post')).default as unknown as Handler
const integrationsCallback = (await import('../../server/api/v1/integrations/[provider]/callback.get')).default as unknown as Handler
const tgGo = (await import('../../server/routes/tg/go.get')).default as unknown as Handler
const candidateCard = (await import('../../server/api/v1/candidates/[id]/index.get')).default as unknown as Handler

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const PREFIX = '+38067997'
const MARK = 'FCA'
const SECOND_SLUG = 'v2-cand-access'
const REFUSAL = 'Термін доступу завершився. Зверніться до рекрутера.'
const SESSION_COOKIE = 'lola_sid'
const SIGNIN_EMAIL = 'fca-archived@kappi.test'
const PASSWORD = 'Kandydat-2026'

let tenantId: string
let secondTenantId: string
let adminId: string
let mentorId: string
let locationId: string
let positionId: string
let tz: string
let today: string
let past: string
let hr: ReturnType<typeof viewerOf>
let seq = 0
/** Кого вернёт userinfo Google — меняется по тесту. */
let profileEmail = SIGNIN_EMAIL

const phone = () => `${PREFIX}${String(++seq).padStart(4, '0')}`

/** Кандидат напрямую в БД: сценарию входа важны вид, состояние и срок, а не путь создания. */
async function seedPerson(patch: Record<string, unknown> = {}, inTenant = tenantId): Promise<{ id: string, phone: string }> {
  const p = (patch.phone as string | undefined) ?? phone()
  const [row] = await admin`
    insert into users ${admin({
      tenant_id: inTenant,
      kind: 'candidate',
      candidate_state: 'active',
      candidate_state_at: new Date(),
      full_name: `${MARK} Кандидат ${seq}`,
      phone: p,
      status: 'invited',
      source: 'manual',
      consent_given_at: new Date(),
      consent_expires_at: new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10),
      ...patch,
    })} returning id`
  return { id: row!.id as string, phone: p }
}

async function sessionsOf(userId: string): Promise<{ total: number, live: number }> {
  const [r] = await admin`
    select count(*)::int as total, count(*) filter (where revoked_at is null)::int as live
      from sessions where user_id = ${userId}`
  return { total: Number(r!.total), live: Number(r!.live) }
}

/** Код из OTP_DEBUG — тем же путём, что экран входа: запрос кода → ручка проверки. */
async function codeFor(p: string, ip: string, channel?: 'email'): Promise<string> {
  const res = await requestOtp(p, ip, channel ? { channel } : {})
  if (!res.ok || !res.devCode) throw new Error(`код не выдан для ${p}: ${JSON.stringify(res)}`)
  return res.devCode
}

async function rejectionOf(fn: () => Promise<unknown>): Promise<{ statusCode?: number, data?: { code?: string, message?: string } } | null> {
  try { await fn(); return null }
  catch (err) { return err as { statusCode?: number, data?: { code?: string, message?: string } } }
}

function expectRefusal(err: { statusCode?: number, data?: { code?: string, message?: string } } | null) {
  expect(err, 'вход прошёл, а должен был получить отказ').not.toBeNull()
  expect(err!.statusCode).toBe(403)
  expect(err!.data?.code).toBe('candidate.access_expired')
  expect(err!.data?.message).toBe(REFUSAL)
}

function fakeHttp(url: string): Promise<Response> {
  const json = (o: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } }))
  if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 })
  if (url.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) return json({ email: profileEmail })
  return json({ error: `unknown url ${url}` }, 404)
}

async function cleanup() {
  const ids = (await admin`
    select id from users where (tenant_id in (${tenantId}, ${secondTenantId}) and (phone like ${`${PREFIX}%`} or full_name like ${`${MARK}%`}))
       or lower(email) = ${SIGNIN_EMAIL}`).map(r => r.id as string)
  for (const id of ids) {
    await admin`delete from review_queue_items where user_id = ${id}`
    await admin`delete from workshop_submissions where user_id = ${id}`
    await admin`delete from candidate_scores where candidate_id = ${id}`
    await admin`delete from candidate_comments where candidate_id = ${id}`
    await admin`delete from candidate_status_history where candidate_id = ${id}`
    await admin`delete from employee_lifecycle_state where user_id = ${id}`
    await admin`delete from functional_chiefs where user_id = ${id} or chief_id = ${id}`
    await admin`delete from user_placements where user_id = ${id}`
    await admin`delete from user_roles where user_id = ${id}`
    await admin`delete from notifications where user_id = ${id} or ref_id = ${id}`
    await admin`delete from telegram_tokens where user_id = ${id}`
    await admin`delete from security_log where user_id = ${id}`
    await admin`delete from audit_log where entity_id = ${id}`
    await admin`delete from users where id = ${id}`
  }
  await admin`delete from workshops where tenant_id = ${tenantId} and title like ${`${MARK}%`}`
  await admin`delete from otp_codes where phone like ${`${PREFIX}%`}`
  await admin`delete from rate_limits where key like ${`%${PREFIX}%`} or key like 'otp:ip:10.97.%' or key like ${`%${SIGNIN_EMAIL}%`}`
  await admin`delete from oauth_states where tenant_id = ${tenantId}`
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  mentorId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380670000002'`)[0]!.id as string
  locationId = (await admin`select id from locations where tenant_id = ${tenantId} order by name limit 1`)[0]!.id as string
  positionId = (await admin`select id from positions where tenant_id = ${tenantId} order by name limit 1`)[0]!.id as string
  // Второе пространство: тот же человек бывает кандидатом в одной сети и сотрудником в другой, а
  // вход по паролю здесь включён политикой — в «Каппі» его не трогаем, там живут соседние тесты
  const [second] = await admin`
    insert into tenants (slug, name) values (${SECOND_SLUG}, 'Вхід кандидата: друга мережа')
    on conflict (slug) do update set name = excluded.name, status = 'active' returning id`
  secondTenantId = second!.id as string
  await admin`update tenants set settings = ${admin.json({ policies: { passwords: { loginEnabled: true } } })} where id = ${secondTenantId}`
  tz = (await admin`select timezone from tenants where id = ${tenantId}`)[0]!.timezone as string
  const [d] = await admin`select (now() at time zone ${tz})::date::text as today, ((now() at time zone ${tz})::date - 2)::text as past`
  today = d!.today as string
  past = d!.past as string
  hr = viewerOf({ userId: adminId, tenantId, grants: [{ scopes: ['candidate.view', 'candidate.edit', 'candidate.decide', 'candidate.hire', 'candidate.delete', 'candidate.status.manage'], scopeType: 'tenant', scopeId: null }] })
  process.env.GOOGLE_CLIENT_ID = 'test-client'
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret'
  process.env.APP_URL = 'https://lola.test'
  oauth.setOAuthHttp(fakeHttp)
  await cleanup()
})

afterAll(async () => {
  oauth.setOAuthHttp(null)
  delete process.env.GOOGLE_CLIENT_ID
  delete process.env.GOOGLE_CLIENT_SECRET
  delete process.env.APP_URL
  await cleanup()
  await admin`update tenants set settings = '{}'::jsonb where id = ${secondTenantId}`
  await admin.end()
})

// ── Решение — одно на все пути (§7.7) ─────────────────────────────────────────────────────

describe('право входа кандидата: одно решение в createSession() (§7.7)', () => {
  const METHODS = ['otp_sms', 'otp_telegram', 'otp_email', 'otp', 'password', 'google', 'invite'] as const

  it('отказ, архив, самоотвод и истёкший access_until: ни один способ входа не даёт сессии', async () => {
    const closed = [
      await seedPerson({ candidate_state: 'rejected' }),
      await seedPerson({ candidate_state: 'archived' }),
      await seedPerson({ candidate_state: 'withdrawn' }),
      await seedPerson({ access_until: past }),
    ]
    for (const person of closed) {
      expect(await candidateMayEnter(tenantId, person.id)).toBe(false)
      for (const loginMethod of METHODS) {
        const err = await rejectionOf(() => createSession({ tenantId, userId: person.id, loginMethod }))
        expectRefusal(err)
        expect(err).toBeInstanceOf(CandidateAccessExpiredError)
      }
      expect(await sessionsOf(person.id), 'отказ оставил сессию').toEqual({ total: 0, live: 0 })
    }
  })

  it('открыто: active без срока и со сроком «сегодня» — день включительно', async () => {
    for (const person of [await seedPerson(), await seedPerson({ access_until: today })]) {
      expect(await candidateMayEnter(tenantId, person.id)).toBe(true)
      const s = await createSession({ tenantId, userId: person.id, loginMethod: 'otp_sms' })
      expect(await validateSession(s.token)).not.toBeNull()
    }
  })

  it('«сегодня» — по поясу человека, а не по UTC и не по серверу', async () => {
    // Между UTC+14 и UTC−11 — 25 часов: календарная дата у первого всегда впереди хотя бы на день.
    // Один и тот же `access_until` — «сегодня» для одного и «вчера» для другого.
    const [d] = await admin`select (now() at time zone 'Pacific/Pago_Pago')::date::text as day`
    const west = await seedPerson({ access_until: d!.day, timezone: 'Pacific/Pago_Pago' })
    const east = await seedPerson({ access_until: d!.day, timezone: 'Pacific/Kiritimati' })
    expect(await candidateMayEnter(tenantId, west.id)).toBe(true)
    expect(await candidateMayEnter(tenantId, east.id)).toBe(false)
  })

  it('сотрудник, нанятый из кандидатов, входит — даже со старым access_until в строке (правило про кандидата)', async () => {
    const hired = await seedPerson({
      kind: 'employee', candidate_state: null, candidate_state_at: null, status: 'active',
      converted_from_candidate_at: new Date(), hired_at: past, access_until: past,
    })
    expect(await candidateMayEnter(tenantId, hired.id)).toBe(true)
    // Весь путь по коду — ручкой, как экран входа
    const event = makeEvent({ path: '/api/v1/auth/otp/verify', body: { phone: hired.phone, code: await codeFor(hired.phone, '10.97.0.1') } })
    const body = await otpVerify(event) as { data?: { requiresTenantSelect: boolean } }
    expect(body.data?.requiresTenantSelect).toBe(false)
    expect(cookieOf(event, SESSION_COOKIE), 'нанятому не выдана сессия').toBeTruthy()
    expect((await sessionsOf(hired.id)).live).toBe(1)
  })
})

// ── Каждый путь входа (критерий §13 к. 7) ─────────────────────────────────────────────────

describe('архивный кандидат: отказ на каждом пути входа (к. 7)', () => {
  it('код на телефон: POST /auth/otp/verify → 403 candidate.access_expired, cookie и сессии нет', async () => {
    const person = await seedPerson({ candidate_state: 'archived', status: 'active' })
    const event = makeEvent({ path: '/api/v1/auth/otp/verify', body: { phone: person.phone, code: await codeFor(person.phone, '10.97.0.2') } })
    expectRefusal(await rejectionOf(() => otpVerify(event)))
    expect(cookieOf(event, SESSION_COOKIE)).toBeUndefined()
    expect((await sessionsOf(person.id)).total).toBe(0)
  })

  it('код на почту: тот же отказ — решение после кода, канал доставки его не меняет', async () => {
    const person = await seedPerson({ candidate_state: 'archived', status: 'active', email: `fca-${seq}@kappi.test` })
    const event = makeEvent({ path: '/api/v1/auth/otp/verify', body: { phone: person.phone, code: await codeFor(person.phone, '10.97.0.3', 'email') } })
    expectRefusal(await rejectionOf(() => otpVerify(event)))
    expect(cookieOf(event, SESSION_COOKIE)).toBeUndefined()
    expect((await sessionsOf(person.id)).total).toBe(0)
  })

  it('выбор пространства: там, где человек архивный кандидат, — отказ; там, где он сотрудник, — вход', async () => {
    const person = await seedPerson({ candidate_state: 'archived', status: 'active' })
    const employee = await seedPerson({ phone: person.phone, kind: 'employee', candidate_state: null, candidate_state_at: null, status: 'active', full_name: `${MARK} Співробітник` }, secondTenantId)
    const verify = makeEvent({ path: '/api/v1/auth/otp/verify', body: { phone: person.phone, code: await codeFor(person.phone, '10.97.0.4') } })
    const listed = await otpVerify(verify) as { data: { requiresTenantSelect: boolean, selectToken: string, tenants: { tenantId: string }[] } }
    expect(listed.data.requiresTenantSelect).toBe(true)
    expect(listed.data.tenants.map(t => t.tenantId).sort()).toEqual([tenantId, secondTenantId].sort())

    const asCandidate = makeEvent({ path: '/api/v1/auth/tenant/select', body: { selectToken: listed.data.selectToken, tenantId } })
    expectRefusal(await rejectionOf(() => tenantSelect(asCandidate)))
    expect(cookieOf(asCandidate, SESSION_COOKIE)).toBeUndefined()
    expect((await sessionsOf(person.id)).total).toBe(0)

    const asEmployee = makeEvent({ path: '/api/v1/auth/tenant/select', body: { selectToken: listed.data.selectToken, tenantId: secondTenantId } })
    await tenantSelect(asEmployee)
    expect(cookieOf(asEmployee, SESSION_COOKIE)).toBeTruthy()
    expect((await sessionsOf(employee.id)).live).toBe(1)
  })

  it('пароль: POST /auth/password/login → 403, хотя пара e-mail и пароль верна', async () => {
    const email = `fca-pwd-${seq}@v2-cand-access.test`
    const person = await seedPerson({ candidate_state: 'archived', status: 'active', email, password_hash: await hashPassword(PASSWORD) }, secondTenantId)
    const event = makeEvent({ path: '/api/v1/auth/password/login', body: { email, password: PASSWORD } })
    expectRefusal(await rejectionOf(() => passwordLogin(event)))
    expect(cookieOf(event, SESSION_COOKIE)).toBeUndefined()
    expect((await sessionsOf(person.id)).total).toBe(0)
  })

  it('ссылка-приглашение: 403 до того, как ссылка потрачена, — повторный клик скажет то же самое', async () => {
    const person = await seedPerson({ candidate_state: 'archived' })
    const invite = await createInvitation({ tenantId, actorId: adminId }, person.id)
    expect(invite).not.toBeNull()
    for (let i = 0; i < 2; i++) {
      const event = makeEvent({ path: '/api/v1/auth/invite/accept', body: { token: invite!.token } })
      expectRefusal(await rejectionOf(() => inviteAccept(event)))
      expect(cookieOf(event, SESSION_COOKIE)).toBeUndefined()
    }
    const [inv] = await admin`select accepted_at from invitations where user_id = ${person.id}`
    expect(inv!.accepted_at, 'отказ потратил приглашение').toBeNull()
    expect((await sessionsOf(person.id)).total).toBe(0)
  })

  it('Google: редирект на /login?error=candidate_access_expired, а не JSON ошибки вместо страницы', async () => {
    const person = await seedPerson({ candidate_state: 'archived', status: 'active', email: SIGNIN_EMAIL })
    profileEmail = SIGNIN_EMAIL
    const link = await oauth.authUrl({ tenantId, actorId: null }, 'google', 'signin')
    if ('error' in link) throw new Error('нет ссылки входа Google')
    const state = new URL(link.url).searchParams.get('state')!
    const event = makeEvent({ path: '/api/v1/integrations/google/callback', params: { provider: 'google' }, query: { code: 'good', state } })
    await integrationsCallback(event)
    expect(event._redirect).toBe('/login?error=candidate_access_expired')
    expect(cookieOf(event, SESSION_COOKIE)).toBeUndefined()
    expect((await sessionsOf(person.id)).total).toBe(0)
  })

  it('кнопка бота /tg/go: редирект на экран входа с тем же кодом, сессии нет', async () => {
    const chatId = String(9_700_000_000 + Math.floor(Math.random() * 99_999_999))
    const person = await seedPerson({ candidate_state: 'archived', status: 'active', telegram_chat_id: chatId })
    const event = makeEvent({ path: '/tg/go', query: { c: chatId, to: '/learn' } })
    await tgGo(event)
    expect(event._redirect).toBe('/login?error=candidate_access_expired')
    expect(cookieOf(event, SESSION_COOKIE)).toBeUndefined()
    expect((await sessionsOf(person.id)).total).toBe(0)
  })
})

// ── Действующие сессии гаснут (§4.2) ──────────────────────────────────────────────────────

describe('действующие сессии гаснут, когда кандидат покидает active (§4.2, к. 7)', () => {
  /** Кандидат, уже вошедший в систему: сессия действует, пока его не перевели. */
  async function signedIn(patch: Record<string, unknown> = {}) {
    const [statusNew] = await admin`select id from candidate_statuses where tenant_id = ${tenantId} and code = 'new'`
    const person = await seedPerson({ candidate_status_id: statusNew!.id, recruiter_id: adminId, ...patch })
    const s = await createSession({ tenantId, userId: person.id, loginMethod: 'otp_sms' })
    expect(await validateSession(s.token)).not.toBeNull()
    return { ...person, token: s.token }
  }

  async function expectClosed(person: { id: string, token: string }, state: string) {
    expect(await validateSession(person.token), 'сессия пережила закрытие доступа').toBeNull()
    expect((await sessionsOf(person.id)).live).toBe(0)
    const [log] = await admin`
      select meta from security_log where user_id = ${person.id} and event = 'session.revoked' order by created_at desc limit 1`
    expect(log, 'закрытие сессии не записано в журнал безопасности').toBeDefined()
    expect(log!.meta).toMatchObject({ reason: 'candidate_access', state, closed: 1 })
    expect(await candidateMayEnter(tenantId, person.id)).toBe(false)
  }

  it('архивация вручную', async () => {
    const person = await signedIn()
    expect((await archiveCandidate(hr, person.id, {})).ok).toBe(true)
    await expectClosed(person, 'archived')
  })

  it('отказ', async () => {
    const person = await signedIn()
    expect((await rejectCandidate(hr, person.id, { reasonCode: 'skills', notify: false })).ok).toBe(true)
    await expectClosed(person, 'rejected')
  })

  it('самоотвод', async () => {
    const person = await signedIn()
    expect((await withdrawCandidate(hr, person.id, {})).ok).toBe(true)
    await expectClosed(person, 'withdrawn')
  })

  it('перенос карточки в колонку «Відхилені» на доске', async () => {
    const person = await signedIn()
    const [rejected] = await admin`select id from candidate_statuses where tenant_id = ${tenantId} and code = 'rejected'`
    const res = await moveStatus(hr, person.id, { statusId: rejected!.id as string, reasonText: `${MARK}: не вийшов на звʼязок`, notify: false })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    await expectClosed(person, 'rejected')
  })

  it('массовый перенос в «Відхилені»', async () => {
    const a = await signedIn()
    const b = await signedIn()
    const [rejected] = await admin`select id from candidate_statuses where tenant_id = ${tenantId} and code = 'rejected'`
    const res = await bulkStatus(hr, { ids: [a.id, b.id], statusId: rejected!.id as string, reasonText: `${MARK}: вакансію закрито`, notify: false })
    expect(res.ok && res.changed).toBe(2)
    await expectClosed(a, 'rejected')
    await expectClosed(b, 'rejected')
  })

  it('ночная candidate.auto_archive: сессия, пережившая отказ (открыта до исправления), гаснет вместе с архивом', async () => {
    // Состояние «отказ с живой сессией» — ровно то, что оставил код до этого исправления
    const person = await signedIn()
    await admin`update users set candidate_state = 'rejected', candidate_state_at = now() - interval '400 days' where id = ${person.id}`
    expect(await validateSession(person.token)).not.toBeNull()
    expect(await candidateAutoArchive(tenantId)).toBeGreaterThanOrEqual(1)
    const [row] = await admin`select candidate_state from users where id = ${person.id}`
    expect(row!.candidate_state).toBe('archived')
    await expectClosed(person, 'archived')
  })

  it('стирание ПД по истёкшему согласию', async () => {
    const person = await signedIn()
    expect(await withTenant(tenantId, null, tx => anonymizeCandidate(tx, tenantId, person.id, null, 'consent_expired'))).toBe(true)
    await expectClosed(person, 'archived')
  })

  it('возврат в воронку снова открывает вход', async () => {
    const person = await signedIn()
    expect((await archiveCandidate(hr, person.id, {})).ok).toBe(true)
    expectRefusal(await rejectionOf(() => createSession({ tenantId, userId: person.id, loginMethod: 'otp_sms' })))
    expect((await reopenCandidate(hr, person.id, { reasonText: `${MARK}: повернули у відбір` })).ok).toBe(true)
    expect(await candidateMayEnter(tenantId, person.id)).toBe(true)
    const again = await createSession({ tenantId, userId: person.id, loginMethod: 'otp_sms' })
    expect(await validateSession(again.token)).not.toBeNull()
  })

  it('найм: сессия не гаснет — человек продолжает уже сотрудником, и входит заново', async () => {
    const person = await signedIn()
    const res = await hireCandidate(hr, person.id, { locationId, positionId, startDate: today, onboardingCourseIds: [], welcomeLetter: false })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(await validateSession(person.token), 'найм выкинул нового сотрудника из системы').not.toBeNull()
    const [row] = await admin`select kind, candidate_state from users where id = ${person.id}`
    expect(row).toMatchObject({ kind: 'employee', candidate_state: null })
    const again = await createSession({ tenantId, userId: person.id, loginMethod: 'otp_sms' })
    expect(await validateSession(again.token)).not.toBeNull()
  })

  it('истёкший access_until сессию не гасит (§12.8: доступ проверяется на входе), но новый вход закрыт', async () => {
    const person = await signedIn()
    await admin`update users set access_until = ${past} where id = ${person.id}`
    expect(await validateSession(person.token), 'начатую работу оборвало посреди попытки').not.toBeNull()
    expectRefusal(await rejectionOf(() => createSession({ tenantId, userId: person.id, loginMethod: 'otp_sms' })))
  })
})

// ── Миграция 0098: сессии, пережившие переход до исправления ──────────────────────────────

describe('миграция 0098: сессии, открытые до исправления, у кандидатов вне active закрыты', () => {
  it('закрывает отказанных, архивных и отозвавших себя; активный кандидат и нанятый не тронуты; повтор ничего не меняет', async () => {
    /** Состояние, которое оставил код до исправления: вошёл, пока был активен, потом решение без закрытия сессии. */
    async function legacy(patch: Record<string, unknown>) {
      const person = await seedPerson()
      const s = await createSession({ tenantId, userId: person.id, loginMethod: 'otp_sms' })
      await admin`update users set ${admin(patch)} where id = ${person.id}`
      return { ...person, token: s.token }
    }
    const closed = [
      await legacy({ candidate_state: 'rejected' }),
      await legacy({ candidate_state: 'archived' }),
      await legacy({ candidate_state: 'withdrawn' }),
    ]
    const kept = [
      await legacy({ access_until: past }), // §12.8: срок гасит вход, а не начатую работу
      await legacy({ kind: 'employee', candidate_state: null, converted_from_candidate_at: new Date(), status: 'active' }),
    ]
    for (const p of [...closed, ...kept]) expect(await validateSession(p.token)).not.toBeNull()

    const migration = readFileSync(resolve(__dirname, '../../server/db/migrations/0098_fix_candidate_access.sql'), 'utf8')
    await admin.unsafe(migration)
    for (const p of closed) expect(await validateSession(p.token), `${p.phone}: сессия пережила миграцию`).toBeNull()
    for (const p of kept) expect(await validateSession(p.token), `${p.phone}: миграция закрыла лишнее`).not.toBeNull()

    const before = await admin`select id, revoked_at from sessions where user_id in ${admin(closed.map(p => p.id))} order by id`
    await admin.unsafe(migration)
    const after = await admin`select id, revoked_at from sessions where user_id in ${admin(closed.map(p => p.id))} order by id`
    expect(after).toEqual(before)
  })
})

// ── Наставник: контакты — null (критерий §13 к. 10) ───────────────────────────────────────

describe('наставник: телефон и e-mail кандидата — null в ответе API, не маска (§2, к. 10)', () => {
  it('GET /candidates/:id наставнику с назначенной проверкой: phone и email null, следов маски в ответе нет', async () => {
    const email = `fca-mentor-${seq}@gmail.com`
    const person = await seedPerson({ email, recruiter_id: adminId })
    const [workshop] = await admin`
      insert into workshops (tenant_id, title, description, criteria, status)
      values (${tenantId}, ${`${MARK} тестове завдання`}, '{}'::jsonb, '[]'::jsonb, 'published') returning id`
    const [sub] = await admin`
      insert into workshop_submissions (tenant_id, workshop_id, user_id, criteria_snapshot, status, submitted_at)
      values (${tenantId}, ${workshop!.id}, ${person.id}, '[]'::jsonb, 'in_review', now()) returning id`
    await admin`
      insert into review_queue_items (tenant_id, task_type, source_id, user_id, subject_kind, status, claimed_by, claimed_at)
      values (${tenantId}, 'workshop', ${sub!.id}, ${person.id}, 'candidate', 'in_review', ${mentorId}, now())`

    const event = makeEvent({ path: `/api/v1/candidates/${person.id}`, params: { id: person.id } })
    event.context.auth = { sessionId: 'test', tenantId, userId: mentorId, impersonatedBy: null, activeRoleId: null, previewRoleId: null }
    // Права наставника (`shared/domain/roles.ts`): очередь проверки есть, `candidate.view` нет
    event.context.access = { userId: mentorId, tenantId, grants: [{ scopes: ['review.queue', 'review.grade'], scopeType: 'location', scopeId: locationId }], activeRole: null, roles: [] }
    const body = await candidateCard(event) as { data: { phone: string | null, email: string | null, resumeAssetId: string | null, pdMasked: boolean, comments: unknown[] } }

    expect(body.data.phone, 'телефон ушёл наставнику').toBeNull()
    expect(body.data.email, 'почта ушла наставнику').toBeNull()
    expect(body.data.resumeAssetId).toBeNull()
    expect(body.data.comments).toEqual([])
    expect(body.data.pdMasked).toBe(true)
    // Ни маски, ни её частей: маска телефона начинается с кода страны, маска почты хранит домен
    const raw = JSON.stringify(body)
    expect(raw).not.toContain('**')
    expect(raw).not.toContain('+380')
    expect(raw).not.toContain('gmail.com')
  })
})
