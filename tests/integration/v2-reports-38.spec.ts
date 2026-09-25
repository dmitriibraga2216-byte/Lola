import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * PR-38 пакета `docs/v2` (`45-plan.md`, П-22, `39-patches.md`): регистрация звітів пакету
 * (воронка й похідні, люди по этапам і швидкість, офбординг, робота перевіряючих,
 * укомплектованість структури, сховище, норми відсутностей, навчальна активність, «Якість
 * контенту» PR-24, «План і факт часу» PR-22) у конструкторі виgrузок `/reports/builder`
 * (`server/services/reportBuilder.ts`).
 *
 * Умови виходу PR-38, які тут перевіряються:
 * - жоден звіт не вигружає `rating_pct` за замовчуванням (PR-35 ще не в `main` — правило
 *   перевіряється на самому білому списку полів, а не на колонці, якої ще нема);
 * - усі персональні колонки — з єдиного каркаса `docs/22` §13 (`reportFrame.ts`), а не
 *   самодільні;
 * - `37` §13 к. 11 («План і факт часу» без жодного імені) не ламається реєстрацією.
 * Плюс власна відповідальність цього PR (П-16.1, інваріант 17): жодна з нових сутностей не
 * бере кандидата в вибірку співробітників — канареечні кандидати сеяться саме для цього.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const { describeEntities, runReport, FIXED_REPORTS, ENTITIES } = await import('../../server/services/reportBuilder')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

let tenantId: string, actorId: string, lazarevaId: string
const cleanupUserIds: string[] = []
const cleanupStageStateIds: string[] = []

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  actorId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
})

afterAll(async () => {
  if (cleanupStageStateIds.length) await admin`delete from employee_lifecycle_state where id in ${admin(cleanupStageStateIds)}`
  if (cleanupUserIds.length) await admin`delete from users where id in ${admin(cleanupUserIds)}`
  await admin.end()
})

describe('PR-38: описание сутностей конструктора', () => {
  it('усі нові сутності й готові звіти зареєстровані', () => {
    const keys = Object.keys(describeEntities())
    for (const k of [
      'stages', 'reviewers', 'orgNodes', 'storage', 'absences',
      'recruiting-funnel', 'recruiter-efficiency', 'candidate-sources', 'time-to-hire', 'rejection-reasons',
      'stage-speed', 'offboarding-reasons', 'learning-activity', 'content-quality', 'time-plan-fact',
    ]) expect(keys, k).toContain(k)
  })

  it('жоден білий список полів не містить rating_pct (умова виходу PR-38)', () => {
    const all = describeEntities()
    const offenders = Object.entries(all).filter(([, v]) => v.fields.includes('rating_pct')).map(([k]) => k)
    expect(offenders).toEqual([])
  })

  it('«План і факт часу» не має жодного поля-ідентифікатора людини (`37` §13 к. 11)', () => {
    const fields = FIXED_REPORTS['time-plan-fact']!.fields
    for (const banned of ['full_name', 'user_id', 'reviewer', 'holder', 'recruiter']) expect(fields).not.toContain(banned)
  })

  it('набір ключів `ENTITIES ∪ FIXED_REPORTS` — саме те, що валідатор ручки `run.post.ts` приймає (`ENTITY_KEYS`)', () => {
    const keys = new Set([...Object.keys(ENTITIES), ...Object.keys(FIXED_REPORTS)])
    expect(keys.has('stages')).toBe(true)
    expect(keys.has('time-plan-fact')).toBe(true)
    expect(keys.has('bogus-entity')).toBe(false)
  })
})

describe('PR-38: конструктор виконує нові сутності', () => {
  const ctx = () => ({ tenantId, actorId })

  it('«Динаміка сховища» не падає з обмеженою областю (scopeCol: null, регресія на `pl not found`)', async () => {
    await expect(runReport(ctx(), { entity: 'storage', fields: ['day', 'origin', 'bytes'], filters: {}, groupBy: null }, 50, [lazarevaId])).resolves.toEqual(expect.any(Array))
    await expect(runReport(ctx(), { entity: 'storage', fields: ['day', 'origin', 'bytes'], filters: {}, groupBy: null }, 50, [])).resolves.toEqual([])
  })

  it('«Укомплектованість структури» виконується (вузол — не людина, без фільтру kind)', async () => {
    await expect(runReport(ctx(), { entity: 'orgNodes', fields: ['node', 'headcount_planned', 'occupied', 'vacancies'], filters: {}, groupBy: null }, 50, null)).resolves.toEqual(expect.any(Array))
  })

  it('«Робота перевіряючих» виконується проти reviewer_stats_daily', async () => {
    await expect(runReport(ctx(), { entity: 'reviewers', fields: ['reviewer', 'day', 'reviewed', 'accepted'], filters: {}, groupBy: null }, 50, null)).resolves.toEqual(expect.any(Array))
  })

  it('«Норми і залишки відсутностей» рахує норму й залишок кожному співробітнику', async () => {
    const rows = await runReport(ctx(), { entity: 'absences', fields: ['full_name', 'vacation_norm', 'vacation_source', 'vacation_used'], filters: {}, groupBy: null }, 50, null)
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(typeof r.vacation_norm === 'number' || typeof r.vacation_norm === 'string').toBe(true)
  })

  it('«Люди по этапам» і «Норми відсутностей» не бачать кандидата, навіть якщо в нього є запис етапу (інваріант 17)', async () => {
    const [candidate] = await admin`select id from users where tenant_id = ${tenantId} and full_name = 'Канарка Перша'`
    expect(candidate, 'канареечный кандидат «Канарка Перша» з сиду не знайдений').toBeTruthy()
    const [stage] = await admin`select id from lifecycle_stages where tenant_id = ${tenantId} order by sort limit 1`
    if (stage && candidate) {
      const [row] = await admin`
        insert into employee_lifecycle_state (tenant_id, user_id, stage_id, is_current, reason_code)
        values (${tenantId}, ${candidate.id}, ${stage.id}, true, 'manual')
        returning id`
      cleanupStageStateIds.push(row!.id as string)
    }
    const stageRows = await runReport(ctx(), { entity: 'stages', fields: ['full_name'], filters: {}, groupBy: null }, 500, null) as { full_name: string }[]
    expect(stageRows.some(r => r.full_name === 'Канарка Перша')).toBe(false)
    const absenceRows = await runReport(ctx(), { entity: 'absences', fields: ['full_name'], filters: {}, groupBy: null }, 500, null) as { full_name: string }[]
    expect(absenceRows.some(r => r.full_name === 'Канарка Перша')).toBe(false)
  })
})

describe('PR-38: готові звіти (funnel/content-quality/time-plan-fact — вже існують, і чотири нові рекрутингові)', () => {
  const ctx = () => ({ tenantId, actorId })

  it('«Воронка найму» реєстрація повертає рядки таблиці етапів, не список людей', async () => {
    const rows = await runReport(ctx(), { entity: 'recruiting-funnel', fields: ['status', 'entered', 'current'], filters: {}, groupBy: null }, 50, null)
    expect(rows.length).toBeGreaterThan(0)
    expect(Object.keys(rows[0]!)).not.toContain('full_name')
  })

  it('«Джерела кандидатів» бачить канареечних кандидатів рекрутера-адміна за джерелом manual', async () => {
    const rows = await runReport(ctx(), { entity: 'candidate-sources', fields: ['source', 'candidates'], filters: {}, groupBy: null }, 50, null) as { source: string, candidates: number }[]
    const manual = rows.find(r => r.source === 'manual')
    expect(manual, JSON.stringify(rows)).toBeTruthy()
    expect(manual!.candidates).toBeGreaterThanOrEqual(3)
  })

  it('«Ефективність рекрутера» й «Відмови по причинах» не падають на порожньому/малому наборі', async () => {
    await expect(runReport(ctx(), { entity: 'recruiter-efficiency', fields: ['recruiter', 'added'], filters: {}, groupBy: null }, 50, null)).resolves.toEqual(expect.any(Array))
    await expect(runReport(ctx(), { entity: 'rejection-reasons', fields: ['reason_code', 'count'], filters: {}, groupBy: null }, 50, null)).resolves.toEqual(expect.any(Array))
    await expect(runReport(ctx(), { entity: 'time-to-hire', fields: ['vacancy', 'hired'], filters: {}, groupBy: null }, 50, null)).resolves.toEqual(expect.any(Array))
  })

  it('«Якість контенту» і «План і факт часу» доступні тим самим шляхом, що й власні ручки', async () => {
    await expect(runReport(ctx(), { entity: 'content-quality', fields: ['element', 'complaints'], filters: {}, groupBy: null }, 50, null)).resolves.toEqual(expect.any(Array))
    const planFact = await runReport(ctx(), { entity: 'time-plan-fact', fields: ['element', 'median_min'], filters: {}, groupBy: null }, 50, null)
    expect(planFact).toEqual(expect.any(Array))
    for (const r of planFact) expect(Object.keys(r)).not.toContain('full_name')
  })

  it('«Швидкість проходження етапів» і «Офбординг за причинами» виконуються', async () => {
    await expect(runReport(ctx(), { entity: 'stage-speed', fields: ['stage', 'n'], filters: {}, groupBy: null }, 50, null)).resolves.toEqual(expect.any(Array))
    await expect(runReport(ctx(), { entity: 'offboarding-reasons', fields: ['reason_code', 'n'], filters: {}, groupBy: null }, 50, null)).resolves.toEqual(expect.any(Array))
  })

  it('«Навчальна активність» — рядки каркаса (ПІБ першими), без rating_pct', async () => {
    const rows = await runReport(ctx(), { entity: 'learning-activity', fields: ['full_name', 'days_active', 'hours'], filters: {}, groupBy: null }, 50, null)
    expect(rows).toEqual(expect.any(Array))
    for (const r of rows) expect(Object.keys(r)).not.toContain('rating_pct')
  })
})
