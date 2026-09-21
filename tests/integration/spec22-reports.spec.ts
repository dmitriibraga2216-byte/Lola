import 'dotenv/config'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assignWithParams } from './_assign'
import { FRAME_KEYS } from '../../server/services/reportFrame'
import { summaryReportSchema } from '../../shared/schemas/reports'

/**
 * Spec 22 (docs/22 §13.1–13.4, Г-22.1; docs/32 Б.9): единый каркас отчётов и журналов, контекст проходження,
 * отчёт по типу контента из четырёх частей + «Перерахувати», сводный мастер, журналы task-access / task-status /
 * org-conflicts с request_context, severity → письмо администраторам, выгрузка по активной роли.
 */

const { createCourse, addModule, addLesson, publishCourse } = await import('../../server/services/courses')
const { createAssignment } = await import('../../server/services/assignments')
const { enrollmentTree, openLesson, markDownloaded } = await import('../../server/services/learning')
const { createBank, createQuestion, createQuiz, setQuizQuestions } = await import('../../server/services/questions')
const { startAttempt, saveAnswer, submitAttempt, recalculateAttempt } = await import('../../server/services/attempts')
const { taskReport, taskReportRows } = await import('../../server/services/reportTasks')
const { summaryReport, summaryRows } = await import('../../server/services/reportSummary')
const { readLog, logRows } = await import('../../server/services/logs')
const { logSecurity, updateSecuritySettings } = await import('../../server/services/securityLog')
const { addPlacement, setChief } = await import('../../server/services/people')
const { requestExport, reportRows } = await import('../../server/services/reportExports')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const stamp = Date.now()
let tenantId: string, adminId: string, learnerId: string, mentorId: string, lazarevaId: string, segedskaId: string, posId: string
let courseId: string, courseTaskId: string, enrollmentId: string, lessonId: string
let bankId: string, quizId: string, quizTaskId: string, attemptId: string
const userIds: string[] = []
const ctx = () => ({ tenantId, actorId: adminId })
const learner = () => ({ tenantId, actorId: learnerId })

async function makePerson(name: string, locationId: string) {
  const phone = `+38093${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, phone, full_name, status, tags, email) values (${tenantId}, ${phone}, ${name}, 'active', ${['s22']}, ${`${phone.slice(1)}@example.test`}) returning id`
  userIds.push(u!.id as string)
  await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary) values (${tenantId}, ${u!.id}, ${locationId}, ${posId}, true)`
  return u!.id as string
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  segedskaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Сегедська'`)[0]!.id as string
  posId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Бариста s22-${stamp}`}, ${`barista-s22-${stamp}`}) returning id`)[0]!.id as string
  learnerId = await makePerson(`Учень s22 ${stamp}`, lazarevaId)
  mentorId = await makePerson(`Наставник s22 ${stamp}`, lazarevaId)
  // Курс с одним уроком
  const c = await createCourse(ctx(), { title: `Курс s22 ${stamp}`, language: 'uk', strictOrder: true, isCatalogVisible: false, tags: [] })
  courseId = c.id
  const m = await addModule(ctx(), courseId, 'Р')
  const l = await addLesson(ctx(), { moduleId: m!.id, title: 'Урок', itemType: 'resource', resource: { body: [{ id: 'b', type: 'text', html: '<p>x</p>' }] }, isRequired: true, videoThresholdPct: 90 })
  if (!l.ok) throw new Error(l.code)
  lessonId = l.lesson.id
  await publishCourse(ctx(), courseId, 'v1')
  const r = await createAssignment(ctx(), { subjectType: 'course', subjectId: courseId, lockVersion: false, audience: { rules: [{ type: 'user', ids: [learnerId, mentorId] }], match: 'any' }, dueMode: 'relative', dueDays: 14, isMandatory: true, autoSync: false, tags: [], status: 'active', reminders: { notifyOnAssign: false } })
  if (!r.ok) throw new Error(r.code)
  courseTaskId = r.assignmentId
  enrollmentId = (await admin`select id from enrollments where assignment_id = ${courseTaskId} and user_id = ${learnerId}`)[0]!.id as string
  // Тест из одного вопроса, назначен ученику с тремя попытками
  bankId = (await createBank(ctx(), { name: `Банк s22 ${stamp}` })).id
  const q = await createQuestion(ctx(), { bankId, kind: 'single', stem: [{ id: 'b1', type: 'text', html: '<p>2+2?</p>' }], options: [{ id: 'a', text: '4' }, { id: 'b', text: '5' }], answer: { correctId: 'a' }, isCritical: false, difficulty: 3, points: 1, scoringMethod: 'formula', attachFiles: false, negativeMarking: false, tags: [] })
  quizId = (await createQuiz(ctx(), { title: `Тест s22 ${stamp}`, kind: 'quiz', tags: [], selectionMode: 'fixed', requiresOfflineConfirm: false })).id
  await setQuizQuestions(ctx(), quizId, [{ questionId: q.id, sort: 0 }])
  quizTaskId = await assignWithParams(ctx(), 'test', quizId, { attemptsAllowed: 3, shuffleQuestions: false, shuffleOptions: false }, [learnerId])
})

afterAll(async () => {
  await admin`delete from attempts where quiz_id = ${quizId}`
  await admin`delete from assignments where id in (${courseTaskId}, ${quizTaskId})`
  await admin`delete from quizzes where id = ${quizId}`
  await admin`delete from question_banks where id = ${bankId}`
  await admin`delete from enrollments where subject_id = ${courseId}`
  await admin`delete from courses where id = ${courseId}`
  await admin`delete from notifications where tenant_id = ${tenantId} and code = 'security_alert'`
  await admin`delete from security_log where tenant_id = ${tenantId} and (event = 'settings.security_changed' or meta->>'s22' = '1') and created_at > now() - interval '10 minutes'`
  await admin`update tenants set settings = settings - 'security' where id = ${tenantId}`
  await admin`update users set email = null where id = ${adminId} and email = 'admin-s22@example.test'`
  if (userIds.length) { await admin`delete from functional_chiefs where user_id in ${admin(userIds)} or chief_id in ${admin(userIds)}`; await admin`delete from users where id in ${admin(userIds)}` }
  await admin`delete from positions where id = ${posId}`
  await admin.end()
})

describe('единый каркас (§13.3) и контекст проходження (Г-22.1)', () => {
  it('открытие курса пишет обращение; старт урока — смену статуса с from/to и request_context', async () => {
    expect(await enrollmentTree(learner(), enrollmentId)).not.toBeNull()
    await openLesson(learner(), enrollmentId, lessonId)
    await markDownloaded(learner(), enrollmentId, lessonId)
    const access = await admin`select * from task_access_log where enrollment_id = ${enrollmentId} order by created_at`
    expect(access.map(a => a.action)).toEqual(['open', 'download'])
    expect(access[0]!.content_type).toBe('course')
    expect('request_context' in access[0]!).toBe(true) // вне HTTP — null, колонка есть (п. 14)
    const [ev] = await admin`select payload from enrollment_events where enrollment_id = ${enrollmentId} and event = 'started'`
    expect(ev!.payload).toMatchObject({ from: 'not_started', to: 'in_progress' })
  })

  it('отчёт по курсу, отчёт по тесту и журнал статусов отдают одну и ту же левую часть', async () => {
    const course = await taskReport(ctx(), 'course', { taskId: courseTaskId })
    if ('error' in course) throw new Error(course.error)
    expect(course.rows.length).toBe(2)
    const row = course.rows.find(r => r.user_id === learnerId)!
    for (const k of FRAME_KEYS) expect(k in row, `нет колонки ${k} в отчёте по курсу`).toBe(true)
    expect(row.position).toContain('Бариста s22')
    expect(row.location).toBe('Лазарева')
    expect(row.tags).toEqual(['s22'])
    expect(row.status).toBe('in_progress')
    expect(row.context).toBe('standalone')
    expect(row.context_title).toBe(`Курс s22 ${stamp}`)

    const test = await taskReport(ctx(), 'test', { taskId: quizTaskId })
    if ('error' in test) throw new Error(test.error)
    for (const k of FRAME_KEYS) expect(k in test.rows[0]!, `нет колонки ${k} в отчёте по тесту`).toBe(true)
    expect(test.rows[0]!.status).toBe('not_started')

    const log = await readLog(ctx(), 'task-status', { userId: learnerId })
    expect(log.length).toBeGreaterThan(0)
    for (const k of FRAME_KEYS) expect(k in log[0]!, `нет колонки ${k} в журнале статусов`).toBe(true)
    expect(log.find(r => r.event === 'started')).toMatchObject({ from_status: 'not_started', status: 'in_progress', content_type: 'course' })
  })

  it('фильтры каркаса: посада, мітки, точка; чужая точка сужает до пустого; контекст in_course отсекает записи курса', async () => {
    const byTag = await taskReport(ctx(), 'course', { taskId: courseTaskId, tags: ['s22'] })
    if ('error' in byTag) throw new Error(byTag.error)
    expect(byTag.rows.length).toBe(2)
    const byPos = await taskReport(ctx(), 'course', { taskId: courseTaskId, positionIds: [posId], scope: [segedskaId] })
    if ('error' in byPos) throw new Error(byPos.error)
    expect(byPos.rows.length).toBe(0)
    const inCourse = await taskReport(ctx(), 'course', { taskId: courseTaskId, context: 'in_course' })
    if ('error' in inCourse) throw new Error(inCourse.error)
    expect(inCourse.rows.length).toBe(0)
    const standalone = await taskReport(ctx(), 'course', { taskId: courseTaskId, context: 'standalone' })
    if ('error' in standalone) throw new Error(standalone.error)
    expect(standalone.rows.length).toBe(2)
  })
})

describe('отчёт по типу контента из четырёх частей + «Перерахувати» (§13.7)', () => {
  it('огляд · звернення · статистика · таблица; попытка меняет статус, пересчёт пишет attempt_results', async () => {
    const s = await startAttempt(learner(), quizId)
    if (!s.ok) throw new Error(s.code)
    attemptId = s.attemptId
    const [snap] = await admin`select snapshot from attempts where id = ${attemptId}`
    const qid = (snap!.snapshot as { id: string }[])[0]!.id
    await saveAnswer(learner(), attemptId, qid, { optionId: 'a' })
    await submitAttempt(learner(), attemptId)

    const r = await taskReport(ctx(), 'test', { taskId: quizTaskId })
    if ('error' in r) throw new Error(r.error)
    expect(r.task).toMatchObject({ id: quizTaskId, attemptsAllowed: 3 })
    expect(r.overview).toMatchObject({ assigned: 1, done: 1, donePct: 100 })
    expect(r.stats).toMatchObject({ assigned: 1, doneOk: 1, notOpened: 0, doneFail: 0, inProgress: 0, onReview: 0 })
    expect(r.accesses.length).toBe(1)
    expect(r.accesses[0]).toMatchObject({ hits: 1, users: 1 })
    const row = r.rows[0]!
    expect(row).toMatchObject({ status: 'done', result: 100, best_pct: 100, attempts_used: 1, attempts_allowed: 3, last_attempt_id: attemptId, context: 'standalone' })

    const rc = await recalculateAttempt(ctx(), attemptId, 'перевірка')
    expect(rc.ok).toBe(true)
    const results = await admin`select reason from attempt_results where attempt_id = ${attemptId} order by created_at`
    expect(results.map(x => x.reason)).toEqual(['submit', 'recalculate'])
    // Пересчёт виден в журнале статусов как событие теста
    const log = await readLog(ctx(), 'task-status', { userId: learnerId, contentType: 'test' })
    expect(log.map(x => x.event)).toContain('attempt.recalculate')
    expect(log[0]).toMatchObject({ content_type: 'test', status: 'done', result: 100 })
  })

  it('выгрузка: колонки каркаса идут первыми', async () => {
    const rows = await taskReportRows(ctx(), 'test', { taskId: quizTaskId })
    expect(Object.keys(rows[0]!).slice(0, 9)).toEqual(['full_name', 'position', 'city', 'unit', 'tags', 'assigned_at', 'completed_at', 'status', 'result'])
    expect(rows[0]!.tags).toBe('s22')
  })

  it('неподдерживаемый тип и чужое назначение', async () => {
    // docs/33 D-047: опитування тепер підтримане (по survey_participations); без прохождення лишилось лише оголошення
    expect(await taskReport(ctx(), 'notice', {})).toEqual({ error: 'unsupported' })
    expect(await taskReport(ctx(), 'course', { taskId: crypto.randomUUID() })).toEqual({ error: 'not_found' })
  })
})

describe('сводный мастер (§13.1): люди → задания → конфигурация → результат', () => {
  it('шаги считаются на сервере; результат — пересечение выборок с пятью статусами', async () => {
    const users = await summaryReport(ctx(), summaryReportSchema.parse({ step: 'users', userFilter: { tags: ['s22'] } }))
    expect(users.step).toBe('users')
    if (users.step !== 'users') return
    expect(users.count).toBe(2)
    for (const k of ['user_id', 'full_name', 'position', 'city', 'unit', 'tags']) expect(k in users.rows[0]!).toBe(true)

    const tasks = await summaryReport(ctx(), summaryReportSchema.parse({ step: 'tasks', taskFilter: { assignmentIds: [courseTaskId, quizTaskId] } }))
    if (tasks.step !== 'tasks') return
    expect(tasks.rows.map(t => t.id).sort()).toEqual([courseTaskId, quizTaskId].sort())
    expect(tasks.rows.find(t => t.id === courseTaskId)!.assigned).toBe(2)

    const res = await summaryReport(ctx(), summaryReportSchema.parse({ step: 'result', userFilter: { tags: ['s22'] }, taskFilter: { assignmentIds: [courseTaskId, quizTaskId] }, columns: ['status', 'result'], groupBy: 'position' }))
    if (res.step !== 'result') return
    expect(res.people).toBe(2)
    expect(res.tasks.length).toBe(2)
    const me = res.rows.find(r => r.user_id === learnerId)!
    const mine = me.tasks as Record<string, { status: string, result: number | null }>
    expect(mine[courseTaskId]!.status).toBe('in_progress')
    expect(mine[quizTaskId]).toMatchObject({ status: 'done', result: 100 })
    const other = res.rows.find(r => r.user_id === mentorId)!
    expect((other.tasks as Record<string, { status: string }>)[quizTaskId]!.status).toBe('not_assigned') // не «не розпочато» — п. 12
    expect(res.groups.length).toBe(1)
    expect(res.groups[0]).toMatchObject({ total: 2 })

    const flat = await summaryRows(ctx(), summaryReportSchema.parse({ userFilter: { tags: ['s22'] }, taskFilter: { assignmentIds: [quizTaskId] } }))
    expect(Object.keys(flat[0]!)[0]).toBe('full_name')
    expect(Object.keys(flat[0]!).some(k => k.endsWith('· статус'))).toBe(true)
  })
})

describe('журналы task-access · org-conflicts · severity → почта (§13.4, docs/16 §14)', () => {
  it('task-access: каждое открытие — строка с каркасом и контекстом', async () => {
    await enrollmentTree(learner(), enrollmentId)
    const rows = await readLog(ctx(), 'task-access', { userId: learnerId, contentType: 'course' })
    expect(rows.filter(r => r.action === 'open').length).toBeGreaterThanOrEqual(2)
    for (const k of ['full_name', 'position', 'city', 'unit', 'tags', 'ip', 'geo', 'client', 'task_title']) expect(k in rows[0]!).toBe(true)
    const test = await readLog(ctx(), 'task-access', { contentType: 'test', contentId: quizId })
    expect(test.length).toBe(1)
    expect(test[0]!.assignment_id).toBe(quizTaskId)
  })

  it('org-conflicts: второе размещение в другом подразделении, руководитель сам себе и кольцо — строки, действие продолжается', async () => {
    await addPlacement(ctx(), learnerId, { locationId: segedskaId, positionId: posId, isPrimary: false })
    expect(await setChief(ctx(), { userId: learnerId, chiefId: learnerId, kind: 'line' })).toBeNull()
    await setChief(ctx(), { userId: learnerId, chiefId: mentorId, kind: 'line' })
    await setChief(ctx(), { userId: mentorId, chiefId: learnerId, kind: 'line' })
    const rows = await readLog(ctx(), 'org-conflicts', { userId: learnerId })
    expect(rows.map(r => r.kind).sort()).toEqual(['double_unit', 'manager_self'])
    const cycle = await readLog(ctx(), 'org-conflicts', { userId: mentorId, type: 'manager_cycle' })
    expect(cycle.length).toBe(1)
    const [{ n }] = await admin<[{ n: number }]>`select count(*)::int as n from user_placements where user_id = ${learnerId} and ended_at is null`
    expect(n).toBe(2)
    const [raw] = await admin`select * from org_conflicts where user_id = ${learnerId} and kind = 'double_unit'`
    expect('request_context' in raw!).toBe(true)
    expect(raw!.source).toBe('manual')
  })

  it('severity: при включённом «Повідомляти на E-mail» warning и critical кладут письмо администраторам в очередь, info — нет', async () => {
    await logSecurity({ tenantId, userId: learnerId, event: 'login.failed', severity: 'warning', meta: { s22: 1 } })
    const n = await admin`select count(*)::int as n from notifications where code = 'security_alert' and tenant_id = ${tenantId}`
    expect(n[0]!.n).toBe(0) // выключено по умолчанию

    await admin`update users set email = coalesce(email, 'admin-s22@example.test') where id = ${adminId}`
    const s = await updateSecuritySettings(ctx(), { emailAlerts: true })
    expect(s.emailAlerts).toBe(true)
    // Сама смена настройки безопасности — critical → уже письмо
    await logSecurity({ tenantId, userId: learnerId, event: 'login.failed', severity: 'warning', meta: { s22: 1 } })
    await logSecurity({ tenantId, userId: learnerId, event: 'otp.sent', meta: { s22: 1 } })
    const mails = await admin`select payload, channel, user_id from notifications where code = 'security_alert' and tenant_id = ${tenantId} order by created_at`
    expect(mails.length).toBeGreaterThanOrEqual(2)
    expect(mails.every(m => m.channel === 'email')).toBe(true)
    expect(mails.some(m => (m.payload as { event: string }).event === 'login.failed')).toBe(true)
    expect(mails.some(m => (m.payload as { event: string }).event === 'otp.sent')).toBe(false)
    expect(mails.some(m => m.user_id === adminId)).toBe(true)
    const [audit] = await admin`select 1 from audit_log where tenant_id = ${tenantId} and action = 'settings.security' and actor_id = ${adminId} limit 1`
    expect(audit).toBeDefined()
  })

  it('выгрузка журнала — каркас первыми колонками', async () => {
    const rows = await logRows(ctx(), 'task-access', { userId: learnerId })
    expect(Object.keys(rows[0]!).slice(0, 5)).toEqual(['full_name', 'position', 'city', 'unit', 'tags'])
  })
})

describe('выгрузка по активной роли (долг #34)', () => {
  it('report_exports хранит active_role_id; строки считаются по этой роли', async () => {
    const mentorRole = (await admin`select id from roles where tenant_id = ${tenantId} and code = 'mentor'`)[0]!.id as string
    await admin`insert into user_roles (tenant_id, user_id, role_id, scope_type, scope_id) values (${tenantId}, ${mentorId}, ${mentorRole}, 'location', ${lazarevaId})`
    const e = await requestExport({ tenantId, actorId: adminId, activeRoleId: mentorRole }, { report: 'tasks-course', filters: { taskId: courseTaskId } })
    expect(e.activeRoleId).toBe(mentorRole)
    // Администратор видит всю сеть; наставник точки — только свою точку
    const all = await reportRows(tenantId, adminId, 'tasks-course', { taskId: courseTaskId })
    expect(all.length).toBe(2)
    const asMentor = await reportRows(tenantId, mentorId, 'tasks-course', { taskId: courseTaskId }, mentorRole)
    expect(asMentor.length).toBe(2) // оба на Лазаревій
    const asMentorOther = await reportRows(tenantId, mentorId, 'tasks-course', { taskId: courseTaskId, locationId: segedskaId }, mentorRole)
    expect(asMentorOther.length).toBe(0)
    const summary = await reportRows(tenantId, adminId, 'summary', { userFilter: { tags: ['s22'] }, taskFilter: { assignmentIds: [courseTaskId] } })
    expect(summary.length).toBe(2)
    const log = await reportRows(tenantId, adminId, 'log-task-access', { userId: learnerId })
    expect(log.length).toBeGreaterThan(0)
    expect(await reportRows(tenantId, mentorId, 'log-task-access', {}, mentorRole)).toEqual([]) // без audit.view — пусто
    await admin`delete from report_exports where id = ${e.id}`
  })
})
