import 'dotenv/config'
import postgres from 'postgres'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * debts-2 (docs/33 §Б): D-011 санитизация SVG и D-006 страницы PDF в media.process; D-007 версия ресурса
 * в назначении; D-009 результат курса по result_mode; D-013 откат зачёта при «Перерахувати»/аннулировании;
 * D-019 баннер «N завдань змінено» для практикума и опроса.
 */
const { processMedia } = await import('../../server/jobs/mediaProcess')
const { S3_BUCKET, s3, ensureBucket } = await import('../../server/services/media')
const { createResource, updateResource, publishResource, viewResource } = await import('../../server/services/resources')
const { createAssignment } = await import('../../server/services/assignments')
const { createCourse, addModule, addLesson, publishCourse } = await import('../../server/services/courses')
const { selfEnroll, enrollmentTree, openLesson, completeLesson, myLearning } = await import('../../server/services/learning')
const { createBank, createQuestion, updateQuestion, createQuiz, setQuizQuestions } = await import('../../server/services/questions')
const { startAttempt, saveAnswer, submitAttempt, recalculateAttempt, annulAttempt } = await import('../../server/services/attempts')
const { myCertificates, issueForEnrollment } = await import('../../server/services/certificates')
const { createWorkshop, updateWorkshop } = await import('../../server/services/workshops')
const { createSurvey, updateSurvey } = await import('../../server/services/surveys')
const { listChanged } = await import('../../server/services/tasks')
const { assignWithParams } = await import('./_assign')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const stamp = Date.now()

let tenantId: string
let authorId: string
let learnerId: string
const mediaIds: string[] = []
const resourceIds: string[] = []
const courseIds: string[] = []
const quizIds: string[] = []
const assignmentIds: string[] = []
const workshopIds: string[] = []
const surveyIds: string[] = []
let bankId: string

const author = () => ({ tenantId, actorId: authorId })
const learner = () => ({ tenantId, actorId: learnerId })
const text = (html: string, id = 'b1') => [{ id, type: 'text' as const, html }]
const baseQ = { isCritical: false, difficulty: 3, points: 1, scoringMethod: 'formula' as const, attachFiles: false, negativeMarking: false, tags: [] as string[] }
const opts = (...ids: string[]) => ids.map(id => ({ id, text: `Варіант ${id}` }))

async function putMedia(mime: string, ext: string, body: Buffer) {
  const key = `t/${tenantId}/test/${crypto.randomUUID()}.${ext}`
  await s3().send(new PutObjectCommand({ Bucket: S3_BUCKET(), Key: key, Body: body, ContentType: mime }))
  const kind = mime.startsWith('image/') ? 'image' : 'file'
  const [m] = await admin`insert into media_assets (tenant_id, key, original_name, kind, mime, bytes, status, uploaded_by)
    values (${tenantId}, ${key}, ${`f.${ext}`}, ${kind}, ${mime}, ${body.length}, 'processing', ${authorId}) returning id`
  mediaIds.push(m!.id as string)
  return { id: m!.id as string, key }
}

async function readObject(key: string) {
  const obj = await s3().send(new GetObjectCommand({ Bucket: S3_BUCKET(), Key: key }))
  return Buffer.from(await obj.Body!.transformToByteArray()).toString('utf8')
}

beforeAll(async () => {
  const [t] = await admin`select id from tenants where slug = 'kappi'`
  tenantId = t!.id as string
  const pick = async (phone: string) => (await admin`select id from users where tenant_id = ${tenantId} and phone = ${phone}`)[0]!.id as string
  authorId = await pick('+380661864742')
  learnerId = await pick('+380670000003')
  bankId = (await createBank(author(), { name: `Банк debts-2 ${stamp}` })).id
})

afterAll(async () => {
  if (assignmentIds.length) await admin`delete from assignments where id in ${admin(assignmentIds)}`
  if (courseIds.length) {
    await admin`delete from certificates where course_id in ${admin(courseIds)}`
    await admin`delete from enrollments where subject_id in ${admin(courseIds)}`
    await admin`delete from courses where id in ${admin(courseIds)}`
  }
  if (quizIds.length) {
    await admin`delete from attempts where quiz_id in ${admin(quizIds)}`
    await admin`delete from quizzes where id in ${admin(quizIds)}`
  }
  await admin`delete from question_banks where id = ${bankId}`
  if (resourceIds.length) await admin`delete from resources where id in ${admin(resourceIds)}`
  if (workshopIds.length) await admin`delete from workshops where id in ${admin(workshopIds)}`
  if (surveyIds.length) await admin`delete from surveys where id in ${admin(surveyIds)}`
  if (mediaIds.length) await admin`delete from media_assets where id in ${admin(mediaIds)}`
  await admin.end()
})

describe('D-011 / D-006: media.process — SVG чистится, у PDF считаются страницы', () => {
  it('SVG со <script> и onload сохраняется очищенным поверх оригинала, варианты строятся', async () => {
    await ensureBucket()
    const evil = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" onload="alert(1)"><script>alert(1)</script><rect width="100" height="50" fill="#0aa"/></svg>'
    const m = await putMedia('image/svg+xml', 'svg', Buffer.from(evil))
    await processMedia({ tenantId, mediaId: m.id })
    const stored = await readObject(m.key)
    expect(stored).not.toMatch(/script|onload/i)
    expect(stored).toContain('<rect width="100" height="50" fill="#0aa">')
    const [row] = await admin`select status, width, height, variants from media_assets where id = ${m.id}`
    expect(row!.status).toBe('ready')
    expect(row!.width).toBe(100)
    expect(Object.keys(row!.variants as object)).toEqual(expect.arrayContaining(['320', '768', '1600']))
  })

  it('HTML под видом SVG — обработка падает, файл failed', async () => {
    const m = await putMedia('image/svg+xml', 'svg', Buffer.from('<html><body><script>alert(1)</script></body></html>'))
    await expect(processMedia({ tenantId, mediaId: m.id })).rejects.toThrow()
    const [row] = await admin`select status, error from media_assets where id = ${m.id}`
    expect(row!.status).toBe('failed')
    expect(String(row!.error)).toContain('SVG')
  })

  it('PDF: число страниц пишется в variants.pages; docx — нет', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 12 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF', 'latin1')
    const m = await putMedia('application/pdf', 'pdf', pdf)
    await processMedia({ tenantId, mediaId: m.id })
    const [row] = await admin`select status, variants from media_assets where id = ${m.id}`
    expect(row!.status).toBe('ready')
    expect((row!.variants as { pages: number }).pages).toBe(12)

    const d = await putMedia('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx', Buffer.from('PK not really'))
    await processMedia({ tenantId, mediaId: d.id })
    const [drow] = await admin`select status, variants from media_assets where id = ${d.id}`
    expect(drow!.status).toBe('ready')
    expect((drow!.variants as { pages?: number }).pages).toBeUndefined()
  })
})

describe('D-007: назначение ресурса закреплено за версией на момент выдачи', () => {
  it('createAssignment(resource) пишет опубликованную версию; ученик по назначению читает её и после новой публикации', async () => {
    const r = await createResource(author(), { kind: 'article', title: `Стандарт d2-${stamp}`, language: 'uk', tags: [], categoryIds: [], allowPrint: true, body: text('<p>v1</p>') })
    resourceIds.push(r.id)
    const p1 = await publishResource(author(), r.id, { notifyAssigned: false })
    if (!p1.ok) throw new Error(p1.code)

    const a = await createAssignment(author(), {
      subjectType: 'resource', subjectId: r.id, lockVersion: false,
      audience: { rules: [{ type: 'user', ids: [learnerId] }], match: 'any' },
      dueMode: 'none', dueDays: 14, isMandatory: false, autoSync: false, tags: [], status: 'active',
      params: { contentType: 'resource' }, reminders: { notifyOnAssign: false },
    } as never)
    if (!a.ok) throw new Error(a.code)
    assignmentIds.push(a.assignmentId)
    const [row] = await admin`select subject_version_id from assignments where id = ${a.assignmentId}`
    expect(row!.subject_version_id).toBe(p1.versionId)

    await updateResource(author(), r.id, { body: text('<p>v2</p>') })
    const p2 = await publishResource(author(), r.id, { notifyAssigned: false })
    if (!p2.ok) throw new Error(p2.code)
    expect(p2.version).toBe(2)

    const pinned = await viewResource(learner(), r.id, { assignmentId: a.assignmentId })
    expect(pinned).toMatchObject({ version: 1, versionId: p1.versionId, pinned: true })
    expect(JSON.stringify(pinned!.body)).toContain('v1')
    const current = await viewResource(learner(), r.id)
    expect(current).toMatchObject({ version: 2, pinned: false })

    // Назначение другого контента — 404
    const other = await createResource(author(), { kind: 'article', title: `Інший d2-${stamp}`, language: 'uk', tags: [], categoryIds: [], allowPrint: true, body: text('<p>x</p>') })
    resourceIds.push(other.id)
    await publishResource(author(), other.id, { notifyAssigned: false })
    expect(await viewResource(learner(), other.id, { assignmentId: a.assignmentId })).toBeNull()
  })
})

describe('D-009 / D-013: результат курса по result_mode; откат зачёта при пересчёте', () => {
  let quizA: string // 1 вопрос → 100%
  let quizB: string // 2 вопроса, верный один → 50%
  let qB1: string
  const byMode: Record<string, { enrollmentId: string, attemptB: string, lessonB: string }> = {}

  async function buildCourse(resultMode: 'pct' | 'avg_score' | 'final_test') {
    const course = await createCourse(author(), { title: `Курс ${resultMode} d2-${stamp}`, language: 'uk', strictOrder: false, isCatalogVisible: true, tags: [], validityMonths: 12, resultMode })
    courseIds.push(course.id)
    const mod = await addModule(author(), course.id, 'Розділ')
    const lA = await addLesson(author(), { moduleId: mod!.id, title: 'Тест A', itemType: 'quiz', quizId: quizA, isRequired: true, videoThresholdPct: 90, passScorePct: 100 })
    const lB = await addLesson(author(), { moduleId: mod!.id, title: 'Тест B', itemType: 'quiz', quizId: quizB, isRequired: true, videoThresholdPct: 90, passScorePct: 50 })
    if (!lA.ok || !lB.ok) throw new Error('lesson')
    expect((await publishCourse(author(), course.id, 'v1')).ok).toBe(true)
    const enr = await selfEnroll(learner(), course.id)
    if (!enr.ok) throw new Error(enr.code)

    await openLesson(learner(), enr.enrollmentId, lA.lesson.id)
    const a = await startAttempt(learner(), quizA, { enrollmentId: enr.enrollmentId, lessonId: lA.lesson.id })
    if (!a.ok) throw new Error(a.code)
    const [qa] = (await admin`select id from questions where bank_id = ${bankId} and (stem::text) like '%A1%'`)
    await saveAnswer(learner(), a.attemptId, qa!.id as string, { optionId: 'a' })
    expect((await submitAttempt(learner(), a.attemptId)).ok).toBe(true)

    await openLesson(learner(), enr.enrollmentId, lB.lesson.id)
    const b = await startAttempt(learner(), quizB, { enrollmentId: enr.enrollmentId, lessonId: lB.lesson.id })
    if (!b.ok) throw new Error(b.code)
    await saveAnswer(learner(), b.attemptId, qB1, { optionId: 'a' }) // верно; второй вопрос без ответа
    const sb = await submitAttempt(learner(), b.attemptId)
    expect(sb.ok && sb.status).toBe('passed')
    byMode[resultMode] = { enrollmentId: enr.enrollmentId, attemptB: b.attemptId, lessonB: lB.lesson.id }
    const [e] = await admin`select status, score from enrollments where id = ${enr.enrollmentId}`
    expect(e!.status).toBe('done')
    return Number(e!.score)
  }

  it('готовим два теста: A — 100%, B — 50%', async () => {
    const qa = (await createQuestion(author(), { bankId, kind: 'single', stem: text('<p>A1</p>'), options: opts('a', 'b'), answer: { correctId: 'a' }, ...baseQ })).id
    qB1 = (await createQuestion(author(), { bankId, kind: 'single', stem: text('<p>B1</p>'), options: opts('a', 'b'), answer: { correctId: 'a' }, ...baseQ })).id
    const qB2 = (await createQuestion(author(), { bankId, kind: 'single', stem: text('<p>B2</p>'), options: opts('a', 'b'), answer: { correctId: 'a' }, ...baseQ })).id
    quizA = (await createQuiz(author(), { title: `Тест A d2-${stamp}`, kind: 'quiz', tags: [], selectionMode: 'fixed', requiresOfflineConfirm: false })).id
    quizB = (await createQuiz(author(), { title: `Тест B d2-${stamp}`, kind: 'quiz', tags: [], selectionMode: 'fixed', requiresOfflineConfirm: false })).id
    quizIds.push(quizA, quizB)
    await setQuizQuestions(author(), quizA, [{ questionId: qa, sort: 0 }])
    await setQuizQuestions(author(), quizB, [{ questionId: qB1, sort: 0 }, { questionId: qB2, sort: 1 }])
    // Самозапись без назначения: порог — lessons.pass_score_pct (docs/11 §14.1), попытки — умолчания тенанта
  })

  it('pct → 100 (доля зачтённых уроков)', async () => {
    expect(await buildCourse('pct')).toBe(100)
  })

  it('avg_score → 75 (среднее по тестам плана)', async () => {
    expect(await buildCourse('avg_score')).toBe(75)
  })

  it('final_test → 50 (последний тест плана); результат виден в «Мої завдання» и дереве', async () => {
    expect(await buildCourse('final_test')).toBe(50)
    const mine = await myLearning(learner(), 'done')
    expect(Number(mine.find(m => m.id === byMode.final_test!.enrollmentId)!.score)).toBe(50)
    const tree = await enrollmentTree(learner(), byMode.final_test!.enrollmentId)
    expect(tree!.course.resultMode).toBe('final_test')
    expect(Number(tree!.enrollment.score)).toBe(50)
  })

  it('«Перерахувати» passed → failed: урок снова открыт, запись in_progress без score, сертификат отозван; аудит', async () => {
    const { enrollmentId, attemptB, lessonB } = byMode.pct!
    const certBefore = (await myCertificates(learner())).find(c => c.courseTitle?.includes(`Курс pct d2-${stamp}`))
    expect(certBefore).toBeDefined()
    expect(certBefore!.revokedAt).toBeNull()

    // Автор понял: верный ответ у B1 — «b». Попытка B: 0 из 2 → failed при пороге 50
    await updateQuestion(author(), qB1, { answer: { correctId: 'b' } })
    const r = await recalculateAttempt(author(), attemptB, 'Виправлено ключ')
    expect(r.ok && r.after.status).toBe('failed')
    expect(r.ok && r.rollback).toMatchObject({ lessonReopened: true, courseReopened: true, certificateIds: [certBefore!.id] })

    const [lp] = await admin`select status, completed_at from lesson_progress where enrollment_id = ${enrollmentId} and lesson_id = ${lessonB}`
    expect(lp).toMatchObject({ status: 'opened', completed_at: null })
    const [e] = await admin`select status, score, completed_at, required_done, required_total from enrollments where id = ${enrollmentId}`
    expect(e).toMatchObject({ status: 'in_progress', score: null, completed_at: null, required_done: 1, required_total: 2 })
    const [cert] = await admin`select revoked_at, revoke_reason, revoked_by from certificates where id = ${certBefore!.id}`
    expect(cert!.revoked_at).not.toBeNull()
    expect(cert!.revoke_reason).toBe('Помилка при видачі')
    expect(cert!.revoked_by).toBe(authorId)
    const [audit] = await admin`select after from audit_log where action = 'attempt.recalculate' and entity_id = ${attemptB} order by created_at desc limit 1`
    expect((audit!.after as { rollback: { courseReopened: boolean } }).rollback.courseReopened).toBe(true)
    expect((await admin`select count(*)::int as n from audit_log where action = 'certificate.revoke' and entity_id = ${certBefore!.id}`)[0]!.n).toBe(1)
    const tree = await enrollmentTree(learner(), enrollmentId)
    expect(tree!.enrollment.status).toBe('in_progress')
    expect(tree!.modules[0]!.lessons.find(l => l.id === lessonB)!.status).toBe('opened')

    // Ключ вернули — failed → passed: урок и курс закрыты снова, сертификат выдан новый
    await updateQuestion(author(), qB1, { answer: { correctId: 'a' } })
    const back = await recalculateAttempt(author(), attemptB, 'Повернули ключ')
    expect(back.ok && back.after.status).toBe('passed')
    const [e2] = await admin`select status, score from enrollments where id = ${enrollmentId}`
    expect(e2!.status).toBe('done')
    expect(Number(e2!.score)).toBe(100)
    const reissued = await issueForEnrollment(author(), enrollmentId)
    expect(reissued.ok && reissued.certificateId).not.toBe(certBefore!.id)
    expect((await admin`select count(*)::int as n from certificates where enrollment_id = ${enrollmentId} and revoked_at is null`)[0]!.n).toBe(1)
  })

  it('другая зачтённая попытка по уроку удерживает зачёт; аннулирование тоже откатывает', async () => {
    const { enrollmentId, attemptB, lessonB } = byMode.avg_score!
    // Вторая попытка по тому же уроку — тоже зачтена
    const b2 = await startAttempt(learner(), quizB, { enrollmentId, lessonId: lessonB })
    if (!b2.ok) throw new Error(b2.code)
    await saveAnswer(learner(), b2.attemptId, qB1, { optionId: 'a' })
    expect((await submitAttempt(learner(), b2.attemptId)).ok).toBe(true)

    // Аннулировали первую — вторая держит зачёт
    await annulAttempt(author(), attemptB, 'Списування')
    let [e] = await admin`select status from enrollments where id = ${enrollmentId}`
    expect(e!.status).toBe('done')
    // Аннулировали и вторую — откат
    await annulAttempt(author(), b2.attemptId, 'Списування')
    ;[e] = await admin`select status from enrollments where id = ${enrollmentId}`
    expect(e!.status).toBe('in_progress')
    const [lp] = await admin`select status from lesson_progress where enrollment_id = ${enrollmentId} and lesson_id = ${lessonB}`
    expect(lp!.status).toBe('opened')
    // completeLesson кнопкой урок-тест не закроет — только новой зачтённой попыткой
    expect((await completeLesson(learner(), enrollmentId, lessonB)).ok).toBe(false)
  })
})

describe('D-019: баннер «N завдань змінено» для практикума и опроса', () => {
  it('практикум: правка критериев у опубликованного помечает назначения; правка названия — нет', async () => {
    const w = await createWorkshop(author(), {
      title: `Практикум d2-${stamp}`, description: text('<p>x</p>'), submissionKinds: ['text'], minTextLength: 10,
      criteria: [{ text: 'Чисто' }], passRule: { type: 'all_criteria' }, reviewerRule: 'any_mentor', slaHours: 24, status: 'published',
    })
    workshopIds.push(w.id)
    const aId = await assignWithParams(author(), 'workshop', w.id, { contentType: 'workshop' } as never, [learnerId])
    assignmentIds.push(aId)
    expect((await listChanged(author())).items.some(i => i.id === aId)).toBe(false)

    await updateWorkshop(author(), w.id, { title: `Практикум d2-${stamp} (v2)` })
    expect((await listChanged(author())).items.some(i => i.id === aId)).toBe(false)

    await updateWorkshop(author(), w.id, { criteria: [{ text: 'Чисто' }, { text: 'Швидко', isCritical: true }] })
    expect((await listChanged(author())).items.some(i => i.id === aId)).toBe(true)
  })

  it('опрос: изменение вопросов помечает назначения', async () => {
    const s = await createSurvey(author(), {
      title: `Опитування d2-${stamp}`, kind: 'survey', mode: 'linear', isAnonymous: false, isConfidential: false, showResults: false, tags: [],
      questions: [{ id: 'q1', type: 'scale', text: 'Оцініть', required: true }],
    })
    surveyIds.push(s.id)
    const aId = await assignWithParams(author(), 'poll', s.id, { contentType: 'poll' } as never, [learnerId])
    assignmentIds.push(aId)
    expect((await listChanged(author())).items.some(i => i.id === aId)).toBe(false)

    const same = await updateSurvey(author(), s.id, { questions: [{ id: 'q1', type: 'scale', text: 'Оцініть', required: true }] })
    expect(same.ok).toBe(true)
    expect((await listChanged(author())).items.some(i => i.id === aId)).toBe(false)

    const changed = await updateSurvey(author(), s.id, { questions: [{ id: 'q1', type: 'scale', text: 'Оцініть', required: true }, { id: 'q2', type: 'free', text: 'Чому?' }] })
    expect(changed.ok).toBe(true)
    expect((await listChanged(author())).items.some(i => i.id === aId)).toBe(true)
  })
})
