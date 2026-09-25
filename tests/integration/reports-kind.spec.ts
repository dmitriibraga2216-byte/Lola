import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Entity } from '../../server/services/reportBuilder'

/**
 * Отчёты по штату и инвариант 17 (CLAUDE.md; П-16.1 `docs/v2/39`: кандидат не появляется «в
 * отчётах по штату»; В-8 слой 3 `docs/v2/44`).
 *
 * Баг, который здесь воспроизводится: три давние сущности конструктора отчётов — `people`,
 * `enrollments`, `attempts` (`server/services/reportBuilder.ts`) — брали людей из `users` без
 * фильтра по виду, и кандидат со своим ПІБ, телефоном и результатами теста уходил в таблицу
 * экрана, в xlsx и в отчёт по расписанию. Сканер слоя 2 этого не видел: запрос собирается из
 * фрагментов (`sql\`users u …\``, `join users u on u.id = e.user_id`), и ни один фрагмент
 * по отдельности не похож на выборку людей. Статическая сторона того же правила —
 * `tests/unit/report-builder-kind.spec.ts` (итоговый SQL каждой сущности). Второй блок — соседние
 * отчёты той же формы («Прострочені», «Результати атестацій», «Прогрес навчання», «Звіт з
 * програм»): записи на курс, попытки и записи на программу, соединённые с `users` по первичному
 * ключу, без вида.
 *
 * Канарейка — «Канарка Перша» из посева (`server/db/seed.ts`). Запись на курс (просроченную) и
 * попытку теста ей даёт сам тест — так же, как их дал бы шаблон вакансии (`assignFromVacancy`,
 * `29` §7.20); запись на программу — как назначение, где кандидат назван поимённо. Рядом —
 * такие же строки у сотрудника, которого тест заводит сам: отчёт обязан показать его и не
 * показать кандидата, иначе «кандидата нет» доказывало бы только пустоту отчёта.
 */

const { ENTITIES, runReport } = await import('../../server/services/reportBuilder')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const CANARY = 'Канарка Перша'
const STAFF = 'Штатна Контрольна'
/** Лимит выше любого объёма тестовой базы: строка не должна пропасть из-за `limit`, а не из-за фильтра. */
const ALL = 100_000

let tenantId: string, actorId: string, canaryId: string, staffId: string, courseId: string, quizId: string
let canaryNames: string[] = []
const enrollmentIds: string[] = []
const attemptIds: string[] = []
const programEnrollmentIds: string[] = []

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  actorId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  const [canary] = await admin`select id from users where tenant_id = ${tenantId} and full_name = ${CANARY} and kind = 'candidate'`
  if (!canary) throw new Error(`канареечный кандидат «${CANARY}» не найден — нужен \`pnpm db:seed\` на чистой базе`)
  canaryId = canary.id as string
  // Свой сотрудник, а не человек посева: чужой тест мог его заархивировать или перевести.
  const phone = `+38063${String(Date.now()).slice(-7)}`
  staffId = (await admin`insert into users (tenant_id, phone, full_name, status) values (${tenantId}, ${phone}, ${STAFF}, 'active') returning id`)[0]!.id as string
  canaryNames = (await admin`select full_name from users where tenant_id = ${tenantId} and kind = 'candidate'`).map(r => r.full_name as string)
  const [course] = await admin`select id, published_version_id from courses where tenant_id = ${tenantId} and published_version_id is not null order by created_at limit 1`
  courseId = course!.id as string
  quizId = (await admin`select id from quizzes where tenant_id = ${tenantId} order by created_at limit 1`)[0]!.id as string
  const programId = (await admin`select id from programs where tenant_id = ${tenantId} order by created_at limit 1`)[0]!.id as string

  for (const userId of [canaryId, staffId]) {
    const [e] = await admin`
      insert into enrollments (tenant_id, user_id, subject_id, version_id, source, required_total, status, started_at, due_at)
      values (${tenantId}, ${userId}, ${courseId}, ${course!.published_version_id as string}, 'assigned', 1, 'in_progress', now(), now() - interval '1 day')
      returning id`
    enrollmentIds.push(e!.id as string)
    const [a] = await admin`
      insert into attempts (tenant_id, quiz_id, user_id, attempt_no, snapshot, params, status, passed, score, started_at, submitted_at)
      values (${tenantId}, ${quizId}, ${userId}, 1, '{}', '{}', 'passed', true, 90, now(), now())
      returning id`
    attemptIds.push(a!.id as string)
    const [pe] = await admin`
      insert into program_enrollments (tenant_id, program_id, user_id, status, started_at)
      values (${tenantId}, ${programId}, ${userId}, 'in_progress', now())
      returning id`
    programEnrollmentIds.push(pe!.id as string)
  }
})

afterAll(async () => {
  if (programEnrollmentIds.length) await admin`delete from program_enrollments where id in ${admin(programEnrollmentIds)}`
  if (attemptIds.length) await admin`delete from attempts where id in ${admin(attemptIds)}`
  if (enrollmentIds.length) await admin`delete from enrollments where id in ${admin(enrollmentIds)}`
  if (staffId) await admin`delete from users where id = ${staffId}`
  await admin.end()
})

type Rows = Record<string, unknown>[]
const ctx = () => ({ tenantId, actorId })
/** Имена людей, которые видны в строках отчёта: любая ячейка, совпавшая с ПІБ. */
const namesIn = (rows: Rows, names: string[]) => [...new Set(rows.flatMap(r => Object.values(r).filter(v => typeof v === 'string' && names.includes(v)) as string[]))]

describe('конструктор отчётов: кандидат не попадает в отчёт по штату (инвариант 17)', () => {
  // Фильтр сужает отчёт до курса и теста, где строки есть у обоих, — функцией: id известны
  // только после beforeAll.
  const cases: { entity: Entity, filters: () => Record<string, unknown> }[] = [
    { entity: 'people', filters: () => ({}) },
    { entity: 'enrollments', filters: () => ({ course_id: courseId }) },
    { entity: 'attempts', filters: () => ({ quiz_id: quizId }) },
  ]

  it.each(cases)('$entity: сотрудник в отчёте есть, кандидата нет', async ({ entity, filters }) => {
    const rows = await runReport(ctx(), { entity, fields: ['full_name'], filters: filters() }, ALL) as Rows
    expect(namesIn(rows, [STAFF]), `сотрудник пропал из отчёта «${entity}» — проверка ниже ничего бы не доказала`).toEqual([STAFF])
    expect(namesIn(rows, canaryNames), `кандидат в отчёте «${entity}»`).toEqual([])
  })

  it.each(cases)('$entity: группировка по ПІБ тоже не видит кандидата', async ({ entity }) => {
    const rows = await runReport(ctx(), { entity, fields: ['full_name'], groupBy: 'full_name' }, ALL) as Rows
    expect(namesIn(rows, [STAFF])).toEqual([STAFF])
    expect(namesIn(rows, canaryNames), `кандидат в сгруппированном отчёте «${entity}»`).toEqual([])
  })

  it('«Люди»: телефон кандидата не уходит в выгрузку', async () => {
    const [canary] = await admin`select phone from users where id = ${canaryId}`
    const rows = await runReport(ctx(), { entity: 'people', fields: ['full_name', 'phone'] }, ALL) as Rows
    expect(rows.filter(r => r.phone === canary!.phone), 'телефон кандидата в отчёте «Люди»').toEqual([])
  })

  /**
   * Класс ошибок, а не три места: каждая сущность конструктора — и те, что появятся потом, —
   * прогоняется со всеми своими полями. Рекрутинговая сущность (`kind: 'candidate'`), когда
   * она появится, кандидата показывать обязана — для неё проверка обратная не здесь, а в её
   * собственной спеке; все остальные виды (`employee` и «строки не люди») — не показывают.
   */
  it('ни одна сущность конструктора, кроме рекрутинговых, не показывает кандидата ни в одной колонке', async () => {
    const leaks: string[] = []
    for (const [entity, def] of Object.entries(ENTITIES) as [string, { kind?: string | null, fields: Record<string, unknown> }][]) {
      if (def.kind === 'candidate') continue
      const rows = await runReport(ctx(), { entity: entity as Entity, fields: Object.keys(def.fields) }, ALL) as Rows
      for (const name of namesIn(rows, canaryNames)) leaks.push(`${entity}: ${name}`)
    }
    expect(leaks, 'кандидат в отчёте конструктора').toEqual([])
  })
})

/**
 * Соседи той же формы (задача PR, п. 4): отчёты по штату, где записи на курс и попытки соединены
 * с `users` по первичному ключу — сканер слоя 2 выводит такое соединение из-под фильтра как
 * «join ради ФИО», хотя здесь строки отчёта и есть люди. «Прогрес навчання» к тому же собирает
 * запрос из фрагмента-обёртки `people(…)`.
 */
describe('соседние отчёты по штату: кандидат не попадает (инвариант 17)', () => {
  it('«Прострочені» (reports.overdue)', async () => {
    const { overdue } = await import('../../server/services/reports')
    const rows = await overdue(ctx(), { courseId }) as Rows
    expect(namesIn(rows, [STAFF]), 'просроченная запись сотрудника пропала — проверка ниже пуста').toEqual([STAFF])
    expect(namesIn(rows, canaryNames), 'кандидат в отчёте «Прострочені»').toEqual([])
  })

  it('«Результати атестацій» (reports.attemptsReport)', async () => {
    const { attemptsReport } = await import('../../server/services/reports')
    const rows = await attemptsReport(ctx(), {}) as Rows
    expect(namesIn(rows, [STAFF])).toEqual([STAFF])
    expect(namesIn(rows, canaryNames), 'кандидат в отчёте «Результати атестацій»').toEqual([])
  })

  it('«Звіт з програм» (reports.programsReport, ручка `/reports/programs`)', async () => {
    const { programsReport } = await import('../../server/services/reports')
    const rows = await programsReport(ctx(), null) as Rows
    expect(namesIn(rows, [STAFF])).toEqual([STAFF])
    expect(namesIn(rows, canaryNames), 'кандидат в «Звіт з програм»').toEqual([])
  })

  it.each(['course', 'quiz'] as const)('«Прогрес навчання» (reportsExtra.progress), предмет %s', async (subject) => {
    const { progress } = await import('../../server/services/reportsExtra')
    const r = await progress(ctx(), { subject, subjectId: subject === 'course' ? courseId : quizId })
    expect(namesIn(r.rows, [STAFF])).toEqual([STAFF])
    expect(namesIn(r.rows, canaryNames), `кандидат в «Прогрес навчання» (${subject})`).toEqual([])
  })
})
