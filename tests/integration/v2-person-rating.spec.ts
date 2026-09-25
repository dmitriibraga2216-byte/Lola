import { existsSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bulkSchema, personListQuerySchema } from '../../shared/schemas/people'
import { KEYSETS, encodeKeyset } from '../../shared/domain/keyset'

/**
 * Індекс навчальної залученості и четыре блока карточки (docs/v2/38-people-extensions.md §3.1,
 * §3.7, §5.1–§5.3, §7.1–§7.3, §10, §11; docs/v2/33 §5.3; П-16.2, П-16.3; PR-35).
 *
 * Критерии приёмки `38` §13:
 *  1. 8 из 10 обязательных, в среднем на 20 % раньше срока, серия 15 дней, 10 действий помощи →
 *     после `rating.recalc` `rating_pct = 80 + 2 + 5 + 5 = 92.0`, расшифровка несёт все четыре
 *     слагаемых с этими числами;
 *  2. 100 % основы и максимальные бонусы → в списке 130, не обрезано (поповер — e2e);
 *  3. фильтр `rating_pct < 50` как единственное условие массового архивирования →
 *     `422 rating_only_filter_forbidden`.
 * Вокруг них — то, без чего критерии ничего не значат: индекс — не баллы рейтинга; кандидату не
 * считается; уволенному значение фиксируется; этап без `counts_in_rating` в индекс не входит;
 * чужой индекс — только носителю скоупа в его области; место в списке по индексу не раскрывает
 * людей вне области.
 */

const E = await import('../../server/services/engagementIndex')
const P = await import('../../server/services/people')
const T = await import('../../server/services/personTracks')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const stamp = Date.now()
let tenantId: string, lazarevaId: string, otherLocId: string, posId: string, courseId: string, versionId: string
let psyCourseId: string, psyVersionId: string, knowCourseId: string, knowVersionId: string, otherTenantId: string
let subjectId: string, topId: string, lowId: string, lowElsewhereId: string, noAssignId: string, archivedId: string, candidateId: string
let managerLazId: string, managerOtherId: string, hrId: string, strangerId: string
const userIds: string[] = []
const assignmentIds: string[] = []

type Grant = { scopes: string[], scopeType: 'tenant' | 'location' | 'org_unit', scopeId: string | null }
const access = (userId: string, grants: Grant[] = [], extra: { viaToken?: true } = {}) => ({ userId, tenantId, grants, activeRole: null, roles: [], ...extra })
const VIEW = ['person.rating.view_others']
const hr = () => access(hrId, [{ scopes: [...VIEW, 'people.view', 'people.deactivate', 'lifecycle.view', 'time.metrics.view'], scopeType: 'tenant', scopeId: null }])
const managerLaz = () => access(managerLazId, [{ scopes: [...VIEW, 'people.view'], scopeType: 'location', scopeId: lazarevaId }])
const managerOther = () => access(managerOtherId, [{ scopes: [...VIEW, 'people.view'], scopeType: 'location', scopeId: otherLocId }])
const ctx = () => ({ tenantId, actorId: hrId })

async function makePerson(name: string, locationId: string | null, extra: { kind?: 'candidate' } = {}) {
  const phone = `+38093${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = extra.kind === 'candidate'
    ? await admin`insert into users (tenant_id, phone, full_name, status, kind, candidate_state) values (${tenantId}, ${phone}, ${`${name}-${stamp}`}, 'active', 'candidate', 'active') returning id`
    : await admin`insert into users (tenant_id, phone, full_name, status) values (${tenantId}, ${phone}, ${`${name}-${stamp}`}, 'active') returning id`
  const id = u!.id as string
  userIds.push(id)
  if (locationId) await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary, started_at) values (${tenantId}, ${id}, ${locationId}, ${posId}, true, current_date - 400)`
  return id
}

/** Запись на курс: `assigned`, `due`, `completed` — дни от сейчас (минус — в прошлом). */
async function enroll(userId: string, p: { status: string, mandatory?: boolean, assigned: number, due?: number | null, completed?: number | null, progress?: number, course?: [string, string], cancelled?: boolean, startsIn?: number }) {
  const [c, v] = p.course ?? [courseId, versionId]
  const [a] = await admin`insert into assignments (tenant_id, title, subject_type, subject_id, audience, is_mandatory, status)
    values (${tenantId}, ${`Призначення ${stamp}`}, 'course', ${c}, ${admin.json({ rules: [], match: 'any' })}, ${p.mandatory ?? true}, 'active') returning id`
  assignmentIds.push(a!.id as string)
  const days = (n: number | null | undefined) => (n === null || n === undefined ? null : new Date(Date.now() + n * 86_400_000))
  await admin`insert into enrollments (tenant_id, user_id, subject_id, version_id, assignment_id, source, status, progress_pct, created_at, due_at, completed_at, starts_at, cancelled_at, required_total, required_done)
    values (${tenantId}, ${userId}, ${c}, ${v}, ${a!.id}, 'assigned', ${p.status}, ${p.progress ?? (p.status === 'done' ? 100 : 0)}, ${days(p.assigned)}, ${days(p.due)}, ${days(p.completed)},
            ${days(p.startsIn)}, ${p.cancelled ? new Date() : null}, 4, ${p.status === 'done' ? 4 : 1})`
}

/** Дни ленты: `offsets` — дни назад от сегодня по Киеву, `kinds` — разбивка. */
async function activity(userId: string, offsets: number[], kinds: Record<string, number> = { lesson_completed: 1 }) {
  const count = Object.values(kinds).reduce((s, n) => s + n, 0)
  for (const d of offsets) {
    await admin`insert into user_activity_daily (tenant_id, user_id, local_date, events_count, kinds, level)
      values (${tenantId}, ${userId}, (now() at time zone 'Europe/Kyiv')::date - ${d}::int, ${count}, ${admin.json(kinds)}, ${count > 10 ? 4 : count > 5 ? 3 : count > 2 ? 2 : 1})
      on conflict (tenant_id, user_id, local_date) do update set events_count = excluded.events_count, kinds = excluded.kinds, level = excluded.level`
  }
}

const snapshot = (userId: string) => admin`select base_pct::float8 as base, bonus_early::float8 as early, bonus_streak::float8 as streak, bonus_help::float8 as help,
  total_pct::float8 as total, breakdown, calc_date::text as calc_date, window_from::text as window_from, window_to::text as window_to
  from person_rating_snapshots where user_id = ${userId} and is_current`
const ratingOf = async (userId: string) => (await admin`select rating_pct::float8 as pct, rating_updated_at from users where id = ${userId}`)[0]!

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  const [laz] = await admin`select id, org_unit_id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`
  lazarevaId = laz!.id as string
  otherLocId = (await admin`insert into locations (tenant_id, org_unit_id, name) values (${tenantId}, ${laz!.org_unit_id}, ${`Інша точка-${stamp}`}) returning id`)[0]!.id as string
  posId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Посада-rating-${stamp}`}, 'rating-pos') returning id`)[0]!.id as string
  const stages = Object.fromEntries((await admin`select code, id from lifecycle_stages where tenant_id = ${tenantId}`).map(r => [r.code as string, r.id as string]))
  const course = async (title: string, stageId: string | null) => {
    const [c] = await admin`insert into courses (tenant_id, title, slug, status, lifecycle_stage_id) values (${tenantId}, ${`${title} ${stamp}`}, ${`rating-${title.length}-${stamp}`}, 'published', ${stageId}) returning id`
    const [v] = await admin`insert into course_versions (tenant_id, course_id, version) values (${tenantId}, ${c!.id}, 1) returning id`
    return [c!.id as string, v!.id as string] as [string, string]
  }
  ;[courseId, versionId] = await course('Онбординг кухаря', stages.onboarding!)
  ;[psyCourseId, psyVersionId] = await course('Опитувальник вигорання', stages.psychological!)
  ;[knowCourseId, knowVersionId] = await course('Посадова інструкція', stages.knowledge!)

  subjectId = await makePerson('Критерій один', lazarevaId)
  topId = await makePerson('Сто тридцять', lazarevaId)
  lowId = await makePerson('Низький індекс', lazarevaId)
  lowElsewhereId = await makePerson('Низький на іншій точці', otherLocId)
  noAssignId = await makePerson('Без призначень', lazarevaId)
  archivedId = await makePerson('Звільнений', lazarevaId)
  candidateId = await makePerson('Кандидат', null, { kind: 'candidate' })
  managerLazId = await makePerson('Керівник Лазаревої', lazarevaId)
  managerOtherId = await makePerson('Керівник іншої', otherLocId)
  hrId = await makePerson('HR', lazarevaId)
  otherTenantId = (await admin`insert into tenants (slug, name) values (${`rating-iso-${stamp}`}, 'Ізоляція індексу') returning id`)[0]!.id as string
  strangerId = (await admin`insert into users (tenant_id, phone, full_name, status) values (${otherTenantId}, '+380950000011', 'Чужий', 'active') returning id`)[0]!.id as string

  // Критерий 1: 8 из 10 обязательных, каждое на 20 % раньше срока: назначено 20 дней назад, срок —
  // 10 дней назад, завершено 12 дней назад → (−10 − (−12)) / (−10 − (−20)) = 0.2; два открытых
  for (let i = 0; i < 8; i++) await enroll(subjectId, { status: 'done', assigned: -20, due: -10, completed: -12 })
  for (let i = 0; i < 2; i++) await enroll(subjectId, { status: 'not_started', assigned: -20, due: 10 })
  // Не входят в индекс: психологический тест (этап без counts_in_rating), снятое, ещё не открытое,
  // запись, чей срок и завершение за пределами окна, и заявка каталога
  await enroll(subjectId, { status: 'failed', assigned: -30, due: -5, course: [psyCourseId, psyVersionId] })
  await enroll(subjectId, { status: 'not_started', assigned: -3, due: 20, cancelled: true })
  await enroll(subjectId, { status: 'not_started', assigned: -1, due: 40, startsIn: 5 })
  await enroll(subjectId, { status: 'done', assigned: -500, due: -420, completed: -430 })
  await enroll(subjectId, { status: 'not_assigned', assigned: -2 })
  // Серия 15 дней (40…26 дней назад) и отдельные 3 дня подряд; 6 проверок и 4 принятых замечания
  await activity(subjectId, Array.from({ length: 15 }, (_, i) => 40 - i))
  await activity(subjectId, [10, 9, 8])
  await activity(subjectId, [40], { lesson_completed: 1, review_graded: 6, content_issue_accepted: 4 })

  // Критерий 2: всё завершено в момент назначения, серия 45 дней, 25 действий
  for (let i = 0; i < 3; i++) await enroll(topId, { status: 'done', assigned: -30, due: -10, completed: -30 })
  await activity(topId, Array.from({ length: 45 }, (_, i) => 100 - i))
  await activity(topId, [100], { review_graded: 25 })

  // Критерий 3: низкий индекс на своей и на чужой точке
  for (const id of [lowId, lowElsewhereId]) {
    await enroll(id, { status: 'done', assigned: -20, due: -10, completed: -11 })
    for (let i = 0; i < 3; i++) await enroll(id, { status: 'not_started', assigned: -20, due: 10 })
  }
  await enroll(archivedId, { status: 'done', assigned: -20, due: -10, completed: -15 })
  await enroll(candidateId, { status: 'done', assigned: -20, due: -10, completed: -15 })
})

afterAll(async () => {
  await admin`delete from audit_log where entity_id in ${admin(userIds)}`
  await admin`delete from tags where tenant_id = ${tenantId} and name like ${`%${String(stamp).slice(0, 20)}%`}`
  await admin`delete from enrollments where user_id in ${admin(userIds)}`
  await admin`delete from assignments where id in ${admin(assignmentIds)}`
  await admin`delete from user_placements where user_id in ${admin(userIds)}`
  await admin`delete from users where id in ${admin(userIds)}` // снимки и лента уходят каскадом
  await admin`delete from course_versions where course_id in ${admin([courseId, psyCourseId, knowCourseId])}`
  await admin`delete from courses where id in ${admin([courseId, psyCourseId, knowCourseId])}`
  await admin`delete from locations where id = ${otherLocId}`
  await admin`delete from positions where id = ${posId}`
  await admin`delete from tenants where id = ${otherTenantId}`
  await admin.end()
})

describe('схема (`38` §3.1, §3.7)', () => {
  it('rating_pct и итог снимка — 0…130; текущий снимок у человека один', async () => {
    await expect(admin`update users set rating_pct = 130.1 where id = ${noAssignId}`).rejects.toThrow(/users_rating_pct_chk/)
    await expect(admin`insert into person_rating_snapshots (tenant_id, user_id, calc_date, base_pct, total_pct, window_from, window_to)
      values (${tenantId}, ${noAssignId}, current_date, 100, 131, current_date - 364, current_date)`).rejects.toThrow(/person_rating_total_chk/)
    await admin`insert into person_rating_snapshots (tenant_id, user_id, calc_date, base_pct, total_pct, window_from, window_to) values (${tenantId}, ${noAssignId}, current_date - 3, 50, 50, current_date - 367, current_date - 3)`
    await expect(admin`insert into person_rating_snapshots (tenant_id, user_id, calc_date, base_pct, total_pct, window_from, window_to) values (${tenantId}, ${noAssignId}, current_date - 2, 50, 50, current_date - 366, current_date - 2)`).rejects.toThrow(/uq_person_rating_current/)
    await admin`delete from person_rating_snapshots where user_id = ${noAssignId}`
  })

  it('частичный индекс списка — только сотрудники, без условия статуса (Р-35.1)', async () => {
    const [idx] = await admin`select indexdef from pg_indexes where indexname = 'idx_users_tenant_rating'`
    expect(idx!.indexdef).toMatch(/\(tenant_id, rating_pct DESC NULLS LAST\) WHERE \(kind = 'employee'::text\)$/)
  })
})

describe('rating.recalc и критерий §13 к. 1', () => {
  beforeAll(async () => {
    // Уволенный: сначала посчитан, потом уволен — значение фиксируется (§7.2)
    await E.recalcEngagementFor(ctx(), [archivedId])
    await admin`update users set status = 'archived', rating_updated_at = now() - interval '10 days' where id = ${archivedId}`
    await admin`update enrollments set status = 'failed', completed_at = null where user_id = ${archivedId}`
    await E.recalcTenantEngagement(tenantId)
  })

  it('8 из 10, на 20 % раньше, серия 15, 10 действий → 80 + 2 + 5 + 5 = 92.0', async () => {
    const [s] = await snapshot(subjectId)
    expect([s!.base, s!.early, s!.streak, s!.help, s!.total]).toEqual([80, 2, 5, 5, 92])
    expect((await ratingOf(subjectId)).pct).toBe(92)
    const b = s!.breakdown as { formula_version: number, base: { weighted_done: number, weighted_total: number, items: unknown[] }, early: { avg_share: number, counted: number }, streak: { longest: number }, help: { actions: number } }
    expect(b.formula_version).toBe(1)
    expect(b.base).toMatchObject({ weighted_done: 16, weighted_total: 20 })
    // Психологический тест, снятое, ещё не открытое, давнее и заявка каталога — не в окне индекса
    expect(b.base.items).toHaveLength(10)
    // `33` §13 к. 4: курс этапа без `counts_in_rating` (психологический тест) индекс не меняет
    expect((b.base.items as { subjectId: string }[]).some(i => i.subjectId === psyCourseId)).toBe(false)
    expect(b.early).toMatchObject({ avg_share: 0.2, counted: 8 })
    expect(b.streak.longest).toBe(15)
    expect(b.help.actions).toBe(10)
    expect(s!.window_to).toBe(s!.calc_date)
  })

  it('экран §5.3 получает все четыре слагаемых с этими числами', async () => {
    const r = await E.personEngagement(access(subjectId), subjectId)
    if (!r.ok) throw new Error(`personEngagement: ${r.code}`)
    const v = r.data
    expect(v).toMatchObject({ self: true, state: 'ok', total: 92, base: 80, bonuses: { early: 2, streak: 5, help: 5 }, stale: false })
    expect(v.breakdown!.base.weighted_done).toBe(16)
    expect(v.window!.from < v.window!.to).toBe(true)
    expect(v.history.at(-1)!.total).toBe(92)
  })

  it('кандидату индекс не считается, уволенному значение зафиксировано, без назначений — null, а не 0', async () => {
    expect(await snapshot(candidateId)).toHaveLength(0)
    expect((await ratingOf(candidateId)).pct).toBeNull()
    const archived = await ratingOf(archivedId)
    expect(archived.pct).toBe(105) // 100 основы + 5 досрочности — посчитан до увольнения и больше не пересчитывался
    expect(new Date(archived.rating_updated_at as string).getTime()).toBeLessThan(Date.now() - 9 * 86_400_000)
    const none = await ratingOf(noAssignId)
    expect(none.pct).toBeNull()
    expect(none.rating_updated_at).not.toBeNull()
    const r = await E.personEngagement(access(noAssignId), noAssignId)
    expect(r.ok && r.data.state).toBe('no_assignments')
  })

  it('пересчёт идемпотентен: второй прогон в тот же день — тот же снимок, текущий один', async () => {
    await E.recalcTenantEngagement(tenantId)
    const rows = await admin`select is_current, total_pct::float8 as total from person_rating_snapshots where user_id = ${subjectId}`
    expect(rows).toEqual([{ is_current: true, total: 92 }])
  })

  it('баллы рейтинга в индекс не входят: 500 баллов не меняют цифру (`38` §7.1)', async () => {
    await admin`insert into points_ledger (tenant_id, user_id, currency, delta, balance_after, event, ref_id, title)
      values (${tenantId}, ${subjectId}, 'points', 500, 500, 'task_completed', gen_random_uuid(), 'Корпоратив')`
    try {
      const out = await E.recalcEngagementFor(ctx(), [subjectId])
      expect(out.get(subjectId)!.total).toBe(92)
    }
    finally {
      await admin`delete from points_ledger where user_id = ${subjectId}`
    }
  })

  it('смена формулы видна на экране: «Формулу змінено {дата}»', async () => {
    await admin`insert into person_rating_snapshots (tenant_id, user_id, calc_date, base_pct, total_pct, breakdown, window_from, window_to, is_current)
      values (${tenantId}, ${subjectId}, current_date - 40, 70, 70, '{"formula_version": 0}', current_date - 404, current_date - 40, false)`
    const r = await E.personEngagement(access(subjectId), subjectId)
    expect(r.ok && r.data.formula.changedAt).toBeTruthy()
    expect(r.ok && r.data.history.length).toBeGreaterThanOrEqual(2)
    await admin`delete from person_rating_snapshots where user_id = ${subjectId} and not is_current`
  })
})

describe('критерий §13 к. 2 — 130 %, не обрезано; список «%»', () => {
  it('100 % основы и максимальные бонусы → 130 в снимке и в строке списка', async () => {
    const [s] = await snapshot(topId)
    expect([s!.base, s!.early, s!.streak, s!.help, s!.total]).toEqual([100, 10, 10, 10, 130])
    const list = await P.listPeople(ctx(), { q: `Сто тридцять-${stamp}`, tab: 'all', limit: 10 }, { ratingArea: 'tenant' })
    expect(list.items[0]).toMatchObject({ ratingPct: 130, ratingVisible: true })
  })

  it('сортировка по индексу — по убыванию, «не рассчитан» в конце; курсор своего ключа', async () => {
    const q = `-${stamp}`
    const page = await P.listPeople(ctx(), personListQuerySchema.parse({ q, tab: 'all', sort: 'rating', limit: 2 }), { ratingArea: 'tenant' })
    expect(page.items.map(i => i.ratingPct)).toEqual([130, 105]) // уволенный — со своим зафиксированным значением
    expect(page.cursor).toBeTruthy()
    const next = await P.listPeople(ctx(), personListQuerySchema.parse({ q, tab: 'all', sort: 'rating', limit: 50, cursor: page.cursor }), { ratingArea: 'tenant' })
    const values = next.items.map(i => i.ratingPct)
    expect(values.slice(0, 3)).toEqual([92, 26, 26])
    const firstNull = values.indexOf(null)
    expect(firstNull).toBe(3)
    expect(values.slice(firstNull).every(v => v === null)).toBe(true)
    // Курсор сортировки по дате к сортировке по индексу не подходит — 400, а не первая страница
    expect(personListQuerySchema.safeParse({ sort: 'rating', cursor: encodeKeyset(KEYSETS.people, ['2026-09-24T09:00:00.123456Z', subjectId]) }).success).toBe(false)
  })

  it('без скоупа цифр нет; руководитель видит только свою точку, и порядок чужих не раскрывается', async () => {
    const plain = await P.listPeople(ctx(), { q: `-${stamp}`, tab: 'all', limit: 50 })
    expect(plain.items.every(i => i.ratingPct === null && !i.ratingVisible)).toBe(true)
    const mine = await P.listPeople(ctx(), { q: `-${stamp}`, tab: 'all', limit: 50 }, { ratingArea: [lazarevaId] })
    const byId = new Map(mine.items.map(i => [i.id, i]))
    expect(byId.get(lowId)).toMatchObject({ ratingVisible: true })
    expect(byId.get(lowElsewhereId)).toMatchObject({ ratingVisible: false, ratingPct: null })
    const filtered = await P.listPeople(ctx(), { q: `-${stamp}`, tab: 'all', limit: 50, ratingLt: 50 }, { ratingArea: [lazarevaId] })
    expect(filtered.items.map(i => i.id)).toEqual([lowId]) // человек чужой точки под порог не попадает
  })
})

describe('критерий §13 к. 3 — индекс не единственное условие массового архивирования', () => {
  it('rating_pct < 50 одним условием + «Архівувати» → rating_only_filter_forbidden, никто не уволен', async () => {
    const r = await P.bulkPeople(ctx(), { action: 'archive', filter: { tab: 'active', ratingLt: 50 } }, { ratingArea: 'tenant' })
    expect(r).toEqual({ ok: false, code: 'rating_only_filter_forbidden' })
    const rows = await admin`select status from users where id in ${admin([lowId, lowElsewhereId])}`
    expect(rows.every(u => u.status === 'active')).toBe(true)
  })

  it('со вторым сужающим условием — можно; другие массовые действия с одним индексом — можно', async () => {
    const tagged = await P.bulkPeople(ctx(), { action: 'add_tag', tag: `низький-${stamp}`.slice(0, 40), filter: { tab: 'active', ratingLt: 50, q: `-${stamp}` } }, { ratingArea: 'tenant' })
    expect(tagged).toMatchObject({ ok: true, done: 2 })
    const onlyRating = await P.bulkPeople(ctx(), { action: 'add_tag', tag: `ще-${stamp}`.slice(0, 40), filter: { tab: 'active', ratingLt: 50 } }, { ratingArea: [otherLocId] })
    expect(onlyRating).toMatchObject({ ok: true, done: 1 }) // только его точка — индекс чужих ему не виден
    const archived = await P.bulkPeople(ctx(), { action: 'archive', filter: { tab: 'active', ratingLt: 50, locationId: otherLocId } }, { ratingArea: 'tenant' })
    expect(archived).toMatchObject({ ok: true, done: 1 })
    expect((await admin`select status from users where id = ${lowElsewhereId}`)[0]!.status).toBe('archived')
  })

  it('фильтр по индексу без скоупа — forbidden; схема: либо отмеченные, либо фильтр', async () => {
    expect(await P.bulkPeople(ctx(), { action: 'add_tag', tag: 'x', filter: { tab: 'all', ratingGte: 90 } }, { ratingArea: 'none' })).toEqual({ ok: false, code: 'forbidden' })
    expect(bulkSchema.safeParse({ action: 'archive', filter: { ratingLt: 50 } }).success).toBe(true)
    expect(bulkSchema.safeParse({ action: 'archive' }).success).toBe(false)
    expect(bulkSchema.safeParse({ action: 'archive', ids: [subjectId], filter: { ratingLt: 50 } }).success).toBe(false)
    expect(personListQuerySchema.safeParse({ ratingLt: 131 }).success).toBe(false)
  })
})

describe('права на чужой индекс (`38` §2, §7.3) и ручной пересчёт (§10)', () => {
  it('свой — без скоупа; руководитель — своей точки; HR — тенант; чужая точка и сотрудник — forbidden', async () => {
    expect((await E.personEngagement(managerLaz(), subjectId)).ok).toBe(true)
    expect((await E.personEngagement(hr(), subjectId)).ok).toBe(true)
    expect(await E.personEngagement(managerOther(), subjectId)).toEqual({ ok: false, code: 'forbidden' })
    expect(await E.personEngagement(access(lowId), subjectId)).toEqual({ ok: false, code: 'forbidden' })
    // Токен интеграции своего индекса по данным не получает — только скоуп
    expect(await E.personEngagement(access(subjectId, [], { viaToken: true }), subjectId)).toEqual({ ok: false, code: 'forbidden' })
  })

  it('кандидат, чужой тенант, не-uuid — not_found', async () => {
    expect(await E.personEngagement(hr(), candidateId)).toEqual({ ok: false, code: 'not_found' })
    expect(await E.personEngagement(hr(), strangerId)).toEqual({ ok: false, code: 'not_found' })
    expect(await E.personEngagement(hr(), 'не-uuid')).toEqual({ ok: false, code: 'not_found' })
  })

  it('пересчёт — не чаще раза в час; уволенному — person_archived; чужой — в audit_log', async () => {
    expect(await E.recalcPersonEngagement(hr(), subjectId)).toEqual({ ok: false, code: 'recalc_too_often' })
    await admin`update users set rating_updated_at = now() - interval '2 hours' where id = ${subjectId}`
    const r = await E.recalcPersonEngagement(hr(), subjectId)
    expect(r.ok && r.data.total).toBe(92)
    const [log] = await admin`select action, after from audit_log where entity_id = ${subjectId} and action = 'person_rating.recalc' order by created_at desc limit 1`
    expect(log!.after).toEqual({ ratingPct: 92 })
    expect(await E.recalcPersonEngagement(hr(), archivedId)).toEqual({ ok: false, code: 'person_archived' })
  })
})

describe('блок «Етап» карточки: треки по этапам (`33` §5.3, `38` §5.1)', () => {
  beforeAll(async () => {
    await enroll(noAssignId, { status: 'in_progress', assigned: -5, due: 20, progress: 40, course: [knowCourseId, knowVersionId] })
    await enroll(noAssignId, { status: 'in_progress', assigned: -5, due: 2, progress: 25 })
  })

  it('этап без progress — плоский список без процента и срока; срок — светофором; модули — версии записи', async () => {
    const r = await T.personTracks(hr(), noAssignId)
    if (!r.ok) throw new Error(`personTracks: ${r.code}`)
    const groups = r.data.groups
    const knowledge = groups.find(g => g.items.some(i => i.progressPct === null))!
    expect(knowledge.flat).toBe(true)
    expect(knowledge.items[0]).toMatchObject({ progressPct: null, dueAt: null, light: 'none' })
    const onboarding = groups.find(g => g.items.some(i => i.progressPct === 25))!
    expect(onboarding.flat).toBe(false)
    expect(onboarding.items[0]).toMatchObject({ light: 'soon', modulesDone: 1, modulesTotal: 4, spentSeconds: 0 })
    // Пустой этап, назначаемый сотруднику, — строкой «немає призначень»
    expect(groups.some(g => g.stage && g.items.length === 0)).toBe(true)
  })

  it('время человека видно только тому, кому видно его время (`37` §2)', async () => {
    const r = await T.personTracks(managerLaz(), noAssignId)
    expect(r.ok && r.data.timeVisible).toBe(false)
    expect(r.ok && r.data.groups.flatMap(g => g.items).every(i => i.spentSeconds === null && i.plannedSeconds === null)).toBe(true)
    expect(await T.personTracks(hr(), candidateId)).toEqual({ ok: false, code: 'not_found' })
  })
})

// ── HTTP: код ошибки и статус (сборка `.output` есть в CI после `pnpm build`) ──────────────
const BUILT = existsSync('.output/server/index.mjs')
const PORT = 3847
const BASE = `http://127.0.0.1:${PORT}`

describe.skipIf(!BUILT)('HTTP: 422 rating_only_filter_forbidden', () => {
  let server: ChildProcess | undefined
  let cookie = ''
  beforeAll(async () => {
    await admin`delete from rate_limits`
    await admin`delete from otp_codes`
    server = spawn('node', ['.output/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), NITRO_PORT: String(PORT), OTP_DEBUG: '1', NUXT_DATABASE_URL: process.env.DATABASE_URL, WORKER_ENABLED: '0' }, stdio: 'ignore' })
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${BASE}/health`)).ok) break }
      catch { /* ещё поднимается */ }
      await new Promise(r => setTimeout(r, 500))
    }
    const phone = '+380661864742'
    const req = await fetch(`${BASE}/api/v1/auth/otp/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) })
    const code = ((await req.json()) as { data: { devCode: string } }).data.devCode
    const ver = await fetch(`${BASE}/api/v1/auth/otp/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, code }) })
    cookie = ver.headers.getSetCookie().map(c => c.split(';')[0]!).join('; ')
  }, 60_000)
  afterAll(() => { server?.kill() })

  it('POST /people/bulk {action: archive, filter: {ratingLt: 50}} → 422', async () => {
    const csrf = cookie.split('; ').find(c => c.startsWith('lola_csrf='))?.split('=')[1] ?? ''
    const res = await fetch(`${BASE}/api/v1/people/bulk`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'archive', filter: { ratingLt: 50 } }) })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('rating_only_filter_forbidden')
  })
})
