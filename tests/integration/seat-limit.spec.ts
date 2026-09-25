import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeEvent, type FakeEvent } from './_nitroGlobals'

/**
 * fix-seat-limit (сводная проверка PR-40, #144): лимит активных сотрудников обходился.
 *
 * Было: разблокировка не проверяла лимит (заблокировал 50-го, добавил нового, разблокировал
 * старого — 51 при лимите 50); найм кандидата проверял его отдельным подключением **до**
 * транзакции (два найма на последнее место проходили оба); `POST /people` при сбое самой
 * проверки считал «можно»; восстановление из архива, повторный найм, приглашение, импорт и
 * первый вход приглашённого не проверяли места вовсе.
 *
 * Стало: каждый путь, добавляющий активного сотрудника, зовёт `assertSeatsWithinLimit()`
 * (`server/services/tenantLimits.ts`, решение — `checkLimit()`) в транзакции самой операции.
 * Здесь — `docs/v2/35` §13 к. 1 и §12 на отдельном тенанте с лимитом N:
 *   · каждый путь при N активных — отказ `409 limit_exceeded` (ось `users_active`) и ничего не
 *     изменилось; при N−1 — проходит;
 *   · гонка за последнее место — проходит ровно одна операция;
 *   · сбой проверки — отказ `503 limit.check_failed`, а не пропуск.
 */

process.env.PLATFORM_DATABASE_URL ??= 'postgres://platform_admin:platform_admin_dev@localhost:5432/lola'
process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

// Автоимпорты Nitro, которых нет в `_nitroGlobals`: тело запроса и статус ответа ручки
const g = globalThis as unknown as Record<string, unknown>
g.readBody = async (event: FakeEvent & { _body?: unknown }) => event._body
g.setResponseStatus = (event: FakeEvent, status: number) => { event._status = status }

const { createTenant, ensureFirstAdmin, platformLogin, validatePlatformSession } = await import('../../server/services/platform')
const { purgeTenantData } = await import('../../server/services/platformTenants')
const P = await import('../../server/services/people')
const { hire: rehire } = await import('../../server/services/offboarding')
const { hireCandidate } = await import('../../server/services/candidateHire')
const { viewerOf } = await import('../../server/services/candidates')
const { validateImport, applyImport, getImportJob } = await import('../../server/services/importPeople')
const { createSession } = await import('../../server/services/session')
const { invalidateLimits, LimitExceededError, LimitCheckFailedError } = await import('../../server/services/tenantLimits')
const errorHandler = (await import('../../server/error')).default as unknown as (error: unknown, event: unknown) => void
type Handler = (event: FakeEvent) => Promise<unknown>
const postPeople = (await import('../../server/api/v1/people/index.post')).default as unknown as Handler
const acceptInvite = (await import('../../server/api/v1/auth/invite/accept.post')).default as unknown as Handler

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 3, onnotice: () => {} })

const OPS_EMAIL = 'ops-seat-limit@lola.local'
const OPS_PASSWORD = 'test-password-123'
const stamp = Date.now().toString(36)
/** Лимит мест тестового тенанта. Администратор — одно из них. */
const N = 3

let tenantId: string
let adminId: string
let locationId: string
let positionId: string
let opsAuth: NonNullable<Awaited<ReturnType<typeof validatePlatformSession>>>
const ctx = () => ({ tenantId, actorId: adminId })
const hr = () => viewerOf({ userId: adminId, tenantId, grants: [{ scopes: ['candidate.view', 'candidate.edit', 'candidate.hire'], scopeType: 'tenant', scopeId: null }] })

let seq = 0
const phone = () => `+38050${String(7_000_000 + seq++).padStart(7, '0')}`

async function person(status: 'active' | 'invited' | 'suspended' | 'archived', opts: { blocked?: boolean } = {}): Promise<string> {
  const [row] = await admin`
    insert into users (tenant_id, kind, full_name, phone, status, is_blocked, archived_at)
    values (${tenantId}, 'employee', ${`Місце ${seq}`}, ${phone()}, ${status}, ${opts.blocked ?? false}, ${status === 'archived' ? new Date() : null})
    returning id`
  return row!.id as string
}

async function candidate(): Promise<string> {
  const [st] = await admin`select id from candidate_statuses where tenant_id = ${tenantId} and code = 'new'`
  const [row] = await admin`
    insert into users (tenant_id, kind, candidate_state, candidate_state_at, candidate_status_id, full_name, phone, status, source,
                       consent_given_at, consent_expires_at)
    values (${tenantId}, 'candidate', 'active', now(), ${st!.id}, ${`Кандидат ${seq}`}, ${phone()}, 'invited', 'manual',
            now(), current_date + 180)
    returning id`
  return row!.id as string
}

async function activeSeats(): Promise<number> {
  const [r] = await admin`select count(*)::int as n from users where tenant_id = ${tenantId} and kind = 'employee' and status = 'active' and not is_blocked`
  return r!.n as number
}

/** Ровно `n` занятых мест: администратор плюс заполнители, лишние занятые — в архив. */
async function seats(n: number): Promise<void> {
  await admin`update users set status = 'archived', archived_at = now() where tenant_id = ${tenantId} and kind = 'employee' and status = 'active' and not is_blocked and id <> ${adminId}`
  for (let i = 1; i < n; i++) await person('active')
  expect(await activeSeats()).toBe(n)
}

async function statusOf(id: string) {
  const [r] = await admin`select kind, status, is_blocked, candidate_state, access_until from users where id = ${id}`
  return r!
}

/** Отказ по местам: единый `409 limit_exceeded` с осью, фактом и лимитом (`35` §10). */
function expectSeatRefusal(err: unknown, used = N) {
  expect(err, 'ожидался отказ по лимиту мест').toBeInstanceOf(LimitExceededError)
  const e = err as InstanceType<typeof LimitExceededError>
  expect(e.statusCode).toBe(409)
  expect(e.data).toMatchObject({ code: 'limit_exceeded', details: { axis: 'users_active', used, limit: N } })
  expect(e.message.length, 'текст отказа объясняет, что делать').toBeGreaterThan(40)
}

async function refusal(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  }
  catch (err) {
    return err
  }
  throw new Error('операция прошла, хотя мест нет')
}

beforeAll(async () => {
  process.env.PLATFORM_ADMIN_EMAIL = OPS_EMAIL
  process.env.PLATFORM_ADMIN_PASSWORD = OPS_PASSWORD
  await admin`delete from platform_admins where email = ${OPS_EMAIL}`
  await ensureFirstAdmin()
  opsAuth = (await validatePlatformSession((await platformLogin(OPS_EMAIL, OPS_PASSWORD))!.token))!
  const r = await createTenant({ slug: `seats-${stamp}`, name: 'Ліміт місць', adminPhone: phone(), adminName: 'Адмін Місць', plan: 'trial' }, opsAuth)
  if (!r.ok) throw new Error('не удалось создать тестовый тенант')
  tenantId = r.tenantId
  adminId = r.adminUserId
  await admin`update users set status = 'active' where id = ${adminId}`
  locationId = (await admin`select id from locations where tenant_id = ${tenantId} limit 1`)[0]!.id as string
  positionId = (await admin`select id from positions where tenant_id = ${tenantId} limit 1`)[0]!.id as string
  await admin`insert into tenant_limits (tenant_id, users) values (${tenantId}, ${N}) on conflict (tenant_id) do update set users = ${N}`
  invalidateLimits(tenantId)
}, 60_000)

afterAll(async () => {
  if (tenantId) await purgeTenantData(tenantId, opsAuth).catch(() => {})
  invalidateLimits()
  await admin`delete from platform_audit where admin_email = ${OPS_EMAIL}`
  await admin`delete from platform_sessions where admin_id in (select id from platform_admins where email = ${OPS_EMAIL})`
  await admin`delete from platform_admins where email = ${OPS_EMAIL}`
  await admin.end()
}, 60_000)

// ── Каждый путь: N активных — отказ, N−1 — проходит ────────────────────────────────────────

describe('35 §13 к. 1: каждый путь, добавляющий сотрудника, упирается в лимит', () => {
  it('создание человека (POST /people → createPerson): при N — отказ и человека нет, при N−1 — приглашённый', async () => {
    await seats(N)
    const tel = phone()
    expectSeatRefusal(await refusal(P.createPerson(ctx(), { fullName: 'Новий Понад Ліміт', phone: tel, tags: [] })))
    expect(await admin`select 1 from users where tenant_id = ${tenantId} and phone = ${tel}`).toHaveLength(0)

    await seats(N - 1)
    const created = await P.createPerson(ctx(), { fullName: 'Новий У Межах', phone: tel, tags: [] })
    expect(created.status).toBe('invited')
    // Заблокированному при создании место не нужно — он не войдёт
    await seats(N)
    const blocked = await P.createPerson(ctx(), { fullName: 'Заблокований Одразу', phone: phone(), tags: [], isBlocked: true })
    expect(blocked.isBlocked).toBe(true)
  })

  it('ручка POST /people: при N — 409 limit_exceeded, человек не создан', async () => {
    await seats(N)
    const tel = phone()
    const event = Object.assign(makeEvent({ path: '/api/v1/people' }), { _body: { fullName: 'Через Ручку', phone: tel } })
    event.context.auth = { tenantId, userId: adminId }
    event.context.access = { userId: adminId, tenantId, grants: [{ scopes: ['people.invite'], scopeType: 'tenant', scopeId: null }], activeRole: null, roles: [] }
    expectSeatRefusal(await refusal(postPeople(event)))
    expect(await admin`select 1 from users where tenant_id = ${tenantId} and phone = ${tel}`).toHaveLength(0)
  })

  it('приглашение (createInvitation, массовое «Запросити»): при N — отказ, приглашения нет; уже активному — можно', async () => {
    const invited = await person('invited')
    await seats(N)
    expectSeatRefusal(await refusal(P.createInvitation(ctx(), invited)))
    expect(await admin`select 1 from invitations where user_id = ${invited}`).toHaveLength(0)
    const bulk = await P.bulkPeople(ctx(), { action: 'invite', ids: [invited] })
    expect(bulk).toEqual({ ok: true, done: 0, errors: [{ id: invited, code: 'limit_exceeded' }] })
    // Повторное приглашение того, кто уже занимает место, места не требует
    expect(await P.createInvitation(ctx(), adminId)).toMatchObject({ token: expect.any(String) })

    await seats(N - 1)
    expect(await P.createInvitation(ctx(), invited)).toMatchObject({ token: expect.any(String) })
  })

  it('импорт CSV: новых больше, чем мест, — не применяется ни одна строка (§12); влезает — применяется', async () => {
    const row = (tel: string, name: string) => ({ 'ПІБ': name, 'Телефон': tel, 'Посада': 'Співробітник', 'Підрозділ': 'Ліміт місць', 'Точка': 'Головна' })
    await seats(N)
    const full = await validateImport(ctx(), 'seats-full.csv', [row(phone(), 'Імпорт Перший')])
    expect(full.stats.create).toBe(1)
    const err = await refusal(applyImport(ctx(), full.jobId))
    expectSeatRefusal(err)
    expect((err as Error).message).toContain(`0 вільних із ${N}`)
    expect((await getImportJob(ctx(), full.jobId))!.status, 'задача остаётся готовой к повтору').toBe('ready')

    // §12: «40 вільних із 50, у файлі 300» — одно место, два новых человека
    await seats(N - 1)
    const tels = [phone(), phone()]
    const two = await validateImport(ctx(), 'seats-two.csv', [row(tels[0]!, 'Імпорт Другий'), row(tels[1]!, 'Імпорт Третій')])
    const errTwo = await refusal(applyImport(ctx(), two.jobId))
    expect(errTwo).toBeInstanceOf(LimitExceededError)
    expect((errTwo as Error).message).toContain(`1 вільних із ${N}`)
    expect((errTwo as Error).message).toContain('— 2')
    expect(await admin`select 1 from users where tenant_id = ${tenantId} and phone in ${admin(tels)}`).toHaveLength(0)

    const one = await validateImport(ctx(), 'seats-one.csv', [row(phone(), 'Імпорт Четвертий')])
    const applied = await applyImport(ctx(), one.jobId)
    expect((applied!.stats as { created: number }).created).toBe(1)
  })

  it('разблокировка: при N — отказ, человек остаётся заблокированным; блокировка другого сразу освобождает место', async () => {
    const blocked = await person('suspended', { blocked: true })
    await seats(N)
    expectSeatRefusal(await refusal(P.setBlocked(ctx(), blocked, false)))
    expect(await statusOf(blocked)).toMatchObject({ status: 'suspended', is_blocked: true })

    // §13 к. 1: «коли один заблокований — активація проходить негайно», без ночного среза
    const [filler] = await admin`select id from users where tenant_id = ${tenantId} and kind = 'employee' and status = 'active' and id <> ${adminId} limit 1`
    expect(await P.setBlocked(ctx(), filler!.id as string, true)).toEqual({ ok: true })
    expect(await P.setBlocked(ctx(), blocked, false)).toEqual({ ok: true })
    expect(await statusOf(blocked)).toMatchObject({ status: 'active', is_blocked: false })
    expect(await activeSeats()).toBe(N)
  })

  it('восстановление из архива и снятие блокировки правкой карточки (PATCH /people/:id)', async () => {
    const archived = await person('archived')
    const blockedActive = await person('active', { blocked: true })
    await seats(N)
    expectSeatRefusal(await refusal(P.updatePerson(ctx(), archived, { status: 'active' })))
    expect((await statusOf(archived)).status).toBe('archived')
    expectSeatRefusal(await refusal(P.updatePerson(ctx(), blockedActive, { isBlocked: false })))
    expect((await statusOf(blockedActive)).is_blocked).toBe(true)
    // Правка, которая места не добавляет, лимитом не останавливается
    expect(await P.updatePerson(ctx(), archived, { comment: 'без зміни статусу' })).toMatchObject({ status: 'archived' })

    await seats(N - 1)
    expect(await P.updatePerson(ctx(), archived, { status: 'active' })).toMatchObject({ status: 'active' })
    expect(await activeSeats()).toBe(N)
  })

  it('повторный найм (POST /people/hire): из архива и нового — при N отказ, при N−1 проходит', async () => {
    const archived = await person('archived')
    const archivedPhone = (await admin`select phone from users where id = ${archived}`)[0]!.phone as string
    await seats(N)
    expectSeatRefusal(await refusal(rehire(ctx(), { phone: archivedPhone, locationId, positionId })))
    expect((await statusOf(archived)).status).toBe('archived')
    expect(await admin`select 1 from user_placements where user_id = ${archived}`).toHaveLength(0)
    const newTel = phone()
    expectSeatRefusal(await refusal(rehire(ctx(), { phone: newTel, fullName: 'Новий Через Найм', locationId, positionId })))
    expect(await admin`select 1 from users where tenant_id = ${tenantId} and phone = ${newTel}`).toHaveLength(0)

    await seats(N - 1)
    expect(await rehire(ctx(), { phone: archivedPhone, locationId, positionId })).toMatchObject({ reused: true })
    expect((await statusOf(archived)).status).toBe('active')
  })

  it('найм кандидата: при N — понятный отказ рекрутеру, человек остаётся кандидатом с продлённым входом', async () => {
    const cand = await candidate()
    const input = { locationId, positionId, startDate: new Date().toISOString().slice(0, 10), onboardingCourseIds: [], welcomeLetter: false }
    await seats(N)
    const res = await hireCandidate(hr(), cand, input)
    expect(res).toMatchObject({ ok: false, code: 'limit_exceeded', used: N, limit: N, accessUntil: expect.any(String) })
    if (!res.ok && res.code === 'limit_exceeded') expect(res.message).toContain('лишається кандидатом')
    expect(await statusOf(cand)).toMatchObject({ kind: 'candidate', candidate_state: 'active' })
    const [access] = await admin`select access_until = current_date + 14 as extended from users where id = ${cand}`
    expect(access!.extended, 'вход кандидата продлён на 14 дней (§12.5)').toBe(true)
    expect(await admin`select 1 from user_placements where user_id = ${cand}`, 'откат целиком — размещения нет').toHaveLength(0)

    await seats(N - 1)
    expect(await hireCandidate(hr(), cand, input)).toMatchObject({ ok: true })
    expect(await statusOf(cand)).toMatchObject({ kind: 'employee', status: 'active' })
  })

  it('первый вход приглашённого: при N — сессии нет, человеку «зверніться до адміністратора»; при N−1 — входит', async () => {
    const invited = await person('invited')
    await seats(N)
    const err = await refusal(createSession({ tenantId, userId: invited, loginMethod: 'otp_sms' }))
    expectSeatRefusal(err)
    expect((err as Error).message).toContain('Зверніться до адміністратора')
    expect(await admin`select 1 from sessions where user_id = ${invited}`).toHaveLength(0)
    expect((await statusOf(invited)).status).toBe('invited')

    // «Вхід не блокується» (§7.4) — для того, кто место уже занимает, даже сверх лимита
    const [over] = await admin`select id from users where tenant_id = ${tenantId} and kind = 'employee' and status = 'active' and id <> ${adminId} limit 1`
    await person('active') // N + 1: оператор снизил лимит ниже факта (§12)
    expect(await createSession({ tenantId, userId: over!.id as string, loginMethod: 'otp_sms' })).toMatchObject({ token: expect.any(String) })
    // Кандидат места сотрудника не занимает — его вход лимитом сотрудников не проверяется
    const cand = await candidate()
    expect(await createSession({ tenantId, userId: cand, loginMethod: 'otp_sms' })).toMatchObject({ token: expect.any(String) })

    await seats(N - 1)
    expect(await createSession({ tenantId, userId: invited, loginMethod: 'otp_sms' })).toMatchObject({ token: expect.any(String) })
    expect((await statusOf(invited)).status).toBe('active')
  })

  it('ссылка-приглашение: место заняли после отправки — вход отклонён, но ссылка не сгорела', async () => {
    const invited = await person('invited')
    await seats(N - 1)
    const { token } = (await P.createInvitation(ctx(), invited))!
    await person('active') // последнее место занял другой, пока ссылка шла
    const event = () => Object.assign(makeEvent({ path: '/api/v1/auth/invite/accept' }), { _body: { token } })
    expectSeatRefusal(await refusal(acceptInvite(event())))
    const [inv] = await admin`select accepted_at from invitations where user_id = ${invited}`
    expect(inv!.accepted_at, 'отклонённый вход не сжигает ссылку').toBeNull()

    await seats(N - 1)
    expect(await acceptInvite(event())).toMatchObject({ data: { ok: true } })
    expect((await statusOf(invited)).status).toBe('active')
  })
})

// ── Гонка за последнее место ────────────────────────────────────────────────────────────────

describe('гонка: два и больше запросов на последнее место — проходит ровно один', () => {
  it('две разблокировки одновременно', async () => {
    const a = await person('suspended', { blocked: true })
    const b = await person('suspended', { blocked: true })
    await seats(N - 1)
    const results = await Promise.allSettled([P.setBlocked(ctx(), a, false), P.setBlocked(ctx(), b, false)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expectSeatRefusal(rejected[0]!.reason)
    expect(await activeSeats()).toBe(N)
  })

  it('пять разных путей одновременно: разблокировка, восстановление, повторный найм, найм кандидата, первый вход', async () => {
    const blocked = await person('suspended', { blocked: true })
    const archived = await person('archived')
    const archivedForRehire = await person('archived')
    const rehirePhone = (await admin`select phone from users where id = ${archivedForRehire}`)[0]!.phone as string
    const cand = await candidate()
    const invited = await person('invited')
    await seats(N - 1)
    const hireInput = { locationId, positionId, startDate: new Date().toISOString().slice(0, 10), onboardingCourseIds: [], welcomeLetter: false }
    const results = await Promise.allSettled([
      P.setBlocked(ctx(), blocked, false),
      P.updatePerson(ctx(), archived, { status: 'active' }),
      rehire(ctx(), { phone: rehirePhone, locationId, positionId }),
      hireCandidate(hr(), cand, hireInput).then((r) => {
        if (!r.ok) throw Object.assign(new Error(r.code), { hire: r })
        return r
      }),
      createSession({ tenantId, userId: invited, loginMethod: 'otp_sms' }),
    ])
    const won = results.filter(r => r.status === 'fulfilled')
    expect(won, JSON.stringify(results.map(r => r.status))).toHaveLength(1)
    for (const r of results) {
      if (r.status === 'fulfilled') continue
      const reason = r.reason as { hire?: { code: string } }
      if (reason.hire) expect(reason.hire.code).toBe('limit_exceeded')
      else expectSeatRefusal(r.reason)
    }
    expect(await activeSeats()).toBe(N)
  })
})

// ── Сбой проверки — отказ, а не пропуск ────────────────────────────────────────────────────

describe('fail-closed: проверку не удалось выполнить — операция отклоняется', () => {
  /** Тариф тенанта без строки в `plans` и без переопределения: лимит мест не определить. */
  async function breakLimits() {
    await admin`update tenant_limits set users = null where tenant_id = ${tenantId}`
    await admin`update tenants set plan = ${`no-such-plan-${stamp}`} where id = ${tenantId}`
    invalidateLimits(tenantId)
  }
  async function restoreLimits() {
    await admin`update tenants set plan = 'trial' where id = ${tenantId}`
    await admin`update tenant_limits set users = ${N} where tenant_id = ${tenantId}`
    invalidateLimits(tenantId)
  }
  function expectCheckFailed(err: unknown) {
    expect(err, 'ожидался отказ проверки').toBeInstanceOf(LimitCheckFailedError)
    const e = err as InstanceType<typeof LimitCheckFailedError>
    expect(e.statusCode).toBe(503)
    expect(e.data).toMatchObject({ code: 'limit.check_failed', details: { axis: 'users_active' }, expose: true })
    expect(e.message).toMatch(/спробуйте ще раз/i)
  }

  it('каждый путь при сломанной проверке отклоняется и ничего не меняет', async () => {
    await seats(1)
    const blocked = await person('suspended', { blocked: true })
    const archived = await person('archived')
    const cand = await candidate()
    const invited = await person('invited')
    const tel = phone()
    await breakLimits()
    try {
      expectCheckFailed(await refusal(P.createPerson(ctx(), { fullName: 'Без Перевірки', phone: tel, tags: [] })))
      expectCheckFailed(await refusal(P.setBlocked(ctx(), blocked, false)))
      expectCheckFailed(await refusal(P.updatePerson(ctx(), archived, { status: 'active' })))
      expectCheckFailed(await refusal(P.createInvitation(ctx(), invited)))
      expectCheckFailed(await refusal(createSession({ tenantId, userId: invited, loginMethod: 'otp_sms' })))
      expectCheckFailed(await refusal(rehire(ctx(), { phone: tel, fullName: 'Без Перевірки', locationId, positionId })))
      const job = await validateImport(ctx(), 'seats-broken.csv', [{ 'ПІБ': 'Без Перевірки', 'Телефон': phone(), 'Посада': 'Співробітник', 'Підрозділ': 'Ліміт місць', 'Точка': 'Головна' }])
      expectCheckFailed(await refusal(applyImport(ctx(), job.jobId)))
      // Найм: сбой проверки — не «мест нет»: вход кандидату не продлевается, найма нет
      expectCheckFailed(await refusal(hireCandidate(hr(), cand, { locationId, positionId, startDate: new Date().toISOString().slice(0, 10), onboardingCourseIds: [], welcomeLetter: false })))

      expect(await admin`select 1 from users where tenant_id = ${tenantId} and phone = ${tel}`).toHaveLength(0)
      expect(await statusOf(blocked)).toMatchObject({ status: 'suspended', is_blocked: true })
      expect((await statusOf(archived)).status).toBe('archived')
      expect((await statusOf(invited)).status).toBe('invited')
      expect(await statusOf(cand)).toMatchObject({ kind: 'candidate', access_until: null })
      expect(await activeSeats()).toBe(1)
    }
    finally {
      await restoreLimits()
    }
  })

  it('ручка POST /people при сбое проверки — отказ, человек не создан (прежде считалось «можно»)', async () => {
    await seats(1)
    const tel = phone()
    await breakLimits()
    try {
      const event = Object.assign(makeEvent({ path: '/api/v1/people' }), { _body: { fullName: 'Ручка Без Перевірки', phone: tel } })
      event.context.auth = { tenantId, userId: adminId }
      event.context.access = { userId: adminId, tenantId, grants: [{ scopes: ['people.invite'], scopeType: 'tenant', scopeId: null }], activeRole: null, roles: [] }
      expectCheckFailed(await refusal(postPeople(event)))
      expect(await admin`select 1 from users where tenant_id = ${tenantId} and phone = ${tel}`).toHaveLength(0)
    }
    finally {
      await restoreLimits()
    }
  })

  it('обработчик ошибок отдаёт клиенту код и понятный текст: 409 с осью, 503 — не «Щось пішло не так»', async () => {
    const render = (err: InstanceType<typeof LimitExceededError> | InstanceType<typeof LimitCheckFailedError>) => {
      let body = ''
      const res = { statusCode: 0, setHeader: () => {}, end: (s: string) => { body = s } }
      // Nitro передаёт обработчику H3Error, собранный из брошенной ошибки: statusCode и data
      errorHandler(Object.assign(new Error(err.message), { statusCode: err.statusCode, data: err.data }), { path: '/api/v1/people', context: {}, node: { res } })
      return { status: res.statusCode, body: JSON.parse(body) as { error: { code: string, message: string, details?: Record<string, unknown> } } }
    }
    const exceeded = render(new LimitExceededError({ ok: false, axis: 'users_active', used: N, limit: N }))
    expect(exceeded.status).toBe(409)
    expect(exceeded.body.error).toMatchObject({ code: 'limit_exceeded', details: { axis: 'users_active', used: N, limit: N } })
    const failed = render(new LimitCheckFailedError('users_active'))
    expect(failed.status).toBe(503)
    expect(failed.body.error.code).toBe('limit.check_failed')
    expect(failed.body.error.message).not.toBe('Щось пішло не так')
    expect(failed.body.error.details).toMatchObject({ axis: 'users_active', traceId: expect.any(String) })
  })
})
