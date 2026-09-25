import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readThrough } from './_lesson'

/**
 * Шаг траектории, который выполняет не учащийся, а другой человек о нём (решение владельца продукта
 * 25.09.2026; docs/17 §5.2, docs/28 §28.21). Узел «Завдання» с чек-листом ждёт, пока руководитель
 * заполнит чек-лист о человеке; узел с оцениванием — пока оценивание завершится. Учащийся видит
 * статус без кнопки, исполнитель получает «людина чекає» со ссылкой на заполнение, а засчитывает шаг
 * тот же хук результата, что у остальных видов (`onTaskResult`).
 *
 * Хуки результата запускаются «выстрелил и забыл» после фиксации — результат ждём опросом условия,
 * а не паузой (#123).
 */

const tr = await import('../../server/services/trajectories')
const cl = await import('../../server/services/checklists')
const as = await import('../../server/services/assessment')
const { createCourse, addModule, addLesson, publishCourse } = await import('../../server/services/courses')
const { createBank, createQuestion, createQuiz, setQuizQuestions } = await import('../../server/services/questions')
const { startAttempt, saveAnswer, submitAttempt, getAttemptState } = await import('../../server/services/attempts')
const { completeLesson, openLesson, enrollmentTree } = await import('../../server/services/learning')
const { refUrl, tenantAdminIds } = await import('../../server/services/notifications')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const stamp = Date.now()
let tenantId: string, adminId: string, orgUnitId: string, posId: string, bankId: string, scaleId: string
/** Своя точка с руководителем (роль «Керівник точки» на ней): `resolveManager()` шаг 2 → он. */
let locationId: string, managerId: string, managerName: string
const userIds: string[] = [], locationIds: string[] = [], courseIds: string[] = [], quizIds: string[] = [], trajIds: string[] = []
const checklistIds: string[] = [], formIds: string[] = [], groupIds: string[] = [], cycleIds: string[] = []
const ctx = (actorId = adminId) => ({ tenantId, actorId })

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await cond()) return
    if (Date.now() >= deadline) throw new Error(`тайм-аут ожидания (${timeoutMs}ms) — хук результата не обновил состояние траектории`)
    await new Promise(r => setTimeout(r, 20))
  }
}

async function makeUser(name: string, at: string) {
  const phone = `+38068${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, phone, full_name, status, hired_at) values (${tenantId}, ${phone}, ${name}, 'active', current_date) returning id`
  userIds.push(u!.id as string)
  await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary) values (${tenantId}, ${u!.id}, ${at}, ${posId}, true)`
  return u!.id as string
}

async function makeLocation(name: string, manager: string | null) {
  const [l] = await admin`insert into locations (tenant_id, org_unit_id, name, manager_id) values (${tenantId}, ${orgUnitId}, ${`${name} ${stamp}`}, ${manager}) returning id`
  locationIds.push(l!.id as string)
  return l!.id as string
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

async function passQuiz(userId: string, quizId: string) {
  const s = await startAttempt(ctx(userId), quizId)
  if (!s.ok) throw new Error(s.code)
  const st = await getAttemptState(ctx(userId), s.attemptId)
  await saveAnswer(ctx(userId), s.attemptId, st!.questions[0]!.id, { optionId: 'a' })
  await submitAttempt(ctx(userId), s.attemptId)
}

/** Чек-лист о человеке: два пункта по шкале 1–5, прохідний 80 %. */
async function makeChecklist(title: string) {
  const r = await cl.upsertChecklist(ctx(), {
    title: `${title} ${stamp}`, kind: 'observation', scaleId, items: [{ id: 'greet', text: 'Вітається з гостем', weight: 1 }, { id: 'order', text: 'Звіряє замовлення', weight: 1 }],
    scoring: 'percent', passScore: 80, criticalFailRule: 'none', whoCanRun: { roles: ['manager'] }, subjectKind: 'user', allowSkip: false, allowItemComment: true, itemCommentRequired: false, tags: [],
  })
  if (!r.ok) throw new Error(r.code)
  checklistIds.push(r.checklist.id)
  return r.checklist.id
}

/** Прогон чек-листа наблюдателем `observer` о человеке `subject`: оценки пунктов — `values`. */
async function runChecklist(observer: string, checklistId: string, subject: string, values: [number, number]) {
  const run = await cl.startRun(ctx(observer), checklistId, { subjectUserId: subject })
  if (!run) throw new Error('прогон не начался')
  const answers = [{ itemId: 'greet', value: values[0] }, { itemId: 'order', value: values[1] }]
  const plan = [{ id: 'p1', text: 'Повторити стандарт зустрічі', responsibleId: observer, dueAt: '2026-12-31', status: 'open' as const }]
  const r = await cl.finishRun(ctx(observer), run.id, { answers, actionPlan: plan })
  if (!r.ok) throw new Error(r.code)
  return r.score
}

/** Анкета оценки: одна группа, два критерия (веса 1 и 2), норма 3 по шкале 1–5. */
async function makeForm(title: string) {
  const g = await as.upsertGroup(ctx(), { name: `Сервіс-rv ${stamp}-${Math.random()}`, weight: 1 })
  groupIds.push(g!.id)
  const c1 = await as.upsertCriterion(ctx(), { groupId: g!.id, text: 'Вітається з гостем' })
  const c2 = await as.upsertCriterion(ctx(), { groupId: g!.id, text: 'Пропонує доповнення', weight: 2 })
  const r = await as.saveForm(ctx(), { title: `${title} ${stamp}`, kind: 'by_criteria', scaleId, allowCommentGroups: false, commentGroupsRequired: false, commentWhenAboveNorm: false, commentWhenBelowNorm: true, commentWhenEqual: false, zeroMeansNoGrade: false, tags: [], isActive: true, items: [{ criterionId: c1!.id, norm: 3 }, { criterionId: c2!.id, norm: 3 }] })
  if (!r.ok) throw new Error(r.code)
  formIds.push(r.form.id)
  return { formId: r.form.id, c1: c1!.id, c2: c2!.id }
}

type N = Parameters<typeof tr.putGraph>[2]['nodes'][number]
type TaskType = 'course' | 'test' | 'check_list' | 'assessment'
const task = (tmpId: string, contentType: TaskType, contentId: string, params: Record<string, unknown> = {}): N => ({ tmpId, kind: 'task', contentType, contentId, params, x: 0, y: 0 } as N)

/** Линейная траектория Start → узлы по порядку → Finish, опубликованная. */
async function makeTrajectory(title: string, nodes: N[]) {
  const t = await tr.createTrajectory(ctx(), { title: `${title} ${stamp}`, tags: [] })
  trajIds.push(t.id)
  const full = (await tr.getTrajectory(ctx(), t.id))!
  const start = full.nodes.find(n => n.kind === 'start')!, finish = full.nodes.find(n => n.kind === 'finish')!
  const chain = [start.id, ...nodes.map(n => n.tmpId!), finish.id]
  const g = await tr.putGraph(ctx(), t.id, {
    nodes: [{ id: start.id, kind: 'start', x: 0, y: 0 }, { id: finish.id, kind: 'finish', x: 0, y: 0 }, ...nodes],
    edges: chain.slice(0, -1).map((id, i) => ({ fromNodeId: id, toNodeId: chain[i + 1]!, sort: 0 })),
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
const stateOf = async (enrollmentId: string, nodeId: string) => (await admin`select id, status, passed, score, assignment_id from trajectory_node_states where enrollment_id = ${enrollmentId} and node_id = ${nodeId}`)[0]!
const enrOf = async (enrollmentId: string) => (await admin`select status, progress_pct from trajectory_enrollments where id = ${enrollmentId}`)[0]!
const stepOf = async (userId: string, enrollmentId: string, nodeId: string) => (await tr.myTrajectory(ctx(userId), enrollmentId))!.steps.find(s => s.nodeId === nodeId)!
const waiting = (userId: string, code: string, enrollmentId: string) =>
  admin`select code, payload, ref_type, ref_id from notifications where user_id = ${userId} and code = ${code} and ref_id = ${enrollmentId} order by created_at`
/** Журнал задания человека как проверяемого: исполнитель (`actor_id`) — тот, кто заполнил о нём (D-020). */
const journal = (userId: string, contentId: string, actorId: string) =>
  admin`select status, assignment_id, source_kind, actor_id from task_status_log where user_id = ${userId} and content_id = ${contentId} and actor_id = ${actorId} order by created_at`

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  orgUnitId = (await admin`select org_unit_id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.org_unit_id as string
  posId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Бариста-rv-${stamp}`}, ${`barista-rv-${stamp}`}) returning id`)[0]!.id as string
  scaleId = (await admin`select id from scales where tenant_id = ${tenantId} and name = '1–5'`)[0]!.id as string
  bankId = (await createBank(ctx(), { name: `Банк-rv ${stamp}` })).id
  // Керівник точки — роль `manager` на своей точке: у неё есть и `checklist.run`, и `assessment.run` (docs/20 §2)
  locationId = await makeLocation('Точка-rv', null)
  managerName = `Керівниця Перевірка ${stamp}`
  managerId = await makeUser(managerName, locationId)
  await admin`update locations set manager_id = ${managerId} where id = ${locationId}`
  const [role] = await admin`select id from roles where tenant_id = ${tenantId} and code = 'manager'`
  await admin`insert into user_roles (tenant_id, user_id, role_id, scope_type, scope_id) values (${tenantId}, ${managerId}, ${role!.id}, 'location', ${locationId})`
})

afterAll(async () => {
  if (trajIds.length) {
    await admin`delete from notifications where ref_type = 'trajectory_enrollment' and ref_id in (select id from trajectory_enrollments where trajectory_id in ${admin(trajIds)})`
    await admin`delete from assignments where audience->>'trajectoryId' in ${admin(trajIds)}`
    await admin`delete from trajectories where id in ${admin(trajIds)}`
  }
  if (cycleIds.length) await admin`delete from assessment_cycles where id in ${admin(cycleIds)}`
  if (formIds.length) await admin`delete from assessment_forms where id in ${admin(formIds)}`
  if (groupIds.length) await admin`delete from criteria_groups where id in ${admin(groupIds)}`
  if (checklistIds.length) { await admin`delete from checklist_runs where checklist_id in ${admin(checklistIds)}`; await admin`delete from checklists where id in ${admin(checklistIds)}` }
  if (quizIds.length) { await admin`delete from attempts where quiz_id in ${admin(quizIds)}`; await admin`delete from quizzes where id in ${admin(quizIds)}` }
  await admin`delete from questions where bank_id = ${bankId}`
  await admin`delete from question_banks where id = ${bankId}`
  if (userIds.length) {
    for (const table of ['task_status_log', 'task_access_log', 'notifications', 'certificates', 'attempts', 'enrollments']) {
      await admin`delete from ${admin(table)} where user_id in ${admin(userIds)}`
    }
  }
  if (courseIds.length) {
    await admin`delete from enrollments where subject_id in ${admin(courseIds)}`
    await admin`delete from resources where id in (select l.item_id from lessons l join modules m on m.id = l.module_id join course_versions v on v.id = m.course_version_id where l.item_type = 'resource' and v.course_id in ${admin(courseIds)})`
    await admin`delete from courses where id in ${admin(courseIds)}`
  }
  if (locationIds.length) await admin`update locations set manager_id = null where id in ${admin(locationIds)}`
  if (userIds.length) await admin`delete from users where id in ${admin(userIds)}`
  if (locationIds.length) await admin`delete from locations where id in ${admin(locationIds)}`
  await admin`delete from positions where id = ${posId}`
  await admin.end()
})

describe('шаг «чек-лист»: заполняет руководитель, засчитывает хук результата (решение 25.09.2026)', () => {
  it('«курс → чек-лист → тест»: шаг ждёт руководителя, провал не засчитывает, пройденный чек-лист открывает тест', async () => {
    const courseId = await makeCourse('Курс перед перевіркою')
    const checklistId = await makeChecklist('Зустріч гостя')
    const quizId = await makeQuiz('Тест після перевірки')
    const t = await makeTrajectory('Курс-чек-лист-тест', [task('course', 'course', courseId), task('check', 'check_list', checklistId), task('quiz', 'test', quizId, { passScore: 50, attemptsAllowed: 0 })])
    const learner = await makeUser('Стажерка Перевірка', locationId)
    const e = await enroll(t.id, learner)
    const nodeId = t.ids.get('check')!

    // Чек-лист до курса не открыт — руководителю пока писать не о чем
    expect((await stateOf(e, nodeId)).status).toBe('locked')
    expect(await waiting(managerId, 'trajectory_checklist_waiting', e)).toHaveLength(0)
    await passCourse(learner, courseId, async () => (await stateOf(e, nodeId)).status === 'available')
    const node = await stateOf(e, nodeId)
    expect(node.assignment_id).toBeTruthy()

    // Учащийся: шаг открыт, но ведёт его руководитель — лента говорит, кого ждём (кнопки у шага нет: экран, e2e)
    expect(await stepOf(learner, e, nodeId)).toMatchObject({ contentType: 'check_list', status: 'available', review: { kind: 'checklist', person: managerName, until: null } })

    // Руководитель: «людина чекає» со ссылкой на форму прогона о ней; учащемуся такое не уходит
    const url = `/learn/checklists/run/trj-${node.id}?checklistId=${checklistId}&subjectUserId=${learner}`
    const sent = await waiting(managerId, 'trajectory_checklist_waiting', e)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.payload).toMatchObject({ name: 'Стажерка Перевірка', checklist: `Зустріч гостя ${stamp}`, url })
    expect(refUrl({ refType: sent[0]!.ref_type as string, refId: sent[0]!.ref_id as string, payload: sent[0]!.payload, code: 'trajectory_checklist_waiting' })).toBe(url)
    expect(await waiting(learner, 'trajectory_checklist_waiting', e)).toHaveLength(0)

    // Не засчитывают: чек-лист о другом человеке и чек-лист, заполненный самим учащимся о себе
    const stranger = await makeUser('Інший бариста', locationId)
    await runChecklist(managerId, checklistId, stranger, [5, 5])
    await runChecklist(learner, checklistId, learner, [5, 5])

    // Провал (50 % при прохідному 80): тот же хук, что у теста, — шаг остаётся открытым, ждёт повторной проверки
    const failed = await runChecklist(managerId, checklistId, learner, [5, 1])
    expect(failed).toMatchObject({ passed: false, percent: 50 })
    await waitFor(async () => (await stateOf(e, nodeId)).passed === false)
    expect(await stateOf(e, nodeId)).toMatchObject({ status: 'in_progress', passed: false, score: '50.00' })
    expect((await stateOf(e, t.ids.get('quiz')!)).status).toBe('locked')
    expect((await stepOf(learner, e, nodeId)).review).toMatchObject({ kind: 'checklist', person: managerName })
    // Журнал задания учащегося — «не пройдено», наблюдатель записан исполнителем (D-020)
    expect(await journal(learner, checklistId, managerId)).toEqual([expect.objectContaining({ status: 'failed', assignment_id: node.assignment_id, source_kind: 'checklist_run' })])

    // Повторная проверка пройдена → шаг засчитан, открылся тест
    await runChecklist(managerId, checklistId, learner, [5, 4])
    await waitFor(async () => (await stateOf(e, t.ids.get('quiz')!)).status === 'available')
    expect(await stateOf(e, nodeId)).toMatchObject({ status: 'done', passed: true, score: '87.50' })
    expect((await stepOf(learner, e, nodeId)).review).toBeNull()
    expect((await journal(learner, checklistId, managerId)).map(r => r.status)).toEqual(['failed', 'done'])
    // Кто и о ком заполнил — в журнале действий (DoD: действие меняет чужие данные)
    expect(await admin`select 1 from audit_log where action = 'checklist.run.finish' and actor_id = ${managerId} and after->>'subjectUserId' = ${learner}`).toHaveLength(2)

    // Тест — последний шаг: траектория пройдена целиком
    await passQuiz(learner, quizId)
    await waitFor(async () => (await enrOf(e)).status === 'done')
    expect(await tr.myTrajectory(ctx(learner), e)).toMatchObject({ status: 'done', done: 3, total: 3 })
  })

  it('руководителя нет или у него нет права заполнять чек-лист — «людина чекає» уходит администраторам', async () => {
    const checklistId = await makeChecklist('Без керівника')
    const t = await makeTrajectory('Чек-лист без керівника', [task('check', 'check_list', checklistId)])
    // Точка, где «руководитель» — рядовой сотрудник без `checklist.run`: ссылка привела бы его на запрет
    const plain = await makeUser('Формальний керівник', locationId)
    const bare = await makeLocation('Точка-rv-без-права', plain)
    const learner = await makeUser('Стажер без керівника', bare)
    const e = await enroll(t.id, learner)
    expect((await stateOf(e, t.ids.get('check')!)).status).toBe('available')

    expect(await waiting(plain, 'trajectory_checklist_waiting', e)).toHaveLength(0)
    const admins = await withTenant(tenantId, null, tx => tenantAdminIds(tx, tenantId))
    expect(admins.length).toBeGreaterThan(0)
    for (const a of admins) expect(await waiting(a, 'trajectory_checklist_waiting', e), a).toHaveLength(1)
    expect((await stepOf(learner, e, t.ids.get('check')!)).review).toEqual({ kind: 'checklist', person: null, until: null })

    // Прогон о человеке — только о своём человеке тенанта: несуществующий и чужой — «не найдено» (п. 15)
    expect(await cl.startRun(ctx(managerId), checklistId, { subjectUserId: crypto.randomUUID() })).toBeNull()
    const [other] = await admin`insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції') on conflict (slug) do update set name = excluded.name returning id`
    const [foreign] = await admin`insert into users (tenant_id, phone, full_name, status) values (${other!.id}, ${`+38099${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`}, 'Чужий', 'active') returning id`
    try {
      expect(await cl.startRun(ctx(managerId), checklistId, { subjectUserId: foreign!.id as string })).toBeNull()
    }
    finally { await admin`delete from users where id = ${foreign!.id}` }
  })
})

describe('шаг «оценивание»: выполняют оценщики цикла, засчитывает завершение оценивания (решение 25.09.2026)', () => {
  it('«курс → оцінювання → тест»: цикла нет — руководителю «запустіть», стартовал — оценщикам ссылка на анкету, завершён — шаг засчитан', async () => {
    const courseId = await makeCourse('Курс перед оцінюванням')
    const { formId, c1, c2 } = await makeForm('Оцінка стажера')
    const quizId = await makeQuiz('Тест після оцінювання')
    const t = await makeTrajectory('Курс-оцінювання-тест', [task('course', 'course', courseId), task('rate', 'assessment', formId), task('quiz', 'test', quizId, { passScore: 50, attemptsAllowed: 0 })])
    const learner = await makeUser('Стажер Оцінювання', locationId)
    const e = await enroll(t.id, learner)
    const nodeId = t.ids.get('rate')!
    await passCourse(learner, courseId, async () => (await stateOf(e, nodeId)).status === 'available')
    const node = await stateOf(e, nodeId)

    // Цикла ещё нет: тому, кто запускает оценку (руководитель с `assessment.run`), — экран запуска с анкетой и человеком
    const launch = await waiting(managerId, 'trajectory_assessment_waiting', e)
    expect(launch).toHaveLength(1)
    expect(launch[0]!.payload).toMatchObject({ name: 'Стажер Оцінювання', form: `Оцінка стажера ${stamp}`, launch: true, url: `/admin/assessment/cycles?formId=${formId}&subjectId=${learner}` })
    expect(await stepOf(learner, e, nodeId)).toMatchObject({ status: 'available', review: { kind: 'assessment', person: managerName, until: null } })

    // Руководитель запускает цикл: оценщики — сам человек и руководитель. Руководителю — ссылка на его анкету о человеке,
    // самому человеку «людина чекає» не уходит (самооценку он видит в «Мої оцінки», как всегда)
    const endsAt = new Date(Date.now() + 7 * 86_400_000)
    const cycle = await as.createCycle(ctx(managerId), {
      title: `Оцінка стажера ${stamp}`, formId, periodFrom: '2026-09-01', periodTo: '2026-09-30', startsAt: new Date().toISOString(), endsAt: endsAt.toISOString(),
      subjects: { rules: [{ type: 'user', ids: [learner] }], match: 'any' }, raterKinds: ['self', 'manager'], minRatersToShow: 3,
    })
    cycleIds.push(cycle.id)
    expect(await as.startCycle(ctx(managerId), cycle.id)).toMatchObject({ ok: true, subjects: 1, tasks: 2 })
    const [mgrTask] = await admin`select id from assessment_tasks where cycle_id = ${cycle.id} and rater_user_id = ${managerId} and rater_kind = 'manager'`
    const fill = (await waiting(managerId, 'trajectory_assessment_waiting', e)).filter(n => (n.payload as { fill?: boolean }).fill)
    expect(fill).toHaveLength(1)
    expect(fill[0]!.payload).toMatchObject({ fill: true, url: `/learn/assessment/tasks/${mgrTask!.id}` })
    expect(await waiting(learner, 'trajectory_assessment_waiting', e)).toHaveLength(0)
    const running = await stepOf(learner, e, nodeId)
    expect(running.review).toMatchObject({ kind: 'assessment', person: null })
    expect(new Date(running.review!.until!).getTime()).toBe(new Date(cycle.endsAt).getTime())

    // Анкета руководителя сдана, но оценивание ещё не завершено — шаг ждёт
    await as.saveAnswers(ctx(managerId), mgrTask!.id as string, [{ criterionId: c1, value: 4 }, { criterionId: c2, value: 4 }])
    expect(await as.submitTask(ctx(managerId), mgrTask!.id as string)).toEqual({ ok: true })
    expect((await stateOf(e, nodeId)).status).toBe('available')

    // Цикл завершён → тот же хук результата: шаг засчитан, балл — итог в процентах шкалы (4 из 1–5 → 75 %)
    expect(await as.finishCycle(ctx(managerId), cycle.id)).toMatchObject({ ok: true, subjects: 1 })
    await waitFor(async () => (await stateOf(e, t.ids.get('quiz')!)).status === 'available')
    expect(await stateOf(e, nodeId)).toMatchObject({ status: 'done', passed: true, score: '75.00' })
    expect(await journal(learner, formId, managerId)).toEqual([expect.objectContaining({ status: 'done', assignment_id: node.assignment_id, source_kind: 'assessment_cycle' })])

    await passQuiz(learner, quizId)
    await waitFor(async () => (await enrOf(e)).status === 'done')
    expect(await tr.myTrajectory(ctx(learner), e)).toMatchObject({ status: 'done', done: 3, total: 3 })
  })

  it('цикл уже идёт, когда человек дошёл до шага: оценщикам — ссылка на анкету, запускать нечего', async () => {
    const { formId } = await makeForm('Оцінка в процесі')
    const learner = await makeUser('Стажер у циклі', locationId)
    const cycle = await as.createCycle(ctx(managerId), {
      title: `Оцінка в процесі ${stamp}`, formId, periodFrom: '2026-09-01', periodTo: '2026-09-30', startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      subjects: { rules: [{ type: 'user', ids: [learner] }], match: 'any' }, raterKinds: ['manager'], minRatersToShow: 3,
    })
    cycleIds.push(cycle.id)
    expect((await as.startCycle(ctx(managerId), cycle.id)).ok).toBe(true)
    const t = await makeTrajectory('Оцінювання в процесі', [task('rate', 'assessment', formId)])
    const e = await enroll(t.id, learner)
    const sent = await waiting(managerId, 'trajectory_assessment_waiting', e)
    expect(sent.map(n => (n.payload as { fill?: boolean, launch?: boolean }))).toEqual([expect.objectContaining({ fill: true })])
    expect((await stepOf(learner, e, t.ids.get('rate')!)).review).toMatchObject({ kind: 'assessment', person: null })
    // Отменённый цикл оценивание не завершает — шаг по-прежнему ждёт
    expect(await as.cancelCycle(ctx(managerId), cycle.id)).toBe(true)
    expect((await stateOf(e, t.ids.get('rate')!)).status).toBe('available')
    expect((await stepOf(learner, e, t.ids.get('rate')!)).review).toMatchObject({ kind: 'assessment', person: managerName, until: null })
  })
})

describe('балл шага — процент', () => {
  it('итог оценивания — доля диапазона шкалы; чек-лист — доля от суммы весов, ноль при критическом провале', () => {
    expect(as.scalePercent(4, { min: 1, max: 5 })).toBe(75)
    expect(as.scalePercent(4.67, { min: 1, max: 5 })).toBe(91.75)
    expect(as.scalePercent(12, { min: 0, max: 10 })).toBe(100)
    expect(as.scalePercent(null, { min: 1, max: 5 })).toBeNull()
    expect(as.scalePercent(3, { min: 3, max: 3 })).toBeNull()
    const score = { score: 0, points: 1.5, maxPoints: 2, percent: 75, passed: false, criticalFailed: ['x'], failedItems: ['x'], answered: 2, total: 2, missingPhoto: [], missingComment: [] }
    expect(cl.runPercent(score, 'any_critical_fails_all')).toBe(0)
    expect(cl.runPercent(score, 'none')).toBe(75)
    expect(cl.runPercent({ ...score, criticalFailed: [] }, 'any_critical_fails_all')).toBe(75)
  })
})
