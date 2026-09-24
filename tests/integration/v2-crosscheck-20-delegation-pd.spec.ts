import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SYSTEM_ROLES } from '../../shared/domain/roles'

/**
 * Сквозная проверка 20 (`docs/v2/42-stages-delta.md` §5) и критерий приёмки `37` §13 к. 15:
 * **делегирование не расширяет доступ к персональным данным кандидата** (`37` §1, §12; `28` §2).
 *
 * Сценарий: кандидат сдал тестовое задание, работа назначена наставнику А, А передал её Б,
 * Б — В (цепочка из двух передач). Тогда:
 *   - Б и В в карточке проверки `GET /review/items/:id` видят ответ и критерии, но **не
 *     получают полей** `phone`, `email`, `resume_asset_id` (ни под каким именем и ни в каком
 *     виде — ни значением, ни маской);
 *   - Б и В на `GET /candidates/:id` получают `404`: карточку кандидата делегирование не
 *     открывает — доступ к записи о человеке выдаёт организация, а не коллега передачей.
 *
 * Проверка идёт на двух уровнях: сервисом (всегда) и по HTTP против собранного приложения
 * (`.output`, как `scopes-http.spec.ts`; CI собирает до тестов) — чтобы сериализатор
 * эндпоинта не вернул поле, которого нет в сервисе.
 */

const { delegateItem, reassignItem } = await import('../../server/services/reviewDelegation')
const { getReviewItem } = await import('../../server/services/reviewCard')
const { reviewActorOf } = await import('../../server/services/reviewActor')
const { getCandidate, viewerOf } = await import('../../server/services/candidates')
const { createWorkshop, submitWorkshop } = await import('../../server/services/workshops')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const H = 3_600_000
const PHONE = '+380679200009'
const EMAIL = 'pr19-candidate@kappi.test'
const BUILT = existsSync('.output/server/index.mjs')
const PORT = 3788
const BASE = `http://127.0.0.1:${PORT}`

let tenantId: string
let lazareva: string
let adminId: string
let candidateId: string
let resumeId: string
let itemId: string
let workshopId: string
const people: Record<string, string> = {}
const PEOPLE: [key: string, name: string, phone: string][] = [
  ['a', 'PR19-20 Наставник А', '+380679200001'],
  ['b', 'PR19-20 Наставник Б', '+380679200002'],
  ['c', 'PR19-20 Наставник В', '+380679200003'],
  ['m', 'PR19-20 Керівник точки', '+380679200004'],
]

const grantsOf = (key: string) => [{ scopes: [...SYSTEM_ROLES[key === 'm' ? 'manager' : 'mentor']!.scopes], scopeType: 'location' as const, scopeId: lazareva }]
const actor = (key: string) => reviewActorOf({ tenantId, userId: people[key]!, grants: grantsOf(key) })
const viewer = (key: string) => viewerOf({ tenantId, userId: people[key]!, grants: grantsOf(key) })

/** Все ключи объекта на любой глубине — поле не должно найтись ни под каким вложением. */
function keysDeep(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach(x => keysDeep(x, out))
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.add(k)
      keysDeep(x, out)
    }
  }
  return out
}

const FORBIDDEN_KEYS = ['phone', 'email', 'resumeAssetId', 'resume_asset_id']

function assertNoPd(card: unknown, who: string) {
  const keys = keysDeep(card)
  for (const k of FORBIDDEN_KEYS) expect(keys.has(k), `${who}: в карточке проверки есть поле ${k}`).toBe(false)
  const text = JSON.stringify(card)
  expect(text.includes(PHONE.slice(4)), `${who}: телефон кандидата утёк в карточку`).toBe(false)
  expect(text.includes(EMAIL), `${who}: e-mail кандидата утёк в карточку`).toBe(false)
  expect(text.includes(resumeId), `${who}: резюме кандидата утекло в карточку`).toBe(false)
}

async function cleanup() {
  const ids = (await admin`select id from users where tenant_id = ${tenantId} and (phone like '+38067920000%')`).map(r => r.id as string)
  if (!ids.length) return
  await admin`delete from review_queue_items where user_id in ${admin(ids)}`
  await admin`delete from workshop_submissions where user_id in ${admin(ids)}`
  await admin`delete from review_delegations where from_user_id in ${admin(ids)} or to_user_id in ${admin(ids)}`
  await admin`delete from reviewer_capacity where user_id in ${admin(ids)}`
  await admin`delete from notifications where user_id in ${admin(ids)}`
  await admin`delete from audit_log where actor_id in ${admin(ids)} or entity_id in ${admin(ids)}`
  await admin`delete from sessions where user_id in ${admin(ids)}`
  await admin`update users set resume_asset_id = null where id in ${admin(ids)}`
  await admin`delete from media_assets where tenant_id = ${tenantId} and original_name = 'pr19-cv.pdf'`
  await admin`delete from candidate_status_history where candidate_id in ${admin(ids)}`
  await admin`delete from user_roles where user_id in ${admin(ids)}`
  await admin`delete from user_placements where user_id in ${admin(ids)}`
  await admin`delete from users where id in ${admin(ids)}`
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  lazareva = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  const positionId = (await admin`select id from positions where tenant_id = ${tenantId} and code = 'cook-hot'`)[0]!.id as string
  await cleanup()
  for (const [key, name, phone] of PEOPLE) {
    const [u] = await admin`
      insert into users (tenant_id, kind, full_name, phone, status) values (${tenantId}, 'employee', ${name}, ${phone}, 'active')
      returning id`
    people[key] = u!.id as string
    await admin`insert into user_placements (tenant_id, user_id, location_id, position_id) values (${tenantId}, ${u!.id}, ${lazareva}, ${positionId})`
    await admin`
      insert into user_roles (tenant_id, user_id, role_id, scope_type, scope_id)
      values (${tenantId}, ${u!.id}, (select id from roles where tenant_id = ${tenantId} and code = ${key === 'm' ? 'manager' : 'mentor'}), 'location', ${lazareva})`
  }
  // Кандидат с полным набором ПД: телефон, почта, резюме (`28` §2, §7.10).
  const [cand] = await admin`
    insert into users (tenant_id, kind, candidate_state, full_name, phone, email, status, recruiter_id, consent_given_at, consent_expires_at)
    values (${tenantId}, 'candidate', 'active', 'PR19-20 Кандидатка Тестова', ${PHONE}, ${EMAIL}, 'active', ${adminId}, now(), current_date + 180)
    returning id`
  candidateId = cand!.id as string
  const [cv] = await admin`
    insert into media_assets (tenant_id, key, original_name, kind, mime, bytes, origin)
    values (${tenantId}, ${`pr19/${candidateId}/cv.pdf`}, 'pr19-cv.pdf', 'document', 'application/pdf', 1024, 'candidate_cv')
    returning id`
  resumeId = cv!.id as string
  await admin`update users set resume_asset_id = ${resumeId} where id = ${candidateId}`

  // Тестовое задание кандидата — настоящая сдача практикума, через единую точку постановки.
  const w = await createWorkshop({ tenantId, actorId: adminId }, {
    title: 'PR19-20 Тестове завдання кандидата', description: [{ id: 'b1', type: 'text', html: '<p>Опишіть подачу страви</p>' }],
    submissionKinds: ['text'], minTextLength: 5, criteria: [{ text: 'Подача за стандартом' }, { text: 'Температура' }],
    reviewerRule: 'any_mentor', slaHours: 48, status: 'published',
  })
  workshopId = w.id
  const sub = await submitWorkshop({ tenantId, actorId: candidateId }, workshopId, { text: 'Подаю на теплій тарілці, соус окремо' })
  if (!sub.ok) throw new Error(sub.code)
  itemId = (await admin`select id from review_queue_items where task_type = 'workshop' and source_id = ${sub.submissionId}`)[0]!.id as string

  // А — назначенный проверяющий; А → Б → В — цепочка из двух передач.
  const assigned = await reassignItem(actor('m'), itemId, { toUserId: people.a!, reason: 'Призначення' })
  if (!assigned.ok) throw new Error(assigned.code)
  const ab = await delegateItem(actor('a'), itemId, { toUserId: people.b!, reasonCode: 'workload', dueAt: new Date(Date.now() + 30 * H).toISOString(), notify: false })
  if (!ab.ok) throw new Error(ab.code)
  const bc = await delegateItem(actor('b'), itemId, { toUserId: people.c!, reasonCode: 'expertise', dueAt: new Date(Date.now() + 20 * H).toISOString(), notify: false })
  if (!bc.ok) throw new Error(bc.code)
})

afterAll(async () => {
  await cleanup()
  await admin`delete from workshops where id = ${workshopId}`
  await admin.end()
})

describe('сквозная проверка 20: делегирование не расширяет доступ к ПД кандидата (сервис)', () => {
  it('работа стоит в очереди как работа кандидата, цепочка — две передачи', async () => {
    const [q] = await admin`select subject_kind, delegation_depth, assigned_reviewer_id, origin_reviewer_id from review_queue_items where id = ${itemId}`
    expect(q!.subject_kind).toBe('candidate')
    expect(q!.delegation_depth).toBe(2)
    expect(q!.assigned_reviewer_id).toBe(people.c)
    expect(q!.origin_reviewer_id).toBe(people.a)
  })

  it('к. 15: делегат по цепочке видит ответ и критерии, но не видит телефона, e-mail и резюме', async () => {
    for (const key of ['b', 'c']) {
      const card = await getReviewItem(actor(key), itemId)
      expect(card, `${key}: карточка проверки не открылась`).not.toBeNull()
      expect(card!.subject.kind).toBe('candidate')
      expect(card!.contactsHidden, 'нет плашки «Контактні дані кандидата доступні рекрутеру»').toBe(true)
      const work = card!.work
      expect(work?.kind).toBe('workshop')
      if (work?.kind === 'workshop') {
        expect(work.text).toBe('Подаю на теплій тарілці, соус окремо')
        expect(work.criteria.map(c => c.text)).toEqual(['Подача за стандартом', 'Температура'])
      }
      assertNoPd(card, key)
    }
  })

  it('контроль: карточка кандидата существует — администратор её видит', async () => {
    const hr = viewerOf({ tenantId, userId: adminId, grants: [{ scopes: [...SYSTEM_ROLES.admin!.scopes], scopeType: 'tenant', scopeId: null }] })
    expect((await getCandidate(hr, candidateId))?.id).toBe(candidateId)
  })

  it('делегат по цепочке получает «не найдено» на карточку кандидата', async () => {
    expect(await getCandidate(viewer('b'), candidateId), 'Б (первое звено) открыл карточку кандидата').toBeNull()
    expect(await getCandidate(viewer('c'), candidateId), 'В (второе звено) открыл карточку кандидата').toBeNull()
  })

  it('делегировавший, отдав работу, карточку кандидата тоже теряет: доступ был у работы, а работа ушла', async () => {
    expect(await getCandidate(viewer('a'), candidateId)).toBeNull()
  })
})

/**
 * HTTP-половина. **Рекрутинг тенанту включается на время этого блока** — и это не подгонка
 * теста, а условие, без которого проверка 20 ничего не проверяет. Флаг `tenants.candidates_enabled`
 * по умолчанию выключен, и тогда `/candidates/*` гасится сквозным запретом
 * `server/middleware/03.guards.ts` — `403 candidates.disabled` **любому** человеку тенанта,
 * включая администратора, для **любого** идентификатора, в том числе несуществующего. Такой ответ
 * существования карточки не раскрывает, но и о делегировании ничего не говорит: до решения «кто
 * видит карточку» запрос не доходит (так упал первый прогон CI на #118 — `403` вместо `404`).
 *
 * Поэтому в блоке два контроля: администратор при включённом рекрутинге получает `200` — маршрут
 * жив; делегаты по цепочке получают `404 not_found` — ответ сервиса «этому человеку карточки
 * нет», тот же, что для наставника без назначенной проверки (`28` §13 к. 10), и для чужого
 * тенанта (CLAUDE.md п. 15). Существование карточки не подтверждается ни делегату, ни чужому.
 */
describe.skipIf(!BUILT)('сквозная проверка 20 по HTTP (собранное приложение)', () => {
  let server: ChildProcess | undefined
  let recruitingWas = false

  async function login(phone: string): Promise<string> {
    const req = await fetch(`${BASE}/api/v1/auth/otp/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) })
    const body = await req.json() as { data: { devCode?: string } }
    if (!body.data?.devCode) throw new Error(`Нет devCode для ${phone}: ${JSON.stringify(body)}`)
    const ver = await fetch(`${BASE}/api/v1/auth/otp/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, code: body.data.devCode }) })
    if (!ver.ok) throw new Error(`verify ${phone} → ${ver.status}`)
    return ver.headers.getSetCookie().map(c => c.split(';')[0]!).join('; ')
  }

  beforeAll(async () => {
    await admin`delete from rate_limits`
    await admin`delete from otp_codes`
    recruitingWas = Boolean((await admin`select candidates_enabled from tenants where id = ${tenantId}`)[0]!.candidates_enabled)
    // До запуска процесса: флаг кешируется в процессе на минуту (`modules.isRecruitingEnabled`).
    await admin`update tenants set candidates_enabled = true where id = ${tenantId}`
    server = spawn('node', ['.output/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), NITRO_PORT: String(PORT), OTP_DEBUG: '1', NUXT_DATABASE_URL: process.env.DATABASE_URL, WORKER_ENABLED: '0' }, stdio: 'ignore' })
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${BASE}/health`)).ok) return }
      catch { /* ещё поднимается */ }
      await new Promise(r => setTimeout(r, 500))
    }
    throw new Error('Собранное приложение не поднялось за 30 секунд')
  }, 90_000)

  afterAll(async () => {
    server?.kill()
    await admin`update tenants set candidates_enabled = ${recruitingWas} where id = ${tenantId}`
    await admin`delete from rate_limits`
    await admin`delete from otp_codes`
  })

  it('GET /review/items/:id — 200 без phone / email / resume_asset_id у обоих звеньев цепочки', async () => {
    for (const key of ['b', 'c']) {
      const cookie = await login(PEOPLE.find(p => p[0] === key)![2])
      const res = await fetch(`${BASE}/api/v1/review/items/${itemId}`, { headers: { cookie } })
      expect(res.status, `${key}: карточка проверки не отдана`).toBe(200)
      const body = await res.json() as { data: unknown }
      assertNoPd(body, `${key} (HTTP)`)
    }
  })

  it('контроль: при включённом рекрутинге маршрут карточки жив — администратор получает 200', async () => {
    const cookie = await login('+380661864742')
    const res = await fetch(`${BASE}/api/v1/candidates/${candidateId}`, { headers: { cookie } })
    expect(res.status, 'маршрут карточки кандидата недоступен вовсе — 404 делегатам ничего бы не доказал').toBe(200)
  })

  it('GET /candidates/:id — 404 not_found у обоих звеньев цепочки', async () => {
    for (const key of ['b', 'c']) {
      const cookie = await login(PEOPLE.find(p => p[0] === key)![2])
      const res = await fetch(`${BASE}/api/v1/candidates/${candidateId}`, { headers: { cookie } })
      const body = await res.json() as { error?: { code: string }, data?: unknown }
      expect(res.status, `${key}: ответ ${JSON.stringify(body.error ?? 'data')}`).toBe(404)
      expect(body.error?.code, `${key}: отказ не решением о видимости, а другим запретом`).toBe('not_found')
      assertNoPd(body, `${key} (HTTP /candidates)`)
    }
  })
})
