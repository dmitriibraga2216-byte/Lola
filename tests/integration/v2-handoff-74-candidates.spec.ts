import ExcelJS from 'exceljs'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Access } from '../../server/services/access'
import type { Entity } from '../../server/services/reportBuilder'

/**
 * `docs/v2/HANDOFF.md` §7.4 — «проверка по существу» главного риска пакета (`docs/v2/42` §7.1): кандидат
 * и сотрудник — одна запись `users`, и забытый фильтр по `kind` не падает, а молча возвращает кандидатов
 * в списки сотрудников, в адресаты рассылок и в оплачиваемый счётчик. HANDOFF просит проверить это
 * **на стенде с посеянными кандидатами**; у PR-40 стенда нет, поэтому та же проверка — автотестом на
 * свежей базе (CI: `migrate` → `seed` → тесты). Шаги ручной проверки на стенде для владельца продукта —
 * в описании PR-40 и в `docs/v2/46-progress.md` (запись PR-40); здесь — их автоматический двойник.
 *
 * Чем этот файл отличается от соседей. Слой 3 В-8 (`users-kind-filter.spec.ts`), конструктор
 * (`reports-kind.spec.ts`) и журналы (`logs-candidate-kind.spec.ts`, #143) проверяют каждый свою
 * поверхность на канарейках посева — а у тех нет ни размещения, ни роли, ни группы: правило «точка»
 * или «роль» их не выбрало бы и без фильтра, и тест такого правила зелёный по построению. Здесь
 * кандидаты «громкие»: у каждого та же точка, должность, подразделение, роль, метка, группа, запись на
 * курс, попытка и строки в журналах, что и у штатного контроля рядом. Если кандидат не попал в
 * поверхность, то только потому, что его отрезал вид, — а контроль в той же поверхности доказывает,
 * что она вообще что-то возвращает. Канарейки посева проверяются заодно — их отсутствие в тех же
 * выдачах и есть проверка «на свежей базе».
 *
 * Пять поверхностей HANDOFF §7.4 и задания PR-40: 1) списки сотрудников; 2) адресаты рассылок;
 * 3) счётчик активных пользователей (и оплачиваемая ось `users_active`); 4) отчёты конструктора;
 * 5) журналы (решение владельца 25.09, #143: без `candidate.view` строк о кандидатах нет).
 */

const { listPeople, exportPeople, staffingReport, inactiveReport } = await import('../../server/services/people')
const { contacts, birthdays } = await import('../../server/services/hubPeople')
const { resolveAudience } = await import('../../server/services/audience')
const { broadcast } = await import('../../server/services/notifications')
const { collectUsage, usageView } = await import('../../server/services/usage')
const { checkPlanLimit, getTenantCard, listTenants, platformMetrics } = await import('../../server/services/platform')
const { currentUsage, measureLive, syncLiveAxes } = await import('../../server/services/usageCounters')
const { ENTITIES, runReport } = await import('../../server/services/reportBuilder')
const { readLog } = await import('../../server/services/logs')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const STAMP = String(Date.now()).slice(-6)
const TAG = `hf74-${STAMP}`
const LOUD = ['Канарка 7.4 Перша', 'Канарка 7.4 Друга', 'Канарка 7.4 Третя']
const STAFF = 'Штатна 7.4 Контрольна'
const MARK = `HANDOFF 7.4 розсилка ${STAMP}`
/** Лимит выше любого объёма тестовой базы: строка не должна пропасть из-за `limit`, а не из-за фильтра. */
const ALL = 100_000
/** Журналы, где строка привязана к человеку (`frameSelect()`); `security` решение владельца не сужает. */
const GATED_LOGS = ['task-status', 'task-access', 'org-conflicts', 'notifications', 'sessions', 'automation'] as const

let tenantId: string, actorId: string, locationId: string, orgUnitId: string, positionId: string
let courseId: string, quizId: string, groupId: string, ruleId: string
let staffId: string
const loudIds: string[] = []
/** Все кандидаты тенанта — «громкие» этого теста и канарейки посева. */
let candidates: { id: string, fullName: string, phone: string }[] = []
let seedCanaries: { id: string, fullName: string }[] = []

const cleanup: { table: string, ids: string[] }[] = []
const track = (table: string, id: string) => {
  const entry = cleanup.find(c => c.table === table) ?? (cleanup.push({ table, ids: [] }), cleanup[cleanup.length - 1]!)
  entry.ids.push(id)
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  actorId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  const [loc] = await admin`select id, org_unit_id from locations where tenant_id = ${tenantId} and org_unit_id is not null order by created_at limit 1`
  locationId = loc!.id as string
  orgUnitId = loc!.org_unit_id as string
  positionId = (await admin`select id from positions where tenant_id = ${tenantId} order by created_at limit 1`)[0]!.id as string
  const employeeRoleId = (await admin`select id from roles where tenant_id = ${tenantId} and code = 'employee'`)[0]!.id as string
  const [course] = await admin`select id, published_version_id from courses where tenant_id = ${tenantId} and published_version_id is not null order by created_at limit 1`
  courseId = course!.id as string
  quizId = (await admin`select id from quizzes where tenant_id = ${tenantId} order by created_at limit 1`)[0]!.id as string
  seedCanaries = (await admin`select id, full_name from users where tenant_id = ${tenantId} and kind = 'candidate' order by full_name`)
    .map(r => ({ id: r.id as string, fullName: r.full_name as string }))

  // День рождения сегодня (виджет «Дні народження» смотрит две недели вперёд), последний вход — два
  // месяца назад (отчёт «Неактивні понад 30 днів»): у контроля и у кандидатов одинаково.
  const birth = `${new Date().getUTCFullYear() - 30}-${new Date().toISOString().slice(5, 10)}`
  const person = (fullName: string, i: number, kind: 'employee' | 'candidate') => ({
    tenant_id: tenantId, full_name: fullName, phone: `+38066${STAMP}${i}`, status: 'active', tags: [TAG],
    birth_date: birth, birthday_consent: true, last_seen_at: new Date(Date.now() - 60 * 86_400_000),
    ...(kind === 'candidate' ? { kind, candidate_state: 'active', source: 'manual', comm_language: 'uk' } : {}),
  })
  const [staff] = await admin`insert into users ${admin(person(STAFF, 0, 'employee'))} returning id`
  staffId = staff!.id as string
  track('users', staffId)
  for (const [i, name] of LOUD.entries()) {
    const [u] = await admin`insert into users ${admin(person(name, i + 1, 'candidate'))} returning id`
    loudIds.push(u!.id as string)
    track('users', u!.id as string)
  }
  candidates = (await admin`select id, full_name, phone from users where tenant_id = ${tenantId} and kind = 'candidate'`)
    .map(r => ({ id: r.id as string, fullName: r.full_name as string, phone: r.phone as string }))

  const [rule] = await admin`insert into automation_rules (tenant_id, name, trigger) values (${tenantId}, ${`handoff 7.4 ${STAMP}`}, 'user.created') returning id`
  ruleId = rule!.id as string
  const [group] = await admin`
    insert into user_groups (tenant_id, name, kind, members)
    values (${tenantId}, ${`Група 7.4 ${STAMP}`}, 'static', ${[staffId, ...loudIds]}::uuid[]) returning id`
  groupId = group!.id as string

  // Одинаковый след у контроля и у каждого «громкого» кандидата
  for (const userId of [staffId, ...loudIds]) {
    const rows: [string, postgres.PendingQuery<postgres.Row[]>][] = [
      ['user_placements', admin`
        insert into user_placements (tenant_id, user_id, location_id, position_id, org_unit_id, is_primary, started_at)
        values (${tenantId}, ${userId}, ${locationId}, ${positionId}, ${orgUnitId}, true, current_date - 10) returning id`],
      ['user_roles', admin`
        insert into user_roles (tenant_id, user_id, role_id, scope_type) values (${tenantId}, ${userId}, ${employeeRoleId}, 'tenant') returning id`],
      ['enrollments', admin`
        insert into enrollments (tenant_id, user_id, subject_id, version_id, source, required_total, status, started_at, due_at)
        values (${tenantId}, ${userId}, ${courseId}, ${course!.published_version_id as string}, 'assigned', 1, 'in_progress', now(), now() - interval '1 day')
        returning id`],
      ['attempts', admin`
        insert into attempts (tenant_id, quiz_id, user_id, attempt_no, snapshot, params, status, passed, score, started_at, submitted_at)
        values (${tenantId}, ${quizId}, ${userId}, 1, '{}', '{}', 'passed', true, 90, now(), now()) returning id`],
      ['pass_events', admin`
        insert into pass_events (tenant_id, subject_type, subject_id, enrollment_id, user_id, event)
        values (${tenantId}, 'training_program', gen_random_uuid(), gen_random_uuid(), ${userId}, 'created') returning id`],
      ['task_access_log', admin`
        insert into task_access_log (tenant_id, user_id, content_type, content_id)
        values (${tenantId}, ${userId}, 'course', gen_random_uuid()) returning id`],
      ['notifications', admin`
        insert into notifications (tenant_id, user_id, code, channel) values (${tenantId}, ${userId}, 'handoff_74_probe', 'telegram') returning id`],
      ['sessions', admin`
        insert into sessions (tenant_id, user_id, token_hash, expires_at)
        values (${tenantId}, ${userId}, ${`th_hf74_${userId}_${STAMP}`}, now() + interval '1 day') returning id`],
      ['org_conflicts', admin`
        insert into org_conflicts (tenant_id, user_id, kind) values (${tenantId}, ${userId}, 'double_unit') returning id`],
      ['automation_runs', admin`
        insert into automation_runs (tenant_id, rule_id, user_id, status) values (${tenantId}, ${ruleId}, ${userId}, 'ok') returning id`],
    ]
    for (const [table, q] of rows) track(table, (await q)[0]!.id as string)
  }
})

afterAll(async () => {
  // Порядок — от зависимых к людям; рассылка теста — по своей метке в тексте
  if (tenantId) await admin`delete from notifications where tenant_id = ${tenantId} and code = 'manual' and payload->>'text' = ${MARK}`
  const order = ['automation_runs', 'org_conflicts', 'sessions', 'notifications', 'task_access_log', 'pass_events', 'attempts', 'enrollments', 'user_roles', 'user_placements']
  for (const table of order) {
    const ids = cleanup.find(c => c.table === table)?.ids ?? []
    if (ids.length) await admin`delete from ${admin(table)} where id in ${admin(ids)}`
  }
  if (groupId) await admin`delete from user_groups where id = ${groupId}`
  if (ruleId) await admin`delete from automation_rules where id = ${ruleId}`
  // Снимок `tenant_usage`, который записал сбор потребления, остаётся: это обычный срез тенанта
  // (штатом без кандидатов), и следующий сбор его просто вытеснит из «последнего»
  const people = cleanup.find(c => c.table === 'users')?.ids ?? []
  if (people.length) await admin`delete from users where id in ${admin(people)}`
  await admin.end()
})

const ctx = () => ({ tenantId, actorId })
const candidateIds = () => new Set(candidates.map(c => c.id))
const leaked = (ids: Iterable<string>) => candidates.filter(c => [...ids].includes(c.id)).map(c => c.fullName)
/** Имена людей в строках выдачи: любая ячейка, совпавшая с ПІБ. */
const namesIn = (rows: Record<string, unknown>[], names: string[]) =>
  [...new Set(rows.flatMap(r => Object.values(r).filter(v => typeof v === 'string' && names.includes(v)) as string[]))]
const candidateNames = () => candidates.map(c => c.fullName)
const hrAccess = (): Access => ({ userId: actorId, tenantId, grants: [{ scopes: ['people.view'], scopeType: 'tenant', scopeId: null }], activeRole: null, roles: [] })

describe('HANDOFF §7.4, посев: на свежей базе есть кандидаты, и спрятать их может только фильтр', () => {
  it('посев даёт не меньше трёх канареек на тенант — без них проверка зелёная всегда (`42` §5 п. 10)', () => {
    expect(seedCanaries.length, 'в тенанте нет канареечных кандидатов: нужен `pnpm db:seed` на чистой базе').toBeGreaterThanOrEqual(3)
    expect(candidates.length).toBe(seedCanaries.length + LOUD.length)
  })

  it('изнутри тенанта кандидаты видны, если спросить о них явно — значит, из списков их убирает вид, а не RLS', async () => {
    const { sql } = await import('drizzle-orm')
    const rows = await withTenant(tenantId, actorId, async tx =>
      await tx.execute(sql`select id from users where kind = 'candidate'`) as unknown as { id: string }[])
    expect(rows.map(r => r.id).sort()).toEqual([...candidateIds()].sort())
  })
})

describe('HANDOFF §7.4 (1): списки сотрудников не содержат кандидатов', () => {
  it('«Люди»: ни на одной вкладке, со скрытыми, и чип «Усі» считает только штат', async () => {
    for (const tab of ['active', 'blocked', 'all'] as const) {
      const ids: string[] = []
      let cursor: string | undefined
      let counts: Record<string, number> | undefined
      do {
        const page = await listPeople(ctx(), { tab, limit: 100, cursor, includeHidden: true } as never)
        ids.push(...page.items.map((p: { id: string }) => p.id))
        counts = page.counts as Record<string, number>
        cursor = page.cursor ?? undefined
      } while (cursor)
      expect(leaked(ids), `кандидат в списке людей, вкладка «${tab}»`).toEqual([])
      if (tab !== 'blocked') expect(ids, `контроль пропал со вкладки «${tab}» — проверка ничего не доказывает`).toContain(staffId)
      if (tab === 'all') {
        const [staff] = await admin`select count(*)::int as n from users where tenant_id = ${tenantId} and kind = 'employee'`
        expect(counts!.all, 'чип «Усі» считает кандидатов').toBe(staff!.n)
      }
    }
  })

  it('«Експорт в Excel» списка людей: ни ПІБ, ни телефона кандидата', async () => {
    const buf = await exportPeople(ctx(), { tab: 'all', includeHidden: true } as never, { withContacts: true })
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as unknown as ArrayBuffer)
    const cells: string[] = []
    wb.worksheets[0]!.eachRow(row => row.eachCell(cell => cells.push(String(cell.value ?? ''))))
    expect(cells, 'контроль пропал из выгрузки').toContain(STAFF)
    expect(candidates.filter(c => cells.includes(c.fullName)).map(c => c.fullName), 'ПІБ кандидата в выгрузке людей').toEqual([])
    expect(candidates.filter(c => cells.includes(c.phone)).map(c => c.fullName), 'телефон кандидата в выгрузке людей').toEqual([])
  })

  it('хаб: «Контакти» и «Дні народження» — только штат', async () => {
    const book = await contacts(ctx(), hrAccess(), {})
    expect(book.items.map(i => i.id), 'контроль пропал из «Контактів»').toContain(staffId)
    expect(leaked(book.items.map(i => i.id)), 'кандидат в «Контактах»').toEqual([])
    const bdays = await birthdays(ctx(), { tab: 'upcoming' })
    expect(bdays.items.map(i => i.id), 'контроль пропал из «Днів народження»').toContain(staffId)
    expect(leaked(bdays.items.map(i => i.id)), 'кандидат в «Днях народження»').toEqual([])
  })

  it('«Штат по точках» и «Неактивні понад 30 днів» считают и показывают только штат', async () => {
    const staffing = await staffingReport(ctx())
    const [loc] = await admin`select name from locations where id = ${locationId}`
    const [pos] = await admin`select name from positions where id = ${positionId}`
    const row = staffing.find(r => r.location === loc!.name && r.position === pos!.name)
    const [fact] = await admin`
      select count(*)::int as n from user_placements up join users u on u.id = up.user_id
       where up.tenant_id = ${tenantId} and up.location_id = ${locationId} and up.position_id = ${positionId}
         and up.is_primary and up.started_at <= current_date and (up.ended_at is null or up.ended_at > current_date)
         and u.status <> 'archived' and not u.is_hidden and u.kind = 'employee'`
    expect(row?.people, 'кандидаты с размещением посчитаны в штате точки').toBe(fact!.n)
    const inactive = await inactiveReport(ctx(), 30)
    expect(inactive.map(r => r.id), 'контроль пропал из «Неактивних»').toContain(staffId)
    expect(leaked(inactive.map(r => r.id as string)), 'кандидат в «Неактивних»').toEqual([])
  })
})

describe('HANDOFF §7.4 (2): адресаты рассылок не содержат кандидатов', () => {
  const rules = () => [
    { type: 'location', ids: [locationId] },
    { type: 'position', ids: [positionId] },
    { type: 'org_unit', ids: [orgUnitId], includeChildren: true },
    { type: 'role', codes: ['employee'] },
    { type: 'tag', values: [TAG] },
    { type: 'group', ids: [groupId] },
    { type: 'segment', filter: { locationIds: [locationId] } },
  ]

  it('каждое правило-условие аудитории выбирает контроль и не выбирает ни одного кандидата', async () => {
    for (const rule of rules()) {
      const ids = await withTenant(tenantId, actorId, tx => resolveAudience(tx, { match: 'any', rules: [rule] } as never))
      expect([...ids], `правило «${rule.type}» не выбрало контроль — проверка ничего не доказывает`).toContain(staffId)
      expect(leaked(ids), `кандидат в аудитории по правилу «${rule.type}»`).toEqual([])
    }
  })

  it('ручная рассылка по всем условиям сразу: сообщение в очереди у контроля, ни одного — у кандидата', async () => {
    const res = await broadcast(ctx(), { audience: { match: 'any', rules: rules() }, text: MARK })
    const queued = await admin`
      select user_id from notifications
       where tenant_id = ${tenantId} and code = 'manual' and payload->>'text' = ${MARK}`
    const recipients = queued.map(r => r.user_id as string)
    expect(recipients, 'контроль не получил рассылку').toContain(staffId)
    expect(leaked(recipients), 'кандидат среди адресатов рассылки').toEqual([])
    expect(res.recipients, 'число адресатов в ответе расходится с очередью').toBe(new Set(recipients).size)
  })
})

describe('HANDOFF §7.4 (3): счётчик активных пользователей — только штат', () => {
  let expected: number

  beforeAll(async () => {
    const [row] = await admin`
      select count(*)::int as n from users
       where tenant_id = ${tenantId} and kind = 'employee' and status = 'active' and not is_blocked`
    expected = row!.n as number
  })

  it('кандидаты активны и не заблокированы — без фильтра по виду они попали бы в счёт', async () => {
    const [row] = await admin`select count(*)::int as n from users where tenant_id = ${tenantId} and kind = 'candidate' and status = 'active' and not is_blocked`
    expect(row!.n).toBeGreaterThanOrEqual(LOUD.length)
  })

  it('сбор потребления, жёсткая проверка лимита и экран «Використання» — одно число, без кандидатов', async () => {
    expect((await collectUsage(tenantId)).activeUsers, 'tenant_usage.active_users').toBe(expected)
    expect((await checkPlanLimit(tenantId, 'users')).current, 'жёсткая проверка лимита людей').toBe(expected)
    expect((await usageView(ctx())).last?.activeUsers, 'экран «Використання»').toBe(expected)
  })

  it('оплачиваемая ось users_active: прямой пересчёт, счётчик периода и SQL сквозной проверки 15 сходятся', async () => {
    expect(await measureLive(tenantId, 'users_active'), 'прямой пересчёт оси').toBe(expected)
    await syncLiveAxes(tenantId)
    expect(await currentUsage(tenantId, 'users_active'), 'счётчик периода').toBe(expected)
    // `docs/v2/42` §5 п. 15 — дословно, по тенанту теста
    const rows = await admin`
      select t.id
        from tenants t
       where t.id = ${tenantId}
         and (select used from usage_counters u
               where u.tenant_id = t.id and u.axis = 'users_active'
                 and current_date between u.period_start and u.period_end)
          is distinct from
             (select count(*) from users
               where tenant_id = t.id and status = 'active' and kind = 'employee')`
    expect(rows, 'счётчик users_active разошёлся с числом активных сотрудников').toEqual([])
  })

  it('панель оператора: список тенантов, карточка и метрика платформы считают штат', async () => {
    const [total] = await admin`select count(*)::int as n from users where tenant_id = ${tenantId} and kind = 'employee'`
    const row = (await listTenants()).find(t => t.id === tenantId) as Record<string, unknown> | undefined
    expect(row?.active_users, 'active_users в списке тенантов').toBe(expected)
    expect(row?.total_users, 'total_users в списке тенантов').toBe(total!.n)
    const card = await getTenantCard(tenantId)
    expect(card?.active_users, 'active_users в карточке тенанта').toBe(expected)
    const [platform] = await admin`select count(*)::int as n from users where status = 'active' and kind = 'employee'`
    expect((await platformMetrics())!.users_active, 'users_active метрики платформы').toBe(platform!.n)
  })
})

describe('HANDOFF §7.4 (4): отчёты конструктора не показывают кандидатов', () => {
  const byEmployeeEntities = () => (Object.entries(ENTITIES) as [string, { kind?: string | null, fields: Record<string, unknown> }][])
    .filter(([, def]) => def.kind !== 'candidate')

  it('контроль виден в отчётах по людям, записям на курс и попыткам — иначе «кандидата нет» ничего не значит', async () => {
    for (const entity of ['people', 'enrollments', 'attempts'] as Entity[]) {
      const rows = await runReport(ctx(), { entity, fields: ['full_name'] }, ALL)
      expect(namesIn(rows, [STAFF]), `контроль пропал из «${entity}»`).toEqual([STAFF])
    }
  })

  it('ни одна сущность, кроме рекрутинговых, — ни по всей сети, ни в области точки кандидата', async () => {
    const leaks: string[] = []
    for (const [entity, def] of byEmployeeEntities()) {
      for (const scope of [null, [locationId]]) {
        const rows = await runReport(ctx(), { entity: entity as Entity, fields: Object.keys(def.fields) }, ALL, scope)
        for (const name of namesIn(rows, candidateNames())) leaks.push(`${entity}${scope ? ' (точка)' : ''}: ${name}`)
      }
    }
    expect(leaks, 'кандидат в отчёте конструктора').toEqual([])
  })
})

describe('HANDOFF §7.4 (5): журналы без candidate.view не показывают кандидатов (решение владельца 25.09, #143)', () => {
  it.each(GATED_LOGS)('«%s»: у контроля строка есть, у «громких» кандидатов — нет', async (kind) => {
    const staffRows = await readLog({ tenantId, actorId, canSeeCandidates: false }, kind, { userId: staffId, limit: 10 })
    expect(staffRows.length, `контроль пропал из журнала «${kind}»`).toBeGreaterThan(0)
    for (const id of loudIds) {
      const rows = await readLog({ tenantId, actorId, canSeeCandidates: false }, kind, { userId: id, limit: 10 })
      expect(rows.length, `кандидат в журнале «${kind}» без candidate.view`).toBe(0)
    }
    const all = await readLog({ tenantId, actorId, canSeeCandidates: false }, kind, { limit: 500 })
    expect(namesIn(all as Record<string, unknown>[], candidateNames()), `ПІБ кандидата в журнале «${kind}»`).toEqual([])
  })
})
