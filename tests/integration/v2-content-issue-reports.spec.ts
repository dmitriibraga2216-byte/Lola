import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { contentIssueReportQuerySchema } from '../../shared/schemas/contentIssues'

/**
 * Четыре отчёта модуля жалоб (docs/v2/36-content-feedback.md §9): «Скарги», «Дисципліна
 * авторів», «Проблемні питання», «Заявники». Проверяются колонки §9, область видимости
 * (керівник точки — только карточки своих людей) и диагноз «проблемного вопроса»: доля
 * ошибок выше 80 % при жалобах.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const { submitReport } = await import('../../server/services/contentIssues')
const { updateIssue } = await import('../../server/services/contentIssueTriage')
const { authorDisciplineReport, complaintsReport, problemQuestionsReport, reportersReport } = await import('../../server/services/contentIssueReports')
const { createResource, publishResource } = await import('../../server/services/resources')
const { createCourse, addModule, addLesson, publishCourse } = await import('../../server/services/courses')
const { selfEnroll, openLesson } = await import('../../server/services/learning')
const { createBank, createQuestion, createQuiz, setQuizQuestions } = await import('../../server/services/questions')
const { startAttempt, saveAnswer, submitAttempt } = await import('../../server/services/attempts')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const stamp = Date.now()
const TAG = `cir-${stamp}`

let tenantId: string
let adminId: string
let authorId: string
let employeeId: string
let cashierId: string
let employeeLocation: string
const resourceIds: string[] = []
const courseIds: string[] = []
const quizIds: string[] = []
let bankId: string | null = null

let openIssue: string
let rejectedIssue: string
let questionIssue: string
let qKey: string
let quizId: string

const ctx = (actorId: string) => ({ tenantId, actorId })
const all = () => ({ tenantId, actorId: adminId, scope: null })
const authorV = () => ({ tenantId, actorId: authorId, canTriage: true, isAdmin: false, canRescore: false, visibility: 'own' as const })
const q = (query: Record<string, unknown> = {}) => contentIssueReportQuerySchema.parse(query)
const text = (html: string) => [{ id: 'b1', type: 'text' as const, html }]
const opts = (...ids: string[]) => ids.map(id => ({ id, text: `Варіант ${id}` }))
const baseQ = { isCritical: false, difficulty: 3, points: 1, scoringMethod: 'formula' as const, attachFiles: false, negativeMarking: false, tags: [] as string[] }

async function cleanupIssues() {
  await admin`delete from content_issue_events where tenant_id = ${tenantId}`
  await admin`delete from content_reports where tenant_id = ${tenantId}`
  await admin`update attempt_results set issue_id = null where tenant_id = ${tenantId} and issue_id is not null`
  await admin`delete from content_issues where tenant_id = ${tenantId}`
  await admin`delete from content_reporter_stats where tenant_id = ${tenantId}`
  await admin`delete from content_issue_routing_rules where tenant_id = ${tenantId}`
  await admin`delete from notifications where tenant_id = ${tenantId} and (code like 'content_issue%' or code like 'content_reporter%')`
}

async function report(actorId: string, input: Parameters<typeof submitReport>[1]) {
  const r = await submitReport(ctx(actorId), input, { exemptFromLimits: true })
  if (!r.ok) throw new Error(`submitReport: ${JSON.stringify(r)}`)
  return r.result.issueId
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  const pick = async (phone: string) => (await admin`select id from users where tenant_id = ${tenantId} and phone = ${phone}`)[0]!.id as string
  adminId = await pick('+380661864742')
  authorId = await pick('+380670000001')
  employeeId = await pick('+380670000003')
  cashierId = await pick('+380670000004')
  employeeLocation = (await admin`select location_id from user_placements where user_id = ${employeeId} and ended_at is null order by is_primary desc limit 1`)[0]!.location_id as string
  await cleanupIssues()

  // Материал автора: одна открытая жалоба (просроченная) и одна отклонённая
  const r = await createResource(ctx(adminId), { kind: 'article', title: `${TAG} Матеріал`, language: 'uk', tags: [], categoryIds: [], allowPrint: true, body: text('<p>Текст</p>'), authorIds: [authorId] })
  resourceIds.push(r.id)
  const p = await publishResource(ctx(adminId), r.id, { notifyAssigned: false })
  if (!p.ok) throw new Error(p.code)
  openIssue = await report(employeeId, { targetType: 'resource', targetId: r.id, issueType: 'unclear', source: 'lesson', context: {} })
  await admin`update content_issues set due_at = now() - interval '4 days' where id = ${openIssue}`
  rejectedIssue = await report(cashierId, { targetType: 'resource', targetId: r.id, issueType: 'typo', source: 'lesson', context: {} })
  const rej = await updateIssue(authorV(), rejectedIssue, { status: 'rejected', resolution: 'not_an_error', resolutionComment: 'Перевірили: помилки немає' })
  if (!rej.ok) throw new Error(rej.code)

  // Тест с неверным ключом: оба ответили «b», ключ — «a» → 100 % ошибок
  bankId = (await createBank(ctx(adminId), { name: `${TAG} банк` })).id
  qKey = (await createQuestion(ctx(adminId), { bankId, kind: 'single', stem: text('<p>Температура зберігання</p>'), options: opts('a', 'b'), answer: { correctId: 'a' }, ...baseQ })).id
  quizId = (await createQuiz(ctx(adminId), { title: `${TAG} Тест`, kind: 'quiz', tags: [], selectionMode: 'fixed', requiresOfflineConfirm: false })).id
  quizIds.push(quizId)
  await setQuizQuestions(ctx(adminId), quizId, [{ questionId: qKey, sort: 0 }])
  const course = await createCourse(ctx(adminId), { title: `${TAG} Курс`, language: 'uk', strictOrder: false, isCatalogVisible: true, tags: [] })
  courseIds.push(course.id)
  const mod = await addModule(ctx(adminId), course.id, 'Розділ')
  const lesson = await addLesson(ctx(adminId), { moduleId: mod!.id, title: 'Тест', itemType: 'quiz', quizId, isRequired: true, videoThresholdPct: 90, passScorePct: 100 })
  if (!lesson.ok) throw new Error('lesson')
  if (!(await publishCourse(ctx(adminId), course.id, 'v1')).ok) throw new Error('publish')
  for (const userId of [employeeId, cashierId]) {
    const enr = await selfEnroll(ctx(userId), course.id)
    if (!enr.ok) throw new Error(enr.code)
    await openLesson(ctx(userId), enr.enrollmentId, lesson.lesson.id)
    const a = await startAttempt(ctx(userId), quizId, { enrollmentId: enr.enrollmentId, lessonId: lesson.lesson.id })
    if (!a.ok) throw new Error(a.code)
    await saveAnswer(ctx(userId), a.attemptId, qKey, { optionId: 'b' })
    const s = await submitAttempt(ctx(userId), a.attemptId)
    if (!s.ok) throw new Error(s.code)
  }
  questionIssue = await report(employeeId, { targetType: 'question', targetId: qKey, issueType: 'wrong_key', comment: 'Правильна відповідь — b', source: 'lesson', context: {} })
})

afterAll(async () => {
  await cleanupIssues()
  if (courseIds.length) {
    await admin`delete from certificates where enrollment_id in (select id from enrollments where subject_id in ${admin(courseIds)})`
  }
  if (quizIds.length) await admin`delete from attempts where quiz_id in ${admin(quizIds)}`
  if (courseIds.length) {
    await admin`delete from task_status_log where user_id in (${employeeId}, ${cashierId}) and created_at >= to_timestamp(${stamp / 1000})`
    await admin`delete from enrollment_events where enrollment_id in (select id from enrollments where subject_id in ${admin(courseIds)})`
    await admin`delete from enrollments where subject_id in ${admin(courseIds)}`
    await admin`delete from courses where id in ${admin(courseIds)}`
  }
  if (quizIds.length) await admin`delete from quizzes where id in ${admin(quizIds)}`
  if (bankId) await admin`delete from question_banks where id = ${bankId}`
  if (resourceIds.length) await admin`delete from resources where id in ${admin(resourceIds)}`
  await admin.end()
})

describe('«Скарги» — плоская выгрузка карточек (§9)', () => {
  it('колонки §9: версия, заявители, статус, резолюция, ответственный, срок, просрочка, пересчёт', async () => {
    const { rows } = await complaintsReport(all(), q())
    const open = rows.find(r => r.id === openIssue)!
    expect(open).toMatchObject({ issueType: 'unclear', targetType: 'resource', contentVersion: 1, reporters: 1, status: 'new', resolution: null, assignee: expect.any(String), rescoreState: 'none' })
    expect(open.overdueDays).toBeGreaterThanOrEqual(3)
    const rejected = rows.find(r => r.id === rejectedIssue)!
    expect(rejected).toMatchObject({ status: 'rejected', resolution: 'not_an_error', overdueDays: null })
    const quest = rows.find(r => r.id === questionIssue)!
    expect(quest).toMatchObject({ targetType: 'question', rescoreState: 'none' })
  })

  it('фильтры: статус и тип проблемы сужают выгрузку', async () => {
    expect((await complaintsReport(all(), q({ status: 'rejected' }))).rows.map(r => r.id)).toEqual([rejectedIssue])
    expect((await complaintsReport(all(), q({ issueType: 'wrong_key' }))).rows.map(r => r.id)).toEqual([questionIssue])
    expect((await complaintsReport(all(), q({ from: '2000-01-01', to: '2000-01-31' }))).rows).toEqual([])
  })

  it('керівник точки видит только карточки своих людей; чужая точка — ничего', async () => {
    const mine = await complaintsReport({ tenantId, actorId: adminId, scope: [employeeLocation] }, q())
    expect(mine.rows.map(r => r.id)).toEqual(expect.arrayContaining([openIssue, questionIssue]))
    const none = await complaintsReport({ tenantId, actorId: adminId, scope: ['00000000-0000-0000-0000-000000000001'] }, q())
    expect(none.rows).toEqual([])
  })
})

describe('«Дисципліна авторів» (§9)', () => {
  it('на ответственного: открытых, просрочено, доля отклонённых', async () => {
    const { rows } = await authorDisciplineReport(all(), q())
    const author = rows.find(r => r.assigneeId === authorId)!
    expect(author).toMatchObject({ active: true, open: 1, overdue: 1, decided: 1, rejectedPct: 100, avgDaysToFix: null })
  })
})

describe('«Проблемні питання» (§9)', () => {
  it('вопрос с жалобой и 100 % ошибок — «почти наверняка сломан», тест назван', async () => {
    const { rows } = await problemQuestionsReport(all(), q())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ questionId: qKey, complaints: 1, cards: 1, answers: 2, wrongPct: 100, suspect: true, rescoreState: 'none' })
    expect(rows[0]!.quizzes.map(z => z.id)).toEqual([quizId])
  })

  it('жалобы других типов в отчёт не попадают', async () => {
    expect((await problemQuestionsReport(all(), q({ issueType: 'typo' }))).rows).toHaveLength(1)
  })
})

describe('«Заявники» (§9, только администратор)', () => {
  it('подано, подтверждено, отклонено; mute — по репутации', async () => {
    await admin`update content_reporter_stats set muted_until = now() + interval '5 days' where user_id = ${cashierId}`
    const { rows } = await reportersReport(all(), q())
    expect(rows.find(r => r.userId === employeeId)).toMatchObject({ reports: 2, confirmed: 0, rejected: 0, mutedUntil: null, trusted: false })
    const cashier = rows.find(r => r.userId === cashierId)!
    expect(cashier).toMatchObject({ reports: 1, rejected: 1, confirmedPct: 0 })
    expect(cashier.mutedUntil).not.toBeNull()
  })
})
