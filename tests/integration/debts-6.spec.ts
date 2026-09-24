import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readThrough } from './_lesson'

/**
 * PR debts-6 (docs/33): D-027 (узел-объявление траектории — по notice_acks), D-030 (звіт по сесіях на каркасі
 * reportFrame, колонки Г-18.2), D-031 (профіль посади на кілька посад — position_profile_positions),
 * D-045 (протокол статусів програм і траєкторій — pass_events у журналі task-status),
 * D-047 (звіт по типу для resource/workshop/poll/assessment/check_list/meetup/webinar/complex_test).
 * D-024 (drag-n-drop полотна) — клієнтський, перевіряється e2e/візуально.
 */

const tr = await import('../../server/services/trajectories')
const pg = await import('../../server/services/programs')
const nt = await import('../../server/services/notices')
const ms = await import('../../server/services/meetupSessions')
const mt = await import('../../server/services/meetups')
const dev = await import('../../server/services/development')
const dx = await import('../../server/services/developmentExtra')
const { readLog } = await import('../../server/services/logs')
const { taskReport, TASK_REPORT_TYPES } = await import('../../server/services/reportTasks')
const { FRAME_KEYS } = await import('../../server/services/reportFrame')
const { createCourse, addModule, addLesson, publishCourse } = await import('../../server/services/courses')
const { completeLesson, openLesson, enrollmentTree } = await import('../../server/services/learning')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

let tenantId: string, adminId: string, lazarevaId: string, posId: string, posId2: string, posId3: string, scaleId: string
const userIds: string[] = [], courseIds: string[] = [], trajIds: string[] = [], programIds: string[] = [], noticeIds: string[] = [], meetupIds: string[] = []
const cleanup: { table: string, ids: string[] }[] = []
const track = (table: string, id: string) => { (cleanup.find(c => c.table === table) ?? cleanup[cleanup.push({ table, ids: [] }) - 1]!).ids.push(id) }
const stamp = Date.now()
const ctx = (actorId = adminId) => ({ tenantId, actorId })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()
/**
 * Опрос условия вместо фиксированной паузы. Хуки программы/траектории идут вне транзакции
 * completeLesson — fire-and-forget `import('./trajectories').then(...)` / `import('./programs').then(...)`
 * (server/services/learning.ts:817–818), без await со стороны вызывающего. Время их применения не
 * гарантировано: под нагрузкой (несколько файлов тестов параллельно, медленная машина) фиксированная
 * пауза иногда заканчивалась раньше, чем хук успевал дописать `pass_events` — флейк D-045
 * («started» вместо «completed»). Теперь ждём факт, а не время.
 */
async function waitFor(cond: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await cond()) return
    if (Date.now() >= deadline) throw new Error(`тайм-аут ожидания (${timeoutMs}ms) — хук курса не успел обновить состояние`)
    await sleep(20)
  }
}

async function makePerson(name: string, pos = posId) {
  const phone = `+38077${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, phone, full_name, status, hired_at) values (${tenantId}, ${phone}, ${`${name} ${stamp}`}, 'active', current_date) returning id`
  userIds.push(u!.id as string)
  await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary) values (${tenantId}, ${u!.id}, ${lazarevaId}, ${pos}, true)`
  await admin`insert into user_roles (tenant_id, user_id, role_id, scope_type) select ${tenantId}, ${u!.id}, id, 'tenant' from roles where tenant_id = ${tenantId} and code = 'employee'`
  return u!.id as string
}
async function makeCourse(title: string) {
  const c = await createCourse(ctx(), { title: `${title} ${stamp}`, language: 'uk', strictOrder: true, isCatalogVisible: false, tags: [] })
  courseIds.push(c.id)
  const m = await addModule(ctx(), c.id, 'Р')
  await addLesson(ctx(), { moduleId: m!.id, title: 'Урок', itemType: 'resource', resource: { body: [{ id: 'b', type: 'text', html: '<p>x</p>' }] }, isRequired: true, videoThresholdPct: 90 })
  await publishCourse(ctx(), c.id, 'v1')
  return c.id
}
async function passCourse(userId: string, courseId: string, until: () => Promise<boolean>) {
  const findEnrollment = () => admin`select id from enrollments where user_id = ${userId} and subject_id = ${courseId} and cancelled_at is null order by created_at desc limit 1`
  // Запись о зачислении раскрывается вне транзакции хука узла (applyEffects/expandAssignment,
  // server/services/trajectories.ts:614–668) — на случай, если её ещё нет, ждём опросом.
  let rows = await findEnrollment()
  if (!rows[0]) await waitFor(async () => { rows = await findEnrollment(); return !!rows[0] })
  const enr = rows[0]
  if (!enr) throw new Error('нет записи на курс')
  const tree = await enrollmentTree(ctx(userId), enr.id as string)
  const lessonId = tree!.modules[0]!.lessons[0]!.id
  await openLesson(ctx(userId), enr.id as string, lessonId)
  await readThrough(admin, enr.id as string, lessonId)
  const r = await completeLesson(ctx(userId), enr.id as string, lessonId)
  expect(r.ok).toBe(true)
  await waitFor(until) // хук программы/траектории — вне транзакции; ждём его результат опросом
}
async function makeNotice(title: string) {
  const n = await nt.createNotice(ctx(), { title: `${title} ${stamp}`, body: [{ id: 'b', type: 'text' as const, html: '<p>Ознайомтесь.</p>' }], kind: 'acknowledge', publish: true })
  noticeIds.push(n.id)
  return n.id
}
type N = Parameters<typeof tr.putGraph>[2]['nodes'][number]
async function makeTrajectory(title: string, nodes: N[], edges: { fromNodeId: string, toNodeId: string }[]) {
  const t = await tr.createTrajectory(ctx(), { title: `${title} ${stamp}`, tags: [] })
  trajIds.push(t.id)
  const full = (await tr.getTrajectory(ctx(), t.id))!
  const start = full.nodes.find(n => n.kind === 'start')!, finish = full.nodes.find(n => n.kind === 'finish')!
  const map = (id: string) => (id === 'start' ? start.id : id === 'finish' ? finish.id : id)
  const g = await tr.putGraph(ctx(), t.id, {
    nodes: [{ id: start.id, kind: 'start', x: 0, y: 0 }, { id: finish.id, kind: 'finish', x: 0, y: 0 }, ...nodes],
    edges: edges.map(e => ({ ...e, fromNodeId: map(e.fromNodeId), toNodeId: map(e.toNodeId), sort: 0 })),
  })
  if (!g.ok) throw new Error(`graph: ${g.code}`)
  const p = await tr.publishTrajectory(ctx(), t.id)
  if (!p.ok) throw new Error(`publish: ${JSON.stringify(p.problems)}`)
  return { id: t.id, ids: new Map<string, string>(nodes.map(n => [n.tmpId!, g.ids[n.tmpId!]!])) }
}
async function enroll(trajectoryId: string, userId: string) {
  const r = await tr.assignTrajectory(ctx(), trajectoryId, [userId])
  if (!r.ok) throw new Error(r.code)
  const [e] = await admin`select id from trajectory_enrollments where trajectory_id = ${trajectoryId} and user_id = ${userId}`
  return e!.id as string
}
const stateOf = async (enrollmentId: string, nodeId: string) => (await admin`select status, passed from trajectory_node_states where enrollment_id = ${enrollmentId} and node_id = ${nodeId}`)[0]
const events = async (enrollmentId: string) => (await admin`select event, payload from pass_events where enrollment_id = ${enrollmentId} order by created_at`).map(r => ({ event: r.event as string, to: (r.payload as { to?: string }).to ?? null }))

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  posId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Бариста-d6-${stamp}`}, ${`barista-d6-${stamp}`}) returning id`)[0]!.id as string
  posId2 = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Старший бариста-d6-${stamp}`}, ${`sbarista-d6-${stamp}`}) returning id`)[0]!.id as string
  posId3 = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Кухар-d6-${stamp}`}, ${`cook-d6-${stamp}`}) returning id`)[0]!.id as string
  scaleId = (await admin`select id from scales where tenant_id = ${tenantId} limit 1`)[0]!.id as string
  await admin`update locations set manager_id = ${adminId} where id = ${lazarevaId}`
})

afterAll(async () => {
  if (trajIds.length) { await admin`delete from notifications where ref_type = 'trajectory_enrollment' and ref_id in (select id from trajectory_enrollments where trajectory_id in ${admin(trajIds)})`; await admin`delete from assignments where audience->>'trajectoryId' in ${admin(trajIds)}`; await admin`delete from trajectories where id in ${admin(trajIds)}` }
  if (programIds.length) await admin`delete from programs where id in ${admin(programIds)}`
  if (noticeIds.length) { await admin`delete from assignments where subject_type = 'notice' and subject_id in ${admin(noticeIds)}`; await admin`delete from notices where id in ${admin(noticeIds)}` }
  if (userIds.length) {
    await admin`delete from workshop_submissions where user_id in ${admin(userIds)}`; await admin`delete from survey_participations where user_id in ${admin(userIds)}`
    await admin`delete from checklist_runs where subject_user_id in ${admin(userIds)}`; await admin`delete from complex_test_attempts where user_id in ${admin(userIds)}`
  }
  for (const c of cleanup.reverse()) if (c.ids.length) await admin.unsafe(`delete from ${c.table} where id in (${c.ids.map(i => `'${i}'`).join(',')})`)
  if (meetupIds.length) await admin`delete from meetups where id in ${admin(meetupIds)}`
  if (userIds.length) {
    await admin`delete from pass_events where user_id in ${admin(userIds)}`
    await admin`delete from notifications where user_id in ${admin(userIds)}`; await admin`delete from task_access_log where user_id in ${admin(userIds)}`
    await admin`delete from certificates where user_id in ${admin(userIds)}`; await admin`delete from enrollments where user_id in ${admin(userIds)}`; await admin`delete from users where id in ${admin(userIds)}`
  }
  if (courseIds.length) { await admin`delete from enrollments where subject_id in ${admin(courseIds)}`; await admin`delete from resources where id in (select l.item_id from lessons l join modules m on m.id = l.module_id join course_versions v on v.id = m.course_version_id where l.item_type = 'resource' and v.course_id in ${admin(courseIds)})`; await admin`delete from courses where id in ${admin(courseIds)}` }
  await admin`delete from position_profiles where position_id in ${admin([posId, posId2, posId3])}`
  await admin`delete from positions where id in ${admin([posId, posId2, posId3])}`
  await admin`update locations set manager_id = null where id = ${lazarevaId}`
  await admin.end()
})

describe('D-027: узел-объявление траектории проходится по notice_acks', () => {
  it('«Ознайомлений» → узел done → траектория идёт дальше; уже подтверждённое объявление зачитывается при активации', async () => {
    const noticeId = await makeNotice('Регламент')
    const courseId = await makeCourse('Після оголошення')
    const t = await makeTrajectory('Оголошення → курс', [
      { tmpId: 'n', kind: 'task', contentType: 'notice', contentId: noticeId, params: {}, x: 0, y: 0 } as N,
      { tmpId: 'c', kind: 'task', contentType: 'course', contentId: courseId, params: {}, x: 0, y: 0 } as N,
    ], [{ fromNodeId: 'start', toNodeId: 'n' }, { fromNodeId: 'n', toNodeId: 'c' }, { fromNodeId: 'c', toNodeId: 'finish' }])
    const u = await makePerson('Читач')
    const e = await enroll(t.id, u)
    expect((await stateOf(e, t.ids.get('n')!))!.status).toBe('available')
    // Узел создал назначение объявления → человек в аудитории и может подтвердить
    const ack = await nt.acknowledge(ctx(u), noticeId)
    expect(ack.ok).toBe(true)
    // acknowledge() тоже дёргает хук траектории fire-and-forget (notices.ts:201) — та же гонка,
    // что и в D-045 ниже; чиним тем же способом, раз уж всё равно правим этот файл.
    await waitFor(async () => (await stateOf(e, t.ids.get('n')!))?.status === 'done')
    expect(await stateOf(e, t.ids.get('n')!)).toMatchObject({ status: 'done', passed: true })
    expect((await stateOf(e, t.ids.get('c')!))!.status).toBe('available')
    // Повторное подтверждение идемпотентно и хук не дублирует
    expect((await nt.acknowledge(ctx(u), noticeId)).ok).toBe(true)

    // Человек, уже подтвердивший это объявление, проходит узел сразу при активации
    const v = await makePerson('Уже читав')
    await admin`insert into assignments (tenant_id, title, kind, subject_type, subject_id, audience, status, created_by) values (${tenantId}, 'Пряме оголошення', 'manual', 'notice', ${noticeId}, ${admin.json({ rules: [{ type: 'user', ids: [v] }], match: 'any' })}, 'active', ${adminId})`
    expect((await nt.acknowledge(ctx(v), noticeId)).ok).toBe(true)
    const e2 = await enroll(t.id, v)
    expect(await stateOf(e2, t.ids.get('n')!)).toMatchObject({ status: 'done', passed: true })
    expect((await stateOf(e2, t.ids.get('c')!))!.status).toBe('available')
    await admin`delete from assignments where subject_type = 'notice' and subject_id = ${noticeId} and kind = 'manual'`
  })
})

describe('D-045: протокол статусов программ и траекторий (pass_events → журнал task-status)', () => {
  it('траектория: created → started → completed; снятие — cancelled; журнал показывает строки с каркасом', async () => {
    const courseId = await makeCourse('Єдиний крок')
    const t = await makeTrajectory('Журнал', [{ tmpId: 'c', kind: 'task', contentType: 'course', contentId: courseId, params: {}, x: 0, y: 0 } as N], [{ fromNodeId: 'start', toNodeId: 'c' }, { fromNodeId: 'c', toNodeId: 'finish' }])
    const u = await makePerson('Журнальний')
    const e = await enroll(t.id, u)
    expect(await events(e)).toEqual([{ event: 'created', to: 'not_started' }, { event: 'started', to: 'in_progress' }])
    await passCourse(u, courseId, async () => (await events(e)).at(-1)?.event === 'completed')
    expect((await events(e)).at(-1)).toEqual({ event: 'completed', to: 'done' })

    const w = await makePerson('Знятий')
    const e2 = await enroll(t.id, w)
    expect(await tr.cancelTrajectoryEnrollment(tenantId, e2, { actorId: adminId, reason: 'Звільнення' })).toBe(true)
    expect((await events(e2)).map(x => x.event)).toEqual(['created', 'started', 'cancelled'])

    // У журналі — і рядки курсу (enrollment_events від назначення вузла), і рядки траєкторії
    const log = (await readLog(ctx(), 'task-status', { userId: w, limit: 50 })).filter(r => r.content_type === 'trajectory')
    expect(log.length).toBe(3)
    for (const k of FRAME_KEYS) expect(Object.keys(log[0]!), k).toContain(k)
    expect(log[0]).toMatchObject({ content_type: 'trajectory', event: 'cancelled', full_name: `Знятий ${stamp}`, position: `Бариста-d6-${stamp}` })
    expect(log.map(r => r.event)).toEqual(['cancelled', 'started', 'created'])
    expect(log.find(r => r.event === 'started')).toMatchObject({ status: 'in_progress', from_status: 'not_started' })
    // Фильтр по типу события
    expect((await readLog(ctx(), 'task-status', { userId: w, type: 'cancelled' })).length).toBe(1)
  })

  it('программа: created при зачислении → started при открытии шага → completed; фильтр contentType=training_program', async () => {
    const courseId = await makeCourse('Крок програми')
    const p = await pg.createProgram(ctx(), { title: `Програма-журнал ${stamp}`, mode: 'linear' })
    programIds.push(p.id)
    const node = (await pg.upsertNode(ctx(), p.id, { itemType: 'course', itemId: courseId, sort: 1 }))!
    expect((await pg.publishProgram(ctx(), p.id)).ok).toBe(true)
    const u = await makePerson('Програміст')
    const enr = await withTenant(tenantId, adminId, tx => pg.enrollProgram(tx, tenantId, p.id, u, { source: 'manual', actorId: adminId }))
    if (!enr.ok) throw new Error(enr.code)
    expect(await events(enr.enrollmentId)).toEqual([{ event: 'created', to: 'not_started' }])
    expect((await pg.openNode(ctx(u), enr.enrollmentId, node.id)).ok).toBe(true)
    expect((await events(enr.enrollmentId)).at(-1)).toEqual({ event: 'started', to: 'in_progress' })
    await passCourse(u, courseId, async () => (await events(enr.enrollmentId)).at(-1)?.event === 'completed')
    expect((await events(enr.enrollmentId)).at(-1)).toEqual({ event: 'completed', to: 'done' })
    const log = await readLog(ctx(), 'task-status', { userId: u, contentType: 'training_program' })
    expect(log.map(r => r.event)).toEqual(['completed', 'started', 'created'])
    expect(log[0]).toMatchObject({ content_type: 'training_program', task_title: `Програма-журнал ${stamp}`, status: 'done', result: 100 })
    // Курс того же человека в журнал по contentType=course — отдельно, строки программы туда не попадают
    expect((await readLog(ctx(), 'task-status', { userId: u, contentType: 'course' })).every(r => r.content_type === 'course')).toBe(true)
  })
})

describe('D-030: звіт по сесіях на каркасі reportFrame (Г-18.2)', () => {
  it('people: колонки каркаса + сесія · статус реєстрації · присутність · хто відмітив · час відмітки', async () => {
    const m = await mt.createMeetup(ctx(), { kind: 'meetup', title: `Тренінг-d6 ${stamp}`, announcement: [{ id: 'a', type: 'text', html: '<p>Анонс</p>' }], startsAt: hours(500), endsAt: hours(501), trainerIds: [adminId] })
    meetupIds.push(m.id)
    const s = await ms.createSession(ctx(), m.id, { startsAt: hours(-3), endsAt: hours(-2), locationId: lazarevaId, trainerIds: [adminId], capacity: 5 })
    if (!s.ok) throw new Error('no session')
    const came = await makePerson('Прийшов'), missed = await makePerson('Не прийшов')
    await ms.registerSession(ctx(adminId), s.session.id, came)
    await ms.registerSession(ctx(adminId), s.session.id, missed)
    expect(await ms.setAttendance(ctx(adminId), s.session.id, { userId: came, status: 'attended', reason: 'Був, забули відмітити' })).toMatchObject({ ok: true })
    expect((await ms.setAttendance(ctx(adminId), s.session.id, { userId: missed, status: 'missed', reason: 'Не був на тренінгу' })).ok).toBe(true)
    await admin`update meetup_sessions set status = 'finished' where id = ${s.session.id}`

    const r = await ms.attendanceReport(ctx(), { sessionId: s.session.id })
    expect(r.sessions.length).toBe(1)
    expect(r.people.length).toBe(2)
    for (const k of FRAME_KEYS) expect(Object.keys(r.people[0]!), k).toContain(k)
    const rowCame = r.people.find(p => p.user_id === came)!, rowMissed = r.people.find(p => p.user_id === missed)!
    expect(rowCame).toMatchObject({ status: 'done', registration_status: 'registered', presence: 'came', position: `Бариста-d6-${stamp}`, session_title: `Тренінг-d6 ${stamp}`, kind: 'meetup' })
    expect(rowCame.marked_by).toBeTruthy()
    expect(rowCame.marked_at).toBeTruthy()
    expect(rowCame.session_place).toContain('Лазарева')
    expect(rowMissed).toMatchObject({ status: 'failed', presence: 'missed', completed_at: null })
    // Область видимості: чужа точка — рядків немає
    expect((await ms.attendanceReport(ctx(), { sessionId: s.session.id, scope: [] })).people.length).toBe(0)
    // Вивантаження: каркас першими, службові поля прибрані
    const rows = await ms.attendanceReportRows(ctx(), { sessionId: s.session.id })
    expect(Object.keys(rows[0]!).slice(0, 3)).toEqual(['full_name', 'position', 'city'])
    expect(rows[0]).not.toHaveProperty('session_id')
  })
})

describe('D-031: профіль посади на кілька посад', () => {
  it('positionIds → position_profile_positions; пошук профілю за додатковою посадою; посада в іншому профілі — position_taken; охоплення — по всіх посадах', async () => {
    const comp = await dev.createCompetency(ctx(), { name: `Еспресо-d6 ${stamp}`, kind: 'hard', levels: [{ level: 1, title: 'База', behavior: 'Готує' }, { level: 2, title: 'Впевнено', behavior: 'Стабільно' }] })
    track('competencies', comp.id)
    const r = await dev.upsertPositionProfile(ctx(), { positionId: posId, positionIds: [posId2], competencyRequirements: [{ competencyId: comp.id, requiredLevel: 2 }] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.positionIds).toEqual([posId, posId2])
    expect((await admin`select position_id from position_profile_positions where profile_id = ${r.profile.id}`).length).toBe(2)

    // Профіль знаходиться і за головною, і за додатковою посадою; за сторонньою — ні
    const found = await withTenant(tenantId, adminId, tx => dev.profileForPosition(tx, posId2))
    expect(found?.id).toBe(r.profile.id)
    expect(await withTenant(tenantId, adminId, tx => dev.profileForPosition(tx, posId3))).toBeNull()
    const list = await dev.listPositionProfiles(ctx())
    const row = list.find(p => p.id === r.profile.id)!
    expect(row.positionIds).toEqual([posId, posId2])
    expect(row.positionNames[0]).toBe(`Бариста-d6-${stamp}`)

    // Людина на додатковій посаді бачить розрив за цим профілем; охоплення рахує обидві посади
    const senior = await makePerson('Старший', posId2)
    const gap = await dev.competencyGap(ctx(senior), senior)
    expect(gap.profile?.id).toBe(r.profile.id)
    expect(gap.items.map(i => i.competencyId)).toEqual([comp.id])
    const junior = await makePerson('Молодший', posId)
    expect(junior).toBeTruthy()
    // Охоплення і «людей» у списку — по обох посадах (інші люди цього файлу теж на posId)
    const expected = (await admin`select count(*)::int as n from user_placements where position_id in ${admin([posId, posId2])} and ended_at is null`)[0]!.n as number
    expect(expected).toBeGreaterThanOrEqual(2)
    expect((await dx.profileCoverage(ctx(), r.profile.id))!.people).toBe(expected)
    expect((await dev.listPositionProfiles(ctx())).find(p => p.id === r.profile.id)!.people).toBe(expected)

    // Інший профіль не може забрати посаду, яка вже в цьому профілі
    const clash = await dev.upsertPositionProfile(ctx(), { positionId: posId3, positionIds: [posId2], competencyRequirements: [] })
    expect(clash).toMatchObject({ ok: false, code: 'position_taken', positionId: posId2 })
    expect((await admin`select id from position_profiles where position_id = ${posId3}`).length).toBe(0)

    // Прибрали додаткову посаду — зв'язок зник, головна лишилась
    const r2 = await dev.upsertPositionProfile(ctx(), { positionId: posId, positionIds: [], competencyRequirements: [{ competencyId: comp.id, requiredLevel: 2 }] })
    expect(r2.ok && r2.positionIds).toEqual([posId])
    expect((await admin`select position_id from position_profile_positions where profile_id = ${r.profile.id}`).map(x => x.position_id)).toEqual([posId])
    expect(await withTenant(tenantId, adminId, tx => dev.profileForPosition(tx, posId2))).toBeNull()
  })
})

describe('D-047: звіт по типу контенту для решти типів — по записях завершення', () => {
  it('усі типи, крім notice, підтримані; workshop/poll/check_list/complex_test/meetup/resource дають каркас і огляд', async () => {
    expect(TASK_REPORT_TYPES).not.toContain('notice')
    expect(TASK_REPORT_TYPES.length).toBe(11)
    expect(await taskReport(ctx(), 'notice', {})).toEqual({ error: 'unsupported' })

    const a = await makePerson('Звіт А'), b = await makePerson('Звіт Б')
    // Практикум: A — прийнято з балом, B — на перевірці
    const [w] = await admin`insert into workshops (tenant_id, title, description, criteria, status) values (${tenantId}, ${`Практикум-d6 ${stamp}`}, '[]', '[]', 'published') returning id`
    track('workshops', w!.id as string)
    await admin`insert into workshop_submissions (tenant_id, workshop_id, user_id, criteria_snapshot, status, score, passed, submitted_at, reviewed_at) values (${tenantId}, ${w!.id}, ${a}, '[]', 'accepted', 90, true, now(), now())`
    await admin`insert into workshop_submissions (tenant_id, workshop_id, user_id, criteria_snapshot, status, submitted_at) values (${tenantId}, ${w!.id}, ${b}, '[]', 'submitted', now())`
    const ws = await taskReport(ctx(), 'workshop', { subjectId: w!.id as string })
    if ('error' in ws) throw new Error(ws.error)
    expect(ws.subject?.title).toBe(`Практикум-d6 ${stamp}`)
    expect(ws.overview).toMatchObject({ assigned: 2, done: 1, inProgress: 1, donePct: 50 })
    expect(ws.stats.onReview).toBe(1)
    for (const k of FRAME_KEYS) expect(Object.keys(ws.rows[0]!), k).toContain(k)
    expect(ws.rows.find(r => r.user_id === a)).toMatchObject({ status: 'done', result: 90 })
    expect(ws.rows.find(r => r.user_id === a)!.completed_at).toBeTruthy()

    // Опитування: A — здано, B — у процесі; фільтр за статусом
    const [sv] = await admin`insert into surveys (tenant_id, title, questions, status) values (${tenantId}, ${`Опитування-d6 ${stamp}`}, '[]', 'active') returning id`
    track('surveys', sv!.id as string)
    await admin`insert into survey_participations (tenant_id, survey_id, user_id, status, submitted_at) values (${tenantId}, ${sv!.id}, ${a}, 'submitted', now()), (${tenantId}, ${sv!.id}, ${b}, 'in_progress', null)`
    const ps = await taskReport(ctx(), 'poll', { subjectId: sv!.id as string, status: 'done' })
    if ('error' in ps) throw new Error(ps.error)
    expect(ps.rows.map(r => r.user_id)).toEqual([a])

    // Чек-лист: A — пройдено, B — провалено
    const [cl] = await admin`insert into checklists (tenant_id, title, items, scale_id) values (${tenantId}, ${`Чек-лист-d6 ${stamp}`}, '[]', ${scaleId}) returning id`
    track('checklists', cl!.id as string)
    await admin`insert into checklist_runs (tenant_id, checklist_id, subject_kind, observer_id, subject_user_id, status, score, passed, finished_at) values (${tenantId}, ${cl!.id}, 'user', ${adminId}, ${a}, 'finished', 85, true, now()), (${tenantId}, ${cl!.id}, 'user', ${adminId}, ${b}, 'finished', 40, false, now())`
    const cs = await taskReport(ctx(), 'check_list', { subjectId: cl!.id as string })
    if ('error' in cs) throw new Error(cs.error)
    expect(cs.overview).toMatchObject({ assigned: 2, done: 1, failed: 1 })
    expect(cs.rows.find(r => r.user_id === b)).toMatchObject({ status: 'failed', result: 40 })

    // Комплексний тест: A — спочатку failed, потім passed → done з кращим балом; B — expired → failed
    const [ct] = await admin`insert into complex_tests (tenant_id, title, parts) values (${tenantId}, ${`Комплексний-d6 ${stamp}`}, '[]') returning id`
    track('complex_tests', ct!.id as string)
    await admin`insert into complex_test_attempts (tenant_id, complex_test_id, user_id, status, score, passed, started_at, finished_at) values
      (${tenantId}, ${ct!.id}, ${a}, 'failed', 40, false, now() - interval '2 hours', now() - interval '1 hour'), (${tenantId}, ${ct!.id}, ${a}, 'passed', 80, true, now() - interval '30 minutes', now()),
      (${tenantId}, ${ct!.id}, ${b}, 'expired', null, false, now() - interval '2 hours', now())`
    const xs = await taskReport(ctx(), 'complex_test', { subjectId: ct!.id as string })
    if ('error' in xs) throw new Error(xs.error)
    expect(xs.rows.find(r => r.user_id === a)).toMatchObject({ status: 'done', result: 80 })
    expect(xs.rows.find(r => r.user_id === b)).toMatchObject({ status: 'failed' })

    // Заняття: реєстрації на сесії — attended → done, missed → failed; аудиторія призначення без запису — not_started
    const m = await mt.createMeetup(ctx(), { kind: 'meetup', title: `Заняття-звіт ${stamp}`, announcement: [{ id: 'a', type: 'text', html: '<p>Анонс</p>' }], startsAt: hours(500), endsAt: hours(501), trainerIds: [adminId] })
    meetupIds.push(m.id)
    const s = await ms.createSession(ctx(), m.id, { startsAt: hours(-3), endsAt: hours(-2), locationId: lazarevaId, trainerIds: [adminId], capacity: 5 })
    if (!s.ok) throw new Error('no session')
    await ms.registerSession(ctx(adminId), s.session.id, a)
    expect((await ms.setAttendance(ctx(adminId), s.session.id, { userId: a, status: 'attended', reason: 'Був, забули відмітити' })).ok).toBe(true)
    const c = await makePerson('Звіт В')
    const [asg] = await admin`insert into assignments (tenant_id, title, kind, subject_type, subject_id, audience, status, created_by) values (${tenantId}, 'Заняття всім', 'manual', 'meetup', ${m.id}, ${admin.json({ rules: [{ type: 'user', ids: [c] }], match: 'any' })}, 'active', ${adminId}) returning id`
    track('assignments', asg!.id as string)
    const mr = await taskReport(ctx(), 'meetup', { subjectId: m.id })
    if ('error' in mr) throw new Error(mr.error)
    expect(mr.overview).toMatchObject({ assigned: 2, done: 1, notStarted: 1 })
    expect(mr.rows.find(r => r.user_id === c)).toMatchObject({ status: 'not_started' })
    expect(mr.rows.find(r => r.user_id === c)!.assigned_at).toBeTruthy()
    // За назначенням (taskId) — тільки його аудиторія плюс записи
    const byTask = await taskReport(ctx(), 'meetup', { taskId: asg!.id as string })
    if ('error' in byTask) throw new Error(byTask.error)
    expect(byTask.task?.id).toBe(asg!.id)

    // Ресурс: перше відкриття = ознайомлення (done)
    const [rs] = await admin`insert into resources (tenant_id, title, slug, kind, status) values (${tenantId}, ${`Ресурс-d6 ${stamp}`}, ${`res-d6-${stamp}`}, 'article', 'published') returning id`
    track('resources', rs!.id as string)
    await admin`insert into task_access_log (tenant_id, user_id, content_type, content_id, action) values (${tenantId}, ${a}, 'resource', ${rs!.id}, 'open'), (${tenantId}, ${a}, 'resource', ${rs!.id}, 'open')`
    const rr = await taskReport(ctx(), 'resource', { subjectId: rs!.id as string })
    if ('error' in rr) throw new Error(rr.error)
    expect(rr.rows.length).toBe(1)
    expect(rr.rows[0]).toMatchObject({ user_id: a, status: 'done' })
    expect(rr.accesses.reduce((n, d) => n + d.hits, 0)).toBe(2)
  })
})
