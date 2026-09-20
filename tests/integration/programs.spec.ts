import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readThrough } from './_lesson'

const pg = await import('../../server/services/programs')
const { createCourse, addModule, addLesson, publishCourse } = await import('../../server/services/courses')
const { createBank, createQuestion, createQuiz, setQuizQuestions } = await import('../../server/services/questions')
const { startAttempt, saveAnswer, submitAttempt, getAttemptState } = await import('../../server/services/attempts')
const { completeLesson, openLesson, enrollmentTree } = await import('../../server/services/learning')
const { createRule, runRules, listRules, deleteRule } = await import('../../server/services/automation')
const { withTenant } = await import('../../server/utils/withTenant')
const { assignWithParams } = await import('./_assign')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
let tenantId: string, adminId: string, lazarevaId: string, posId: string, bankId: string
const userIds: string[] = [], courseIds: string[] = [], quizIds: string[] = [], programIds: string[] = [], ruleIds: string[] = [], assignmentIds: string[] = []
const ctx = (actorId = adminId) => ({ tenantId, actorId })

async function makePerson(name: string) {
  const phone = `+38063${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, phone, full_name, status, hired_at) values (${tenantId}, ${phone}, ${name}, 'active', current_date) returning id`
  userIds.push(u!.id as string)
  await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary) values (${tenantId}, ${u!.id}, ${lazarevaId}, ${posId}, true)`
  return u!.id as string
}
async function makeCourse(title: string) {
  const c = await createCourse(ctx(), { title: `${title} ${Date.now()}`, language: 'uk', strictOrder: true, isCatalogVisible: false, tags: [] })
  courseIds.push(c.id)
  const m = await addModule(ctx(), c.id, 'Р')
  await addLesson(ctx(), { moduleId: m!.id, title: 'Урок', itemType: 'resource', resource: { body: [{ id: 'b', type: 'text', html: '<p>x</p>' }] }, isRequired: true, videoThresholdPct: 90 })
  await publishCourse(ctx(), c.id, 'v1')
  return c.id
}
/** Пройти курс за человека: запись → открыть урок → завершить. */
async function passCourse(userId: string, courseId: string) {
  const [enr] = await admin`insert into enrollments (tenant_id, user_id, subject_id, version_id, source, required_total, status) select ${tenantId}, ${userId}, id, published_version_id, 'self', 1, 'not_started' from courses where id = ${courseId} returning id`
  const tree = await enrollmentTree(ctx(userId), enr!.id as string)
  const lessonId = tree!.modules[0]!.lessons[0]!.id
  await openLesson(ctx(userId), enr!.id as string, lessonId)
  await readThrough(admin, enr!.id as string, lessonId) // Г-11.5: страница дочитана
  const r = await completeLesson(ctx(userId), enr!.id as string, lessonId)
  expect(r.ok).toBe(true)
  await new Promise(r => setTimeout(r, 150)) // хук программы — вне транзакции
  return enr!.id as string
}
async function makeQuiz(passScore = 50) {
  const q = (await createQuestion(ctx(), { bankId, kind: 'single', stem: [{ id: 'b', type: 'text', html: '<p>?</p>' }], options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], answer: { correctId: 'a' }, isCritical: false, difficulty: 1, points: 1, scoringMethod: 'formula', attachFiles: false, negativeMarking: false, tags: [] })).id
  const quiz = await createQuiz(ctx(), { title: `Тест ${Date.now()}`, kind: 'quiz', tags: [], selectionMode: 'fixed', requiresOfflineConfirm: false })
  quizIds.push(quiz.id)
  assignmentIds.push(await assignWithParams(ctx(), 'test', quiz.id, { passScore, attemptsAllowed: 0, shuffleQuestions: false, shuffleOptions: false }))
  await setQuizQuestions(ctx(), quiz.id, [{ questionId: q, sort: 0 }])
  await admin`update quizzes set status = 'published' where id = ${quiz.id}`
  return quiz.id
}
async function takeQuiz(userId: string, quizId: string, correct: boolean) {
  const s = await startAttempt(ctx(userId), quizId)
  if (!s.ok) throw new Error(s.code)
  const st = await getAttemptState(ctx(userId), s.attemptId)
  await saveAnswer(ctx(userId), s.attemptId, st!.questions[0]!.id, { optionId: correct ? 'a' : 'b' })
  const r = await submitAttempt(ctx(userId), s.attemptId)
  await new Promise(r => setTimeout(r, 150))
  return r
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  posId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Бариста-prog-${Date.now()}`}, 'barista-prog') returning id`)[0]!.id as string
  bankId = (await createBank(ctx(), { name: `Банк-prog ${Date.now()}` })).id
})
afterAll(async () => {
  if (programIds.length) await admin`delete from programs where id in ${admin(programIds)}`
  if (ruleIds.length) await admin`delete from automation_rules where id in ${admin(ruleIds)}`
  if (userIds.length) { await admin`delete from notifications where user_id in ${admin(userIds)}`; await admin`delete from attempts where user_id in ${admin(userIds)}`; await admin`delete from certificates where user_id in ${admin(userIds)}`; await admin`delete from enrollments where user_id in ${admin(userIds)}`; await admin`delete from users where id in ${admin(userIds)}` }
  if (assignmentIds.length) await admin`delete from assignments where id in ${admin(assignmentIds)}`
  if (quizIds.length) { await admin`delete from attempts where quiz_id in ${admin(quizIds)}`; await admin`delete from quizzes where id in ${admin(quizIds)}` }
  await admin`delete from questions where bank_id = ${bankId}`; await admin`delete from question_banks where id = ${bankId}`
  if (courseIds.length) { await admin`delete from enrollments where subject_id in ${admin(courseIds)}`; await admin`delete from resources where id in (select l.item_id from lessons l join modules m on m.id = l.module_id join course_versions v on v.id = m.course_version_id where l.item_type = 'resource' and v.course_id in ${admin(courseIds)})`; await admin`delete from courses where id in ${admin(courseIds)}` }
  await admin`delete from positions where id = ${posId}`
  await admin.end()
})

describe('программы и траектории (docs/17 §13)', () => {
  it('§13.4 + §13.2: публикация без пути до Finish — отказ с узлом; зачёт пройденного курса → прогресс стартует с 1 из 5', async () => {
    const cs = [] as string[]
    for (let i = 1; i <= 5; i++) cs.push(await makeCourse(`Крок ${i}`))
    const p = await pg.createProgram(ctx(), { title: `Програма ${Date.now()}`, mode: 'graph' })
    programIds.push(p.id)
    const nodes: string[] = []
    for (const [i, c] of cs.entries()) nodes.push((await pg.upsertNode(ctx(), p.id, { itemType: 'course', itemId: c, sort: i + 1 }))!.id)
    const full = await pg.getProgram(ctx(), p.id)
    const start = full!.nodes.find(n => n.nodeType === 'start')!.id, finish = full!.nodes.find(n => n.nodeType === 'finish')!.id
    // Только start → n1 → n2: нет пути до Finish, n3–n5 без входящих
    await pg.upsertEdge(ctx(), p.id, { fromNodeId: start, toNodeId: nodes[0]! })
    await pg.upsertEdge(ctx(), p.id, { fromNodeId: nodes[0]!, toNodeId: nodes[1]! })
    const bad = await pg.publishProgram(ctx(), p.id)
    expect(bad.ok).toBe(false)
    if (!bad.ok) { expect(bad.problems.some(x => x.code === 'no_path' && x.nodeId === finish)).toBe(true); expect(bad.problems.filter(x => x.code === 'orphan').length).toBe(3) }
    for (let i = 1; i < 5; i++) await pg.upsertEdge(ctx(), p.id, { fromNodeId: nodes[i]!, toNodeId: nodes[i + 1] ?? finish })
    expect((await pg.publishProgram(ctx(), p.id)).ok).toBe(true)

    // Человек уже прошёл курс 1 с действующим результатом
    const u = await makePerson('Досвідчений')
    await passCourse(u, cs[0]!)
    const enr = await withTenant(tenantId, adminId, tx => pg.enrollProgram(tx, tenantId, p.id, u, { source: 'manual', actorId: adminId }))
    expect(enr.ok).toBe(true)
    if (!enr.ok) return
    const ladder = await pg.programLadder(ctx(u), enr.enrollmentId)
    expect(ladder!.done).toBe(1)
    expect(ladder!.total).toBe(5)
    expect(ladder!.steps.find(s => s.id === nodes[0])!.state).toMatchObject({ status: 'done', via: 'prior' })
    expect(ladder!.steps.find(s => s.id === nodes[1])!.state.status).toBe('available')
    expect(ladder!.steps.find(s => s.id === nodes[2])).toBeDefined() // следующий показан как locked
    expect(ladder!.steps.find(s => s.id === nodes[2])!.state.status).toBe('locked')
    // Идемпотентность зачисления
    expect(await withTenant(tenantId, adminId, tx => pg.enrollProgram(tx, tenantId, p.id, u, { source: 'manual' }))).toMatchObject({ ok: true, created: false })
  })

  it('§13.1: ветвление «сдал → практикум, не сдал → доп. курс»; §13.5 воронка; открытие шага создаёт запись на курс', async () => {
    const quiz = await makeQuiz(50)
    const extra = await makeCourse('Додатковий')
    const next = await makeCourse('Основний далі')
    const p = await pg.createProgram(ctx(), { title: `Траєкторія ${Date.now()}`, mode: 'graph' })
    programIds.push(p.id)
    const nq = (await pg.upsertNode(ctx(), p.id, { itemType: 'quiz', itemId: quiz, titleOverride: 'Тест по касі' }))!.id
    const nx = (await pg.upsertNode(ctx(), p.id, { itemType: 'course', itemId: extra, titleOverride: 'Доп. курс' }))!.id
    const nn = (await pg.upsertNode(ctx(), p.id, { itemType: 'course', itemId: next, titleOverride: 'Далі' }))!.id
    const full = await pg.getProgram(ctx(), p.id)
    const start = full!.nodes.find(n => n.nodeType === 'start')!.id, finish = full!.nodes.find(n => n.nodeType === 'finish')!.id
    await pg.upsertEdge(ctx(), p.id, { fromNodeId: start, toNodeId: nq })
    await pg.upsertEdge(ctx(), p.id, { fromNodeId: nq, toNodeId: nn, condition: { type: 'passed' }, sort: 0 })
    await pg.upsertEdge(ctx(), p.id, { fromNodeId: nq, toNodeId: nx, condition: { type: 'failed' }, sort: 1 })
    await pg.upsertEdge(ctx(), p.id, { fromNodeId: nx, toNodeId: nn })
    await pg.upsertEdge(ctx(), p.id, { fromNodeId: nn, toNodeId: finish })
    expect((await pg.publishProgram(ctx(), p.id)).ok).toBe(true)

    const loser = await makePerson('Провалив')
    const winner = await makePerson('Здав')
    const eL = await withTenant(tenantId, adminId, tx => pg.enrollProgram(tx, tenantId, p.id, loser, { source: 'manual' }))
    const eW = await withTenant(tenantId, adminId, tx => pg.enrollProgram(tx, tenantId, p.id, winner, { source: 'manual' }))
    if (!eL.ok || !eW.ok) throw new Error('enroll')
    expect((await pg.openNode(ctx(loser), eL.enrollmentId, nq))).toMatchObject({ ok: true, to: `/learn/quiz/${quiz}` })
    expect(await pg.openNode(ctx(loser), eL.enrollmentId, nn)).toMatchObject({ ok: false, code: 'locked' })
    await takeQuiz(loser, quiz, false)
    await takeQuiz(winner, quiz, true)
    const lL = await pg.programLadder(ctx(loser), eL.enrollmentId)
    expect(lL!.steps.find(s => s.id === nq)!.state.status).toBe('failed')
    expect(lL!.steps.find(s => s.id === nx)!.state.status).toBe('available') // доп. курс открыт
    expect(lL!.steps.find(s => s.id === nn)?.state.status ?? 'locked').toBe('locked') // основной остался закрыт
    const lW = await pg.programLadder(ctx(winner), eW.enrollmentId)
    expect(lW!.steps.find(s => s.id === nn)!.state.status).toBe('available')
    expect(lW!.steps.find(s => s.id === nx)?.state.status ?? 'locked').toBe('locked')

    // Открытие шага-курса создаёт запись
    const open = await pg.openNode(ctx(winner), eW.enrollmentId, nn)
    expect(open.ok && open.to).toMatch(/^\/learn\/[0-9a-f-]{36}$/)
    const [en] = await admin`select id from enrollments where user_id = ${winner} and subject_id = ${next}`
    expect(en).toBeTruthy()
    // Воронка: оба дошли до теста, один провалил
    const rep = await pg.programReport(ctx(), p.id)
    expect(rep!.funnel.find(f => f.nodeId === nq)).toMatchObject({ reached: 2, done: 1, failed: 1 })
    expect(rep!.people.find(x => x.userId === winner)!.currentStep).toBeGreaterThan(0)
  })

  it('§13.3: no_assign_after_finish — после завершения правило не назначает повторно; linear-программа завершается по всем узлам', async () => {
    const c1 = await makeCourse('Лінійний 1')
    const p = await pg.createProgram(ctx(), { title: `Лінійна ${Date.now()}`, mode: 'linear' })
    programIds.push(p.id)
    await pg.upsertNode(ctx(), p.id, { itemType: 'course', itemId: c1 })
    const rule = await createRule(ctx(), { name: `Правило програми ${Date.now()}`, trigger: 'user.attributes_changed', conditions: {}, dimensions: [{ dimension: 'position', mode: 'include', valueIds: [posId] }], actions: [], isActive: true, runLimit: { oncePerUser: false }, assignDelayDays: 0 })
    ruleIds.push(rule.id)
    await pg.updateProgram(ctx(), p.id, { assignmentMode: ['automation'], automationRuleId: rule.id, noAssignAfterFinish: true })
    expect((await pg.publishProgram(ctx(), p.id)).ok).toBe(true)
    expect((await listRules(ctx())).find(r => r.id === rule.id)!.usedBy.map(u => u.id)).toContain(p.id)
    expect(await deleteRule(ctx(), rule.id)).toMatchObject({ ok: false, code: 'in_use' })

    const u = await makePerson('Автоматичний')
    const r1 = await runRules(tenantId, 'user.placement_changed', u)
    expect(r1.find(x => x.ruleId === rule.id)!.actions).toEqual([expect.objectContaining({ type: 'assign_program', programId: p.id, enrollmentId: expect.any(String) })])
    // Прохождение единственного курса завершает программу
    await passCourse(u, c1)
    const [pe] = await admin`select status, progress_pct from program_enrollments where program_id = ${p.id} and user_id = ${u}`
    expect(pe).toMatchObject({ status: 'done' })
    expect(Number(pe!.progress_pct)).toBe(100)
    const [n] = await admin`select count(*)::int as c from notifications where user_id = ${u} and code = 'program_completed'`
    expect(n!.c).toBe(1)
    // Снова под правило — повторного назначения нет
    const r2 = await runRules(tenantId, 'user.placement_changed', u)
    expect(r2.find(x => x.ruleId === rule.id)!.actions).toEqual([expect.objectContaining({ type: 'assign_program', skipped: 'finished_no_reassign' })])
    expect((await admin`select count(*)::int as c from program_enrollments where program_id = ${p.id} and user_id = ${u}`)[0]!.c).toBe(1)
  })
})
