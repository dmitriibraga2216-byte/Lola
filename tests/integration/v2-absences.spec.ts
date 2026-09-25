import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * PR-33 пакета `docs/v2` (`45-plan.md`): нормы отсутствий и сдвиг дедлайнов —
 * docs/v2/38-people-extensions.md §3.6, §4, §5.1, §6.3–6.4, §7.12–7.14, §12, §13 к. 9–10.
 *
 * - **§13 к. 9** — на карточке: компания 24 дня, точка переопределила только больничный (7),
 *   индивидуальной корректировки нет → відпустка 24 «Норма компанії», лікарняний 7 «Норма точки».
 *   (Само разрешение уже проверено `v2-settings-39.spec.ts`; здесь — блок «Відсутності».)
 * - **§13 к. 10** — буквально, в отдельном пространстве, чтобы проход напоминаний по календарю не
 *   трогал посеянные записи «Каппі»: обязательное назначение с дедлайном 15 июля, отпуск 10–20
 *   июля → при создании назначения дедлайн 21 июля, `deadline_shifted_reason='absence'`,
 *   `due.scan` 10–20 июля напоминаний человеку не шлёт, 21-го — «сьогодні останній день».
 * - Условие входа плана: сдвиг только там, где у этапа курса включена возможность `deadline`
 *   (`stageCan()`), только у обязательного назначения и только вперёд (§12).
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const A = await import('../../server/services/absences')
const AN = await import('../../server/services/absenceNorms')
const { createAssignment, extendEnrollment } = await import('../../server/services/assignments')
const { runDueScan } = await import('../../server/services/dueScan')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const stamp = Date.now()
const MARK = `PR-33 ${stamp}`

let tenantId: string, lazarevaId: string, otherLocationId: string, posId: string, prevManagerId: string | null
let hrId: string, managerId: string, subjectId: string, shiftedId: string, outsiderId: string, candidateId: string, leaverId: string
let courseId: string, noDeadlineCourseId: string
const userIds: string[] = []
const courseIds: string[] = []

type Grant = { scopes: string[], scopeType: 'tenant' | 'location' | 'org_unit', scopeId: string | null }
const access = (userId: string, grants: Grant[], tid = tenantId) => ({ userId, tenantId: tid, grants, activeRole: null, roles: [] })
const SCOPES = ['person.absence.manage', 'assignment.create']
const hrV = () => A.absenceViewerOf(access(hrId, [{ scopes: SCOPES, scopeType: 'tenant', scopeId: null }]))
const managerV = () => A.absenceViewerOf(access(managerId, [{ scopes: SCOPES, scopeType: 'location', scopeId: lazarevaId }]))
const otherManagerV = () => A.absenceViewerOf(access(managerId, [{ scopes: SCOPES, scopeType: 'location', scopeId: otherLocationId }]))
const selfV = (id: string) => A.absenceViewerOf(access(id, [{ scopes: ['learn.view'], scopeType: 'location', scopeId: lazarevaId }]))
const ctx = (actorId: string) => ({ tenantId, actorId })

async function makePerson(name: string, locationId: string | null, kind: 'employee' | 'candidate' = 'employee') {
  const [u] = await admin`insert into users (tenant_id, full_name, status, kind, candidate_state)
    values (${tenantId}, ${`${name} ${MARK}`}, 'active', ${kind}, ${kind === 'candidate' ? 'active' : null}) returning id`
  const id = u!.id as string
  userIds.push(id)
  if (locationId) await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary, started_at) values (${tenantId}, ${id}, ${locationId}, ${posId}, true, current_date - 30)`
  return id
}

async function makeCourse(tid: string, title: string, stageId: string | null = null) {
  const [c] = await admin`insert into courses (tenant_id, title, slug, status, lifecycle_stage_id) values (${tid}, ${`${title} ${MARK}`}, ${`pr33-${stamp}-${courseIds.length}`}, 'published', ${stageId}) returning id`
  const id = c!.id as string
  const [v] = await admin`insert into course_versions (tenant_id, course_id, version) values (${tid}, ${id}, 1) returning id`
  await admin`update courses set published_version_id = ${v!.id as string} where id = ${id}`
  courseIds.push(id)
  return id
}

/** Обязательное назначение курса с календарным сроком — ровно то, что сдвигает §7.14. */
async function assign(tid: string, actorId: string, course: string, people: string[], dueAt: string, opts: { mandatory?: boolean } = {}) {
  const r = await createAssignment({ tenantId: tid, actorId }, {
    subjectType: 'course', subjectId: course, lockVersion: false,
    audience: { rules: [{ type: 'user', ids: people }], match: 'any' },
    dueMode: 'absolute', dueAt, dueDays: 14, isMandatory: opts.mandatory ?? true, autoSync: false, tags: [], status: 'active',
  })
  if (!r.ok) throw new Error(`assign: ${r.code}`)
  return r.assignmentId
}

const enrollmentOf = async (assignmentId: string, userId: string) =>
  (await admin`select id, due_at, starts_at, deadline_shifted_reason from enrollments where assignment_id = ${assignmentId} and user_id = ${userId}`)[0]!

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  const locs = await admin`select id, name from locations where tenant_id = ${tenantId} order by name`
  lazarevaId = locs.find(l => l.name === 'Лазарева')!.id as string
  otherLocationId = locs.find(l => l.name !== 'Лазарева')!.id as string
  prevManagerId = (await admin`select manager_id from locations where id = ${lazarevaId}`)[0]!.manager_id as string | null
  posId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Посада ${MARK}`}, 'pr33-pos') returning id`)[0]!.id as string
  hrId = await makePerson('HR відсутностей', lazarevaId)
  managerId = await makePerson('Керівник Лазарева', lazarevaId)
  subjectId = await makePerson('Бариста у відпустці', lazarevaId)
  shiftedId = await makePerson('Кухар з дедлайнами', lazarevaId)
  outsiderId = await makePerson('Бариста Сегедської', otherLocationId)
  candidateId = await makePerson('Кандидат', null, 'candidate')
  leaverId = await makePerson('Звільняється', lazarevaId)
  // Руководитель — единственным источником истины `resolveManager()`: без дерева — руководитель точки
  await admin`update locations set manager_id = ${managerId} where id = ${lazarevaId}`
  courseId = await makeCourse(tenantId, 'Стандарти подачі')
  // Этап «без сроков» выбирается по возможности, а не по коду (инвариант 16)
  const [noDeadline] = await admin`select id from lifecycle_stages where tenant_id = ${tenantId} and is_enabled and coalesce((capabilities->>'deadline')::boolean, false) = false order by sort limit 1`
  noDeadlineCourseId = await makeCourse(tenantId, 'Довідник без строків', noDeadline!.id as string)
})

afterAll(async () => {
  await admin`update locations set manager_id = ${prevManagerId} where id = ${lazarevaId}`
  await admin`delete from notifications where tenant_id = ${tenantId} and user_id in ${admin(userIds)}`
  await admin`delete from audit_log where tenant_id = ${tenantId} and (actor_id in ${admin(userIds)} or entity_id in ${admin(userIds)} or entity in ('absence_record', 'enrollment') and after->>'userId' in ${admin(userIds)})`
  await admin`delete from absence_norms where tenant_id = ${tenantId} and year in (2033, 2034)`
  await admin`delete from absence_records where tenant_id = ${tenantId} and user_id in ${admin(userIds)}`
  await admin`delete from offboarding_cases where user_id in ${admin(userIds)}`
  const enrollmentIds = (await admin`select id from enrollments where user_id in ${admin(userIds)}`).map(r => r.id as string)
  if (enrollmentIds.length) {
    await admin`delete from audit_log where entity_id in ${admin(enrollmentIds)}`
    await admin`delete from enrollment_events where enrollment_id in ${admin(enrollmentIds)}`
    await admin`delete from enrollments where id in ${admin(enrollmentIds)}`
  }
  await admin`delete from assignments where tenant_id = ${tenantId} and subject_id in ${admin(courseIds)}`
  await admin`update courses set published_version_id = null where id in ${admin(courseIds)}`
  await admin`delete from course_versions where course_id in ${admin(courseIds)}`
  await admin`delete from courses where id in ${admin(courseIds)}`
  await admin`delete from user_placements where user_id in ${admin(userIds)}`
  await admin`delete from users where id in ${admin(userIds)}`
  await admin`delete from positions where id = ${posId}`
  await admin.end()
})

// ── §13 к. 9 на карточке, остаток, записи (§5.1, §6.4, §7.13) ─────────────────────────────

describe('§13 к. 9: блок «Відсутності» — норма компании и точки', () => {
  it('компания 24, точка переопределила только больничный (7) → 24 «Норма компанії» и 7 «Норма точки»', async () => {
    await AN.putAbsenceNorm(ctx(hrId), { scopeType: 'tenant', scopeId: null, year: 2033, vacationDays: 24, sickDays: 5 })
    await AN.putAbsenceNorm(ctx(hrId), { scopeType: 'location', scopeId: lazarevaId, year: 2033, sickDays: 7 })
    const r = await A.getAbsenceCard(ctx(hrId), await hrV(), subjectId, 2033)
    if (!r.ok) throw new Error(r.code)
    expect(r.card.norms.vacation).toMatchObject({ value: 24, source: 'tenant', setBy: null })
    expect(r.card.norms.sick).toMatchObject({ value: 7, source: 'location' })
    expect(r.card.levels).toMatchObject({ tenant: { vacationDays: 24, sickDays: 5 }, location: { vacationDays: null, sickDays: 7 }, user: null })
    expect(r.card.remaining).toEqual({ vacation: 24, sick: 7 })
    expect(r.card.person).toMatchObject({ locationId: lazarevaId, locationName: 'Лазарева' })
  })

  it('«Скоригувати» для человека — источник «Індивідуально, {хто}, {дата}» с причиной', async () => {
    await AN.putAbsenceNorm(ctx(hrId), { scopeType: 'user', scopeId: subjectId, year: 2033, vacationDays: 26.5, reason: 'Стаж понад 10 років' })
    const r = await A.getAbsenceCard(ctx(managerId), await managerV(), subjectId, 2033)
    if (!r.ok) throw new Error(r.code)
    expect(r.card.norms.vacation).toMatchObject({ value: 26.5, source: 'user', reason: 'Стаж понад 10 років' })
    expect(r.card.norms.vacation.setBy).toContain('HR відсутностей')
    expect(r.card.norms.vacation.setAt).toBeInstanceOf(Date)
    // Больничный у человека не задан — по-прежнему от точки
    expect(r.card.norms.sick).toMatchObject({ value: 7, source: 'location' })
  })
})

describe('записи отсутствий и остаток (§4, §6.4, §7.13)', () => {
  it('в остаток — только подтверждённое; период, частично попавший в год, — пересечением', async () => {
    const hr = await hrV()
    const a = await A.createAbsenceRecord(ctx(hrId), hr, subjectId, { kind: 'vacation', dateFrom: '2033-03-02', dateTo: '2033-03-13', status: 'approved', comment: 'Весняна відпустка' })
    if (!a.ok) throw new Error(a.code)
    expect(a.record).toMatchObject({ daysCount: 12, status: 'approved', source: 'manual', createdBy: { id: hrId } })
    expect((await A.createAbsenceRecord(ctx(hrId), hr, subjectId, { kind: 'vacation', dateFrom: '2033-06-01', dateTo: '2033-06-05', status: 'planned' })).ok).toBe(true)
    expect((await A.createAbsenceRecord(ctx(hrId), hr, subjectId, { kind: 'sick', dateFrom: '2033-12-30', dateTo: '2034-01-03', status: 'approved' })).ok).toBe(true)

    const r = await A.getAbsenceCard(ctx(hrId), hr, subjectId, 2033)
    if (!r.ok) throw new Error(r.code)
    expect(r.card.used).toEqual({ vacation: 12, sick: 2, unpaid: 0, other: 0 })
    expect(r.card.remaining).toEqual({ vacation: 14.5, sick: 5 })
    expect(r.card.records.map(x => [x.dateFrom, x.status, x.daysInYear])).toEqual([
      ['2033-03-02', 'approved', 12], ['2033-06-01', 'planned', 5], ['2033-12-30', 'approved', 2],
    ])
    const next = await A.getAbsenceCard(ctx(hrId), hr, subjectId, 2034)
    if (!next.ok) throw new Error(next.code)
    expect(next.card.used.sick).toBe(3)
    const [audit] = await admin`select count(*)::int as n from audit_log where action = 'absence_record.create' and actor_id = ${hrId}`
    expect(audit!.n).toBe(3)
  })

  it('перерасход — остаток отрицательный и не обрезается (§7.14)', async () => {
    const hr = await hrV()
    expect((await A.createAbsenceRecord(ctx(hrId), hr, subjectId, { kind: 'sick', dateFrom: '2033-02-01', dateTo: '2033-02-08', status: 'approved' })).ok).toBe(true)
    const r = await A.getAbsenceCard(ctx(hrId), hr, subjectId, 2033)
    if (!r.ok) throw new Error(r.code)
    // 7 − (2 + 8) = −3
    expect(r.card.remaining.sick).toBe(-3)
  })

  it('пересечение — 409 absence_overlap с конфликтующим периодом; период наоборот и длиннее года — range_invalid', async () => {
    const hr = await hrV()
    const overlap = await A.createAbsenceRecord(ctx(hrId), hr, subjectId, { kind: 'other', dateFrom: '2033-03-10', dateTo: '2033-03-15', status: 'approved' })
    expect(overlap).toMatchObject({ ok: false, code: 'absence_overlap', conflict: { dateFrom: '2033-03-02', dateTo: '2033-03-13' } })
    expect(await A.createAbsenceRecord(ctx(hrId), hr, subjectId, { kind: 'other', dateFrom: '2033-04-10', dateTo: '2033-04-01', status: 'approved' }))
      .toEqual({ ok: false, code: 'absence_record.range_invalid', reason: 'order' })
    expect(await A.createAbsenceRecord(ctx(hrId), hr, subjectId, { kind: 'unpaid', dateFrom: '2035-01-01', dateTo: '2036-01-05', status: 'approved' }))
      .toEqual({ ok: false, code: 'absence_record.range_invalid', reason: 'too_long' })
    // БД держит то же самое сама — сервис не единственный рубеж
    await expect(admin`insert into absence_records (tenant_id, user_id, kind, date_from, date_to, days_count) values (${tenantId}, ${subjectId}, 'other', '2033-05-10', '2033-05-12', 5)`).rejects.toThrow(/absence_records_days_chk/)
    await expect(admin`insert into absence_records (tenant_id, user_id, kind, date_from, date_to, days_count) values (${tenantId}, ${subjectId}, 'holiday', '2033-05-10', '2033-05-12', 3)`).rejects.toThrow(/absence_records_kind_chk/)
  })

  it('статус только вперёд; отменённая запись не правится и не мешает новой', async () => {
    const hr = await hrV()
    const card = await A.getAbsenceCard(ctx(hrId), hr, subjectId, 2033)
    if (!card.ok) throw new Error(card.code)
    const planned = card.card.records.find(x => x.status === 'planned')!
    const approved = card.card.records.find(x => x.dateFrom === '2033-03-02')!
    expect(await A.updateAbsenceRecord(ctx(hrId), hr, subjectId, approved.id, { status: 'planned' }))
      .toEqual({ ok: false, code: 'absence_status_invalid', from: 'approved', to: 'planned' })
    const ok = await A.updateAbsenceRecord(ctx(hrId), hr, subjectId, planned.id, { status: 'approved', comment: 'Погоджено' })
    expect(ok).toMatchObject({ ok: true, record: { status: 'approved', comment: 'Погоджено' } })
    const cancelled = await A.updateAbsenceRecord(ctx(hrId), hr, subjectId, planned.id, { status: 'cancelled' })
    expect(cancelled).toMatchObject({ ok: true, record: { status: 'cancelled' } })
    expect(await A.updateAbsenceRecord(ctx(hrId), hr, subjectId, planned.id, { comment: 'ще раз' })).toEqual({ ok: false, code: 'absence_cancelled' })
    // Отменённая пересечения не даёт
    const again = await A.createAbsenceRecord(ctx(hrId), hr, subjectId, { kind: 'vacation', dateFrom: '2033-06-02', dateTo: '2033-06-04', status: 'approved' })
    expect(again.ok).toBe(true)
    const [row] = await admin`select before->>'status' as b, after->>'status' as a from audit_log where action = 'absence_record.update' and entity_id = ${planned.id} order by created_at desc limit 1`
    expect(row).toMatchObject({ b: 'approved', a: 'cancelled' })
  })

  it('правка периода проверяется так же, как запись: порядок дат, пересечение с другой, чужой id — 404', async () => {
    const hr = await hrV()
    const card = await A.getAbsenceCard(ctx(hrId), hr, subjectId, 2033)
    if (!card.ok) throw new Error(card.code)
    const march = card.card.records.find(x => x.dateFrom === '2033-03-02')!
    expect(await A.updateAbsenceRecord(ctx(hrId), hr, subjectId, march.id, { dateTo: '2033-03-01' }))
      .toEqual({ ok: false, code: 'absence_record.range_invalid', reason: 'order' })
    expect(await A.updateAbsenceRecord(ctx(hrId), hr, subjectId, march.id, { dateTo: '2033-06-03' }))
      .toMatchObject({ ok: false, code: 'absence_overlap', conflict: { dateFrom: '2033-06-02' } })
    // Сдвиг внутри своих же дат — не пересечение с самой собой
    const moved = await A.updateAbsenceRecord(ctx(hrId), hr, subjectId, march.id, { dateFrom: '2033-03-03', kind: 'vacation' })
    expect(moved).toMatchObject({ ok: true, record: { dateFrom: '2033-03-03', daysCount: 11 } })
    expect(await A.updateAbsenceRecord(ctx(hrId), hr, subjectId, '00000000-0000-4000-8000-000000000000', { comment: 'x' })).toEqual({ ok: false, code: 'not_found' })
    // Запись другого человека по пути этого — тоже 404: id записи привязан к человеку в пути
    expect(await A.updateAbsenceRecord(ctx(hrId), hr, shiftedId, march.id, { comment: 'x' })).toEqual({ ok: false, code: 'not_found' })
    expect(await A.updateAbsenceRecord(ctx(managerId), await otherManagerV(), subjectId, march.id, { comment: 'x' })).toEqual({ ok: false, code: 'forbidden' })
  })
})

describe('права (§2): свои — без скоупа, чужие — `person.absence.manage` в области точки', () => {
  it('сам человек видит свои отсутствия, но не вносит и не правит норму', async () => {
    const own = await A.getAbsenceCard(ctx(subjectId), await selfV(subjectId), subjectId, 2033)
    if (!own.ok) throw new Error(own.code)
    expect(own.card.can).toEqual({ record: false, adjust: { tenant: false, location: false, user: false }, extend: false })
    expect(await A.createAbsenceRecord(ctx(subjectId), await selfV(subjectId), subjectId, { kind: 'vacation', dateFrom: '2033-08-01', dateTo: '2033-08-02', status: 'approved' }))
      .toEqual({ ok: false, code: 'forbidden' })
    // Чужую карточку без скоупа — 403
    expect(await A.getAbsenceCard(ctx(outsiderId), await selfV(outsiderId), subjectId, 2033)).toEqual({ ok: false, code: 'forbidden' })
  })

  it('руководитель своей точки ведёт записи и правит норму точки и человека, но не компании; чужой точки — 403', async () => {
    const mine = await A.getAbsenceCard(ctx(managerId), await managerV(), subjectId, 2033)
    if (!mine.ok) throw new Error(mine.code)
    expect(mine.card.can).toEqual({ record: true, adjust: { tenant: false, location: true, user: true }, extend: true })
    const hr = await A.getAbsenceCard(ctx(hrId), await hrV(), subjectId, 2033)
    if (!hr.ok) throw new Error(hr.code)
    expect(hr.card.can.adjust.tenant).toBe(true)
    expect(await A.getAbsenceCard(ctx(managerId), await otherManagerV(), subjectId, 2033)).toEqual({ ok: false, code: 'forbidden' })
    expect(await A.createAbsenceRecord(ctx(managerId), await managerV(), outsiderId, { kind: 'vacation', dateFrom: '2033-08-01', dateTo: '2033-08-02', status: 'approved' }))
      .toEqual({ ok: false, code: 'forbidden' })
  })

  it('кандидат, несуществующий человек — 404; уволенный — только чтение', async () => {
    expect(await A.getAbsenceCard(ctx(hrId), await hrV(), candidateId, 2033)).toEqual({ ok: false, code: 'not_found' })
    expect(await A.getAbsenceCard(ctx(hrId), await hrV(), '00000000-0000-4000-8000-000000000000', 2033)).toEqual({ ok: false, code: 'not_found' })
    expect(await A.getAbsenceCard(ctx(hrId), await hrV(), 'not-a-uuid', 2033)).toEqual({ ok: false, code: 'not_found' })
    const archived = await makePerson('Архівний', lazarevaId)
    await admin`update users set status = 'archived' where id = ${archived}`
    expect(await A.createAbsenceRecord(ctx(hrId), await hrV(), archived, { kind: 'vacation', dateFrom: '2033-08-01', dateTo: '2033-08-02', status: 'approved' }))
      .toEqual({ ok: false, code: 'person_archived' })
  })
})

// ── Сдвиг дедлайна (§7.14, §12) ──────────────────────────────────────────────────────────

describe('сдвиг дедлайна обязательного назначения (§7.14)', () => {
  it('отсутствие внесено после создания назначения — срок сдвигается сразу, в журнал и уведомления', async () => {
    // Киев в марте 2034 — UTC+2: 15:00Z = 17:00 местного; 2034-03-21 — вторник
    const assignmentId = await assign(tenantId, hrId, courseId, [shiftedId], '2034-03-15T15:00:00.000Z')
    const before = await enrollmentOf(assignmentId, shiftedId)
    expect(before.deadline_shifted_reason).toBeNull()
    const r = await A.createAbsenceRecord(ctx(managerId), await managerV(), shiftedId, { kind: 'vacation', dateFrom: '2034-03-10', dateTo: '2034-03-20', status: 'planned' })
    expect(r).toMatchObject({ ok: true, shifted: 1 })
    const after = await enrollmentOf(assignmentId, shiftedId)
    expect((after.due_at as Date).toISOString()).toBe('2034-03-21T15:00:00.000Z')
    expect(after.deadline_shifted_reason).toBe('absence')
    const [audit] = await admin`select actor_id, before->>'dueAt' as b, after->>'reason' as reason from audit_log where action = 'enrollment.deadline_shifted' and entity_id = ${after.id as string}`
    expect(audit).toMatchObject({ actor_id: managerId, reason: 'absence' })
    expect(new Date(audit!.b as string).toISOString()).toBe('2034-03-15T15:00:00.000Z')
    const [event] = await admin`select payload from enrollment_events where enrollment_id = ${after.id as string} and event = 'extended'`
    expect(event!.payload).toMatchObject({ reason: 'absence', trigger: 'absence' })
    const sent = await admin`select user_id, payload from notifications where code = 'absence_deadline_shifted' and (payload->>'enrollmentId' = ${after.id as string} or user_id = ${managerId})`
    expect(sent.map(n => n.user_id).sort()).toEqual([managerId, shiftedId].sort())
    expect(sent.find(n => n.user_id === managerId)!.payload).toMatchObject({ url: `/admin/people/${shiftedId}?tab=absences` })
    // Повторный проход ничего не трогает: новый срок отсутствием не покрыт
    expect(await withTenant(tenantId, null, tx => A.shiftDeadlinesForAbsences(tx, { tenantId, actorId: null }, { userIds: [shiftedId] }))).toEqual([])
    // Ручное продление снимает причину: срок поставил человек, а не правило
    await extendEnrollment(ctx(hrId), after.id as string, { dueAt: '2034-04-01T15:00:00.000Z', reason: 'Домовились окремо', notify: false })
    expect((await enrollmentOf(assignmentId, shiftedId)).deadline_shifted_reason).toBeNull()
  })

  it('этап без возможности `deadline` и добровольное назначение — срок не трогается', async () => {
    const noStage = await assign(tenantId, hrId, noDeadlineCourseId, [shiftedId], '2034-05-17T15:00:00.000Z')
    const voluntary = await assign(tenantId, hrId, courseId, [shiftedId], '2034-05-17T15:00:00.000Z', { mandatory: false })
    const mandatory = await assign(tenantId, hrId, courseId, [shiftedId], '2034-05-18T15:00:00.000Z')
    const r = await A.createAbsenceRecord(ctx(hrId), await hrV(), shiftedId, { kind: 'sick', dateFrom: '2034-05-15', dateTo: '2034-05-19', status: 'approved' })
    expect(r).toMatchObject({ ok: true, shifted: 1 })
    expect((await enrollmentOf(noStage, shiftedId)).deadline_shifted_reason).toBeNull()
    expect(((await enrollmentOf(noStage, shiftedId)).due_at as Date).toISOString()).toBe('2034-05-17T15:00:00.000Z')
    expect((await enrollmentOf(voluntary, shiftedId)).deadline_shifted_reason).toBeNull()
    // 2034-05-19 — пятница, возвращение в субботу → понедельник 22-го
    expect(((await enrollmentOf(mandatory, shiftedId)).due_at as Date).toISOString()).toBe('2034-05-22T15:00:00.000Z')
  })

  it('ночной проход `absence.deadline_guard` ловит отсутствие, внесённое мимо формы', async () => {
    const assignmentId = await assign(tenantId, hrId, courseId, [shiftedId], '2034-06-14T15:00:00.000Z')
    await admin`insert into absence_records (tenant_id, user_id, kind, date_from, date_to, days_count, status, source) values (${tenantId}, ${shiftedId}, 'vacation', '2034-06-12', '2034-06-16', 5, 'approved', 'import')`
    expect(await A.absenceDeadlineGuardTenant(tenantId)).toBe(1)
    const e = await enrollmentOf(assignmentId, shiftedId)
    // 2034-06-16 — пятница → понедельник 19-го; летом Киев UTC+3, местное время сохраняется
    expect((e.due_at as Date).toISOString()).toBe('2034-06-19T15:00:00.000Z')
    const [event] = await admin`select payload from enrollment_events where enrollment_id = ${e.id as string} and event = 'extended'`
    expect(event!.payload).toMatchObject({ trigger: 'daily' })
    expect(await A.absenceDeadlineGuardTenant(tenantId)).toBe(0)
  })

  it('срок не уезжает за последний рабочий день открытого офбординга', async () => {
    await admin`insert into offboarding_cases (tenant_id, user_id, state, reason_code, last_working_day) values (${tenantId}, ${leaverId}, 'started', 'own_wish', '2034-05-12')`
    const assignmentId = await assign(tenantId, hrId, courseId, [leaverId], '2034-05-12T20:59:00.000Z')
    const r = await A.createAbsenceRecord(ctx(hrId), await hrV(), leaverId, { kind: 'vacation', dateFrom: '2034-05-08', dateTo: '2034-05-12', status: 'approved' })
    expect(r).toMatchObject({ ok: true, shifted: 0 })
    expect((await enrollmentOf(assignmentId, leaverId)).deadline_shifted_reason).toBeNull()
  })

  it('§12: отсутствие задним числом на прошедший срок — дедлайн не воскрешается, карточка показывает «Дедлайн минув…»', async () => {
    const assignmentId = await assign(tenantId, hrId, courseId, [shiftedId], new Date(Date.now() + 30 * 86_400_000).toISOString())
    const e = await enrollmentOf(assignmentId, shiftedId)
    await admin`update enrollments set due_at = now() - interval '3 days' where id = ${e.id as string}`
    const [range] = await admin`select to_char(current_date - 6, 'YYYY-MM-DD') as f, to_char(current_date - 1, 'YYYY-MM-DD') as t`
    const r = await A.createAbsenceRecord(ctx(hrId), await hrV(), shiftedId, { kind: 'sick', dateFrom: range!.f as string, dateTo: range!.t as string, status: 'approved' })
    expect(r).toMatchObject({ ok: true, shifted: 0 })
    expect((await enrollmentOf(assignmentId, shiftedId)).deadline_shifted_reason).toBeNull()
    const card = await A.getAbsenceCard(ctx(managerId), await managerV(), shiftedId)
    if (!card.ok) throw new Error(card.code)
    expect(card.card.missedDeadlines.map(m => m.enrollmentId)).toContain(e.id)
    expect(card.card.can.extend).toBe(true)
  })
})

// ── §13 к. 10 буквально: своё пространство, календарь июля ────────────────────────────────

describe('§13 к. 10: дедлайн 15 июля, отпуск 10–20 июля', () => {
  let calTenant: string, calActor: string, calAbsent: string, calPresent: string, calCourse: string, calAssignment: string

  beforeAll(async () => {
    const [t] = await admin`insert into tenants (slug, name, status, timezone) values (${`v2-33-cal-${stamp}`}, ${`Календар ${MARK}`}, 'active', 'Europe/Kyiv') returning id`
    calTenant = t!.id as string
    const person = async (name: string) => (await admin`insert into users (tenant_id, full_name, status) values (${calTenant}, ${`${name} ${MARK}`}, 'active') returning id`)[0]!.id as string
    calActor = await person('Адміністратор календаря')
    calAbsent = await person('Офіціант у відпустці')
    calPresent = await person('Офіціант на зміні')
    calCourse = await makeCourse(calTenant, 'Інструктаж з безпеки')
  })

  afterAll(async () => {
    await admin`delete from notifications where tenant_id = ${calTenant}`
    await admin`delete from audit_log where tenant_id = ${calTenant}`
    await admin`delete from enrollment_events where tenant_id = ${calTenant}`
    await admin`delete from enrollments where tenant_id = ${calTenant}`
    await admin`delete from assignments where tenant_id = ${calTenant}`
    await admin`delete from absence_records where tenant_id = ${calTenant}`
    await admin`update courses set published_version_id = null where tenant_id = ${calTenant}`
    await admin`delete from course_versions where tenant_id = ${calTenant}`
    await admin`delete from courses where tenant_id = ${calTenant}`
    await admin`delete from users where tenant_id = ${calTenant}`
    await admin`delete from tenants where id = ${calTenant}`
  })

  it('коли назначение создано → дедлайн 21 июля и deadline_shifted_reason = absence; у коллеги — 15-е', async () => {
    const hr = await A.absenceViewerOf(access(calActor, [{ scopes: SCOPES, scopeType: 'tenant', scopeId: null }], calTenant))
    const vacation = await A.createAbsenceRecord({ tenantId: calTenant, actorId: calActor }, hr, calAbsent, { kind: 'vacation', dateFrom: '2027-07-10', dateTo: '2027-07-20', status: 'approved' })
    expect(vacation).toMatchObject({ ok: true, shifted: 0 })
    // 18:00 по Киеву 15 июля 2027 (летом UTC+3)
    calAssignment = await assign(calTenant, calActor, calCourse, [calAbsent, calPresent], '2027-07-15T15:00:00.000Z')
    const absent = await enrollmentOf(calAssignment, calAbsent)
    expect((absent.due_at as Date).toISOString()).toBe('2027-07-21T15:00:00.000Z')
    expect(absent.deadline_shifted_reason).toBe('absence')
    const present = await enrollmentOf(calAssignment, calPresent)
    expect((present.due_at as Date).toISOString()).toBe('2027-07-15T15:00:00.000Z')
    expect(present.deadline_shifted_reason).toBeNull()
    // «Вам призначено … до» уже несёт новую дату
    const [created] = await admin`select payload->>'due' as due from notifications where code = 'assignment_created' and payload->>'enrollmentId' = ${absent.id as string}`
    expect(created!.due).toBe('2027-07-21T15:00:00.000Z')
    const [audit] = await admin`select after->>'trigger' as trigger from audit_log where action = 'enrollment.deadline_shifted' and entity_id = ${absent.id as string}`
    expect(audit!.trigger).toBe('assignment')
  })

  it('напоминания 10–20 июля не отправлены; 21-го — «сьогодні останній день»', async () => {
    const absent = await enrollmentOf(calAssignment, calAbsent)
    const present = await enrollmentOf(calAssignment, calPresent)
    let muted = 0
    for (let day = 10; day <= 21; day++) {
      // 09:00 по Киеву — утро дня в местном поясе
      const s = await runDueScan(calTenant, { now: new Date(`2027-07-${day}T06:00:00.000Z`) })
      muted += s.muted
    }
    const remindersOf = async (enrollmentId: string) => (await admin`
      select code, dedup_key from notifications
      where tenant_id = ${calTenant} and code in ('enrollment_due_soon', 'enrollment_due_today', 'enrollment_overdue') and payload->>'enrollmentId' = ${enrollmentId}
      order by dedup_key`).map(n => `${n.code as string} ${n.dedup_key as string}`)
    // Человеку в отпуске: 14-го (за 7 дней), 18-го (за 3) и 20-го (за 1) — тишина, 21-го — день срока
    expect(await remindersOf(absent.id as string)).toEqual([`enrollment_due_today due_today:${absent.id as string}:2027-07-21`])
    expect(muted).toBe(3)
    // Коллеге на смене те же дни напоминают как обычно — тишина касается только отсутствующего
    expect(await remindersOf(present.id as string)).toEqual(expect.arrayContaining([
      `enrollment_due_soon due_soon:${present.id as string}:2027-07-12`,
      `enrollment_due_soon due_soon:${present.id as string}:2027-07-14`,
      `enrollment_due_today due_today:${present.id as string}:2027-07-15`,
    ]))
    // Кто «в отсутствии» — по местной дате человека
    const absentOn = (iso: string) => withTenant(calTenant, null, tx => A.peopleAbsentOn(tx, calTenant, new Date(iso)))
    expect((await absentOn('2027-07-20T20:00:00.000Z')).has(calAbsent)).toBe(true) // 23:00 20 июля по Киеву
    expect((await absentOn('2027-07-20T21:30:00.000Z')).has(calAbsent)).toBe(false) // 00:30 21 июля по Киеву
  })
})
