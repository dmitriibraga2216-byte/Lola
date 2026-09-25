import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readThrough } from './_lesson'

/**
 * fix-resource-node (docs/11 Г-11.5, docs/17 §14.3; docs/28 «fix-resource-node»).
 *
 * Узел траектории «Завдання» с материалом (ресурсом) не завершался никогда: из ленты его было
 * негде открыть, а просмотр ресурса не звал хук результата траектории. Здесь — путь целиком:
 * открыть по назначению узла → факты (время тиками, прокрутка, «Я ознайомився») → сервер решает по
 * правилу типа → тот же `onTaskResult`, что у курса и теста. Плюс соседние виды «Завдання», у
 * которых не было хука результата: опитування, комплексний тест, навчальна програма.
 *
 * Хуки курса и теста запускаются «выстрелил и забыл» после коммита (learning.ts, attempts.ts) —
 * результат ждём опросом условия, а не паузой (#123).
 */

const tr = await import('../../server/services/trajectories')
const rp = await import('../../server/services/resourcePass')
const programs = await import('../../server/services/programs')
const { createResource, updateResource, publishResource, viewResource } = await import('../../server/services/resources')
const { createCourse, addModule, addLesson, publishCourse } = await import('../../server/services/courses')
const { createBank, createQuestion, createQuiz, setQuizQuestions } = await import('../../server/services/questions')
const { startAttempt, saveAnswer, submitAttempt, getAttemptState } = await import('../../server/services/attempts')
const { completeLesson, openLesson, enrollmentTree } = await import('../../server/services/learning')
const { createSurvey, updateSurvey, startSurvey, answerQuestion } = await import('../../server/services/surveys')
const ct = await import('../../server/services/complexTests')
const { reasonCodes, REASONS } = await import('../../server/services/lessonRules')
const { refUrl } = await import('../../server/services/notifications')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
let tenantId: string, adminId: string, lazarevaId: string, posId: string, bankId: string
const userIds: string[] = [], courseIds: string[] = [], quizIds: string[] = [], trajIds: string[] = [], resourceIds: string[] = [], surveyIds: string[] = [], complexIds: string[] = [], programIds: string[] = []
const ctx = (actorId = adminId) => ({ tenantId, actorId })
const stamp = Date.now()

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await cond()) return
    if (Date.now() >= deadline) throw new Error(`тайм-аут ожидания (${timeoutMs}ms) — хук результата не обновил состояние траектории`)
    await new Promise(r => setTimeout(r, 20))
  }
}

async function makePerson(name: string) {
  const phone = `+38063${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, phone, full_name, status, hired_at) values (${tenantId}, ${phone}, ${name}, 'active', current_date) returning id`
  userIds.push(u!.id as string)
  await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary) values (${tenantId}, ${u!.id}, ${lazarevaId}, ${posId}, true)`
  return u!.id as string
}

async function makeResource(title: string, extra: Record<string, unknown> = {}) {
  const r = await createResource(ctx(), { kind: 'article', title: `${title} ${stamp}`, language: 'uk', tags: [], categoryIds: [], allowPrint: true, body: [{ id: 'b1', type: 'text', html: '<p>Звіряємо номер замовлення на чеку і на пакеті.</p>' }], ...extra } as never)
  resourceIds.push(r.id)
  const p = await publishResource(ctx(), r.id, { notifyAssigned: false })
  if (!p.ok) throw new Error(`publish resource: ${JSON.stringify(p)}`)
  return r.id
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
  let rows = await findEnrollment()
  if (!rows[0]) await waitFor(async () => { rows = await findEnrollment(); return !!rows[0] })
  const enrId = rows[0]!.id as string
  const tree = await enrollmentTree(ctx(userId), enrId)
  const lessonId = tree!.modules[0]!.lessons[0]!.id
  await openLesson(ctx(userId), enrId, lessonId)
  await readThrough(admin, enrId, lessonId)
  expect((await completeLesson(ctx(userId), enrId, lessonId)).ok).toBe(true)
  await waitFor(until)
}

async function makeQuiz(title: string) {
  const q = (await createQuestion(ctx(), { bankId, kind: 'single', stem: [{ id: 'b', type: 'text', html: '<p>?</p>' }], options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], answer: { correctId: 'a' }, isCritical: false, difficulty: 1, points: 1, scoringMethod: 'formula', attachFiles: false, negativeMarking: false, tags: [] })).id
  const quiz = await createQuiz(ctx(), { title: `${title} ${stamp}`, kind: 'quiz', tags: [], selectionMode: 'fixed', requiresOfflineConfirm: false })
  quizIds.push(quiz.id)
  await setQuizQuestions(ctx(), quiz.id, [{ questionId: q, sort: 0 }])
  await admin`update quizzes set status = 'published' where id = ${quiz.id}`
  return quiz.id
}

/** Сдать тест одним ответом; attemptId — для части комплексного теста (попытку создал startPart). */
async function answerQuiz(userId: string, attemptId: string, correct: boolean) {
  const st = await getAttemptState(ctx(userId), attemptId)
  await saveAnswer(ctx(userId), attemptId, st!.questions[0]!.id, { optionId: correct ? 'a' : 'b' })
  await submitAttempt(ctx(userId), attemptId)
}

type N = Parameters<typeof tr.putGraph>[2]['nodes'][number]
type TaskType = 'course' | 'test' | 'resource' | 'poll' | 'complex_test' | 'training_program'
const task = (tmpId: string, contentType: TaskType, contentId: string, params: Record<string, unknown> = {}): N => ({ tmpId, kind: 'task', contentType, contentId, params, x: 0, y: 0 } as N)
const edge = (fromNodeId: string, toNodeId: string) => ({ fromNodeId, toNodeId, sort: 0 })

/** Линейная траектория Start → узлы по порядку → Finish, опубликованная. */
async function makeTrajectory(title: string, nodes: N[]) {
  const t = await tr.createTrajectory(ctx(), { title: `${title} ${stamp}`, tags: [] })
  trajIds.push(t.id)
  const full = (await tr.getTrajectory(ctx(), t.id))!
  const start = full.nodes.find(n => n.kind === 'start')!, finish = full.nodes.find(n => n.kind === 'finish')!
  const chain = [start.id, ...nodes.map(n => n.tmpId!), finish.id]
  const g = await tr.putGraph(ctx(), t.id, {
    nodes: [{ id: start.id, kind: 'start', x: 0, y: 0 }, { id: finish.id, kind: 'finish', x: 0, y: 0 }, ...nodes],
    edges: chain.slice(0, -1).map((id, i) => edge(id, chain[i + 1]!)),
  })
  if (!g.ok) throw new Error(`graph: ${g.code}`)
  expect(g.problems).toEqual([])
  const p = await tr.publishTrajectory(ctx(), t.id)
  if (!p.ok) throw new Error(`publish: ${JSON.stringify(p.problems)}`)
  return { id: t.id, ids: new Map(nodes.map(n => [n.tmpId!, g.ids[n.tmpId!]!])) }
}

async function enroll(trajectoryId: string, userId: string) {
  const r = await tr.assignTrajectory(ctx(), trajectoryId, [userId])
  if (!r.ok) throw new Error(r.code)
  return (await admin`select id from trajectory_enrollments where trajectory_id = ${trajectoryId} and user_id = ${userId}`)[0]!.id as string
}
const stateOf = async (enrollmentId: string, nodeId: string) => (await admin`select status, passed, score, assignment_id from trajectory_node_states where enrollment_id = ${enrollmentId} and node_id = ${nodeId}`)[0]!
const enrOf = async (enrollmentId: string) => (await admin`select status, progress_pct from trajectory_enrollments where id = ${enrollmentId}`)[0]!

/** Факты чтения: открытие «в прошлом» (тик засчитывает не больше реально прошедшего) и тик с прокруткой до конца. */
async function readResource(userId: string, resourceId: string, assignmentId?: string) {
  await admin`update resource_progress set first_opened_at = now() - interval '10 minutes', last_tick_at = null
    where user_id = ${userId} and resource_id = ${resourceId} and assignment_id is not distinct from ${assignmentId ?? null}::uuid`
  return rp.tickResourcePass(ctx(userId), resourceId, { assignmentId, seconds: 20, scrollPct: 100 })
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  posId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Бариста-rn-${stamp}`}, ${`barista-rn-${stamp}`}) returning id`)[0]!.id as string
  bankId = (await createBank(ctx(), { name: `Банк-rn ${stamp}` })).id
})

afterAll(async () => {
  if (trajIds.length) {
    await admin`delete from notifications where ref_type = 'trajectory_enrollment' and ref_id in (select id from trajectory_enrollments where trajectory_id in ${admin(trajIds)})`
    await admin`delete from assignments where audience->>'trajectoryId' in ${admin(trajIds)}`
    await admin`delete from trajectories where id in ${admin(trajIds)}`
  }
  if (programIds.length) { await admin`delete from assignments where subject_id in ${admin(programIds)}`; await admin`delete from programs where id in ${admin(programIds)}` }
  if (userIds.length) {
    for (const table of ['task_status_log', 'task_access_log', 'notifications', 'certificates', 'survey_participations', 'complex_test_attempts', 'attempts', 'enrollments', 'resource_progress']) {
      await admin`delete from ${admin(table)} where user_id in ${admin(userIds)}`
    }
    await admin`delete from users where id in ${admin(userIds)}`
  }
  if (surveyIds.length) { await admin`delete from survey_responses where survey_id in ${admin(surveyIds)}`; await admin`delete from surveys where id in ${admin(surveyIds)}` }
  if (complexIds.length) await admin`delete from complex_tests where id in ${admin(complexIds)}`
  if (quizIds.length) { await admin`delete from attempts where quiz_id in ${admin(quizIds)}`; await admin`delete from quizzes where id in ${admin(quizIds)}` }
  await admin`delete from questions where bank_id = ${bankId}`
  await admin`delete from question_banks where id = ${bankId}`
  if (courseIds.length) {
    await admin`delete from enrollments where subject_id in ${admin(courseIds)}`
    await admin`delete from resources where id in (select l.item_id from lessons l join modules m on m.id = l.module_id join course_versions v on v.id = m.course_version_id where l.item_type = 'resource' and v.course_id in ${admin(courseIds)})`
    await admin`delete from courses where id in ${admin(courseIds)}`
  }
  if (resourceIds.length) await admin`delete from resources where id in ${admin(resourceIds)}`
  await admin`delete from positions where id = ${posId}`
  await admin.end()
})

describe('узел-материал траектории: открыть → выполнить → узел засчитан (docs/11 Г-11.5)', () => {
  it('«урок → материал → тест»: материал открывается по назначению узла, засчитывается по правилу типа, траектория — done', async () => {
    const courseId = await makeCourse('Курс перед матеріалом')
    const resourceId = await makeResource('Стандарт видачі')
    const quizId = await makeQuiz('Тест після матеріалу')
    const t = await makeTrajectory('Урок-матеріал-тест', [task('lesson', 'course', courseId), task('material', 'resource', resourceId), task('quiz', 'test', quizId, { passScore: 50, attemptsAllowed: 0 })])
    const learner = await makePerson('Учень траєкторії')
    const e = await enroll(t.id, learner)
    const nodeId = t.ids.get('material')!

    await passCourse(learner, courseId, async () => (await stateOf(e, nodeId)).status === 'available')
    const node = await stateOf(e, nodeId)
    expect(node.assignment_id).toBeTruthy()
    const assignmentId = node.assignment_id as string

    // Лента: шаг-материал несёт назначение — по нему экран и откроет материал
    const step = (await tr.myTrajectory(ctx(learner), e))!.steps.find(s => s.nodeId === nodeId)!
    expect(step).toMatchObject({ kind: 'task', contentType: 'resource', contentId: resourceId, status: 'available', assignmentId })

    // Открыть: закреплённая версия, контекст траектории для возврата, «открытия мало»
    const opened = await rp.openResourcePass(ctx(learner), resourceId, { assignmentId, device: 'mobile' })
    if (!opened.ok) throw new Error('не открылось')
    expect(opened.resource).toMatchObject({ id: resourceId, kind: 'article', pinned: true })
    expect(opened.context).toMatchObject({ type: 'trajectory', enrollmentId: e })
    expect(opened.progress).toMatchObject({ status: 'opened', ready: false, requiredSeconds: 20 })
    expect(opened.progress.missing).toEqual(expect.arrayContaining(['read_to_end', 'time']))
    expect((await admin`select count(*)::int as n from task_access_log where user_id = ${learner} and content_id = ${resourceId} and assignment_id = ${assignmentId}`)[0]!.n).toBe(1)

    // Рано: сервер отказывает с причинами, узел не трогается
    const early = await rp.completeResourcePass(ctx(learner), resourceId, { assignmentId })
    expect(early).toMatchObject({ ok: false, code: 'conditions_not_met' })
    if (!early.ok && early.code === 'conditions_not_met') {
      expect(early.reasons).toContain(REASONS.read_to_end)
      expect(early.missing).toEqual(expect.arrayContaining(['read_to_end', 'time']))
    }
    expect((await stateOf(e, nodeId)).status).toBe('available')

    // Тик сразу после открытия: прокрутка засчитана, а времени — не больше реально прошедшего (≈0 с)
    const hasty = await rp.tickResourcePass(ctx(learner), resourceId, { assignmentId, seconds: 20, scrollPct: 100 })
    expect(hasty).toMatchObject({ scrollPct: 100, ready: false })
    expect(hasty!.missing).toEqual(['time'])
    // Дочитал: прошло время чтения (20 с минимум, Г-11.5) — тик засчитывает 20 секунд
    const read = await readResource(learner, resourceId, assignmentId)
    expect(read).toMatchObject({ secondsSpent: 20, scrollPct: 100, ready: true, missing: [] })
    // Тик чаще раза в 10 секунд времени не добавляет (анти-накрутка, `11` §7.4)
    expect(await rp.tickResourcePass(ctx(learner), resourceId, { assignmentId, seconds: 20 })).toMatchObject({ secondsSpent: 20 })

    const done = await rp.completeResourcePass(ctx(learner), resourceId, { assignmentId })
    expect(done).toEqual({ ok: true, completedNow: true })
    // Хук результата — после фиксации; ждём факт, а не время
    await waitFor(async () => (await stateOf(e, nodeId)).status === 'done' && (await stateOf(e, t.ids.get('quiz')!)).status === 'available')
    expect(await stateOf(e, nodeId)).toMatchObject({ status: 'done', passed: true })
    const log = await admin`select status, assignment_id, source_kind from task_status_log where user_id = ${learner} and content_type = 'resource' and content_id = ${resourceId}`
    expect(log).toEqual([expect.objectContaining({ status: 'done', assignment_id: assignmentId, source_kind: 'resource_view' })])

    // Повторное «Завершити» — без второй строки журнала; повторное открытие показывает зачёт
    expect(await rp.completeResourcePass(ctx(learner), resourceId, { assignmentId })).toEqual({ ok: true, completedNow: false })
    expect((await admin`select count(*)::int as n from task_status_log where user_id = ${learner} and content_id = ${resourceId}`)[0]!.n).toBe(1)
    const again = await rp.openResourcePass(ctx(learner), resourceId, { assignmentId })
    expect(again.ok && again.progress).toMatchObject({ status: 'completed', ready: true, missing: [] })

    // Тест — последний шаг: траектория завершена целиком
    const quizAssignment = (await stateOf(e, t.ids.get('quiz')!)).assignment_id as string
    expect(quizAssignment).toBeTruthy()
    const s = await startAttempt(ctx(learner), quizId)
    if (!s.ok) throw new Error(s.code)
    await answerQuiz(learner, s.attemptId, true)
    await waitFor(async () => (await enrOf(e)).status === 'done')
    expect(Number((await enrOf(e)).progress_pct)).toBe(100)
    expect(await tr.myTrajectory(ctx(learner), e)).toMatchObject({ status: 'done', done: 3, total: 3 })
  })

  it('ссылка: засчитывается только после «Я ознайомився»; просмотр (GET) больше не пишет «виконано»', async () => {
    const resourceId = await makeResource('Інструкція постачальника', { kind: 'link', externalUrl: 'https://example.com/instruction', body: [] })
    const t = await makeTrajectory('Посилання', [task('link', 'resource', resourceId)])
    const learner = await makePerson('Читач посилання')
    const e = await enroll(t.id, learner)
    const assignmentId = (await stateOf(e, t.ids.get('link')!)).assignment_id as string

    // Чтение ресурса — не зачёт (docs/11 Г-11.5: «открытия мало»)
    expect(await viewResource(ctx(learner), resourceId, { assignmentId })).not.toBeNull()
    expect((await admin`select count(*)::int as n from task_status_log where user_id = ${learner} and content_id = ${resourceId}`)[0]!.n).toBe(0)

    const opened = await rp.openResourcePass(ctx(learner), resourceId, { assignmentId })
    expect(opened.ok && opened.progress.missing).toEqual(['ack_link'])
    expect(await rp.completeResourcePass(ctx(learner), resourceId, { assignmentId })).toMatchObject({ ok: false, code: 'conditions_not_met', missing: ['ack_link'] })
    const ack = await rp.acknowledgeResourcePass(ctx(learner), resourceId, { assignmentId })
    expect(ack).toMatchObject({ acknowledged: true, ready: true })
    // Скачивание — факт прохождения и строка журнала обращений
    expect(await rp.downloadResourcePass(ctx(learner), resourceId, { assignmentId })).toMatchObject({ downloaded: true })
    expect((await admin`select count(*)::int as n from task_access_log where user_id = ${learner} and content_id = ${resourceId} and action = 'download'`)[0]!.n).toBe(1)
    expect(await rp.completeResourcePass(ctx(learner), resourceId, { assignmentId })).toMatchObject({ ok: true })
    await waitFor(async () => (await enrOf(e)).status === 'done')
  })

  it('доступ: чужое назначение, назначение другого ресурса, тик без открытия, чужой тенант — «не найдено»', async () => {
    const resourceId = await makeResource('Чужий матеріал')
    const otherResourceId = await makeResource('Інший матеріал')
    const t = await makeTrajectory('Доступ', [task('m', 'resource', resourceId)])
    const owner = await makePerson('Власник вузла'), stranger = await makePerson('Сторонній')
    const e = await enroll(t.id, owner)
    const assignmentId = (await stateOf(e, t.ids.get('m')!)).assignment_id as string

    expect(await rp.openResourcePass(ctx(stranger), resourceId, { assignmentId })).toEqual({ ok: false, code: 'not_found' })
    expect(await rp.openResourcePass(ctx(owner), otherResourceId, { assignmentId })).toEqual({ ok: false, code: 'not_found' })
    expect(await rp.tickResourcePass(ctx(owner), resourceId, { assignmentId, seconds: 15 })).toBeNull()
    expect(await rp.acknowledgeResourcePass(ctx(owner), resourceId, { assignmentId })).toBeNull()
    expect(await rp.downloadResourcePass(ctx(owner), resourceId, { assignmentId })).toBeNull()
    expect(await rp.completeResourcePass(ctx(owner), resourceId, { assignmentId })).toEqual({ ok: false, code: 'not_found' })
    const [other] = await admin`insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції') on conflict (slug) do update set name = excluded.name returning id`
    expect(await rp.openResourcePass({ tenantId: other!.id as string, actorId: owner }, resourceId, { assignmentId })).toEqual({ ok: false, code: 'not_found' })
    // Сторонний ничего не прошёл — узел владельца не тронут
    expect((await stateOf(e, t.ids.get('m')!)).status).toBe('available')
  })

  it('коды причин повторяют тексты правила зачёта один к одному', () => {
    expect(reasonCodes([REASONS.read_to_end, 'Ще 12 секунд', REASONS.check_all, 'щось інше'])).toEqual(['read_to_end', 'time', 'check_all'])
    expect(reasonCodes([REASONS.watch_video, REASONS.scroll_doc, REASONS.ack_link])).toEqual(['watch_video', 'scroll_doc', 'ack_link'])
  })

  it('«Відкрився наступний крок» ведёт учащегося в его ленту; наставнику и керівнику чужая лента не нужна', () => {
    const e = crypto.randomUUID()
    const n = (code: string) => ({ refType: 'trajectory_enrollment', refId: e, payload: { title: 'Т' }, code })
    for (const code of ['trajectory_assigned', 'trajectory_next_unlocked', 'trajectory_finished', 'trajectory_access_closed']) expect(refUrl(n(code)), code).toBe(`/learn/trajectories/${e}`)
    expect(refUrl(n('trajectory_mentor_confirm'))).toBeNull()
    expect(refUrl(n('trajectory_request'))).toBeNull()
  })
})

describe('соседние виды «Завдання»: тот же хук результата после фиксации', () => {
  it('навчальна програма з матеріалом: матеріал програми засчитан → програма завершена → вузол траєкторії done', async () => {
    const resourceId = await makeResource('Матеріал програми')
    const p = await programs.createProgram(ctx(), { title: `Програма з матеріалом ${stamp}` })
    programIds.push(p.id)
    const item = await programs.upsertNode(ctx(), p.id, { itemType: 'resource', itemId: resourceId })
    // Ресурс — элемент программы (docs/17 §3.2): раньше публикация отвергала его как «Елемент «?» не опубліковано»
    expect(await programs.publishProgram(ctx(), p.id)).toEqual({ ok: true })
    const t = await makeTrajectory('З програмою', [task('prog', 'training_program', p.id)])
    const learner = await makePerson('Учень програми')
    const e = await enroll(t.id, learner)
    const findPe = () => admin`select id, status from program_enrollments where program_id = ${p.id} and user_id = ${learner}`
    await waitFor(async () => (await findPe()).length > 0)
    const pe = (await findPe())[0]!.id as string

    // Элемент программы ведёт на экран прохождения ресурса, а не в справку базы знаний
    const open = await programs.openNode(ctx(learner), pe, item!.id)
    expect(open).toEqual({ ok: true, to: `/learn/resources/${resourceId}?program=${pe}` })
    const opened = await rp.openResourcePass(ctx(learner), resourceId)
    expect(opened.ok && opened.context).toBeNull()
    // Без назначения версия не закреплена: материал переопубликовали — считаем по тому, что человек видит
    await updateResource(ctx(), resourceId, { body: [{ id: 'b1', type: 'text', html: '<p>Звіряємо номер замовлення, склад і температуру.</p>' }] } as never)
    expect((await publishResource(ctx(), resourceId, { notifyAssigned: false })).ok).toBe(true)
    const reopened = await rp.openResourcePass(ctx(learner), resourceId)
    expect(reopened.ok && reopened.resource).toMatchObject({ version: 2, pinned: false })
    const [pr] = await admin`select v.version from resource_progress p join resource_versions v on v.id = p.resource_version_id where p.user_id = ${learner} and p.resource_id = ${resourceId}`
    expect(pr!.version).toBe(2)
    await readResource(learner, resourceId)
    expect(await rp.completeResourcePass(ctx(learner), resourceId)).toEqual({ ok: true, completedNow: true })

    await waitFor(async () => (await findPe())[0]!.status === 'done' && (await enrOf(e)).status === 'done')
    expect(await stateOf(e, t.ids.get('prog')!)).toMatchObject({ status: 'done', passed: true })
  })

  it('опитування: відповідь на останнє питання → вузол done', async () => {
    const s = await createSurvey(ctx(), { title: `Опитування вузла ${stamp}`, kind: 'survey', mode: 'linear', isAnonymous: false, isConfidential: false, showResults: false, tags: [], questions: [{ id: 'q1', type: 'single', text: 'Зрозуміло?', options: [{ id: 'yes', text: 'Так' }, { id: 'no', text: 'Ні' }] }] })
    surveyIds.push(s.id)
    await updateSurvey(ctx(), s.id, { status: 'active' })
    const t = await makeTrajectory('З опитуванням', [task('poll', 'poll', s.id)])
    const learner = await makePerson('Респондент')
    const e = await enroll(t.id, learner)
    expect((await stateOf(e, t.ids.get('poll')!)).status).toBe('available')
    expect((await startSurvey(ctx(learner), s.id)).ok).toBe(true)
    expect(await answerQuestion(ctx(learner), s.id, 'q1', { optionId: 'yes' })).toMatchObject({ ok: true, done: true })
    await waitFor(async () => (await enrOf(e)).status === 'done')
    expect((await stateOf(e, t.ids.get('poll')!)).status).toBe('done')
  })

  it('комплексний тест: підсумок частин → вузол done з балом', async () => {
    const part = await makeQuiz('Частина комплексу')
    const c = await ct.upsertComplexTest(ctx(), { title: `Комплекс вузла ${stamp}`, parts: [{ quizId: part, weight: 1 }] })
    complexIds.push(c!.id)
    const t = await makeTrajectory('З комплексним', [task('ct', 'complex_test', c!.id, { passScore: 50, attemptsAllowed: 0 })])
    const learner = await makePerson('Комплексний учень')
    const e = await enroll(t.id, learner)
    const started = await ct.startComplex(ctx(learner), c!.id)
    if (!started.ok) throw new Error(started.code)
    const p1 = await ct.startPart(ctx(learner), started.attemptId, part)
    if (!p1.ok) throw new Error(p1.code)
    await answerQuiz(learner, p1.attemptId, true)
    expect(await ct.syncComplex(ctx(learner), started.attemptId)).toMatchObject({ status: 'passed', passed: true })
    await waitFor(async () => (await enrOf(e)).status === 'done')
    const st = await stateOf(e, t.ids.get('ct')!)
    expect(st).toMatchObject({ status: 'done', passed: true })
    expect(Number(st.score)).toBe(100)
  })
})
