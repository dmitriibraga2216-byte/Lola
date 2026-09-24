import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readThrough } from './_lesson'

/**
 * Spec 17 (docs/17 §14.3, §15; docs/32 Б.8): узловая модель траектории.
 * Валидация полотна (цикл, недостижимый узел, обязательные поля), движок (and/or/delay/stop_delay/branch/mentor),
 * assign_mode, правила с измерениями + preview/usages, on_leave для траекторий. delay/stop_delay — прямым
 * вызовом обработчика таймера, без ожидания.
 */

const tr = await import('../../server/services/trajectories')
const { createCourse, addModule, addLesson, publishCourse } = await import('../../server/services/courses')
const { createBank, createQuestion, createQuiz, setQuizQuestions } = await import('../../server/services/questions')
const { startAttempt, saveAnswer, submitAttempt, getAttemptState } = await import('../../server/services/attempts')
const { completeLesson, openLesson, enrollmentTree } = await import('../../server/services/learning')
const { createRule, runRules, previewRule, ruleUsages, getRule, deleteRule } = await import('../../server/services/automation')
const { applyOnLeaveForRules } = await import('../../server/services/tasks')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
let tenantId: string, adminId: string, lazarevaId: string, posId: string, otherPosId: string, bankId: string
const userIds: string[] = [], courseIds: string[] = [], quizIds: string[] = [], trajIds: string[] = [], ruleIds: string[] = []
const ctx = (actorId = adminId) => ({ tenantId, actorId })
const stamp = Date.now()
/**
 * Опрос условия вместо фиксированной паузы. completeLesson/submitAttempt коммитят свою
 * транзакцию и только потом, в `.then()`, не дожидаясь, запускают `import('./trajectories').then(t =>
 * t.onTaskResult(...))` (server/services/learning.ts:817–818, attempts.ts:483–484) — это fire-and-forget,
 * вызывающий не держит на него ссылку. Время его применения не гарантировано: под нагрузкой
 * (несколько файлов тестов параллельно, медленная машина) фиксированная пауза (sleep(250)) иногда
 * заканчивалась раньше, чем хук успевал дописать состояние узла — отсюда флейк «Закриття доступу»
 * (таймер опережал хук и закрывал узел, который человек уже фактически сдал). Ждём факт, а не время.
 */
async function waitFor(cond: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await cond()) return
    if (Date.now() >= deadline) throw new Error(`тайм-аут ожидания (${timeoutMs}ms) — хук курса/теста не успел обновить состояние траектории`)
    await new Promise(r => setTimeout(r, 20))
  }
}
/**
 * Активная (не снятая) запись на курс — сигнал, что фоновое раскрытие назначения узла уже случилось.
 * Сам узел и его строка `assignments` создаются в транзакции хука, а фактическая строка `enrollments` —
 * только в `applyEffects`/`expandAssignment` ПОСЛЕ её коммита (server/services/trajectories.ts:614–668).
 * Поэтому «узел доступен» и «запись на курс уже существует» — не один и тот же момент.
 */
const hasCourseEnrollment = async (userId: string, courseId: string) =>
  (await admin`select 1 from enrollments where user_id = ${userId} and subject_id = ${courseId} and cancelled_at is null`).length > 0

async function makePerson(name: string, pos = posId) {
  const phone = `+38063${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, phone, full_name, status, hired_at) values (${tenantId}, ${phone}, ${name}, 'active', current_date) returning id`
  userIds.push(u!.id as string)
  await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary) values (${tenantId}, ${u!.id}, ${lazarevaId}, ${pos}, true)`
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
/** Пройти курс по записи, созданной назначением узла; `until` — признак того, что хук траектории уже применился. */
async function passCourse(userId: string, courseId: string, until: () => Promise<boolean>) {
  const findEnrollment = () => admin`select id from enrollments where user_id = ${userId} and subject_id = ${courseId} and cancelled_at is null order by created_at desc limit 1`
  // Запись о зачислении на курс раскрывается вне транзакции хука (см. hasCourseEnrollment выше) —
  // сразу после активации узла её может ещё не быть; ждём опросом вместо немедленного throw.
  let rows = await findEnrollment()
  if (!rows[0]) await waitFor(async () => { rows = await findEnrollment(); return !!rows[0] })
  const enr = rows[0]
  if (!enr) throw new Error('нет записи на курс — узел не создал назначение')
  const tree = await enrollmentTree(ctx(userId), enr.id as string)
  const lessonId = tree!.modules[0]!.lessons[0]!.id
  await openLesson(ctx(userId), enr.id as string, lessonId)
  await readThrough(admin, enr.id as string, lessonId)
  const r = await completeLesson(ctx(userId), enr.id as string, lessonId)
  expect(r.ok).toBe(true)
  await waitFor(until) // хук траектории — вне транзакции; ждём его результат опросом, а не паузой
}
async function makeQuiz() {
  const q = (await createQuestion(ctx(), { bankId, kind: 'single', stem: [{ id: 'b', type: 'text', html: '<p>?</p>' }], options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], answer: { correctId: 'a' }, isCritical: false, difficulty: 1, points: 1, scoringMethod: 'formula', attachFiles: false, negativeMarking: false, tags: [] })).id
  const quiz = await createQuiz(ctx(), { title: `Тест ${stamp}`, kind: 'quiz', tags: [], selectionMode: 'fixed', requiresOfflineConfirm: false })
  quizIds.push(quiz.id)
  await setQuizQuestions(ctx(), quiz.id, [{ questionId: q, sort: 0 }])
  await admin`update quizzes set status = 'published' where id = ${quiz.id}`
  return quiz.id
}
async function takeQuiz(userId: string, quizId: string, correct: boolean, until: () => Promise<boolean>) {
  const s = await startAttempt(ctx(userId), quizId)
  if (!s.ok) throw new Error(s.code)
  const st = await getAttemptState(ctx(userId), s.attemptId)
  await saveAnswer(ctx(userId), s.attemptId, st!.questions[0]!.id, { optionId: correct ? 'a' : 'b' })
  await submitAttempt(ctx(userId), s.attemptId)
  await waitFor(until) // хук траектории — вне транзакции (submitAttempt, аналогично passCourse)
}

type N = Parameters<typeof tr.putGraph>[2]['nodes'][number]
const task = (tmpId: string, contentType: 'course' | 'test', contentId: string, params: Record<string, unknown> = {}, x = 0): N => ({ tmpId, kind: 'task', contentType, contentId, params, x, y: 0 } as N)
const edge = (fromNodeId: string, toNodeId: string, condition?: { op: 'passed' | 'failed' | 'else' } | { op: 'score_gte', value: number }) => ({ fromNodeId, toNodeId, condition, sort: 0 })

/** Создать траекторию с полотном; start/finish берутся из автосозданных. */
async function makeTrajectory(title: string, nodes: N[], edges: ReturnType<typeof edge>[], opts: { publish?: boolean } = { publish: true }) {
  const t = await tr.createTrajectory(ctx(), { title: `${title} ${stamp}`, tags: [] })
  trajIds.push(t.id)
  const full = (await tr.getTrajectory(ctx(), t.id))!
  const start = full.nodes.find(n => n.kind === 'start')!, finish = full.nodes.find(n => n.kind === 'finish')!
  const map = (id: string) => (id === 'start' ? start.id : id === 'finish' ? finish.id : id)
  const g = await tr.putGraph(ctx(), t.id, {
    nodes: [{ id: start.id, kind: 'start', x: 0, y: 0 }, { id: finish.id, kind: 'finish', x: 0, y: 0 }, ...nodes],
    edges: edges.map(e => ({ ...e, fromNodeId: map(e.fromNodeId), toNodeId: map(e.toNodeId) })),
  })
  if (!g.ok) throw new Error(`graph: ${g.code}`)
  const ids = new Map<string, string>(nodes.map(n => [n.tmpId!, g.ids[n.tmpId!]!]))
  if (opts.publish) { const p = await tr.publishTrajectory(ctx(), t.id); if (!p.ok) throw new Error(`publish: ${JSON.stringify(p.problems)}`) }
  return { id: t.id, startId: start.id, finishId: finish.id, ids, problems: g.problems }
}
async function enroll(trajectoryId: string, userId: string) {
  const r = await tr.assignTrajectory(ctx(), trajectoryId, [userId])
  if (!r.ok) throw new Error(r.code)
  const [e] = await admin`select id from trajectory_enrollments where trajectory_id = ${trajectoryId} and user_id = ${userId}`
  return e!.id as string
}
const stateOf = async (enrollmentId: string, nodeId: string) => (await admin`select status, reason, assignment_id, fires_at, passed from trajectory_node_states where enrollment_id = ${enrollmentId} and node_id = ${nodeId}`)[0]
const enrOf = async (enrollmentId: string) => (await admin`select status, progress_pct, mentor_id, cancelled_at from trajectory_enrollments where id = ${enrollmentId}`)[0]!

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  posId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Бариста-s17-${stamp}`}, ${`barista-s17-${stamp}`}) returning id`)[0]!.id as string
  otherPosId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Кухар-s17-${stamp}`}, ${`cook-s17-${stamp}`}) returning id`)[0]!.id as string
  bankId = (await createBank(ctx(), { name: `Банк-s17 ${stamp}` })).id
  // Наставник по умолчанию — керівник точки; у сида точка без руководителя → назначаем Шефа на время теста
  const [loc] = await admin`select manager_id from locations where id = ${lazarevaId}`
  if (!loc!.manager_id) { setManager = true; await admin`update locations set manager_id = (select id from users where tenant_id = ${tenantId} and phone = '+380670000002') where id = ${lazarevaId}` }
})
let setManager = false
afterAll(async () => {
  if (trajIds.length) { await admin`delete from notifications where ref_type = 'trajectory_enrollment' and ref_id in (select id from trajectory_enrollments where trajectory_id in ${admin(trajIds)})`; await admin`delete from assignments where audience->>'trajectoryId' in ${admin(trajIds)}`; await admin`delete from trajectories where id in ${admin(trajIds)}` }
  if (ruleIds.length) await admin`delete from automation_rules where id in ${admin(ruleIds)}`
  if (setManager) await admin`update locations set manager_id = null where id = ${lazarevaId}`
  if (userIds.length) { await admin`delete from notifications where user_id in ${admin(userIds)}`; await admin`delete from certificates where user_id in ${admin(userIds)}`; await admin`delete from attempts where user_id in ${admin(userIds)}`; await admin`delete from enrollments where user_id in ${admin(userIds)}`; await admin`delete from users where id in ${admin(userIds)}` }
  if (quizIds.length) { await admin`delete from attempts where quiz_id in ${admin(quizIds)}`; await admin`delete from quizzes where id in ${admin(quizIds)}` }
  await admin`delete from questions where bank_id = ${bankId}`; await admin`delete from question_banks where id = ${bankId}`
  if (courseIds.length) { await admin`delete from enrollments where subject_id in ${admin(courseIds)}`; await admin`delete from resources where id in (select l.item_id from lessons l join modules m on m.id = l.module_id join course_versions v on v.id = m.course_version_id where l.item_type = 'resource' and v.course_id in ${admin(courseIds)})`; await admin`delete from courses where id in ${admin(courseIds)}` }
  await admin`delete from positions where id in ${admin([posId, otherPosId])}`
  await admin.end()
})

describe('валидация полотна (docs/17 §15 Г-17.1)', () => {
  it('цикл, недостижимый блок, «І» с одним входом, закриття перед Finish, розгалуження без «інакше», пустые поля', async () => {
    const c1 = await makeCourse('Курс 1'), c2 = await makeCourse('Курс 2')
    const t = await makeTrajectory('Погана', [
      task('a', 'course', c1), task('b', 'course', c2),
      { tmpId: 'and', kind: 'and', title: 'І', x: 0, y: 0 },
      { tmpId: 'sd', kind: 'stop_delay', title: 'Закриття', days: 3, x: 0, y: 0 },
      { tmpId: 'br', kind: 'branch', title: 'Гілка', x: 0, y: 0 },
      { tmpId: 'dl', kind: 'delay', title: '', days: 2, x: 0, y: 0 },
      { tmpId: 'orph', kind: 'or', title: 'Сирота', x: 0, y: 0 },
    ], [
      edge('start', 'a'), edge('a', 'and'), edge('and', 'b'), edge('b', 'a'), // цикл a → and → b → a
      edge('b', 'sd'), edge('sd', 'finish'), // закриття перед Finish
      edge('a', 'br'), edge('br', 'dl', { op: 'passed' }), edge('dl', 'finish'), // розгалуження без «інакше», delay без назви
    ], { publish: false })
    const codes = t.problems.map(p => p.code)
    for (const c of ['cycle', 'unreachable', 'and_single_input', 'stop_delay_before_finish', 'branch_no_else', 'missing_title']) expect(codes, c).toContain(c)
    expect(t.problems.find(p => p.code === 'unreachable')!.nodeId).toBe(t.ids.get('orph'))
    expect(t.problems.find(p => p.code === 'and_single_input')!.nodeId).toBe(t.ids.get('and'))
    for (const p of t.problems) expect(p.message.length).toBeGreaterThan(10) // ошибка объясняет, что делать
    const pub = await tr.publishTrajectory(ctx(), t.id)
    expect(pub.ok).toBe(false)
    if (!pub.ok) expect(pub.code).toBe('invalid')
    // Условие вне розгалуження — тоже ошибка
    const t2 = await makeTrajectory('Умова не там', [task('a', 'course', c1)], [edge('start', 'a', { op: 'passed' }), edge('a', 'finish')], { publish: false })
    expect(t2.problems.map(p => p.code)).toContain('condition_not_allowed')
  })

  it('исправный граф публикуется; опубликованный не перестраивается (409), только координаты', async () => {
    const c1 = await makeCourse('Курс ок')
    const t = await makeTrajectory('Добра', [task('a', 'course', c1)], [edge('start', 'a'), edge('a', 'finish')])
    expect(t.problems).toEqual([])
    const full = (await tr.getTrajectory(ctx(), t.id))!
    expect(full.status).toBe('published')
    const moved = await tr.putGraph(ctx(), t.id, { nodes: full.nodes.map(n => ({ ...n, x: n.x + 10 })) as never, edges: full.edges.map(e => ({ fromNodeId: e.fromNodeId, toNodeId: e.toNodeId, sort: e.sort })) })
    expect(moved.ok).toBe(true)
    const broken = await tr.putGraph(ctx(), t.id, { nodes: full.nodes.filter(n => n.kind !== 'task') as never, edges: [] })
    expect(broken).toMatchObject({ ok: false, code: 'published' })
  })
})

describe('движок прохождения', () => {
  it('«І»: два курса параллельно, дальше — когда выполнены оба; узлы создают назначения kind=trajectory', async () => {
    const c1 = await makeCourse('І-1'), c2 = await makeCourse('І-2'), c3 = await makeCourse('І-3')
    const t = await makeTrajectory('І', [task('a', 'course', c1, { dueDays: 5 }), task('b', 'course', c2), { tmpId: 'and', kind: 'and', title: 'Обидва', x: 0, y: 0 }, task('c', 'course', c3)],
      [edge('start', 'a'), edge('start', 'b'), edge('a', 'and'), edge('b', 'and'), edge('and', 'c'), edge('c', 'finish')])
    const u = await makePerson('Паралельний')
    const e = await enroll(t.id, u)
    expect(await enrOf(e)).toMatchObject({ status: 'in_progress' })
    expect((await stateOf(e, t.ids.get('a')!))!.status).toBe('available')
    expect((await stateOf(e, t.ids.get('c')!))!.status).toBe('locked')
    const asg = await admin`select kind, subject_id, due_days, audience from assignments where audience->>'trajectoryId' = ${t.id}`
    expect(asg.length).toBe(2)
    expect(asg.every(a => a.kind === 'trajectory')).toBe(true)
    expect(asg.find(a => a.subject_id === c1)!.due_days).toBe(5) // правила — из узла
    expect((await admin`select count(*)::int as c from enrollments where user_id = ${u} and subject_id in (${c1}, ${c2})`)[0]!.c).toBe(2)
    await passCourse(u, c1, async () => (await stateOf(e, t.ids.get('and')!))?.status === 'available')
    expect((await stateOf(e, t.ids.get('and')!))!.status).toBe('available') // ждёт второй вход
    expect((await stateOf(e, t.ids.get('c')!))!.status).toBe('locked')
    await passCourse(u, c2, async () => (await stateOf(e, t.ids.get('and')!))?.status === 'done')
    expect((await stateOf(e, t.ids.get('and')!))!.status).toBe('done')
    expect((await stateOf(e, t.ids.get('c')!))!.status).toBe('available')
    await passCourse(u, c3, async () => (await enrOf(e)).status === 'done')
    expect(await enrOf(e)).toMatchObject({ status: 'done' })
    expect(Number((await enrOf(e)).progress_pct)).toBe(100)
    expect((await admin`select count(*)::int as c from notifications where user_id = ${u} and code = 'trajectory_finished'`)[0]!.c).toBe(1)
    const my = await tr.myTrajectory(ctx(u), e)
    expect(my).toMatchObject({ done: 3, total: 3, status: 'done' })
  })

  it('«АБО»: достаточно одного входа', async () => {
    const c1 = await makeCourse('АБО-1'), c2 = await makeCourse('АБО-2'), c3 = await makeCourse('АБО-3')
    const t = await makeTrajectory('АБО', [task('a', 'course', c1), task('b', 'course', c2), { tmpId: 'or', kind: 'or', title: 'Будь-який', x: 0, y: 0 }, task('c', 'course', c3)],
      [edge('start', 'a'), edge('start', 'b'), edge('a', 'or'), edge('b', 'or'), edge('or', 'c'), edge('c', 'finish')])
    const u = await makePerson('Один із двох')
    const e = await enroll(t.id, u)
    await passCourse(u, c2, async () => (await stateOf(e, t.ids.get('or')!))?.status === 'done')
    expect((await stateOf(e, t.ids.get('or')!))!.status).toBe('done')
    expect((await stateOf(e, t.ids.get('c')!))!.status).toBe('available')
    const my = (await tr.myTrajectory(ctx(u), e))!
    expect(my.steps.map(s => s.kind)).toContain('or')
    expect(my.done).toBe(1); expect(my.total).toBe(3)
  })

  it('«Затримка»: следующий блок открывается по таймеру — обработчик вызывается напрямую', async () => {
    const c1 = await makeCourse('Після затримки')
    const t = await makeTrajectory('Затримка', [{ tmpId: 'dl', kind: 'delay', title: 'Три дні', days: 3, x: 0, y: 0 }, task('a', 'course', c1)], [edge('start', 'dl'), edge('dl', 'a'), edge('a', 'finish')])
    const u = await makePerson('Терплячий')
    const e = await enroll(t.id, u)
    const dl = (await stateOf(e, t.ids.get('dl')!))!
    expect(dl.status).toBe('available')
    expect(new Date(dl.fires_at as string).getTime()).toBeGreaterThan(Date.now() + 2.9 * 86_400_000)
    expect((await stateOf(e, t.ids.get('a')!))!.status).toBe('locked')
    expect((await admin`select count(*)::int as c from assignments where audience->>'trajectoryId' = ${t.id}`)[0]!.c).toBe(0)
    const [st] = await admin`select id from trajectory_node_states where enrollment_id = ${e} and node_id = ${t.ids.get('dl')!}`
    expect(await tr.fireTimer(tenantId, st!.id as string)).toBe('delay')
    expect((await stateOf(e, t.ids.get('dl')!))!.status).toBe('done')
    expect((await stateOf(e, t.ids.get('a')!))!.status).toBe('available')
    expect((await admin`select count(*)::int as c from enrollments where user_id = ${u} and subject_id = ${c1}`)[0]!.c).toBe(1)
    expect(await tr.fireTimer(tenantId, st!.id as string)).toBe('noop') // повторно — ничего
  })

  it('«Закриття доступу»: пропускает сразу, а по таймеру закрывает невыполненный следующий блок; прохождение — failed', async () => {
    const c1 = await makeCourse('До закриття'), c2 = await makeCourse('Після закриття')
    const t = await makeTrajectory('Закриття', [task('a', 'course', c1), { tmpId: 'sd', kind: 'stop_delay', title: '14 днів', days: 14, x: 0, y: 0 }, task('b', 'course', c2)],
      [edge('start', 'a'), edge('a', 'sd'), edge('sd', 'b'), edge('b', 'finish')])
    const u = await makePerson('Не встиг')
    const e = await enroll(t.id, u)
    // Ждём не только смены статуса узла «b», а фактического появления записи на курс c2 —
    // иначе fireTimer ниже может застать её ещё не раскрытой и не отменить (флейк, см. PR).
    await passCourse(u, c1, async () => (await stateOf(e, t.ids.get('b')!))?.status === 'available' && await hasCourseEnrollment(u, c2))
    expect((await stateOf(e, t.ids.get('sd')!))!.status).toBe('done') // пропустил сразу
    expect((await stateOf(e, t.ids.get('b')!))!.status).toBe('available') // курс выдан
    const [st] = await admin`select id from trajectory_node_states where enrollment_id = ${e} and node_id = ${t.ids.get('sd')!}`
    expect(await tr.fireTimer(tenantId, st!.id as string)).toBe('stop_delay')
    expect(await stateOf(e, t.ids.get('b')!)).toMatchObject({ status: 'failed', reason: 'access_closed' })
    expect((await admin`select cancelled_at from enrollments where user_id = ${u} and subject_id = ${c2}`)[0]!.cancelled_at).toBeTruthy()
    expect((await enrOf(e)).status).toBe('failed')
    expect((await admin`select count(*)::int as c from audit_log where entity_id = ${e} and action = 'trajectory.access_closed'`)[0]!.c).toBe(1)
    // Выполненный вовремя блок закрытие не трогает
    const u2 = await makePerson('Встиг')
    const e2 = await enroll(t.id, u2)
    // Ждём не только «курс принят», а фактическое применение хука траектории — иначе fireTimer ниже
    // может застать узел «b» ещё «available» и ошибочно закрыть доступ (флейк, см. PR).
    await passCourse(u2, c1, async () => (await stateOf(e2, t.ids.get('b')!))?.status === 'available' && await hasCourseEnrollment(u2, c2))
    await passCourse(u2, c2, async () => (await enrOf(e2)).status === 'done')
    const [st2] = await admin`select id from trajectory_node_states where enrollment_id = ${e2} and node_id = ${t.ids.get('sd')!}`
    await tr.fireTimer(tenantId, st2!.id as string)
    expect((await enrOf(e2)).status).toBe('done')
  })

  it('«Розгалуження за результатом»: не сдал → доп. курс, сдал → далі; невыбранная ветка — skipped (docs/17 §13.1)', async () => {
    const quiz = await makeQuiz()
    const extra = await makeCourse('Додатковий'), next = await makeCourse('Далі')
    const t = await makeTrajectory('Гілки', [task('q', 'test', quiz, { passScore: 50, attemptsAllowed: 0 }), { tmpId: 'br', kind: 'branch', title: 'За балом', x: 0, y: 0 }, task('x', 'course', extra), task('n', 'course', next)],
      [edge('start', 'q'), edge('q', 'br'), edge('br', 'n', { op: 'passed' }), edge('br', 'x', { op: 'else' }), edge('x', 'n'), edge('n', 'finish')])
    const loser = await makePerson('Провалив'), winner = await makePerson('Здав')
    const eL = await enroll(t.id, loser), eW = await enroll(t.id, winner)
    await takeQuiz(loser, quiz, false, async () => (await stateOf(eL, t.ids.get('q')!))?.status === 'failed')
    expect(await stateOf(eL, t.ids.get('q')!)).toMatchObject({ status: 'failed', passed: false })
    expect((await stateOf(eL, t.ids.get('x')!))!.status).toBe('available')
    expect((await stateOf(eL, t.ids.get('n')!))!.status).toBe('locked') // «далі» закрыт, откроется после доп. курса
    await takeQuiz(winner, quiz, true, async () => (await stateOf(eW, t.ids.get('n')!))?.status === 'available')
    expect((await stateOf(eW, t.ids.get('n')!))!.status).toBe('available')
    expect(await stateOf(eW, t.ids.get('x')!)).toMatchObject({ status: 'skipped', reason: 'branch_not_taken' })
    const my = (await tr.myTrajectory(ctx(winner), eW))!
    expect(my.steps.some(s => s.nodeId === t.ids.get('x'))).toBe(false) // в ленте только фактический путь
    expect(my.total).toBe(2) // тест + «далі»; пропущенный не в знаменателе
  })

  it('«Призначити наставника»: ждёт подтверждения наставником (керівник точки), потом открывает следующий блок', async () => {
    const c1 = await makeCourse('Після наставника')
    const t = await makeTrajectory('Наставник', [{ tmpId: 'm', kind: 'mentor', title: 'Знайомство', x: 0, y: 0 }, task('a', 'course', c1)], [edge('start', 'm'), edge('m', 'a'), edge('a', 'finish')])
    const chefId = (await admin`select manager_id from locations where id = ${lazarevaId}`)[0]!.manager_id as string
    const u = await makePerson('Стажер')
    const e = await enroll(t.id, u)
    expect((await stateOf(e, t.ids.get('m')!))!.status).toBe('available')
    expect((await enrOf(e)).mentor_id).toBe(chefId)
    expect((await admin`select count(*)::int as c from notifications where user_id = ${chefId} and code = 'trajectory_mentor_confirm' and ref_id = ${e}`)[0]!.c).toBe(1)
    // Посторонний — не может; наставник — может
    const stranger = await makePerson('Сторонній')
    expect(await tr.confirmMentor(ctx(stranger), e, t.ids.get('m')!, { isAdmin: false })).toMatchObject({ ok: false, code: 'not_mentor' })
    expect(await tr.confirmMentor(ctx(chefId), e, t.ids.get('m')!, { isAdmin: false })).toEqual({ ok: true })
    expect((await stateOf(e, t.ids.get('a')!))!.status).toBe('available')
    expect(await tr.confirmMentor(ctx(chefId), e, t.ids.get('m')!, { isAdmin: false })).toMatchObject({ ok: false, code: 'not_waiting' })
  })
})

describe('assign_mode, правило с измерениями, preview/usages, on_leave', () => {
  it('manual — самозапись невозможна; catalog_free — самозапись; catalog_request — заявка и решение', async () => {
    const c1 = await makeCourse('Каталожний')
    const t = await makeTrajectory('Каталог', [task('a', 'course', c1)], [edge('start', 'a'), edge('a', 'finish')])
    const u = await makePerson('Сам')
    expect(await tr.selfEnroll(ctx(u), t.id)).toMatchObject({ ok: false, code: 'not_in_catalog' })
    expect((await tr.updateTrajectory(ctx(), t.id, { assignMode: 'catalog_free' })).ok).toBe(true)
    expect((await tr.catalogTrajectories(ctx(u))).map(x => x.id)).toContain(t.id)
    const r = await tr.selfEnroll(ctx(u), t.id)
    expect(r.ok).toBe(true)
    const [e] = await admin`select id, status, source from trajectory_enrollments where trajectory_id = ${t.id} and user_id = ${u}`
    expect(e).toMatchObject({ status: 'in_progress', source: 'catalog' })
    expect((await stateOf(e!.id as string, t.ids.get('a')!))!.status).toBe('available')

    expect((await tr.updateTrajectory(ctx(), t.id, { assignMode: 'catalog_request' })).ok).toBe(true)
    const u2 = await makePerson('Заявник')
    const req = await tr.selfEnroll(ctx(u2), t.id)
    expect(req).toMatchObject({ ok: true, requested: true })
    const [e2] = await admin`select id, status from trajectory_enrollments where trajectory_id = ${t.id} and user_id = ${u2}`
    expect(e2!.status).toBe('not_assigned') // пять статусов: ещё не выдано
    expect((await admin`select count(*)::int as c from assignments where audience->>'trajectoryId' = ${t.id} and audience->>'trajectoryEnrollmentId' = ${e2!.id}`)[0]!.c).toBe(0)
    expect(await tr.decideRequest(ctx(), e2!.id as string, true)).toEqual({ ok: true })
    expect((await enrOf(e2!.id as string)).status).toBe('in_progress')
    expect((await stateOf(e2!.id as string, t.ids.get('a')!))!.status).toBe('available')
    // automation без правила — отказ
    expect(await tr.updateTrajectory(ctx(), t.id, { assignMode: 'automation' })).toMatchObject({ ok: false, code: 'rule_required' })
  })

  it('правило с измерениями: preview без побочных эффектов, usages, automation + stop_assign_after_finish, on_leave cancel_all', async () => {
    const c1 = await makeCourse('Автоматичний курс')
    const rule = await createRule(ctx(), {
      name: `Бариста s17 ${stamp}`, trigger: 'user.placement_changed', assignDelayDays: 0, isActive: true, runLimit: { oncePerUser: false },
      conditions: {}, dimensions: [{ dimension: 'position', mode: 'include', valueIds: [posId] }, { dimension: 'city', mode: 'any', valueIds: [] }],
      actions: [], onLeaveCondition: 'cancel_all',
    })
    ruleIds.push(rule.id)
    const dims = await admin`select dimension, mode, value_ids from automation_rule_dimensions where rule_id = ${rule.id} order by dimension`
    expect(dims.map(d => d.dimension)).toEqual(['city', 'org_unit', 'position', 'tag']) // все четыре измерения таблицей
    expect(dims.find(d => d.dimension === 'position')).toMatchObject({ mode: 'include', value_ids: [posId] })
    const got = (await getRule(ctx(), rule.id))!
    expect(got.dimensions.find(d => d.dimension === 'position')!.values[0]!.name).toContain('Бариста-s17')

    const u = await makePerson('Під правилом'), cook = await makePerson('Не під правилом', otherPosId)
    const before = (await admin`select count(*)::int as c from trajectory_enrollments`)[0]!.c
    const pv = (await previewRule(ctx(), { ruleId: rule.id }))!
    expect(pv.people.map(p => p.id)).toContain(u)
    expect(pv.people.map(p => p.id)).not.toContain(cook)
    expect((await admin`select count(*)::int as c from trajectory_enrollments`)[0]!.c).toBe(before) // preview ничего не назначил
    // «Всі, окрім»
    const pvEx = (await previewRule(ctx(), { dimensions: [{ dimension: 'position', mode: 'exclude', valueIds: [posId] }] }))!
    expect(pvEx.people.map(p => p.id)).not.toContain(u)
    expect(pvEx.people.map(p => p.id)).toContain(cook)

    const t = await makeTrajectory('Автоматична', [task('a', 'course', c1)], [edge('start', 'a'), edge('a', 'finish')])
    expect((await tr.updateTrajectory(ctx(), t.id, { assignMode: 'automation', automationRuleId: rule.id, stopAssignAfterFinish: true })).ok).toBe(true)
    expect((await ruleUsages(ctx(), rule.id))!).toEqual([expect.objectContaining({ kind: 'trajectory', id: t.id })])
    expect(await deleteRule(ctx(), rule.id)).toMatchObject({ ok: false, code: 'in_use' })
    expect((await tr.trajectoryUsages(ctx(), t.id))!.rule).toMatchObject({ id: rule.id })
    expect((await tr.contentUsages(ctx(), 'course', c1)).map(x => x.id)).toContain(t.id)

    const r1 = await runRules(tenantId, 'user.placement_changed', u)
    expect(r1.find(x => x.ruleId === rule.id)!.actions).toEqual([expect.objectContaining({ type: 'assign_trajectory', trajectoryId: t.id, started: true })])
    const [e] = await admin`select id, status, source, rule_id from trajectory_enrollments where trajectory_id = ${t.id} and user_id = ${u}`
    expect(e).toMatchObject({ status: 'in_progress', source: 'automation', rule_id: rule.id })
    const [asg] = await admin`select automation_rule_id from assignments where audience->>'trajectoryId' = ${t.id}`
    expect(asg!.automation_rule_id).toBe(rule.id) // источник назначения — правило
    expect((await runRules(tenantId, 'user.placement_changed', cook)).find(x => x.ruleId === rule.id)!.status).toBe('skipped:conditions')

    // Завершил → повторно под правило → нет нового назначения
    await passCourse(u, c1, async () => (await enrOf(e!.id as string)).status === 'done')
    expect((await enrOf(e!.id as string)).status).toBe('done')
    const r2 = await runRules(tenantId, 'user.placement_changed', u)
    expect(r2.find(x => x.ruleId === rule.id)!.actions).toEqual([expect.objectContaining({ type: 'assign_trajectory', skipped: 'finished_no_reassign' })])

    // on_leave: второй человек начал, потом сменил должность → cancel_all снимает прохождение и назначение узла
    const u2 = await makePerson('Пішов з посади')
    await runRules(tenantId, 'user.placement_changed', u2)
    const [e2] = await admin`select id from trajectory_enrollments where trajectory_id = ${t.id} and user_id = ${u2}`
    expect((await enrOf(e2!.id as string)).status).toBe('in_progress')
    await admin`update user_placements set position_id = ${otherPosId} where user_id = ${u2}`
    expect(await applyOnLeaveForRules(tenantId)).toMatchObject({ trajectories: 1 })
    expect((await enrOf(e2!.id as string)).cancelled_at).toBeTruthy()
    expect((await admin`select cancelled_at from enrollments where user_id = ${u2} and subject_id = ${c1}`)[0]!.cancelled_at).toBeTruthy()
    expect((await admin`select count(*)::int as c from audit_log where entity_id = ${e2!.id} and action = 'trajectory.cancel'`)[0]!.c).toBe(1)
    // Первый (done) не тронут
    expect((await enrOf(e!.id as string)).cancelled_at).toBeNull()
  })

  it('чужой тенант не видит траекторию (RLS) — getTrajectory → null', async () => {
    const [other] = await admin`insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції') on conflict (slug) do update set name = excluded.name returning id`
    const t = trajIds[0]!
    expect(await tr.getTrajectory({ tenantId: other!.id as string, actorId: adminId }, t)).toBeNull()
    expect(await withTenant(other!.id as string, null, tx => tr.validateTrajectory(tx, t))).toBeNull()
  })
})
