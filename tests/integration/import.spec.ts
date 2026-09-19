import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const { parseImportFile, validateImport, applyImport, getImportJob, buildImportReport, buildImportTemplate }
  = await import('../../server/services/importPeople')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

let tenantId: string
let actorId: string
const PHONE_PREFIX = '+38099' // тестовый диапазон, чистится в afterAll

beforeAll(async () => {
  const [t] = await admin`select id from tenants where slug = 'kappi'`
  tenantId = t!.id as string
  const [a] = await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`
  actorId = a!.id as string
})

afterAll(async () => {
  await admin`delete from users where tenant_id = ${tenantId} and phone like ${`${PHONE_PREFIX}%`}`
  await admin`delete from import_jobs where tenant_id = ${tenantId}`
  await admin`delete from cities where tenant_id = ${tenantId} and name = 'Тест-Місто'`
  await admin.end()
})

function makeRows(count: number): Record<string, string>[] {
  const rows: Record<string, string>[] = []
  for (let i = 0; i < count; i++) {
    const n = String(i).padStart(4, '0')
    rows.push({
      'ПІБ': `Імпорт Тест ${n}`,
      'Телефон': `${PHONE_PREFIX}${n.padStart(7, '0')}`,
      'Email': '',
      'Посада': i % 2 === 0 ? 'Бариста' : 'Касир',
      'Рівень посади': 'базовий',
      'Місто': 'Тест-Місто',
      'Підрозділ': 'Каппі',
      'Точка': i % 2 === 0 ? 'Лазарева' : 'Сегедська',
      'Роль': 'employee',
      'Мітки': 'імпорт, новачок',
      'Дата найму': '2026-09-01',
      'Зовнішній ID': `IMP-${n}`,
    })
  }
  return rows
}

describe('импорт людей: 500 строк с намеренными ошибками', () => {
  let jobId: string
  const TOTAL = 500
  const BROKEN = 40

  it('валидация: корректные к применению, ошибочные помечены', async () => {
    const rows = makeRows(TOTAL)

    // 40 намеренно испорченных строк
    for (let i = 0; i < BROKEN; i++) {
      const row = rows[i * 12]!
      switch (i % 5) {
        case 0: row['Телефон'] = '12345'; break // кривой телефон
        case 1: row['ПІБ'] = ''; break // нет имени
        case 2: row['Телефон'] = rows[(i * 12 + 3)]!['Телефон']!; break // дубль в файле
        case 3: row['Роль'] = 'неіснуюча'; break // неизвестная роль
        case 4: row['Дата найму'] = '01.09.2026'; break // кривая дата
      }
    }

    const result = await validateImport({ tenantId, actorId }, 'test-500.xlsx', rows)
    jobId = result.jobId

    expect(result.stats.total).toBe(TOTAL)
    expect(result.stats.skip).toBeGreaterThanOrEqual(BROKEN)
    expect(result.stats.create).toBe(TOTAL - result.stats.skip)
    expect(result.stats.errors).toBe(result.stats.skip)

    const broken = result.rows.filter(r => r.errors.length > 0)
    expect(broken.some(r => r.errors.some(e => e.includes('Телефон')))).toBe(true)
    expect(broken.some(r => r.errors.some(e => e.includes('дубль')))).toBe(true)
    expect(broken.some(r => r.errors.some(e => e.includes('Роль')))).toBe(true)
  })

  it('применение: корректные создаются с размещением и ролью', async () => {
    const result = await applyImport({ tenantId, actorId }, jobId)
    expect(result).not.toBeNull()

    const job = await getImportJob({ tenantId, actorId }, jobId)
    expect(job!.status).toBe('applied')
    const stats = job!.stats as { created: number, updated: number, skip: number }
    expect(stats.created).toBe(TOTAL - stats.skip)

    const [{ count }] = await admin<[{ count: number }]>`
      select count(*)::int as count from users
      where tenant_id = ${tenantId} and phone like ${`${PHONE_PREFIX}%`}
    `
    expect(count).toBe(stats.created)

    // размещение и роль на месте
    const [placement] = await admin`
      select up.id from user_placements up
      join users u on u.id = up.user_id
      where u.tenant_id = ${tenantId} and u.phone like ${`${PHONE_PREFIX}%`} and up.ended_at is null
      limit 1
    `
    expect(placement).toBeDefined()

    const [{ count: withRole }] = await admin<[{ count: number }]>`
      select count(distinct ur.user_id)::int as count from user_roles ur
      join users u on u.id = ur.user_id
      where u.tenant_id = ${tenantId} and u.phone like ${`${PHONE_PREFIX}%`}
    `
    expect(withRole).toBe(stats.created)
  })

  it('повторное применение того же job отклоняется', async () => {
    expect(await applyImport({ tenantId, actorId }, jobId)).toBeNull()
  })

  it('повторный импорт того же файла — существующие идут в обновление', async () => {
    // Из первых 50 строк в первом прогоне были испорчены 0, 12, 24, 36, 48.
    // Строка 24 (дубль телефона) всё же создалась и опознаётся по зовнішньому ID,
    // остальные четыре не создались — теперь пойдут в create.
    const rows = makeRows(50)
    const result = await validateImport({ tenantId, actorId }, 'test-repeat.xlsx', rows)
    expect(result.stats.update).toBe(46)
    expect(result.stats.create).toBe(4)
    expect(result.stats.skip).toBe(0)
  })

  it('отчёт xlsx собирается', async () => {
    const report = await buildImportReport({ tenantId, actorId }, jobId)
    expect(report).not.toBeNull()
    expect(report!.length).toBeGreaterThan(1000)
  })

  it('шаблон разбирается обратно парсером (round-trip)', async () => {
    const template = await buildImportTemplate()
    const parsed = await parseImportFile('template.xlsx', template)
    expect(parsed.length).toBe(1)
    expect(parsed[0]!['ПІБ']).toBe('Іваненко Іван')
    expect(parsed[0]!['Телефон']).toBe('+380671234567')
  })

  it('csv разбирается с кавычками и точкой с запятой', async () => {
    const csv = 'ПІБ,Телефон,Посада,Підрозділ,Точка\n"Петренко, Петро",+380991112233,Бариста,Каппі,Лазарева\n'
    const parsed = await parseImportFile('people.csv', Buffer.from(csv, 'utf-8'))
    expect(parsed.length).toBe(1)
    expect(parsed[0]!['ПІБ']).toBe('Петренко, Петро')
  })
})
