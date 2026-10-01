import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeEvent, type FakeEvent } from './_nitroGlobals'

/**
 * Отчёты карточки человека `docs/v2/38` §9 п. 1–4 и «Розподіл по точці» (§7.3) — запись `46`
 * «package-criteria-tails», часть 3; решения `44` Р-BT.4, Р-BT.5. Данные — свои строки на людей
 * посева «Каппі» (документы, нормы 2031 года, активность марта 2020-го, снимки индекса), после
 * файла убираются.
 */

const { documentsReport, documentsExportRows, absenceNormsReport, activityReport } = await import('../../server/services/peopleReports')
const { personEngagement } = await import('../../server/services/engagementIndex')
const { loadAccess } = await import('../../server/services/access')
const documentsGet = (await import('../../server/api/v1/reports/documents.get')).default as unknown as (e: FakeEvent) => Promise<unknown>

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const stamp = Date.now()

let tenantId: string
let adminId: string
let cookId: string
let cashierId: string
let lazareva: string
let segedska: string
const typeId: Record<string, string> = {}
const tempUsers: string[] = []
const ctx = () => ({ tenantId, actorId: adminId })

const pick = async (phone: string) => (await admin`select id from users where tenant_id = ${tenantId} and phone = ${phone}`)[0]!.id as string
const iso = (d: Date) => d.toISOString().slice(0, 10)
const inDays = (n: number) => iso(new Date(Date.now() + n * 86_400_000))

async function cleanup() {
  await admin`delete from person_documents where tenant_id = ${tenantId} and note like ${`pcr-${'%'}`}`
  await admin`delete from absence_records where tenant_id = ${tenantId} and comment like ${'pcr-%'}`
  await admin`delete from absence_norms where tenant_id = ${tenantId} and year = 2031`
  await admin`delete from user_activity_daily where tenant_id = ${tenantId} and local_date between '2020-03-01' and '2020-03-31'`
  await admin`delete from person_rating_snapshots where tenant_id = ${tenantId} and calc_date = '2020-01-01'`
  await admin`update person_document_types set visible_to_manager = true where tenant_id = ${tenantId} and code = 'nda'`
  const temp = (await admin`select id from users where tenant_id = ${tenantId} and phone like '+38067555%'`).map(r => r.id as string)
  if (temp.length) {
    await admin`delete from user_placements where user_id in ${admin(temp)}`
    await admin`delete from users where id in ${admin(temp)}`
  }
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = await pick('+380661864742')
  cookId = await pick('+380670000003')
  cashierId = await pick('+380670000004')
  lazareva = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  segedska = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Сегедська'`)[0]!.id as string
  for (const r of await admin`select id, code from person_document_types where tenant_id = ${tenantId}`) typeId[r.code as string] = r.id as string
  await cleanup()
})

afterAll(async () => {
  await cleanup()
  await admin.end()
})

async function doc(userId: string, type: string, o: { status?: string, issued?: string, expires?: string | null, uploadedBy?: string }) {
  const status = o.status ?? 'valid'
  await admin`insert into person_documents (tenant_id, user_id, type_id, status, issued_at, expires_at, uploaded_by, note, revoked_at, revoke_reason)
    values (${tenantId}, ${userId}, ${typeId[type]!}, ${status}, ${o.issued ?? '2026-01-10'}, ${o.expires ?? null}, ${o.uploadedBy ?? adminId}, ${`pcr-${stamp}`},
            ${status === 'revoked' ? new Date() : null}, ${status === 'revoked' ? 'тест' : null})`
}

describe('38 §9 п. 1–2: «Документи співробітників» и «Прострочені та близькі до завершення»', () => {
  beforeAll(async () => {
    await doc(cookId, 'medical_book', { status: 'expiring', expires: inDays(10) })
    await doc(cookId, 'labor_safety_briefing', { status: 'expired', expires: inDays(-3), uploadedBy: cookId })
    await doc(cookId, 'employment_contract', { status: 'valid' })
    await doc(cookId, 'fire_safety_briefing', { status: 'revoked', expires: inDays(100) })
    await doc(cashierId, 'medical_book', { status: 'expiring', expires: inDays(5) })
    await doc(cashierId, 'nda', { status: 'valid' })
  })

  it('п. 1: колонки, «Залишилось днів» от сегодня, «Завантажено співробітником»; отменённые — только явным статусом', async () => {
    const rows = await documentsReport(ctx(), { locations: null }, { preset: 'all', missingOnly: false, format: 'json' })
    const cook = rows.filter(r => r.userId === cookId)
    expect(cook.map(r => r.status).sort()).toEqual(['expired', 'expiring', 'valid'])
    const med = cook.find(r => r.type && r.status === 'expiring')!
    expect(med).toMatchObject({ fullName: 'Кухар Тестовий', location: 'Лазарева', position: expect.any(String), daysLeft: 10, uploadedBy: 'Адмін Каппі', selfUploaded: false })
    expect(cook.find(r => r.status === 'expired')).toMatchObject({ daysLeft: -3, selfUploaded: true })
    expect(cook.find(r => r.status === 'valid')!.daysLeft).toBeNull() // бессрочный
    const revoked = await documentsReport(ctx(), { locations: null }, { preset: 'all', status: 'revoked', missingOnly: false, format: 'json' })
    expect(revoked.filter(r => r.userId === cookId)).toHaveLength(1)
    // Кандидаты в отчёт не попадают ни при каком фильтре
    const kinds = await admin`select distinct kind from users where id in ${admin(rows.map(r => r.userId))}`
    expect(kinds.map(k => k.kind)).toEqual(['employee'])
  })

  it('п. 1: фильтры точки, типа, срока', async () => {
    const byLoc = await documentsReport(ctx(), { locations: null }, { preset: 'all', locationId: segedska, missingOnly: false, format: 'json' })
    expect(byLoc.every(r => r.location === 'Сегедська')).toBe(true)
    expect(byLoc.some(r => r.userId === cashierId)).toBe(true)
    const byType = await documentsReport(ctx(), { locations: null }, { preset: 'all', typeId: typeId.medical_book, missingOnly: false, format: 'json' })
    expect(new Set(byType.map(r => r.userId))).toEqual(new Set([cookId, cashierId]))
    const soon = await documentsReport(ctx(), { locations: null }, { preset: 'all', expiresFrom: inDays(0), expiresTo: inDays(7), missingOnly: false, format: 'json' })
    expect(soon.map(r => r.userId)).toEqual([cashierId])
  })

  it('п. 2: только expiring/expired, по сроку окончания', async () => {
    const rows = await documentsReport(ctx(), { locations: null }, { preset: 'expiring', status: 'valid', missingOnly: false, format: 'json' })
    expect(rows.every(r => r.status === 'expiring' || r.status === 'expired')).toBe(true)
    expect(rows.map(r => r.daysLeft)).toEqual([-3, 5, 10])
  })

  it('«Тільки відсутні обовʼязкові»: человек × обязательный тип без действующего документа', async () => {
    const rows = await documentsReport(ctx(), { locations: null }, { preset: 'all', missingOnly: true, format: 'json' })
    const cookMissing = rows.filter(r => r.userId === cookId).map(r => r.typeId)
    // Отменённый пожарный инструктаж — не действующий: он в «відсутніх»; трудовой договор — нет
    expect(cookMissing).toContain(typeId.fire_safety_briefing)
    expect(cookMissing).toContain(typeId.nda)
    expect(cookMissing).not.toContain(typeId.employment_contract)
    expect(cookMissing).not.toContain(typeId.external_certificate) // необязательный
    expect(rows.every(r => r.status === null && r.documentId === null)).toBe(true)
    expect(documentsExportRows(rows.slice(0, 1))[0]).toMatchObject({ status: 'Відсутній' })
  })

  it('руководитель точки: только свои точки и типы visible_to_manager (§2)', async () => {
    await admin`update person_document_types set visible_to_manager = false where tenant_id = ${tenantId} and code = 'nda'`
    const all = await documentsReport(ctx(), { locations: [segedska] }, { preset: 'all', missingOnly: false, format: 'json' })
    expect(all.every(r => r.location === 'Сегедська')).toBe(true)
    expect(all.some(r => r.typeId === typeId.nda)).toBe(false)
    expect(all.some(r => r.typeId === typeId.medical_book && r.userId === cashierId)).toBe(true)
    // HR видит и скрытый от руководителей тип
    const hr = await documentsReport(ctx(), { locations: null }, { preset: 'all', locationId: segedska, missingOnly: false, format: 'json' })
    expect(hr.some(r => r.typeId === typeId.nda)).toBe(true)
    await admin`update person_document_types set visible_to_manager = true where tenant_id = ${tenantId} and code = 'nda'`
  })

  it('ручка: сотруднику — 403; администратору — строки, файл xlsx', async () => {
    const employee = makeEvent({ path: '/api/v1/reports/documents' })
    employee.context.auth = { tenantId, userId: cookId }
    const err = await documentsGet(employee).then(() => null, (e: { statusCode?: number }) => e)
    expect(err?.statusCode).toBe(403)

    const ok = makeEvent({ path: '/api/v1/reports/documents', query: { preset: 'expiring' } })
    ok.context.auth = { tenantId, userId: adminId }
    const res = await documentsGet(ok) as { data: { userId: string }[] }
    expect(res.data.length).toBeGreaterThanOrEqual(3)
    const file = makeEvent({ path: '/api/v1/reports/documents', query: { format: 'xlsx' } })
    file.context.auth = { tenantId, userId: adminId }
    expect(Buffer.isBuffer(await documentsGet(file))).toBe(true)
    expect(file._headers['content-disposition']).toContain('lola-documents.xlsx')
  })
})

describe('38 §9 п. 3: «Норми і залишки відсутностей»', () => {
  beforeAll(async () => {
    await admin`insert into absence_norms (tenant_id, scope_type, scope_id, year, vacation_days, sick_days) values (${tenantId}, 'tenant', null, 2031, 20, null)`
    await admin`insert into absence_norms (tenant_id, scope_type, scope_id, year, vacation_days, sick_days, reason, set_by) values (${tenantId}, 'location', ${segedska}, 2031, null, 7, 'тест', ${adminId})`
    await admin`insert into absence_norms (tenant_id, scope_type, scope_id, year, vacation_days, reason, set_by) values (${tenantId}, 'user', ${cookId}, 2031, 3, 'Перевірка звіту', ${adminId})`
    // Пересекает год: в 2031 — 5 дней из 9; запланированный в остаток не входит
    await admin`insert into absence_records (tenant_id, user_id, kind, date_from, date_to, days_count, status, comment) values (${tenantId}, ${cookId}, 'vacation', '2030-12-28', '2031-01-05', 9, 'approved', 'pcr-1')`
    await admin`insert into absence_records (tenant_id, user_id, kind, date_from, date_to, days_count, status, comment) values (${tenantId}, ${cookId}, 'vacation', '2031-06-01', '2031-06-10', 10, 'planned', 'pcr-2')`
    await admin`insert into absence_records (tenant_id, user_id, kind, date_from, date_to, days_count, status, comment) values (${tenantId}, ${cashierId}, 'sick', '2031-02-01', '2031-02-02', 2, 'approved', 'pcr-3')`
  })

  it('строка на вид: норма и её источник, использовано пересечением с годом, остаток (отрицательный — как есть)', async () => {
    const rows = await absenceNormsReport(ctx(), null, { year: 2031, negativeOnly: false, format: 'json' })
    const row = (u: string, k: string) => rows.find(r => r.userId === u && r.kind === k)
    expect(row(cookId, 'vacation')).toMatchObject({ norm: 3, normSource: 'user', used: 5, remaining: -2, location: 'Лазарева' })
    expect(row(cookId, 'sick')).toMatchObject({ norm: 5, normSource: 'system', used: 0, remaining: 5 })
    expect(row(cashierId, 'vacation')).toMatchObject({ norm: 20, normSource: 'tenant', used: 0 })
    expect(row(cashierId, 'sick')).toMatchObject({ norm: 7, normSource: 'location', used: 2, remaining: 5 })
  })

  it('«Тільки відʼємний залишок» и область точек', async () => {
    const neg = await absenceNormsReport(ctx(), null, { year: 2031, negativeOnly: true, format: 'json' })
    expect(neg.map(r => `${r.userId}:${r.kind}`)).toEqual([`${cookId}:vacation`])
    const scoped = await absenceNormsReport(ctx(), [segedska], { year: 2031, negativeOnly: false, format: 'json' })
    expect(scoped.length).toBeGreaterThan(0)
    expect(scoped.every(r => r.location === 'Сегедська')).toBe(true)
  })
})

describe('38 §9 п. 4: «Навчальна активність»', () => {
  beforeAll(async () => {
    // Серия 3 дня (1–3), разрыв, серия 2 дня (5–6); день без событий серию не продолжает
    const days: [string, number, number][] = [['2020-03-01', 2, 1800], ['2020-03-02', 1, 600], ['2020-03-03', 4, 3600], ['2020-03-04', 0, 0], ['2020-03-05', 1, 1200], ['2020-03-06', 3, 0]]
    for (const [d, n, sec] of days) {
      await admin`insert into user_activity_daily (tenant_id, user_id, local_date, events_count, seconds_spent, level) values (${tenantId}, ${cookId}, ${d}, ${n}, ${sec}, ${n > 0 ? 1 : 0})`
    }
  })

  it('дни, серия, события и часы за период; фильтр точки только сужает область', async () => {
    const rows = await activityReport(ctx(), null, { from: '2020-03-01', to: '2020-03-31', format: 'json' })
    expect(rows.find(r => r.userId === cookId)).toMatchObject({ daysActive: 5, longestStreak: 3, totalEvents: 11, hours: 2, location: 'Лазарева' })
    const part = await activityReport(ctx(), null, { from: '2020-03-04', to: '2020-03-06', format: 'json' })
    expect(part.find(r => r.userId === cookId)).toMatchObject({ daysActive: 2, longestStreak: 2, totalEvents: 4 })
    expect(await activityReport(ctx(), [segedska], { from: '2020-03-01', to: '2020-03-31', locationId: lazareva, format: 'json' })).toEqual([])
    const own = await activityReport(ctx(), [lazareva], { from: '2020-03-01', to: '2020-03-31', locationId: lazareva, format: 'json' })
    expect(own.some(r => r.userId === cookId)).toBe(true)
  })
})

describe('38 §7.3: «Розподіл по точці» — гистограмма без имён', () => {
  async function snapshot(userId: string, total: number) {
    await admin`insert into person_rating_snapshots (tenant_id, user_id, calc_date, base_pct, total_pct, window_from, window_to)
      values (${tenantId}, ${userId}, '2020-01-01', ${Math.min(100, total)}, ${total}, '2019-01-01', '2020-01-01')`
  }

  it('меньше пяти человек с индексом — столбцов нет; пять — столбцы, свой отмечен, ни имён, ни id', async () => {
    const lazarevaPeople = (await admin`select up.user_id from user_placements up join users u on u.id = up.user_id
      where up.location_id = ${lazareva} and up.is_primary and up.ended_at is null and u.kind = 'employee' and u.status <> 'archived' and not u.is_hidden`).map(r => r.user_id as string)
    expect(lazarevaPeople.length).toBe(4)
    const totals = [12, 47, 55, 101]
    for (let i = 0; i < 4; i++) await snapshot(lazarevaPeople[i]!, totals[i]!)
    await snapshot(cashierId, 90) // другая точка — в распределение Лазаревой не входит
    const access = (await loadAccess({ sessionId: 'test', tenantId, userId: adminId, impersonatedBy: null, activeRoleId: null, previewRoleId: null }))!
    const subject = lazarevaPeople.indexOf(cookId) >= 0 ? cookId : lazarevaPeople[0]!
    const few = await personEngagement(access, subject)
    expect(few.ok && few.data.distribution).toMatchObject({ location: 'Лазарева', total: 4, tooFew: true, buckets: [], ownBucket: null })

    const [u] = await admin`insert into users (tenant_id, kind, full_name, phone, status) values (${tenantId}, 'employee', 'PCR Новенький', ${`+38067555${String(stamp).slice(-4)}`}, 'active') returning id`
    tempUsers.push(u!.id as string)
    await admin`insert into user_placements (tenant_id, user_id, location_id, position_id) values (${tenantId}, ${u!.id}, ${lazareva}, (select id from positions where tenant_id = ${tenantId} and code = 'cashier'))`
    await snapshot(u!.id as string, 50)

    const r = await personEngagement(access, subject)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const d = r.data.distribution!
    expect(d.tooFew).toBe(false)
    expect(d.total).toBe(5)
    expect(d.buckets).toHaveLength(13)
    expect(d.buckets.reduce((s, b) => s + b.count, 0)).toBe(5)
    expect(d.buckets.find(b => b.from === 50)!.count).toBe(2) // 55 и 50
    expect(d.buckets.find(b => b.from === 100)!.count).toBe(1)
    const own = totals[lazarevaPeople.indexOf(subject)]!
    expect(d.ownBucket).toBe(Math.floor(own / 10))
    const json = JSON.stringify(d)
    expect(json).not.toContain('PCR Новенький')
    for (const id of [...lazarevaPeople, u!.id as string]) expect(json).not.toContain(id)
  })
})
