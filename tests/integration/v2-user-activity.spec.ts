import postgres from 'postgres'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { activityLevel, yearGrid } from '../../shared/domain/activity'
import { USER_ACTIVITY_KINDS } from '../../shared/enums'
import { readThrough } from './_lesson'

/**
 * Лента и карта активности (docs/v2/38-people-extensions.md §3.3, §5.1, §7.9–§7.11, §11; PR-34).
 *
 * Критерии приёмки §13: п. 11 — человек на точке UTC+4, событие в 22:40 UTC → `local_date` —
 * следующий календарный день, клетка закрашена в нём; п. 12 — события старше 400 дней, отработал
 * `activity.purge` → события удалены, карта за позапрошлый год по-прежнему строится из
 * `user_activity_daily`. Вокруг них — то, без чего критерии ничего не значат: день считается по
 * снимку пояса человека (не сервера и не тенанта) и не пересчитывается при переводе (§12),
 * `users.timezone` перекрывает пояс точки, секунды дня берутся из учёта времени (PR-21), права
 * на чужую ленту (§2, §7.11) и настоящие действия, которые порождают события (§7.9).
 */

const A = await import('../../server/services/activity')
const { withTenant } = await import('../../server/utils/withTenant')
const { openLesson, completeLesson } = await import('../../server/services/learning')
const { getArticle } = await import('../../server/services/knowledge')
const { enqueueNotification, scheduleWithQuietHours, CANDIDATE_QUIET_HOURS } = await import('../../server/services/notifications')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const stamp = Date.now()
const DUBAI = 'Asia/Dubai' // UTC+4 круглый год, без перехода на летнее время
let tenantId: string, lazarevaId: string, dubaiId: string, posId: string, otherTenantId: string, vacancyId: string
let subjectId: string, movedId: string, remoteId: string, archiveId: string, flowId: string, colleagueId: string
let managerDubaiId: string, managerLazarevaId: string, hrId: string, mentorId: string, candidateId: string, strangerId: string
const userIds: string[] = []

type Grant = { scopes: string[], scopeType: 'tenant' | 'location' | 'org_unit', scopeId: string | null }
const access = (userId: string, grants: Grant[], extra: { viaToken?: true } = {}) => ({ userId, tenantId, grants, activeRole: null, roles: [], ...extra })
const VIEW = ['person.activity.view_others']
const hr = () => access(hrId, [{ scopes: VIEW, scopeType: 'tenant', scopeId: null }])

async function makePerson(name: string, locationId: string | null, startedDaysAgo = 400) {
  const phone = `+38093${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, phone, full_name, status) values (${tenantId}, ${phone}, ${`${name}-${stamp}`}, 'active') returning id`
  const id = u!.id as string
  userIds.push(id)
  if (locationId) await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary, started_at) values (${tenantId}, ${id}, ${locationId}, ${posId}, true, current_date - ${startedDaysAgo}::int)`
  return id
}

const record = (userId: string, occurredAt: Date | null, kind: typeof USER_ACTIVITY_KINDS[number] = 'lesson_completed') =>
  withTenant(tenantId, null, tx => A.recordActivity(tx, tenantId, { userId, kind, ref: { entity: 'lessons', id: null }, occurredAt }))

const events = (userId: string) => admin`select kind, tz, local_date::text as local_date, location_id, ref_entity from user_activity_events where user_id = ${userId} order by id`
const daily = (userId: string) => admin`select local_date::text as local_date, events_count, seconds_spent, level, kinds from user_activity_daily where user_id = ${userId} order by local_date`

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  const [laz] = await admin`select id, org_unit_id, timezone from locations where tenant_id = ${tenantId} and name = 'Лазарева'`
  lazarevaId = laz!.id as string
  expect(laz!.timezone).toBe('Europe/Kyiv')
  dubaiId = (await admin`insert into locations (tenant_id, org_unit_id, name, timezone) values (${tenantId}, ${laz!.org_unit_id}, ${`Дубай-${stamp}`}, ${DUBAI}) returning id`)[0]!.id as string
  posId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Посада-activity-${stamp}`}, 'activity-pos') returning id`)[0]!.id as string
  subjectId = await makePerson('Кухар у Дубаї', dubaiId)
  movedId = await makePerson('Переведений', dubaiId)
  remoteId = await makePerson('Віддалений', lazarevaId)
  archiveId = await makePerson('Давня активність', lazarevaId, 1200)
  flowId = await makePerson('Проходить курс', dubaiId)
  colleagueId = await makePerson('Колега', dubaiId)
  managerDubaiId = await makePerson('Керівник Дубаю', dubaiId)
  managerLazarevaId = await makePerson('Керівник Лазаревої', lazarevaId)
  hrId = await makePerson('HR мережі', lazarevaId)
  mentorId = await makePerson('Наставник', dubaiId)
  vacancyId = (await admin`insert into vacancies (tenant_id, title, location_id) values (${tenantId}, ${`Вакансія Дубай ${stamp}`}, ${dubaiId}) returning id`)[0]!.id as string
  const [cand] = await admin`insert into users (tenant_id, phone, full_name, status, kind, candidate_state, vacancy_id)
    values (${tenantId}, ${`+38094${String(stamp).slice(-7)}`}, ${`Кандидат-${stamp}`}, 'active', 'candidate', 'active', ${vacancyId}) returning id`
  candidateId = cand!.id as string
  userIds.push(candidateId)
  otherTenantId = (await admin`insert into tenants (slug, name) values (${`activity-iso-${stamp}`}, 'Ізоляція активності') returning id`)[0]!.id as string
  strangerId = (await admin`insert into users (tenant_id, phone, full_name, status) values (${otherTenantId}, '+380950000001', 'Чужий', 'active') returning id`)[0]!.id as string
})

afterAll(async () => {
  await admin`delete from notifications where user_id in ${admin(userIds)}`
  await admin`delete from review_queue_items where user_id in ${admin(userIds)}`
  await admin`delete from learning_time_sessions where user_id in ${admin(userIds)}`
  await admin`delete from certificates where user_id in ${admin(userIds)}`
  await admin`delete from task_status_log where user_id in ${admin(userIds)}`
  await admin`delete from enrollments where user_id in ${admin(userIds)}`
  await admin`delete from knowledge_articles where tenant_id = ${tenantId} and slug like ${`activity-${stamp}%`}`
  await admin`delete from user_placements where user_id in ${admin(userIds)}`
  await admin`delete from users where id in ${admin(userIds)}` // лента уходит каскадом
  await admin`delete from vacancies where id = ${vacancyId}`
  await admin`delete from locations where id = ${dubaiId}`
  await admin`delete from positions where id = ${posId}`
  await admin`delete from tenants where id = ${otherTenantId}`
  await admin.end()
})

describe('схема (`38` §3.1, §3.3)', () => {
  it('закрытый список видов в БД — ровно USER_ACTIVITY_KINDS', async () => {
    const [chk] = await admin`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'user_activity_events_kind_chk'`
    expect([...String(chk!.def).matchAll(/'([a-z_]+)'::text/g)].map(m => m[1])).toEqual([...USER_ACTIVITY_KINDS])
  })

  it('users.timezone: пояс, которого Postgres не знает, не сохраняется', async () => {
    await expect(admin`update users set timezone = 'Mars/Olympus_Mons' where id = ${remoteId}`).rejects.toThrow(/time zone/)
    await admin`update users set timezone = 'Asia/Tokyo' where id = ${remoteId}`
    await admin`update users set timezone = null where id = ${remoteId}`
  })

  it('уровень в SQL — та же лесенка, что activityLevel()', async () => {
    const counts = [0, 1, 2, 3, 5, 6, 10, 11, 40]
    const levels = await withTenant(tenantId, null, tx => Promise.all(counts.map(async n =>
      Number(((await tx.execute(sql`select ${A.levelSql(sql`${n}::int`)} as l`)) as unknown as { l: number }[])[0]!.l))))
    expect(levels).toEqual(counts.map(activityLevel))
  })
})

describe('§13 п. 11: день — по поясу человека на момент события', () => {
  it('человек на точке UTC+4, событие в 22:40 UTC → следующий календарный день, клетка закрашена в нём', async () => {
    const day = await record(subjectId, new Date('2026-03-10T22:40:00Z'))
    expect(day).toBe('2026-03-11')
    const [ev] = await events(subjectId)
    expect(ev).toMatchObject({ kind: 'lesson_completed', tz: DUBAI, local_date: '2026-03-11', location_id: dubaiId })
    expect(await daily(subjectId)).toEqual([{ local_date: '2026-03-11', events_count: 1, seconds_spent: 0, level: 1, kinds: { lesson_completed: 1 } }])

    const r = await A.personActivityYear(hr(), subjectId, { year: 2026 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.days.map(d => d.date)).toEqual(['2026-03-11'])
    const cells = yearGrid(r.data.year, r.data.days, r.data.window).flat()
    expect(cells.find(c => c.date === '2026-03-11')!.day).toMatchObject({ count: 1, level: 1 })
    expect(cells.find(c => c.date === '2026-03-10')!.day).toBeNull() // UTC-день пуст
  })

  it('не сервера и не тенанта: 20:30 UTC — ещё 22:30 по Киеву, но уже 00:30 у человека в Дубае', async () => {
    expect(await record(subjectId, new Date('2026-04-02T20:30:00Z'))).toBe('2026-04-03')
    // Тот же момент у человека на киевской точке — его собственный день, 2 апреля
    expect(await record(remoteId, new Date('2026-04-02T20:30:00Z'))).toBe('2026-04-02')
    const [ev] = await events(remoteId)
    expect(ev!.tz).toBe('Europe/Kyiv')
  })

  it('перевод на точку в другом поясе не переписывает прошлую карту (§12)', async () => {
    const before = await record(movedId, new Date('2026-05-05T21:30:00Z')) // 01:30 6 мая в Дубае
    expect(before).toBe('2026-05-06')
    // Перевод: дубайское размещение закрыто вчера, киевское — с сегодня
    await admin`update user_placements set ended_at = current_date - 1 where user_id = ${movedId}`
    await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary, started_at) values (${tenantId}, ${movedId}, ${lazarevaId}, ${posId}, true, current_date)`
    await record(movedId, null)
    // Позднее событие о дне, когда человек ещё работал в Дубае, — по поясу той точки
    expect(await record(movedId, new Date('2026-05-07T20:30:00Z'))).toBe('2026-05-08')
    const rows = await events(movedId)
    expect(rows.map(e => e.tz)).toEqual([DUBAI, 'Europe/Kyiv', DUBAI])
    expect(rows[0]!.local_date).toBe('2026-05-06') // снимок не пересчитан
    expect(rows[1]!.location_id).toBe(lazarevaId)
  })

  it('users.timezone перекрывает пояс точки (§3.1, §7.10)', async () => {
    await admin`update users set timezone = 'America/New_York' where id = ${remoteId}`
    try {
      // 11 марта 2026 в Нью-Йорке уже летнее время (UTC−4): 02:00 UTC — ещё 22:00 10 марта
      expect(await record(remoteId, new Date('2026-03-11T02:00:00Z'))).toBe('2026-03-10')
      const zone = await withTenant(tenantId, null, tx => A.personTimezone(tx, remoteId))
      expect(zone).toMatchObject({ tz: 'America/New_York', source: 'user' })
    }
    finally {
      await admin`update users set timezone = null where id = ${remoteId}`
    }
  })

  it('цепочка пояса: точка сотрудника, точка вакансии кандидата, тенант', async () => {
    await withTenant(tenantId, null, async (tx) => {
      expect(await A.personTimezone(tx, subjectId)).toMatchObject({ tz: DUBAI, source: 'placement', locationId: dubaiId })
      expect(await A.personTimezone(tx, candidateId)).toMatchObject({ tz: DUBAI, source: 'vacancy', locationId: dubaiId })
      // До начала размещения точки у человека нет — пояс тенанта
      expect(await A.personTimezone(tx, subjectId, new Date('2020-01-01T12:00:00Z'))).toMatchObject({ tz: 'Europe/Kyiv', source: 'tenant' })
    })
  })

  it('сбой записи события не ломает действие: оно откатывается одно, транзакция живёт', async () => {
    await admin`update locations set timezone = 'Mars/Olympus_Mons' where id = ${dubaiId}`
    try {
      const got = await withTenant(tenantId, null, async (tx) => {
        const day = await A.recordActivity(tx, tenantId, { userId: colleagueId, kind: 'lesson_completed' })
        const [alive] = await tx.execute(sql`select 1 as ok`) as unknown as { ok: number }[]
        return { day, alive: alive!.ok }
      })
      expect(got).toEqual({ day: null, alive: 1 })
      expect(await events(colleagueId)).toHaveLength(0)
    }
    finally {
      await admin`update locations set timezone = ${DUBAI} where id = ${dubaiId}`
    }
  })
})

describe('секунды дня — из учёта времени (PR-21), а не из события (`38` §5.1)', () => {
  const session = (startedAt: string, credited: number) => admin`
    insert into learning_time_sessions (tenant_id, user_id, subject_type, subject_id, kind, session_key, started_at, last_beat_at, closed_reason, credited_seconds)
    values (${tenantId}, ${subjectId}, 'lesson', gen_random_uuid(), 'content', gen_random_uuid(), ${startedAt}, ${startedAt}::timestamptz + interval '20 minutes', 'completed', ${credited})`

  it('сегменты сводятся в локальный день человека; прогон идемпотентен и не трогает счётчик событий', async () => {
    await session('2026-03-10T21:00:00Z', 900) // 01:00 11 марта в Дубае
    await session('2026-03-11T15:00:00Z', 300) // 19:00 11 марта
    await session('2026-03-11T20:30:00Z', 60) // 00:30 12 марта
    const first = await A.aggregateActivitySeconds(tenantId, { windowMinutes: 30 })
    expect(first.days).toBeGreaterThanOrEqual(2)
    const again = await A.aggregateActivitySeconds(tenantId, { windowMinutes: 30 })
    expect(again.days).toBe(0) // ничего не изменилось — ничего не переписано
    const rows = (await daily(subjectId)).filter(r => r.local_date.startsWith('2026-03'))
    expect(rows).toEqual([
      { local_date: '2026-03-11', events_count: 1, seconds_spent: 1200, level: 1, kinds: { lesson_completed: 1 } },
      { local_date: '2026-03-12', events_count: 0, seconds_spent: 60, level: 0, kinds: {} },
    ])
    const r = await A.personActivityYear(hr(), subjectId, { year: 2026 })
    if (!r.ok) throw new Error(r.code)
    expect(r.data.days.find(d => d.date === '2026-03-12')).toMatchObject({ count: 0, seconds: 60, level: 0 })
  })
})

describe('§13 п. 12: после activity.purge карта не рассыпается', () => {
  it('события старше 400 дней удалены, карта за позапрошлый год строится из агрегата', async () => {
    const [{ now }] = await admin<[{ now: Date }]>`select now() as now`
    const year = now.getUTCFullYear()
    const old1 = new Date(Date.UTC(year - 2, 6, 1, 9)) // 1 июля позапрошлого года — заведомо старше 400 дней
    const old2 = new Date(now.getTime() - 450 * 86_400_000)
    const fresh = new Date(now.getTime() - 10 * 86_400_000)
    for (const at of [old1, old1, old1, old2, fresh]) await record(archiveId, at)
    const beforeDaily = await daily(archiveId)
    expect(beforeDaily).toHaveLength(3)
    expect(beforeDaily[0]).toMatchObject({ local_date: `${year - 2}-07-01`, events_count: 3, level: 2 })

    const removed = await A.purgeActivity(tenantId)
    expect(removed).toBeGreaterThanOrEqual(4)
    const left = await events(archiveId)
    expect(left).toHaveLength(1) // осталось только свежее
    // Агрегат не тронут ни уборкой, ни пересчётом секунд
    await A.aggregateActivitySeconds(tenantId, { windowMinutes: 2880 })
    expect(await daily(archiveId)).toEqual(beforeDaily)

    const r = await A.personActivityYear(hr(), archiveId, { year: year - 2 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.years).toContain(year - 2)
    expect(r.data.days).toEqual([{ date: `${year - 2}-07-01`, count: 3, seconds: 0, level: 2, kinds: { lesson_completed: 3 } }])
    const cell = yearGrid(r.data.year, r.data.days, r.data.window).flat().find(c => c.date === `${year - 2}-07-01`)
    expect(cell!.day!.level).toBe(2)
  })

  it('уборка — только своего тенанта и только старше 400 дней', async () => {
    const [{ n }] = await admin<[{ n: number }]>`select count(*)::int as n from user_activity_events where tenant_id = ${tenantId} and occurred_at < now() - interval '400 days'`
    expect(n).toBe(0)
    const [{ fresh }] = await admin<[{ fresh: number }]>`select count(*)::int as fresh from user_activity_events where user_id = ${subjectId}`
    expect(fresh).toBeGreaterThan(0) // мартовские события этого года — моложе 400 дней
  })
})

describe('кто видит чужую ленту (§2, §7.11)', () => {
  it('своя — без скоупа; чужая без скоупа — 403', async () => {
    const own = await A.personActivityYear(access(subjectId, []), subjectId, {})
    expect(own.ok && own.data.scope).toBe('self')
    expect(await A.personActivityYear(access(colleagueId, [{ scopes: ['learn.view'], scopeType: 'location', scopeId: dubaiId }]), subjectId, {})).toEqual({ ok: false, code: 'forbidden' })
  })

  it('руководитель точки — только людей своей точки; HR — всех', async () => {
    const mine = await A.personActivityYear(access(managerDubaiId, [{ scopes: VIEW, scopeType: 'location', scopeId: dubaiId }]), subjectId, { year: 2026 })
    expect(mine.ok && mine.data.scope).toBe('full')
    expect(mine.ok && mine.data.days.map(d => d.date)).toContain('2026-03-11')
    expect(await A.personActivityYear(access(managerLazarevaId, [{ scopes: VIEW, scopeType: 'location', scopeId: lazarevaId }]), subjectId, {})).toEqual({ ok: false, code: 'forbidden' })
    const all = await A.personActivityYear(hr(), subjectId, {})
    expect(all.ok && all.data.window.from).toBeNull()
  })

  it('наставник — пока работа человека у него в очереди, и только 90 дней', async () => {
    const mentor = access(mentorId, [{ scopes: ['review.queue', 'review.grade'], scopeType: 'location', scopeId: dubaiId }])
    expect(await A.personActivityYear(mentor, subjectId, {})).toEqual({ ok: false, code: 'forbidden' })
    await record(subjectId, null) // свежее событие — внутри окна
    const [item] = await admin`insert into review_queue_items (tenant_id, task_type, source_id, user_id, status, assigned_reviewer_id)
      values (${tenantId}, 'workshop', gen_random_uuid(), ${subjectId}, 'waiting', ${mentorId}) returning id`
    const r = await A.personActivityYear(mentor, subjectId, { year: 2026 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.scope).toBe('reviewer')
    const from = r.data.window.from!
    const [{ expected }] = await admin<[{ expected: string }]>`select ((now() at time zone ${DUBAI})::date - 89)::text as expected`
    expect(from).toBe(expected)
    expect(r.data.days.length).toBeGreaterThan(0)
    expect(r.data.days.every(d => d.date >= from)).toBe(true)
    expect(r.data.days.map(d => d.date)).not.toContain('2026-03-11') // старше 90 дней
    // Проверил и закрыл — доступ пропал
    await admin`update review_queue_items set status = 'done' where id = ${item!.id}`
    expect(await A.personActivityYear(mentor, subjectId, {})).toEqual({ ok: false, code: 'forbidden' })
  })

  it('токен интеграции прав по данным не получает — только скоуп', async () => {
    expect(await A.personActivityYear(access(subjectId, [], { viaToken: true }), subjectId, {})).toEqual({ ok: false, code: 'forbidden' })
    const t = await A.personActivityYear(access(hrId, [{ scopes: VIEW, scopeType: 'tenant', scopeId: null }], { viaToken: true }), subjectId, {})
    expect(t.ok).toBe(true)
  })

  it('кандидат, чужой тенант и мусор в пути — 404', async () => {
    expect(await A.personActivityYear(hr(), candidateId, {})).toEqual({ ok: false, code: 'not_found' })
    expect(await A.personActivityYear(hr(), strangerId, {})).toEqual({ ok: false, code: 'not_found' })
    expect(await A.personActivityYear(hr(), 'not-a-uuid', {})).toEqual({ ok: false, code: 'not_found' })
  })

  it('годы селектора — с первого дня активности до текущего', async () => {
    const r = await A.personActivityYear(hr(), archiveId, {})
    if (!r.ok) throw new Error(r.code)
    const current = Number(r.data.window.to.slice(0, 4))
    expect(r.data.year).toBe(current)
    expect(r.data.years[0]).toBe(current)
    expect(r.data.years.at(-1)).toBe(current - 2)
  })
})

describe('события порождают настоящие действия (§7.9)', () => {
  it('курс: начало записи, два урока, завершение записи и сертификат — в ленте ученика', async () => {
    const [course] = await admin`select id, published_version_id from courses where tenant_id = ${tenantId} and title = 'Введення на посаду'`
    const lessons = await admin`select l.id from lessons l join modules m on m.id = l.module_id where m.course_version_id = ${course!.published_version_id} order by m.sort, l.sort`
    const [enr] = await admin`insert into enrollments (tenant_id, user_id, subject_id, version_id, source, required_total)
      values (${tenantId}, ${flowId}, ${course!.id}, ${course!.published_version_id}, 'self', ${lessons.length}) returning id`
    const learner = { tenantId, actorId: flowId }
    for (const l of lessons) {
      expect((await openLesson(learner, enr!.id, l.id)).ok).toBe(true)
      await readThrough(admin, enr!.id, l.id, 600)
      expect((await completeLesson(learner, enr!.id, l.id)).ok).toBe(true)
    }
    // Повторный зачёт уже зачтённого урока события не дублирует
    expect((await completeLesson(learner, enr!.id, lessons[0]!.id)).ok).toBe(true)
    const kinds = (await events(flowId)).map(e => e.kind)
    expect(kinds.filter(k => k === 'enrollment_started')).toHaveLength(1)
    expect(kinds.filter(k => k === 'lesson_completed')).toHaveLength(lessons.length)
    expect(kinds.filter(k => k === 'enrollment_completed')).toHaveLength(1)
    expect(kinds.filter(k => k === 'certificate_issued')).toHaveLength(1)
    const [row] = await admin`select events_count, level, kinds from user_activity_daily where user_id = ${flowId}`
    expect(row!.events_count).toBe(kinds.length)
    expect(row!.level).toBe(activityLevel(kinds.length))
    expect(row!.kinds).toMatchObject({ lesson_completed: lessons.length, enrollment_started: 1, enrollment_completed: 1 })
  })

  it('статья базы знаний: прочтение — раз в день, перечитывание не событие', async () => {
    const [art] = await admin`insert into knowledge_articles (tenant_id, title, slug, status) values (${tenantId}, 'Стандарт подачі', ${`activity-${stamp}`}, 'published') returning id`
    const reader = { tenantId, actorId: colleagueId }
    await getArticle(reader, art!.id, { countView: true })
    await getArticle(reader, art!.id, { countView: true })
    const reads = (await events(colleagueId)).filter(e => e.kind === 'knowledge_read')
    expect(reads).toHaveLength(1)
    expect(reads[0]!.ref_entity).toBe('knowledge_articles')
  })
})

describe('тихие часы по той же цепочке пояса (PR-37 → PR-34)', () => {
  it('кандидат с поясом в карточке — окно 09:00–20:00 по нему, а не по точке вакансии', async () => {
    const FAR = 'Pacific/Auckland' // далеко и от Дубая, и от Киева
    await admin`update users set timezone = ${FAR} where id = ${candidateId}`
    const dedupKey = `activity-tz:${stamp}`
    const before = new Date()
    const ok = await withTenant(tenantId, null, tx => enqueueNotification(tx, { tenantId, userId: candidateId, code: 'candidate_reminder', payload: { vacancy: 'Test', days: 2 }, dedupKey }))
    const after = new Date()
    expect(ok).toBe(true)
    const [row] = await admin`select scheduled_for from notifications where dedup_key = ${dedupKey}`
    const got = new Date(row!.scheduled_for as string).getTime()
    const lo = scheduleWithQuietHours(before, FAR, CANDIDATE_QUIET_HOURS).getTime()
    const hi = scheduleWithQuietHours(after, FAR, CANDIDATE_QUIET_HOURS).getTime()
    expect(got).toBeGreaterThanOrEqual(Math.min(lo, hi) - 1000)
    expect(got).toBeLessThanOrEqual(Math.max(lo, hi) + 1000)
  })
})
