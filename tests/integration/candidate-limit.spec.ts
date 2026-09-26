import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeEvent, type FakeEvent } from './_nitroGlobals'

/**
 * fix-candidate-limit-race (продолжение fix-seat-limit, #147): лимит активных кандидатов обходился.
 *
 * Было: `precheckCandidate()` считал ось `candidates_active` отдельным подключением **до**
 * транзакции создания — два запроса на последнее место проходили оба; отклик с публичной
 * страницы вакансии шёл той же предпроверкой; возврат в воронку (`reopen`) и перенос карточки из
 * отказа в колонку `maps_to = 'active'` — поштучно и пачкой — лимит не проверяли вовсе.
 *
 * Стало: каждый путь, добавляющий активного кандидата, зовёт `assertCandidatesWithinLimit()`
 * (`server/services/tenantLimits.ts`, то же тело, что у `assertSeatsWithinLimit()`) в транзакции
 * самой операции, под блокировкой оси. Здесь — `docs/v2/28` §7.1 п. 1, §13 к. 1 на отдельном
 * тенанте с лимитом N кандидатов:
 *   · каждый путь при N активных — отказ `409 limit_exceeded` (ось `candidates_active`) и ничего
 *     не изменилось; при N−1 — проходит;
 *   · гонка двух и пяти запросов за последнее место — проходит ровно один;
 *   · состояние кандидата, по которому решается «занимает ли операция место», не устаревает
 *     до записи (`for update`): перенос между активными колонками, пока карточку архивируют, —
 *     не возврат в воронку мимо лимита;
 *   · найм освобождает место кандидата и не упирается в ось `candidates_active`;
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
const C = await import('../../server/services/candidates')
const { bulkStatus } = await import('../../server/services/candidateFunnel')
const { hireCandidate, reopenCandidate } = await import('../../server/services/candidateHire')
const { convertApplication } = await import('../../server/services/publicApply')
const { createVacancy } = await import('../../server/services/vacancies')
const { invalidateLimits, LimitExceededError, LimitCheckFailedError } = await import('../../server/services/tenantLimits')
type Handler = (event: FakeEvent) => Promise<unknown>
const postCandidates = (await import('../../server/api/v1/candidates/index.post')).default as unknown as Handler

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 3, onnotice: () => {} })

const OPS_EMAIL = 'ops-candidate-limit@lola.local'
const OPS_PASSWORD = 'test-password-123'
const stamp = Date.now().toString(36)
/** Лимит активных кандидатов тестового тенанта. */
const N = 3

let tenantId: string
let adminId: string
let vacancyId: string
let newStatusId: string
let rejectedStatusId: string
let opsAuth: NonNullable<Awaited<ReturnType<typeof validatePlatformSession>>>
const ctx = () => ({ tenantId, actorId: adminId })
const hr = () => C.viewerOf({ userId: adminId, tenantId, grants: [{ scopes: ['candidate.view', 'candidate.edit', 'candidate.decide', 'candidate.delete'], scopeType: 'tenant', scopeId: null }] })

let seq = 0
const phone = () => `+38050${String(8_000_000 + seq++).padStart(7, '0')}`

type State = 'active' | 'rejected' | 'archived'

/** Кандидат в нужном состоянии воронки; отказанный стоит в системной колонке «Відхилені». */
async function candidate(state: State = 'active'): Promise<string> {
  const statusId = state === 'active' ? newStatusId : state === 'rejected' ? rejectedStatusId : null
  const [row] = await admin`
    insert into users (tenant_id, kind, candidate_state, candidate_state_at, candidate_status_id, full_name, phone, status, source,
                       consent_given_at, consent_expires_at)
    values (${tenantId}, 'candidate', ${state}, now(), ${statusId}, ${`Кандидат ${seq}`}, ${phone()}, 'invited', 'manual',
            now(), current_date + 180)
    returning id`
  return row!.id as string
}

async function activeCandidates(): Promise<number> {
  const [r] = await admin`select count(*)::int as n from users where tenant_id = ${tenantId} and kind = 'candidate' and candidate_state = 'active'`
  return r!.n as number
}

/** Ровно `n` активных кандидатов: прежние активные уходят в архив, недостающие дозаводятся. */
async function fill(n: number): Promise<void> {
  await admin`update users set candidate_state = 'archived', candidate_status_id = null where tenant_id = ${tenantId} and kind = 'candidate' and candidate_state = 'active'`
  for (let i = 0; i < n; i++) await candidate('active')
  expect(await activeCandidates()).toBe(n)
}

async function stateOf(id: string): Promise<string> {
  const [r] = await admin`select candidate_state from users where id = ${id}`
  return r!.candidate_state as string
}

/** Отклик с публичной страницы, прошедший проверки и ждущий конверсии (§7.20). */
async function application(): Promise<{ id: string, phone: string }> {
  const tel = phone()
  const [row] = await admin`
    insert into vacancy_applications (tenant_id, vacancy_id, state, full_name, phone, consent_given_at, consent_text_version, ip_hash, form_nonce)
    values (${tenantId}, ${vacancyId}, 'pending', ${`Відгук ${seq}`}, ${tel}, now(), 'v1', ${`hash-${stamp}`}, ${`nonce-${stamp}-${seq}`})
    returning id`
  return { id: row!.id as string, phone: tel }
}

const convert = (appId: string) => convertApplication(tenantId, adminId, vacancyId, appId, { actorId: adminId })

/** Отказ по кандидатам: единый `409 limit_exceeded` с осью, фактом и лимитом (`35` §10). */
function expectCandidateRefusal(err: unknown, used = N) {
  expect(err, 'ожидался отказ по лимиту кандидатов').toBeInstanceOf(LimitExceededError)
  const e = err as InstanceType<typeof LimitExceededError>
  expect(e.statusCode).toBe(409)
  expect(e.data).toMatchObject({ code: 'limit_exceeded', details: { axis: 'candidates_active', used, limit: N } })
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

/** Результат-отказ сервиса превращается в исключение — для `Promise.allSettled` в гонке. */
function orThrow<T extends { ok: boolean }>(p: Promise<T>): Promise<T> {
  return p.then((r) => {
    if (!r.ok) throw Object.assign(new Error((r as unknown as { code: string }).code), { result: r })
    return r
  })
}

beforeAll(async () => {
  process.env.PLATFORM_ADMIN_EMAIL = OPS_EMAIL
  process.env.PLATFORM_ADMIN_PASSWORD = OPS_PASSWORD
  await admin`delete from platform_admins where email = ${OPS_EMAIL}`
  await ensureFirstAdmin()
  opsAuth = (await validatePlatformSession((await platformLogin(OPS_EMAIL, OPS_PASSWORD))!.token))!
  const r = await createTenant({ slug: `cands-${stamp}`, name: 'Ліміт кандидатів', adminPhone: phone(), adminName: 'Адмін Кандидатів', plan: 'trial' }, opsAuth)
  if (!r.ok) throw new Error('не удалось создать тестовый тенант')
  tenantId = r.tenantId
  adminId = r.adminUserId
  await admin`update users set status = 'active' where id = ${adminId}`
  newStatusId = (await admin`select id from candidate_statuses where tenant_id = ${tenantId} and code = 'new'`)[0]!.id as string
  rejectedStatusId = (await admin`select id from candidate_statuses where tenant_id = ${tenantId} and maps_to = 'rejected' order by sort limit 1`)[0]!.id as string

  // Вакансия с курсом — без курса отклик не конвертируется (§7.20)
  const locationId = (await admin`select id from locations where tenant_id = ${tenantId} limit 1`)[0]!.id as string
  const [course] = await admin`
    insert into courses (tenant_id, title, slug, status) values (${tenantId}, 'Курс відбору', ${`cands-course-${stamp}`}, 'published')
    returning id`
  const vacancy = await createVacancy(ctx(), {
    title: 'Бариста (ліміт кандидатів)',
    courseId: course!.id as string,
    locationId,
    recruiterId: adminId,
    salaryCurrency: 'UAH',
    salaryVisible: false,
    publicApplyOtp: false,
    applyDailyCap: 200,
    assignmentTemplate: { dueMode: 'relative', dueDays: 7, isMandatory: true, params: {}, reminders: {}, notifyOnAssign: false },
  } as Parameters<typeof createVacancy>[1])
  vacancyId = vacancy.id

  await admin`insert into tenant_limits (tenant_id, candidates) values (${tenantId}, ${N}) on conflict (tenant_id) do update set candidates = ${N}`
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

const createInput = (tel: string) => ({ lastName: 'Ліміт', firstName: 'Кандидат', phone: tel, commLanguage: 'uk', consentGiven: true }) as Parameters<typeof C.createCandidate>[1]

// ── Каждый путь: N активных — отказ, N−1 — проходит ────────────────────────────────────────

describe('28 §7.1 п. 1, §13 к. 1: каждый путь, добавляющий активного кандидата, упирается в лимит', () => {
  it('создание вручную (createCandidate): при N — limit_exceeded и кандидата нет, при N−1 — создан', async () => {
    await fill(N)
    const tel = phone()
    const refused = await C.createCandidate(ctx(), createInput(tel))
    expect(refused).toMatchObject({ ok: false, code: 'limit_exceeded', current: N, limit: N })
    if (!refused.ok && refused.code === 'limit_exceeded') expect(refused.message).toContain('Заархівуйте')
    expect(await admin`select 1 from users where tenant_id = ${tenantId} and phone = ${tel}`).toHaveLength(0)

    await fill(N - 1)
    expect(await C.createCandidate(ctx(), createInput(tel))).toMatchObject({ ok: true })
    expect(await activeCandidates()).toBe(N)
  })

  it('ручка POST /candidates: при N — 409 limit_exceeded с осью candidates_active, кандидат не создан', async () => {
    await fill(N)
    const tel = phone()
    const event = Object.assign(makeEvent({ path: '/api/v1/candidates' }), { _body: createInput(tel) }) as FakeEvent & { _status?: number }
    event.context.auth = { tenantId, userId: adminId }
    event.context.access = { userId: adminId, tenantId, grants: [{ scopes: ['candidate.edit'], scopeType: 'tenant', scopeId: null }], activeRole: null, roles: [] }
    const body = await postCandidates(event) as { error: { code: string, message: string, details: Record<string, unknown> } }
    expect(event._status).toBe(409)
    expect(body.error).toMatchObject({ code: 'limit_exceeded', details: { axis: 'candidates_active', used: N, limit: N, current: N } })
    expect(body.error.message.length).toBeGreaterThan(40)
    expect(await admin`select 1 from users where tenant_id = ${tenantId} and phone = ${tel}`).toHaveLength(0)
  })

  it('отклик с публичной страницы вакансии: при N — pending_review с причиной limit, при N−1 — кандидат', async () => {
    await fill(N)
    const app = await application()
    expect(await convert(app.id)).toEqual({ ok: false, code: 'limit' })
    const [held] = await admin`select state, spam_reasons, candidate_id from vacancy_applications where id = ${app.id}`
    expect(held).toMatchObject({ state: 'pending_review', candidate_id: null })
    expect(held!.spam_reasons).toContain('limit')
    expect(await admin`select 1 from users where tenant_id = ${tenantId} and phone = ${app.phone}`, 'откат целиком — кандидата нет').toHaveLength(0)
    expect(await admin`select 1 from assignments where tenant_id = ${tenantId} and ${`vacancy:${vacancyId}`} = any(tags)`).toHaveLength(0)

    await fill(N - 1)
    const accepted = await convert(app.id)
    expect(accepted).toMatchObject({ ok: true, state: 'accepted' })
    expect(await activeCandidates()).toBe(N)
  })

  it('возврат в воронку (reopen): при N — отказ, кандидат остаётся в архиве; при N−1 — активен', async () => {
    const archived = await candidate('archived')
    await fill(N)
    expectCandidateRefusal(await refusal(reopenCandidate(hr(), archived, { reasonText: 'Передумали' })))
    expect(await stateOf(archived)).toBe('archived')

    await fill(N - 1)
    expect(await reopenCandidate(hr(), archived, { reasonText: 'Передумали' })).toMatchObject({ ok: true })
    expect(await stateOf(archived)).toBe('active')
  })

  it('перенос карточки из отказа в колонку «Нові» (moveStatus): при N — отказ; между активными колонками — без лимита', async () => {
    const rejected = await candidate('rejected')
    await fill(N)
    expectCandidateRefusal(await refusal(C.moveStatus(hr(), rejected, { statusId: newStatusId, notify: false })))
    expect(await stateOf(rejected)).toBe('rejected')
    // Перенос между колонками `active` места не добавляет — при исчерпанном лимите проходит
    const [active] = await admin`select id from users where tenant_id = ${tenantId} and kind = 'candidate' and candidate_state = 'active' limit 1`
    const inProgress = (await admin`select id from candidate_statuses where tenant_id = ${tenantId} and code = 'in_progress'`)[0]!.id as string
    expect(await C.moveStatus(hr(), active!.id as string, { statusId: inProgress, notify: false })).toMatchObject({ ok: true })

    await fill(N - 1)
    expect(await C.moveStatus(hr(), rejected, { statusId: newStatusId, notify: false })).toMatchObject({ ok: true })
    expect(await stateOf(rejected)).toBe('active')
  })

  it('перенос пачкой (bulkStatus): мест меньше, чем возвращаемых, — не перенесён никто; влезают — все', async () => {
    const a = await candidate('rejected')
    const b = await candidate('rejected')
    await fill(N - 1) // одно место, двое возвращаемых
    expectCandidateRefusal(await refusal(bulkStatus(hr(), { ids: [a, b], statusId: newStatusId, notify: false })), N - 1)
    expect([await stateOf(a), await stateOf(b)]).toEqual(['rejected', 'rejected'])

    await fill(N - 2)
    expect(await bulkStatus(hr(), { ids: [a, b], statusId: newStatusId, notify: false })).toMatchObject({ ok: true, changed: 2 })
    expect(await activeCandidates()).toBe(N)
  })
})

// ── Гонка за последнее место ────────────────────────────────────────────────────────────────

describe('гонка: два и пять запросов на последнее место — проходит ровно один', () => {
  it('два создания одновременно', async () => {
    await fill(N - 1)
    const tels = [phone(), phone()]
    const results = await Promise.all(tels.map(t => C.createCandidate(ctx(), createInput(t))))
    expect(results.filter(r => r.ok), JSON.stringify(results.map(r => r.ok ? 'ok' : r.code))).toHaveLength(1)
    expect(results.filter(r => !r.ok)).toEqual([expect.objectContaining({ ok: false, code: 'limit_exceeded', current: N, limit: N })])
    expect(await activeCandidates()).toBe(N)
  })

  it('пять созданий одновременно', async () => {
    await fill(N - 1)
    const results = await Promise.all(Array.from({ length: 5 }, () => C.createCandidate(ctx(), createInput(phone()))))
    expect(results.filter(r => r.ok), JSON.stringify(results.map(r => r.ok ? 'ok' : r.code))).toHaveLength(1)
    for (const r of results.filter(x => !x.ok)) expect(r).toMatchObject({ code: 'limit_exceeded', current: N, limit: N })
    expect(await activeCandidates()).toBe(N)
  })

  it('два отклика с вакансии одновременно: один стал кандидатом, второй ждёт рекрутера', async () => {
    await fill(N - 1)
    const apps = [await application(), await application()]
    const results = await Promise.all(apps.map(a => convert(a.id)))
    expect(results.filter(r => r.ok), JSON.stringify(results)).toHaveLength(1)
    expect(results.filter(r => !r.ok)).toEqual([{ ok: false, code: 'limit' }])
    expect(await activeCandidates()).toBe(N)
  })

  it('пять разных путей одновременно: создание, отклик, reopen, перенос, перенос пачкой', async () => {
    const archived = await candidate('archived')
    const rejected = await candidate('rejected')
    const rejectedForBulk = await candidate('rejected')
    const app = await application()
    await fill(N - 1)
    const results = await Promise.allSettled([
      orThrow(C.createCandidate(ctx(), createInput(phone()))),
      orThrow(convert(app.id)),
      reopenCandidate(hr(), archived, { reasonText: 'Гонка' }),
      C.moveStatus(hr(), rejected, { statusId: newStatusId, notify: false }),
      bulkStatus(hr(), { ids: [rejectedForBulk], statusId: newStatusId, notify: false }),
    ])
    const won = results.filter(r => r.status === 'fulfilled')
    expect(won, JSON.stringify(results.map(r => r.status === 'fulfilled' ? 'ok' : String((r.reason as Error).message).slice(0, 40)))).toHaveLength(1)
    for (const r of results) {
      if (r.status === 'fulfilled') continue
      const result = (r.reason as { result?: { code: string } }).result
      if (result) expect(['limit_exceeded', 'limit']).toContain(result.code)
      else expectCandidateRefusal(r.reason)
    }
    expect(await activeCandidates()).toBe(N)
  })
})

/** Ждёт, пока хоть одна сессия базы встанет в очередь на блокировку строки. */
async function waitForLockWaiter(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const [r] = await admin`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`
    if ((r!.n as number) > 0) return
    await new Promise(res => setTimeout(res, 20))
  }
  throw new Error('операция не встала в очередь на блокировку строки')
}

describe('состояние кандидата не устаревает между проверкой и записью', () => {
  it('перенос между активными колонками, пока карточку архивируют: решение по свежему состоянию — отказ по лимиту', async () => {
    await fill(N)
    const [x] = await admin`select id from users where tenant_id = ${tenantId} and kind = 'candidate' and candidate_state = 'active' limit 1`
    const id = x!.id as string
    const inProgress = (await admin`select id from candidate_statuses where tenant_id = ${tenantId} and code = 'in_progress'`)[0]!.id as string
    let moved: Promise<unknown> | undefined
    // Параллельная архивация держит строку; перенос встаёт за ней в очередь, а освободившееся
    // место тем временем занимает новый кандидат. Без `for update` перенос прочитал бы «active»,
    // счёл бы себя переносом между активными колонками и вернул архивного в воронку сверх лимита.
    await admin.begin(async (sql) => {
      await sql`update users set candidate_state = 'archived', candidate_status_id = null where id = ${id}`
      moved = refusal(C.moveStatus(hr(), id, { statusId: inProgress, notify: false }))
      await waitForLockWaiter()
      await candidate('active')
    })
    expectCandidateRefusal(await moved)
    expect(await stateOf(id)).toBe('archived')
    expect(await activeCandidates()).toBe(N)
  })
})

describe('найм (28 §7.6): место кандидата освобождается, ось candidates_active его не держит', () => {
  it('при N активных кандидатах найм проходит, после него есть место для нового кандидата', async () => {
    await fill(N)
    const [x] = await admin`select id from users where tenant_id = ${tenantId} and kind = 'candidate' and candidate_state = 'active' limit 1`
    const locationId = (await admin`select id from locations where tenant_id = ${tenantId} limit 1`)[0]!.id as string
    const positionId = (await admin`select id from positions where tenant_id = ${tenantId} limit 1`)[0]!.id as string
    const hired = await hireCandidate(hr(), x!.id as string, { locationId, positionId, startDate: new Date().toISOString().slice(0, 10), onboardingCourseIds: [], welcomeLetter: false } as Parameters<typeof hireCandidate>[2])
    expect(hired).toMatchObject({ ok: true, outcome: { candidatesActive: N - 1 } })
    expect(await activeCandidates()).toBe(N - 1)
    expect(await C.createCandidate(ctx(), createInput(phone()))).toMatchObject({ ok: true })
    expect(await activeCandidates()).toBe(N)
  })
})

// ── Сбой проверки — отказ, а не пропуск ────────────────────────────────────────────────────

describe('fail-closed: проверку не удалось выполнить — операция отклоняется', () => {
  /** Тариф тенанта без строки в `plans` и без переопределения: лимит кандидатов не определить. */
  async function breakLimits() {
    await admin`update tenant_limits set candidates = null where tenant_id = ${tenantId}`
    await admin`update tenants set plan = ${`no-such-plan-${stamp}`} where id = ${tenantId}`
    invalidateLimits(tenantId)
  }
  async function restoreLimits() {
    await admin`update tenants set plan = 'trial' where id = ${tenantId}`
    await admin`update tenant_limits set candidates = ${N} where tenant_id = ${tenantId}`
    invalidateLimits(tenantId)
  }
  function expectCheckFailed(err: unknown) {
    expect(err, 'ожидался отказ проверки').toBeInstanceOf(LimitCheckFailedError)
    const e = err as InstanceType<typeof LimitCheckFailedError>
    expect(e.statusCode).toBe(503)
    expect(e.data).toMatchObject({ code: 'limit.check_failed', details: { axis: 'candidates_active' }, expose: true })
    expect(e.message).toMatch(/спробуйте ще раз/i)
  }

  it('каждый путь при сломанной проверке отклоняется и ничего не меняет', async () => {
    await fill(0)
    const archived = await candidate('archived')
    const rejected = await candidate('rejected')
    const rejectedForBulk = await candidate('rejected')
    const app = await application()
    const tel = phone()
    await breakLimits()
    try {
      expectCheckFailed(await refusal(C.createCandidate(ctx(), createInput(tel))))
      expect(await admin`select 1 from users where tenant_id = ${tenantId} and phone = ${tel}`).toHaveLength(0)
      expectCheckFailed(await refusal(convert(app.id)))
      const [a] = await admin`select state, candidate_id from vacancy_applications where id = ${app.id}`
      expect(a, 'отклик остаётся как был — не принят и не «придержан по лимиту»').toMatchObject({ state: 'pending', candidate_id: null })
      expectCheckFailed(await refusal(reopenCandidate(hr(), archived, { reasonText: 'Без перевірки' })))
      expectCheckFailed(await refusal(C.moveStatus(hr(), rejected, { statusId: newStatusId, notify: false })))
      expectCheckFailed(await refusal(bulkStatus(hr(), { ids: [rejectedForBulk], statusId: newStatusId, notify: false })))
      expect([await stateOf(archived), await stateOf(rejected), await stateOf(rejectedForBulk)]).toEqual(['archived', 'rejected', 'rejected'])
      expect(await activeCandidates()).toBe(0)
    }
    finally {
      await restoreLimits()
    }
  })
})
