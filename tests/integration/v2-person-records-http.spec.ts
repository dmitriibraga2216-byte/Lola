import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Заметки и документы человека по HTTP (PR-32 пакета `docs/v2`, образец — `v2-lifecycle-http.spec.ts`).
 *
 * Главное здесь — коды ответа из условий выхода плана (`docs/v2/45-plan.md` PR-32) и критериев
 * `docs/v2/38` §13: сужение видимости открытой человеку заметки — `409
 * visibility_narrowing_forbidden` (п. 5); тип «лише факт» с файлом — `422
 * document_file_not_allowed`, запись не создаётся (п. 7); `GET` ленты заметок пишет
 * `person_note.read` (п. 4). Плюс то, что делает права правами, а не надписью: чужой тенант —
 * `404`, сотрудник чужие заметки не читает (`403`), файл документа не отдаётся общим
 * `GET /media/:id`.
 */
const BUILT = existsSync('.output/server/index.mjs')
const PORT = 3832
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN_PHONE = '+380661864742'
const EMPLOYEE_PHONE = '+380670000003'
const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const stamp = Date.now()

let server: ChildProcess | undefined
let tenantId: string, adminId: string, subjectId: string, employeeId: string, otherTenantId: string, foreignPersonId: string
let medicalBookId: string, mediaId: string

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

describe.skipIf(!BUILT)('Заметки и документы человека по HTTP', () => {
  let adm: string

  beforeAll(async () => {
    await admin`delete from rate_limits`
    await admin`delete from otp_codes`
    tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
    adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = ${ADMIN_PHONE}`)[0]!.id as string
    employeeId = (await admin`select id from users where tenant_id = ${tenantId} and phone = ${EMPLOYEE_PHONE}`)[0]!.id as string
    const [lazareva] = await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`
    const [pos] = await admin`select id from positions where tenant_id = ${tenantId} order by created_at limit 1`
    const [u] = await admin`insert into users (tenant_id, phone, full_name, status) values (${tenantId}, ${`+38095${String(stamp).slice(-7)}`}, ${`HTTP-нотатки ${stamp}`}, 'active') returning id`
    subjectId = u!.id as string
    await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary, started_at) values (${tenantId}, ${subjectId}, ${lazareva!.id}, ${pos!.id}, true, current_date - 10)`
    medicalBookId = (await admin`select id from person_document_types where tenant_id = ${tenantId} and code = 'medical_book'`)[0]!.id as string
    mediaId = (await admin`insert into media_assets (tenant_id, key, original_name, kind, mime, bytes, status, owner_user_id, origin)
      values (${tenantId}, ${`t/${tenantId}/http/${stamp}.jpg`}, 'medbook.jpg', 'image', 'image/jpeg', 50000, 'ready', ${adminId}, 'person_document') returning id`)[0]!.id as string
    const [other] = await admin`insert into tenants (slug, name) values (${`http-notes-${stamp}`}, 'Чужий тенант нотаток') returning id`
    otherTenantId = other!.id as string
    foreignPersonId = (await admin`insert into users (tenant_id, phone, full_name, status) values (${otherTenantId}, '+380950000001', 'Чужа людина', 'active') returning id`)[0]!.id as string

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
    await admin`delete from notifications where user_id = ${subjectId} or (tenant_id = ${tenantId} and code = 'person_note_flagged')`
    await admin`delete from audit_log where tenant_id = ${tenantId} and (entity_id = ${subjectId} or action like 'person_note.%' or action like 'person_document%' or entity_id = ${mediaId})`
    await admin`delete from user_notes where user_id = ${subjectId}`
    await admin`delete from person_documents where user_id = ${subjectId}`
    await admin`delete from media_assets where id = ${mediaId}`
    await admin`delete from user_placements where user_id = ${subjectId}`
    await admin`delete from users where id in (${subjectId}, ${foreignPersonId})`
    await admin`delete from tenants where id = ${otherTenantId}`
    await admin.end()
  })

  beforeEach(async () => { await admin`delete from rate_limits` })

  it('§13 п. 5: открытую человеку заметку не сузить — 409 visibility_narrowing_forbidden', async () => {
    const created = await fetch(`${BASE}/api/v1/people/${subjectId}/notes`, json(adm, 'POST', { body: `Домовились про наставника ${stamp}`, category: 'agreement', visibility: 'shared_with_person' }))
    expect(created.status).toBe(201)
    const note = await data<{ id: string, visibility: string }>(created)
    expect(note.visibility).toBe('shared_with_person')
    const narrow = await fetch(`${BASE}/api/v1/people/${subjectId}/notes/${note.id}`, json(adm, 'PATCH', { visibility: 'manager' }))
    expect(narrow.status).toBe(409)
    expect((await errOf(narrow)).code).toBe('visibility_narrowing_forbidden')
  })

  it('§13 п. 4: GET ленты пишет person_note.read с note_ids и без текста', async () => {
    const res = await fetch(`${BASE}/api/v1/people/${subjectId}/notes`, { headers: { cookie: adm } })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { id: string }[], meta: { cursor: string | null, total: number } }
    expect(body.meta.total).toBe(body.data.length)
    expect(body.meta.cursor).toBeNull() // одна страница — курсора нет
    const [row] = await admin`select after, request_context from audit_log where tenant_id = ${tenantId} and action = 'person_note.read' and actor_id = ${adminId} and entity_id = ${subjectId} order by created_at desc limit 1`
    expect((row!.after as { note_ids: string[] }).note_ids).toEqual(body.data.map(i => i.id))
    expect(JSON.stringify(row!.after)).not.toContain('Домовились')
    expect(row!.request_context).not.toBeNull() // CLAUDE.md п. 14: журнал пишет технический контекст
    // Счётчик свёрнутой секции — без журнала
    const count = await fetch(`${BASE}/api/v1/people/${subjectId}/notes/count`, { headers: { cookie: adm } })
    expect(await data<{ total: number }>(count)).toMatchObject({ total: body.meta.total })
    // Битый курсор — 400, а не первая страница (docs/04 §4.1)
    expect((await fetch(`${BASE}/api/v1/people/${subjectId}/notes?cursor=abc`, { headers: { cookie: adm } })).status).toBe(400)
  })

  it('короткий текст — 422 note_body_invalid; чувствительный — 409 с признаками, после подтверждения — 201', async () => {
    const short = await fetch(`${BASE}/api/v1/people/${subjectId}/notes`, json(adm, 'POST', { body: ' ок ' }))
    expect(short.status).toBe(422)
    expect((await errOf(short)).code).toBe('note_body_invalid')
    const text = `Хворів тиждень, переносимо дедлайн ${stamp}`
    const sensitive = await fetch(`${BASE}/api/v1/people/${subjectId}/notes`, json(adm, 'POST', { body: text }))
    expect(sensitive.status).toBe(409)
    const err = await errOf(sensitive)
    expect(err.code).toBe('note_sensitive_suspected')
    expect(err.details?.signs).toEqual(['health'])
    const confirmed = await fetch(`${BASE}/api/v1/people/${subjectId}/notes`, json(adm, 'POST', { body: text, confirmSensitive: true }))
    expect(confirmed.status).toBe(201)
    expect((await data<{ flagged: boolean }>(confirmed)).flagged).toBe(true)
  })

  it('§13 п. 7: medical_book с файлом — 422 document_file_not_allowed, записи нет', async () => {
    const res = await fetch(`${BASE}/api/v1/people/${subjectId}/documents`, json(adm, 'POST', { typeId: medicalBookId, mediaId, issuedAt: '2026-09-01', expiresAt: '2027-09-01' }))
    expect(res.status).toBe(422)
    expect((await errOf(res)).code).toBe('document_file_not_allowed')
    const [n] = await admin`select count(*)::int as n from person_documents where user_id = ${subjectId}`
    expect(n!.n).toBe(0)
    // Без файла — факт и срок
    const fact = await fetch(`${BASE}/api/v1/people/${subjectId}/documents`, json(adm, 'POST', { typeId: medicalBookId, issuedAt: '2026-09-01', expiresAt: '2027-09-01', number: 'АБ 7654321' }))
    expect(fact.status).toBe(201)
    expect((await data<{ numberMasked: string }>(fact)).numberMasked).toBe('****4321')
  })

  it('файл документа не отдаётся общим GET /media/:id — только через документ', async () => {
    const res = await fetch(`${BASE}/api/v1/media/${mediaId}`, { headers: { cookie: adm } })
    expect(res.status).toBe(404)
  })

  it('сотрудник чужие заметки не читает (403), свои — читает; чужой тенант и мусорный id — 404', async () => {
    const emp = await login(EMPLOYEE_PHONE)
    expect((await fetch(`${BASE}/api/v1/people/${subjectId}/notes`, { headers: { cookie: emp } })).status).toBe(403)
    const own = await fetch(`${BASE}/api/v1/people/${employeeId}/notes`, { headers: { cookie: emp } })
    expect(own.status).toBe(200)
    const docs = await fetch(`${BASE}/api/v1/people/${employeeId}/documents`, { headers: { cookie: emp } })
    expect(docs.status).toBe(200)
    expect((await data<{ types: { code: string }[] }>(docs)).types.map(t => t.code)).toEqual(['external_certificate'])
    expect((await fetch(`${BASE}/api/v1/people/${foreignPersonId}/notes`, { headers: { cookie: adm } })).status).toBe(404)
    expect((await fetch(`${BASE}/api/v1/people/${foreignPersonId}/documents`, { headers: { cookie: adm } })).status).toBe(404)
    expect((await fetch(`${BASE}/api/v1/people/not-a-uuid/notes`, { headers: { cookie: adm } })).status).toBe(404)
  })

  it('справочник типов: системный не удаляется — 409 type_is_system', async () => {
    const res = await fetch(`${BASE}/api/v1/person-document-types/${medicalBookId}`, json(adm, 'DELETE'))
    expect(res.status).toBe(409)
    expect((await errOf(res)).code).toBe('type_is_system')
  })
})
