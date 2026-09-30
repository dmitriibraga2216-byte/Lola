import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * vacancies-tails, часть 2 — отчёты вакансий `docs/v2/29` §9.1–§9.6 (решения `v2/44` §20
 * Р-VT.6…Р-VT.9): эффективность вакансии когортой откликов, эффективность площадок по метке
 * `?s=`, журнал публикаций, защита публичных страниц без IP, использование ИИ, выгрузка
 * откликов с журналом. Область — как у реестра: вакансия чужой точки не видна ни строкой.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'
process.env.SESSION_SECRET ??= 'test-session-secret'
process.env.OTP_DEBUG = '1'

const { createVacancy, publishVacancy, updateVacancy, viewerOf } = await import('../../server/services/vacancies')
const { submitApplication, signNonce } = await import('../../server/services/publicApply')
const { connectAccount } = await import('../../server/services/jobBoardAccounts')
const { createPublications } = await import('../../server/services/vacancyPublications')
const R = await import('../../server/services/vacancyReports')
const { vacancyStatsRollupJob } = await import('../../server/jobs/vacancyPublish')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const PREFIX = 'v2-vr '
const PHONE_BASE = '+38067995'
const IP = '198.51.100.70'

let tenantId: string
let adminId: string
let recruiterId: string
let courseId: string
let locationId: string
let otherLocationId: string
let hr: ReturnType<typeof viewerOf>
let vacancyId: string
let token: string
let publicationId: string

const phone = (n: number) => `${PHONE_BASE}${String(n).padStart(4, '0')}`
let today = ''
const body = (n: number, over: Record<string, unknown> = {}) => ({
  fullName: `Марія Коваль${n}`, phone: phone(n), consent: true as const,
  formNonce: signNonce(vacancyId, Date.now() - 10_000), ...over,
}) as Parameters<typeof submitApplication>[1]

async function cleanup() {
  await admin`delete from rate_limits where key like 'apply:%'`
  await admin`delete from vacancy_publications where tenant_id = ${tenantId}`
  await admin`delete from tenant_secrets where tenant_id = ${tenantId} and key like 'jobboard:%'`
  await admin`delete from job_board_accounts where tenant_id = ${tenantId}`
  const vs = await admin`select id from vacancies where title like ${`${PREFIX}%`}`
  for (const v of vs) {
    await admin`delete from public_apply_attempts where vacancy_id = ${v.id}`
    await admin`delete from vacancy_applications where vacancy_id = ${v.id}`
    await admin`delete from vacancy_ai_generations where vacancy_id = ${v.id}`
    await admin`update users set vacancy_id = null where vacancy_id = ${v.id}`
  }
  const people = await admin`select id from users where phone like ${`${PHONE_BASE}%`}`
  for (const p of people) {
    await admin`delete from candidate_status_history where candidate_id = ${p.id}`
    await admin`delete from candidate_scores where candidate_id = ${p.id}`
    await admin`delete from enrollments where user_id = ${p.id}`
    await admin`delete from notifications where user_id = ${p.id}`
    await admin`delete from audit_log where entity_id = ${p.id}`
    await admin`delete from users where id = ${p.id}`
  }
  await admin`delete from assignments where title like ${`${PREFIX}%`}`
  for (const v of vs) {
    await admin`delete from audit_log where entity_id = ${v.id}`
    await admin`delete from vacancies where id = ${v.id}`
  }
  await admin`delete from otp_codes where phone like ${`${PHONE_BASE}%`}`
  await admin`delete from notifications where tenant_id = ${tenantId} and code like 'vacancy_%'`
}

async function newVacancy(title: string, over: Record<string, unknown> = {}) {
  const created = await createVacancy({ tenantId, actorId: adminId }, {
    title: `${PREFIX}${title}`, courseId, locationId, recruiterId, salaryCurrency: 'UAH', salaryVisible: false,
    publicApplyOtp: false, applyDailyCap: 200,
    assignmentTemplate: { dueMode: 'relative', dueDays: 7, isMandatory: true, params: {}, reminders: {}, notifyOnAssign: true },
    ...over,
  } as Parameters<typeof createVacancy>[1])
  const published = await publishVacancy(hr, created.id)
  expect(published.ok).toBe(true)
  const [row] = await admin`select public_token from vacancies where id = ${created.id}`
  return { id: created.id, token: row!.public_token as string }
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  recruiterId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380670000001'`)[0]!.id as string
  courseId = (await admin`select id from courses where tenant_id = ${tenantId} and status = 'published' order by title limit 1`)[0]!.id as string
  const locs = await admin`select id from locations where tenant_id = ${tenantId} order by name limit 2`
  locationId = locs[0]!.id as string
  otherLocationId = locs[1]!.id as string
  hr = viewerOf({ userId: adminId, tenantId, grants: [{ scopes: ['vacancy.view', 'vacancy.edit', 'vacancy.publish', 'vacancy.close'], scopeType: 'tenant', scopeId: null }] })
  // «Сегодня» отчётов — по поясу тенанта: в полночь по Киеву UTC ещё во вчерашнем дне.
  today = (await admin`select (now() at time zone timezone)::date::text as d from tenants where id = ${tenantId}`)[0]!.d as string
  await cleanup()

  // Вакансия с площадкой: одна публикация, отклики по её метке и без, спам, наём, пройденный курс.
  const v = await newVacancy('Звіти', { sourceBudget: 1000 })
  vacancyId = v.id
  token = v.token
  const acc = await connectAccount({ tenantId, actorId: adminId, isAdmin: true }, { provider: 'work_ua', ownerType: 'company', label: `${PREFIX}acc` })
  if (!acc.ok) throw new Error('account')
  const pub = await createPublications(hr, { isAdmin: true }, vacancyId, { confirm: true, accountIds: [acc.account.id] })
  if (!pub.ok) throw new Error('publication')
  publicationId = pub.publications[0]!.id

  const a1 = await submitApplication(token, body(1, { s: publicationId }), { ip: IP })
  await admin`delete from rate_limits where key like 'apply:%'`
  const a2 = await submitApplication(token, body(2, { s: publicationId }), { ip: `${IP}1` })
  await admin`delete from rate_limits where key like 'apply:%'`
  await submitApplication(token, body(3), { ip: `${IP}2` })
  await admin`delete from rate_limits where key like 'apply:%'`
  // honeypot 60 + быстрая отправка 40 + ссылки 30 → spam
  await submitApplication(token, body(4, { website: 'http://spam', comment: 'www.spam', formNonce: signNonce(vacancyId, Date.now()) }), { ip: `${IP}3` })
  if (!a1.ok || !a2.ok) throw new Error('apply')

  // Первый — прошёл курс и нанят; второй — только прошёл курс.
  for (const id of [a1.applicationId, a2.applicationId]) {
    const [app] = await admin`select candidate_id from vacancy_applications where id = ${id}`
    const cid = app!.candidate_id as string
    const updated = await admin`update enrollments set status = 'done' where user_id = ${cid} and subject_id = ${courseId} returning id`
    if (!updated.length) {
      const [cv] = await admin`select published_version_id from courses where id = ${courseId}`
      await admin`insert into enrollments (tenant_id, user_id, subject_type, subject_id, version_id, status)
                  values (${tenantId}, ${cid}, 'course', ${courseId}, ${cv!.published_version_id}, 'done')`
    }
  }
  const [hiredApp] = await admin`select candidate_id from vacancy_applications where id = ${a1.applicationId}`
  await admin`update users set kind = 'employee', candidate_state = null, converted_from_candidate_at = now(), hired_at = current_date
              where id = ${hiredApp!.candidate_id}`

  // Журнал попыток → свёртка; ИИ-блок без правки на опубликованной вакансии.
  await admin`insert into public_apply_attempts (tenant_id, vacancy_id, ip_hash, outcome, reason)
              select ${tenantId}, ${vacancyId}, 'h', 'view', null from generate_series(1, 8)`
  await admin`insert into public_apply_attempts (tenant_id, vacancy_id, ip_hash, outcome, reason)
              values (${tenantId}, ${vacancyId}, 'h', 'submit_blocked', 'ip_hour'), (${tenantId}, ${vacancyId}, 'h', 'submit_blocked', 'ip_hour')`
  await vacancyStatsRollupJob(tenantId)
  await admin`update vacancies set ai_blocks = ${admin.json({ description: { generatedBy: adminId, editedAt: null, acknowledged: true } })} where id = ${vacancyId}`
  await admin`insert into vacancy_ai_generations (tenant_id, vacancy_id, target, input, ops_charged, status, author_id)
              values (${tenantId}, ${vacancyId}, 'description', '{}'::jsonb, 1, 'ok', ${adminId}),
                     (${tenantId}, ${vacancyId}, 'description', '{}'::jsonb, 0, 'failed', ${adminId})`

  // Вакансия чужой точки — область рекрутера точки её не видит.
  await newVacancy('Чужа точка', { locationId: otherLocationId, recruiterId: adminId })
})

afterAll(async () => {
  await cleanup()
  await admin.end()
})

describe('§9.1 эффективность вакансии', () => {
  it('когорта откликов: спам не считается, принятые, прошедшие курс, нанятые, конверсии и срок найма', async () => {
    const r = await R.effectivenessReport(hr, { format: 'json' })
    const row = r.rows.find(x => x.vacancyId === vacancyId)!
    expect(row).toMatchObject({ views: 8, applications: 3, accepted: 3, completed: 2, hired: 1, daysToFirstHire: 0 })
    expect(row.viewToApplyPct).toBe(37.5)
    expect(row.applyToCompletedPct).toBe(66.7)
    expect(r.period.to).toBe(today)
  })

  it('период без откликов — нули, а не пропуск строки', async () => {
    const r = await R.effectivenessReport(hr, { from: '2020-01-01', to: '2020-01-31', format: 'json' })
    expect(r.rows.find(x => x.vacancyId === vacancyId)).toMatchObject({ views: 0, applications: 0, hired: 0, viewToApplyPct: null })
  })

  it('рекрутер точки не видит вакансию другой точки (область реестра)', async () => {
    const pointViewer = viewerOf({ userId: recruiterId, tenantId, grants: [{ scopes: ['vacancy.view'], scopeType: 'location', scopeId: locationId }] })
    const titles = (await R.effectivenessReport(pointViewer, { format: 'json' })).rows.map(x => x.title)
    expect(titles).toContain(`${PREFIX}Звіти`)
    expect(titles).not.toContain(`${PREFIX}Чужа точка`)
  })
})

describe('§9.2 эффективность площадок', () => {
  it('отклики и наймы — по метке публикации; бюджет вакансии на её площадку; стоимость найма', async () => {
    const r = await R.boardsReport(hr, { format: 'json' })
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toMatchObject({ provider: 'work_ua', ownerType: 'company', activePublications: 1, applications: 2, hired: 1, budget: 1000, costPerHire: 1000 })
    expect((await R.boardsReport(hr, { provider: 'telegram', format: 'json' })).rows).toHaveLength(0)
  })
})

describe('§9.3 журнал публикаций', () => {
  it('вакансия, площадка, инициатор, состояние и ретраи', async () => {
    const r = await R.publicationsReport(hr, { format: 'json' })
    const row = r.rows.find(x => x.publicationId === publicationId)!
    expect(row).toMatchObject({ vacancy: `${PREFIX}Звіти`, provider: 'work_ua', state: 'active', attempts: 0 })
    expect(row.initiator).toBeTruthy()
    expect(row.publishedAt).toBeTruthy()
  })
})

describe('§9.4 защита публичных страниц', () => {
  it('по суткам из свёртки и откликов, топ причин вместе, без IP', async () => {
    const r = await R.protectionReport(hr, { format: 'json' })
    const day = r.rows.find(x => x.day === today)!
    expect(day).toMatchObject({ views: 8, blocked: 2, spam: 1 })
    const reasons = day.topReasons.map(x => x.reason)
    expect(reasons).toContain('ip_hour')
    expect(reasons).toContain('honeypot')
    expect(day.topReasons.length).toBeLessThanOrEqual(5)
    expect(JSON.stringify(r)).not.toMatch(/ip_hash|198\.51\.100/)
  })
})

describe('§9.5 использование ИИ', () => {
  it('генерации успешные, операции всех вызовов, доля опубликованных без правки', async () => {
    const r = await R.aiUsageReport(hr, { format: 'json' })
    expect(r.rows.find(x => x.userId === adminId && x.target === 'description')).toMatchObject({
      generations: 1, opsCharged: 1, published: 1, publishedUnedited: 1, uneditedPct: 100,
    })
  })
})

describe('§9.6 выгрузка откликов', () => {
  it('контакты, признаки, ссылка на кандидата; журнал с числом строк; чужая — null', async () => {
    const rows = await R.applicationsExport(hr, vacancyId, 'csv')
    expect(rows).toHaveLength(4)
    expect(rows!.some(x => String(x['Кандидат']).includes('/admin/candidates/'))).toBe(true)
    expect(rows!.some(x => String(x['Ознаки спаму']).includes('honeypot'))).toBe(true)
    const [audit] = await admin`select after from audit_log where entity_id = ${vacancyId} and action = 'vacancy.applications_export' order by created_at desc limit 1`
    expect(audit!.after).toMatchObject({ format: 'csv', rows: 4 })
    // Смотрящий другой точки и не рекрутер этой вакансии — её для него нет.
    const pointViewer = viewerOf({ userId: adminId, tenantId, grants: [{ scopes: ['vacancy.view'], scopeType: 'location', scopeId: otherLocationId }] })
    expect(await R.applicationsExport(pointViewer, vacancyId, 'csv')).toBeNull()
  })

  it('строки выгрузки отчётов совпадают с экраном', async () => {
    const eff = await R.effectivenessReport(hr, { format: 'json' })
    expect(R.VACANCY_REPORTS.effectiveness.rows(eff)).toHaveLength(eff.rows.length)
  })
})

describe('§6.1 полная форма вакансии', () => {
  it('все поля формы сохраняются и возвращаются карточкой; языки — списком', async () => {
    const r = await updateVacancy(hr, vacancyId, {
      countryCode: 'PL', city: 'Краків', workFormat: 'hybrid', experienceLevel: '1_3y', educationLevel: 'higher',
      salaryFrom: 20000, salaryTo: 30000, salaryCurrency: 'PLN', salaryVisible: true,
      languages: [{ langCode: 'en', level: 'b2', isRequired: true, sort: 0 }, { langCode: 'pl', level: 'a2', isRequired: false, sort: 1 }],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.vacancy).toMatchObject({ countryCode: 'PL', city: 'Краків', workFormat: 'hybrid', experienceLevel: '1_3y', educationLevel: 'higher', salaryCurrency: 'PLN', salaryVisible: true })
    expect(Number(r.vacancy.salaryFrom)).toBe(20000)
    expect(r.vacancy.languages.map(l => l.langCode)).toEqual(['en', 'pl'])
  })

  it('«Нижня межа більша за верхню» — и когда вторая граница уже сохранена', async () => {
    expect(await updateVacancy(hr, vacancyId, { salaryFrom: 50000, salaryTo: 1000 })).toEqual({ ok: false, code: 'salary_range' })
    expect(await updateVacancy(hr, vacancyId, { salaryFrom: 40000 })).toEqual({ ok: false, code: 'salary_range' })
    expect((await updateVacancy(hr, vacancyId, { salaryFrom: 25000 })).ok).toBe(true)
  })
})
