import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Отсутствия человека по HTTP (PR-33 пакета `docs/v2`, образец — `v2-person-records-http.spec.ts`).
 *
 * Коды ответа `docs/v2/38` §10: пересечение — `409 absence_overlap` с конфликтующим периодом,
 * период наоборот — `422 absence_record.range_invalid`, статус назад — `409 absence_status_invalid`.
 * Права: свои отсутствия сотрудник видит (`200`), чужие — `403`, вносить не может; чужой тенант,
 * кандидат и мусорный id — `404`. Журнал записи пишет технический контекст (CLAUDE.md п. 14).
 * Бизнес-правила остатка и сдвига дедлайнов — `v2-absences.spec.ts`.
 */
const BUILT = existsSync('.output/server/index.mjs')
const PORT = 3833
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN_PHONE = '+380661864742'
const EMPLOYEE_PHONE = '+380670000003'
const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const stamp = Date.now()

let server: ChildProcess | undefined
let tenantId: string, adminId: string, subjectId: string, employeeId: string, otherTenantId: string, foreignPersonId: string

async function login(phone: string): Promise<string> {
  const req = await fetch(`${BASE}/api/v1/auth/otp/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) })
  const body = await req.json() as { data: { devCode?: string } }
  if (!body.data?.devCode) throw new Error(`Нет devCode для ${phone}: ${JSON.stringify(body)}`)
  const ver = await fetch(`${BASE}/api/v1/auth/otp/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, code: body.data.devCode }) })
  if (!ver.ok) throw new Error(`verify ${phone} → ${ver.status}`)
  return ver.headers.getSetCookie().map(c => c.split(';')[0]!).join('; ')
}
const csrfOf = (cookie: string) => cookie.split('; ').find(c => c.startsWith('lola_csrf='))?.split('=')[1] ?? ''
const json = (cookie: string, method: string, body?: unknown) => ({ method, headers: { 'cookie': cookie, 'x-csrf-token': csrfOf(cookie), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const data = async <T>(res: Response) => ((await res.json()) as { data: T }).data
const errOf = async (res: Response) => ((await res.json()) as { error: { code: string, details?: Record<string, unknown> } }).error

describe.skipIf(!BUILT)('Відсутності людини по HTTP', () => {
  let adm: string

  beforeAll(async () => {
    await admin`delete from rate_limits`
    await admin`delete from otp_codes`
    tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
    adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = ${ADMIN_PHONE}`)[0]!.id as string
    employeeId = (await admin`select id from users where tenant_id = ${tenantId} and phone = ${EMPLOYEE_PHONE}`)[0]!.id as string
    const [lazareva] = await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`
    const [pos] = await admin`select id from positions where tenant_id = ${tenantId} order by created_at limit 1`
    const [u] = await admin`insert into users (tenant_id, phone, full_name, status) values (${tenantId}, ${`+38096${String(stamp).slice(-7)}`}, ${`HTTP-відсутності ${stamp}`}, 'active') returning id`
    subjectId = u!.id as string
    await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary, started_at) values (${tenantId}, ${subjectId}, ${lazareva!.id}, ${pos!.id}, true, current_date - 10)`
    const [other] = await admin`insert into tenants (slug, name) values (${`http-absences-${stamp}`}, 'Чужий тенант відсутностей') returning id`
    otherTenantId = other!.id as string
    foreignPersonId = (await admin`insert into users (tenant_id, phone, full_name, status) values (${otherTenantId}, '+380960000001', 'Чужа людина', 'active') returning id`)[0]!.id as string

    server = spawn('node', ['.output/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), NITRO_PORT: String(PORT), OTP_DEBUG: '1', NUXT_DATABASE_URL: process.env.DATABASE_URL, WORKER_ENABLED: '0' }, stdio: 'ignore' })
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${BASE}/health`)).ok) break
      }
      catch { /* ещё поднимается */ }
      await new Promise(r => setTimeout(r, 500))
    }
    adm = await login(ADMIN_PHONE)
  }, 90_000)

  afterAll(async () => {
    server?.kill()
    await admin`delete from audit_log where tenant_id = ${tenantId} and entity = 'absence_record' and after->>'userId' in (${subjectId}, ${employeeId})`
    await admin`delete from absence_records where user_id in (${subjectId}, ${employeeId})`
    await admin`delete from user_placements where user_id = ${subjectId}`
    await admin`delete from users where id in (${subjectId}, ${foreignPersonId})`
    await admin`delete from tenants where id = ${otherTenantId}`
    await admin.end()
  })

  beforeEach(async () => { await admin`delete from rate_limits` })

  it('внести отсутствие — 201; журнал с техническим контекстом', async () => {
    const res = await fetch(`${BASE}/api/v1/people/${subjectId}/absences`, json(adm, 'POST', { kind: 'vacation', dateFrom: '2035-07-10', dateTo: '2035-07-20', status: 'approved', comment: 'Літня відпустка' }))
    expect(res.status).toBe(201)
    const body = await res.json() as { data: { id: string, daysCount: number, status: string, source: string }, meta: { shifted: number } }
    expect(body.data).toMatchObject({ daysCount: 11, status: 'approved', source: 'manual' })
    expect(body.meta.shifted).toBe(0)
    const [row] = await admin`select actor_id, request_context from audit_log where action = 'absence_record.create' and entity_id = ${body.data.id}`
    expect(row!.actor_id).toBe(adminId)
    expect(row!.request_context).not.toBeNull()
  })

  it('пересечение — 409 absence_overlap с периодом; период наоборот — 422; мусор в теле — 400', async () => {
    const overlap = await fetch(`${BASE}/api/v1/people/${subjectId}/absences`, json(adm, 'POST', { kind: 'sick', dateFrom: '2035-07-18', dateTo: '2035-07-22', status: 'approved' }))
    expect(overlap.status).toBe(409)
    expect(await errOf(overlap)).toMatchObject({ code: 'absence_overlap', details: { conflict: { dateFrom: '2035-07-10', dateTo: '2035-07-20' } } })
    const reversed = await fetch(`${BASE}/api/v1/people/${subjectId}/absences`, json(adm, 'POST', { kind: 'sick', dateFrom: '2035-08-10', dateTo: '2035-08-01', status: 'approved' }))
    expect(reversed.status).toBe(422)
    expect(await errOf(reversed)).toMatchObject({ code: 'absence_record.range_invalid', details: { reason: 'order' } })
    const junk = await fetch(`${BASE}/api/v1/people/${subjectId}/absences`, json(adm, 'POST', { kind: 'holiday', dateFrom: '2035-09-01', dateTo: '2035-09-02' }))
    expect(junk.status).toBe(400)
    expect((await errOf(junk)).code).toBe('validation_failed')
  })

  it('статус только вперёд — 409 absence_status_invalid; блок карточки считает остаток', async () => {
    const card = await fetch(`${BASE}/api/v1/people/${subjectId}/absences?year=2035`, { headers: { cookie: adm } })
    expect(card.status).toBe(200)
    const c = await data<{ used: { vacation: number }, norms: { vacation: { value: number, source: string } }, records: { id: string, status: string }[], can: { record: boolean } }>(card)
    expect(c.used.vacation).toBe(11)
    expect(c.norms.vacation.source).toBe('system')
    expect(c.can.record).toBe(true)
    const back = await fetch(`${BASE}/api/v1/people/${subjectId}/absences/${c.records[0]!.id}`, json(adm, 'PATCH', { status: 'planned' }))
    expect(back.status).toBe(409)
    expect((await errOf(back)).code).toBe('absence_status_invalid')
  })

  it('сотрудник свои видит, чужие — 403 и вносить не может; чужой тенант, кандидат и мусорный id — 404', async () => {
    const emp = await login(EMPLOYEE_PHONE)
    const own = await fetch(`${BASE}/api/v1/people/${employeeId}/absences`, { headers: { cookie: emp } })
    expect(own.status).toBe(200)
    expect((await data<{ can: { record: boolean } }>(own)).can.record).toBe(false)
    expect((await fetch(`${BASE}/api/v1/people/${subjectId}/absences`, { headers: { cookie: emp } })).status).toBe(403)
    const post = await fetch(`${BASE}/api/v1/people/${employeeId}/absences`, json(emp, 'POST', { kind: 'vacation', dateFrom: '2035-10-01', dateTo: '2035-10-02', status: 'approved' }))
    expect(post.status).toBe(403)
    expect((await fetch(`${BASE}/api/v1/people/${foreignPersonId}/absences`, { headers: { cookie: adm } })).status).toBe(404)
    expect((await fetch(`${BASE}/api/v1/people/not-a-uuid/absences`, { headers: { cookie: adm } })).status).toBe(404)
    const [candidate] = await admin`select id from users where tenant_id = ${tenantId} and kind = 'candidate' limit 1`
    if (candidate) expect((await fetch(`${BASE}/api/v1/people/${candidate.id as string}/absences`, { headers: { cookie: adm } })).status).toBe(404)
  })
})
