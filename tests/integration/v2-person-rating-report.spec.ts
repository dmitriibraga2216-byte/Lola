import { existsSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Отчёт «Індекс залученості» и ретро-расчёт (docs/v2/38 §5.3, §7.2, §7.3, §9 п. 5; person-card-tails).
 * Отчёт: область смотрящего, только сотрудники без уволенных и скрытых, порядок по ПІБ (Р-38.6),
 * файл — только с подтверждением и первой строкой-предупреждением. Ретро-расчёт: снимок на конец
 * прошедшего месяца «как было» (Р-38.7), настоящий снимок не перезаписывается, текущая цифра не
 * трогается, повтор ничего не меняет.
 */

const E = await import('../../server/services/engagementIndex')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const stamp = Date.now()
let tenantId: string, lazarevaId: string, otherLocId: string, posId: string, courseId: string, versionId: string, adminId: string
let aId: string, bId: string, elsewhereId: string, hiddenId: string, archivedId: string, candidateId: string, retroId: string, realId: string
const userIds: string[] = []
const assignmentIds: string[] = []
const ctx = () => ({ tenantId, actorId: adminId })

async function makePerson(name: string, locationId: string | null, extra: { kind?: 'candidate', hidden?: boolean, archived?: boolean } = {}) {
  const phone = `+38092${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, phone, full_name, status, kind, candidate_state, is_hidden)
    values (${tenantId}, ${phone}, ${`${name}-${stamp}`}, ${extra.archived ? 'archived' : 'active'}, ${extra.kind ?? 'employee'},
            ${extra.kind === 'candidate' ? 'active' : null}, ${extra.hidden ?? false}) returning id`
  const id = u!.id as string
  userIds.push(id)
  if (locationId) await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary, started_at) values (${tenantId}, ${id}, ${locationId}, ${posId}, true, current_date - 400)`
  return id
}

async function currentSnapshot(userId: string, total: number) {
  await admin`insert into person_rating_snapshots (tenant_id, user_id, calc_date, base_pct, bonus_early, bonus_streak, bonus_help, total_pct, breakdown, window_from, window_to, is_current)
    values (${tenantId}, ${userId}, current_date, ${Math.min(total, 100)}, 0, 0, 0, ${Math.min(total, 100)}, '{}'::jsonb, current_date - 364, current_date, true)`
}

/** Запись на курс: дни от сейчас (минус — в прошлом). */
async function enroll(userId: string, p: { status: string, assigned: number, due: number, completed?: number, started?: number }) {
  const [a] = await admin`insert into assignments (tenant_id, title, subject_type, subject_id, audience, is_mandatory, status)
    values (${tenantId}, ${`Ретро ${stamp}`}, 'course', ${courseId}, ${admin.json({ rules: [], match: 'any' })}, true, 'active') returning id`
  assignmentIds.push(a!.id as string)
  const days = (n: number | undefined) => (n === undefined ? null : new Date(Date.now() + n * 86_400_000))
  await admin`insert into enrollments (tenant_id, user_id, subject_id, version_id, assignment_id, source, status, progress_pct, created_at, due_at, completed_at, started_at, required_total, required_done)
    values (${tenantId}, ${userId}, ${courseId}, ${versionId}, ${a!.id}, 'assigned', ${p.status}, ${p.status === 'done' ? 100 : 0}, ${days(p.assigned)}, ${days(p.due)}, ${days(p.completed)}, ${days(p.started)}, 4, ${p.status === 'done' ? 4 : 0})`
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  const [laz] = await admin`select id, org_unit_id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`
  lazarevaId = laz!.id as string
  otherLocId = (await admin`insert into locations (tenant_id, org_unit_id, name) values (${tenantId}, ${laz!.org_unit_id}, ${`Звіт-індекс-${stamp}`}) returning id`)[0]!.id as string
  posId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Посада-report-${stamp}`}, 'report-pos') returning id`)[0]!.id as string
  const [c] = await admin`insert into courses (tenant_id, title, slug, status) values (${tenantId}, ${`Ретро-курс ${stamp}`}, ${`retro-${stamp}`}, 'published') returning id`
  courseId = c!.id as string
  versionId = (await admin`insert into course_versions (tenant_id, course_id, version) values (${tenantId}, ${courseId}, 1) returning id`)[0]!.id as string

  // «Я-…» раньше «А-…» по времени создания — порядок отчёта обязан быть по ПІБ, а не по индексу
  bId = await makePerson('Я-звіт найвищий', lazarevaId)
  aId = await makePerson('А-звіт низький', lazarevaId)
  elsewhereId = await makePerson('Б-звіт інша точка', otherLocId)
  hiddenId = await makePerson('В-звіт прихований', lazarevaId, { hidden: true })
  archivedId = await makePerson('Г-звіт звільнений', lazarevaId, { archived: true })
  candidateId = await makePerson('Д-звіт кандидат', lazarevaId, { kind: 'candidate' })
  for (const [id, total] of [[bId, 120], [aId, 40], [elsewhereId, 70], [hiddenId, 90], [archivedId, 60], [candidateId, 50]] as const) await currentSnapshot(id, total)

  retroId = await makePerson('Ретро-розрахунок', lazarevaId)
  realId = await makePerson('Справжній знімок', lazarevaId)
})

afterAll(async () => {
  await admin`delete from audit_log where tenant_id = ${tenantId} and action in ('report.rating.export', 'person_rating.backfill') and actor_id = ${adminId} and created_at > now() - interval '1 hour'`
  await admin`delete from person_rating_snapshots where user_id in ${admin(userIds)}`
  await admin`delete from enrollments where user_id in ${admin(userIds)}`
  await admin`delete from assignments where id in ${admin(assignmentIds.length ? assignmentIds : ['00000000-0000-0000-0000-000000000000'])}`
  await admin`delete from user_placements where user_id in ${admin(userIds)}`
  await admin`delete from users where id in ${admin(userIds)}`
  await admin`delete from course_versions where course_id = ${courseId}`
  await admin`delete from courses where id = ${courseId}`
  await admin`delete from locations where id = ${otherLocId}`
  await admin`delete from positions where id = ${posId}`
  await admin.end()
})

const mine = (rows: { userId: string }[]) => rows.filter(r => userIds.includes(r.userId))

describe('«Індекс залученості» (§9 п. 5)', () => {
  it('весь тенант: только работающие видимые сотрудники, по ПІБ, без места', async () => {
    const rows = mine(await E.engagementIndexRows(ctx(), { scope: null }))
    expect(rows.map(r => r.userId)).toEqual([aId, elsewhereId, bId])
    expect(rows[0]).toMatchObject({ location: 'Лазарева', basePct: 40, totalPct: 40 })
    expect(Object.keys(rows[0]!)).not.toContain('rank')
  })

  it('руководитель точки видит только свою точку; поиск и фильтр точки сужают', async () => {
    expect(mine(await E.engagementIndexRows(ctx(), { scope: [otherLocId] })).map(r => r.userId)).toEqual([elsewhereId])
    expect(mine(await E.engagementIndexRows(ctx(), { scope: [] }))).toEqual([])
    expect(mine(await E.engagementIndexRows(ctx(), { scope: null, locationId: lazarevaId })).map(r => r.userId)).toEqual([aId, bId])
    expect(mine(await E.engagementIndexRows(ctx(), { scope: null, q: `Я-звіт найвищий-${stamp}` })).map(r => r.userId)).toEqual([bId])
  })

  it('файл: первая строка — предупреждение, дальше колонки §9; конструктор — пусто без подтверждения, с областью', async () => {
    const flat = E.engagementExportRows(await E.engagementIndexRows(ctx(), { scope: [otherLocId] }))
    expect(flat[0]!.full_name).toBe(E.ENGAGEMENT_REPORT_DISCLAIMER)
    expect(Object.keys(flat[1]!)).toEqual(['full_name', 'location', 'base_pct', 'bonus_early', 'bonus_streak', 'bonus_help', 'total_pct'])
    expect(await E.engagementIndexReport(ctx(), false)).toEqual([])
    expect(mine(await E.engagementIndexReport(ctx(), true, [otherLocId])).map(r => r.userId)).toEqual([elsewhereId])
  })
})

describe('ретро-расчёт индекса (§7.2, Р-38.7)', () => {
  it('снимки на конец прошлых месяцев «как было», текущая цифра не тронута, настоящий снимок главнее, повтор — без изменений', async () => {
    const ends = (await admin`
      select (date_trunc('month', (now() at time zone 'Europe/Kyiv')::date) - make_interval(months => g - 1) - interval '1 day')::date::text as d
        from generate_series(1, 3) g order by g`).map(r => r.d as string)
    // Назначено 150 дней назад, завершено 40 дней назад при сроке 35 дней назад: на конец прошлого
    // месяца — сделано досрочно, на конец позапрошлого-но-одного — ещё не начато
    await enroll(retroId, { status: 'done', assigned: -150, due: -35, completed: -40, started: -45 })
    await enroll(realId, { status: 'done', assigned: -150, due: -35, completed: -40, started: -45 })
    // У второго в прошлом месяце уже есть настоящий ночной снимок — его не перезаписывают
    const realDate = `${ends[0]!.slice(0, 7)}-01`
    await admin`insert into person_rating_snapshots (tenant_id, user_id, calc_date, base_pct, bonus_early, bonus_streak, bonus_help, total_pct, breakdown, window_from, window_to, is_current)
      values (${tenantId}, ${realId}, ${realDate}, 55, 0, 0, 0, 55, '{}'::jsonb, ${realDate}::date - 364, ${realDate}, false)`

    const s = await E.backfillTenantEngagement(tenantId, 3)
    expect(s.months).toBe(3)
    expect(s.written).toBeGreaterThanOrEqual(2)

    const snaps = await admin`select calc_date::text as d, base_pct::float8 as base, total_pct::float8 as total, is_current, breakdown
      from person_rating_snapshots where user_id = ${retroId} order by calc_date desc`
    const last = snaps.find(r => r.d === ends[0])!
    expect(last).toMatchObject({ base: 100, is_current: false })
    expect(last.total).toBeGreaterThan(100) // досрочность
    expect((last.breakdown as { retro?: boolean }).retro).toBe(true)
    const third = snaps.find(r => r.d === ends[2])!
    expect(third.base).toBe(0) // на конец этого месяца запись уже назначена, но ещё не завершена
    expect((await admin`select rating_pct from users where id = ${retroId}`)[0]!.rating_pct).toBeNull()

    const real = await admin`select calc_date::text as d, total_pct::float8 as total from person_rating_snapshots where user_id = ${realId} and to_char(calc_date, 'YYYY-MM') = ${ends[0]!.slice(0, 7)}`
    expect(real).toEqual([{ d: realDate, total: 55 }])

    const again = await E.backfillTenantEngagement(tenantId, 3)
    const [n] = await admin`select count(*)::int as n from person_rating_snapshots where user_id = ${retroId}`
    expect(n!.n).toBe(snaps.length)
    expect(again.written).toBeLessThanOrEqual(s.written)
  })

  it('кандидат и уволенный в ретро-расчёт не попадают', async () => {
    await E.backfillTenantEngagement(tenantId, 1)
    const [n] = await admin`select count(*)::int as n from person_rating_snapshots where user_id in (${candidateId}, ${archivedId}) and not is_current`
    expect(n!.n).toBe(0)
  })
})

/** HTTP (`.output` в CI): права, подтверждение выгрузки, запуск ретро-расчёта. */
const BUILT = existsSync('.output/server/index.mjs')
const PORT = 3847
const BASE = `http://127.0.0.1:${PORT}`
describe.skipIf(!BUILT)('GET /reports/rating и POST /reports/rating/backfill по HTTP', () => {
  let server: ChildProcess | undefined
  let adm = ''
  const login = async (phone: string) => {
    const req = await fetch(`${BASE}/api/v1/auth/otp/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) })
    const body = await req.json() as { data: { devCode?: string } }
    const ver = await fetch(`${BASE}/api/v1/auth/otp/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, code: body.data.devCode }) })
    return ver.headers.getSetCookie().map(c => c.split(';')[0]!).join('; ')
  }
  const csrfOf = (cookie: string) => cookie.split('; ').find(c => c.startsWith('lola_csrf='))?.split('=')[1] ?? ''

  beforeAll(async () => {
    await admin`delete from rate_limits`
    await admin`delete from otp_codes`
    server = spawn('node', ['.output/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), NITRO_PORT: String(PORT), OTP_DEBUG: '1', NUXT_DATABASE_URL: process.env.DATABASE_URL, WORKER_ENABLED: '0' }, stdio: 'ignore' })
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${BASE}/health`)).ok) break
      }
      catch { /* ещё поднимается */ }
      await new Promise(r => setTimeout(r, 500))
    }
    adm = await login('+380661864742')
  }, 90_000)
  afterAll(() => { server?.kill() })

  it('администратор: JSON; файл без confirm — 400, с confirm — xlsx и запись в журнале; сотрудник — 403', async () => {
    const list = await fetch(`${BASE}/api/v1/reports/rating`, { headers: { cookie: adm } })
    expect(list.status).toBe(200)
    expect(((await list.json()) as { data: { userId: string }[] }).data.map(r => r.userId)).toContain(aId)
    expect((await fetch(`${BASE}/api/v1/reports/rating?format=xlsx`, { headers: { cookie: adm } })).status).toBe(400)
    const file = await fetch(`${BASE}/api/v1/reports/rating?format=csv&confirm=1`, { headers: { cookie: adm } })
    expect(file.status).toBe(200)
    expect(await file.text()).toContain('Показник довідковий')
    const [log] = await admin`select request_context from audit_log where action = 'report.rating.export' and actor_id = ${adminId} order by created_at desc limit 1`
    expect(log!.request_context).not.toBeNull()
    const emp = await login('+380670000003')
    expect((await fetch(`${BASE}/api/v1/reports/rating`, { headers: { cookie: emp } })).status).toBe(403)
    expect((await fetch(`${BASE}/api/v1/reports/rating/backfill`, { method: 'POST', headers: { 'cookie': emp, 'x-csrf-token': csrfOf(emp) } })).status).toBe(403)
  })

  it('ретро-расчёт ставится в очередь — 202', async () => {
    const res = await fetch(`${BASE}/api/v1/reports/rating/backfill`, { method: 'POST', headers: { 'cookie': adm, 'x-csrf-token': csrfOf(adm) } })
    expect(res.status).toBe(202)
    expect(((await res.json()) as { data: { queued: boolean } }).data.queued).toBe(true)
  })
})
