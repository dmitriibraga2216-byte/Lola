import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Регрессия security-sweep-4 (docs/v2/46-progress.md, «Аудит безопасности»): ответ в вопросе, чужие планы
 * и прогоны внутри тенанта, самоодобрение заявки. Каждый тест — находка, воспроизведённая до исправления.
 */

const { createBank, createQuestion, createQuiz, setQuizQuestions } = await import('../../server/services/questions')
const { startAttempt } = await import('../../server/services/attempts')
const { assignWithParams } = await import('./_assign')
const dev = await import('../../server/services/development')
const { updateAction, addAction } = await import('../../server/services/checklists')
const traj = await import('../../server/services/trajectories')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const stamp = Date.now()
let tenantId: string, adminId: string, mentorId: string, learnerId: string, lazarevaId: string, segedskaId: string
const quizIds: string[] = []
const assignmentIds: string[] = []
const planIds: string[] = []
const runIds: string[] = []
let checklistId: string
let trajectoryId: string | undefined

const as = (actorId: string) => ({ tenantId, actorId })
const stem = (text: string) => [{ id: 'b1', type: 'text' as const, html: `<p>${text}</p>` }]

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  const pick = async (phone: string) => (await admin`select id from users where tenant_id = ${tenantId} and phone = ${phone}`)[0]!.id as string
  adminId = await pick('+380661864742')
  mentorId = await pick('+380670000002')
  learnerId = await pick('+380670000003')
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  segedskaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Сегедська'`)[0]!.id as string
})

afterAll(async () => {
  if (quizIds.length) {
    await admin`delete from attempts where quiz_id in ${admin(quizIds)}`
    await admin`delete from quizzes where id in ${admin(quizIds)}`
  }
  if (assignmentIds.length) await admin`delete from assignments where id in ${admin(assignmentIds)}`
  await admin`delete from question_banks where tenant_id = ${tenantId} and name = ${`Sweep-банк ${stamp}`}`
  if (planIds.length) await admin`delete from development_plans where id in ${admin(planIds)}`
  if (runIds.length) await admin`delete from checklist_runs where id in ${admin(runIds)}`
  if (checklistId) await admin`delete from checklists where id = ${checklistId}`
  if (trajectoryId) {
    await admin`delete from trajectory_enrollments where trajectory_id = ${trajectoryId}`
    await admin`delete from trajectories where id = ${trajectoryId}`
  }
  await admin.end()
})

describe('снимок попытки не выдаёт ответ порядком вариантов', () => {
  it('«Порядок» перемешан и при shuffleOptions: false', async () => {
    const bank = await createBank(as(adminId), { name: `Sweep-банк ${stamp}` })
    const ids = ['s1', 's2', 's3', 's4', 's5', 's6']
    const q = await createQuestion(as(adminId), {
      bankId: bank.id, kind: 'ordering', stem: stem('Порядок приготування'), options: ids.map(id => ({ id, text: `Крок ${id}` })),
      answer: { order: ids }, isCritical: false, difficulty: 2, points: 1, scoringMethod: 'formula', attachFiles: false, negativeMarking: false, tags: [],
    } as never)
    const quiz = await createQuiz(as(adminId), { title: `Порядок ${stamp}`, kind: 'quiz', tags: [], selectionMode: 'fixed', requiresOfflineConfirm: false })
    quizIds.push(quiz.id)
    assignmentIds.push(await assignWithParams(as(adminId), 'test', quiz.id, { passScore: 60, attemptsAllowed: 5, shuffleQuestions: false, shuffleOptions: false }, [learnerId]))
    await setQuizQuestions(as(adminId), quiz.id, [{ questionId: q.id, sort: 0 }])
    const r = await startAttempt(as(learnerId), quiz.id)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const [row] = await admin`select snapshot from attempts where id = ${r.attemptId}`
    const snap = row!.snapshot as { options: { id: string }[] }[]
    expect(snap[0]!.options.map(o => o.id)).not.toEqual(ids)
  })
})

describe('план развития: чужой — только в своей области, свой — не погоджують', () => {
  it('сотрудник не двигает чужой план; наставник не погоджує власний', async () => {
    const own = await dev.createPlan(as(mentorId), { userId: mentorId, periodFrom: '2026-09-01', periodTo: '2026-12-31' })
    planIds.push(own.id)
    const other = await dev.createPlan(as(adminId), { userId: adminId, periodFrom: '2026-09-01', periodTo: '2026-12-31' })
    planIds.push(other.id)
    // Чужой план, не участник и без командного права — его не видно
    expect(await dev.transitionPlan(as(learnerId), other.id, 'submit')).toMatchObject({ ok: false, code: 'not_found' })
    expect((await dev.transitionPlan(as(mentorId), own.id, 'submit')).ok).toBe(true)
    expect(await dev.transitionPlan(as(mentorId), own.id, 'approve', undefined, { scope: [lazarevaId, segedskaId] })).toMatchObject({ ok: false, code: 'forbidden' })
    expect((await dev.transitionPlan(as(adminId), own.id, 'approve', undefined, { scope: null })).ok).toBe(true)
  })
})

describe('план действий прогона чек-листа — не по одному id', () => {
  it('посторонний с checklist.run не правит и не дополняет чужой прогон', async () => {
    const [scale] = await admin`select id from scales where tenant_id = ${tenantId} limit 1`
    const [c] = await admin`insert into checklists (tenant_id, title, scale_id, items) values (${tenantId}, ${`Чек-лист ${stamp}`}, ${scale!.id}, ${admin.json([])}) returning id`
    checklistId = c!.id as string
    const [run] = await admin`
      insert into checklist_runs (tenant_id, checklist_id, subject_kind, location_id, observer_id, status, action_plan)
      values (${tenantId}, ${checklistId}, 'location', ${lazarevaId}, ${adminId}, 'finished', ${admin.json([{ id: 'a1', text: 'Помити витяжку', responsibleId: adminId, dueAt: '2026-12-01', status: 'open' }])})
      returning id`
    runIds.push(run!.id as string)
    // Тот же guard, что ставит эндпоинт: наблюдатель, ответственный или область точки прогона
    const foreign = (actor: string, area: string[]) => (r: { observerId: string, locationId: string | null }, responsibleId?: string) =>
      r.observerId === actor || responsibleId === actor || (!!r.locationId && area.includes(r.locationId))
    expect(await updateAction(as(mentorId), run!.id as string, 'a1', { status: 'done' }, foreign(mentorId, [segedskaId]))).toBeNull()
    expect(await addAction(as(mentorId), run!.id as string, { text: 'x', responsibleId: mentorId, dueAt: '2026-12-01' }, foreign(mentorId, [segedskaId]))).toBeNull()
    expect(await updateAction(as(mentorId), run!.id as string, 'a1', { status: 'done' }, foreign(mentorId, [lazarevaId]))).toMatchObject({ status: 'done' })
  })
})

describe('заявка из каталога', () => {
  it('свою заявку не одобряют', async () => {
    const [t] = await admin`insert into trajectories (tenant_id, title) values (${tenantId}, ${`Траєкторія ${stamp}`}) returning id`
    trajectoryId = t!.id as string
    const [e] = await admin`insert into trajectory_enrollments (tenant_id, trajectory_id, user_id, status, requested_at) values (${tenantId}, ${trajectoryId}, ${mentorId}, 'not_assigned', now()) returning id`
    expect(await traj.decideRequest(as(mentorId), e!.id as string, true)).toEqual({ ok: false, code: 'self' })
  })
})
