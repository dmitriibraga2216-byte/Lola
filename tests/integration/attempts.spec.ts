import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const { createBank, createQuestion, updateQuestion, createQuiz, setQuizQuestions } = await import('../../server/services/questions')
const { startAttempt, getAttemptState, saveAnswer, submitAttempt, getAttemptResult, reviewQueue, gradeManual, annulAttempt, quizIntro }
  = await import('../../server/services/attempts')
const { createCourse, addModule, addLesson, publishCourse } = await import('../../server/services/courses')
const { selfEnroll, enrollmentTree, openLesson, completeLesson } = await import('../../server/services/learning')
const { issueForEnrollment, myCertificates, publicCertificate, revokeCertificate } = await import('../../server/services/certificates')
const { assignWithParams } = await import('./_assign')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

let tenantId: string
let authorId: string
let mentorId: string
let learnerId: string
const courseIds: string[] = []
const quizIds: string[] = []
const assignmentIds: string[] = []

beforeAll(async () => {
  const [t] = await admin`select id from tenants where slug = 'kappi'`
  tenantId = t!.id as string
  const pick = async (phone: string) => (await admin`select id from users where tenant_id = ${tenantId} and phone = ${phone}`)[0]!.id as string
  authorId = await pick('+380661864742')
  mentorId = await pick('+380670000002')
  learnerId = await pick('+380670000003')
})

afterAll(async () => {
  if (courseIds.length) {
    await admin`delete from certificates where course_id in ${admin(courseIds)}`
    await admin`delete from enrollments where subject_id in ${admin(courseIds)}`
    await admin`delete from resources where id in (select l.item_id from lessons l join modules m on m.id = l.module_id join course_versions v on v.id = m.course_version_id where l.item_type = 'resource' and v.course_id in ${admin(courseIds)})`
    await admin`delete from courses where id in ${admin(courseIds)}`
  }
  if (quizIds.length) {
    await admin`delete from attempts where quiz_id in ${admin(quizIds)}`
    await admin`delete from quizzes where id in ${admin(quizIds)}`
  }
  if (assignmentIds.length) await admin`delete from assignments where id in ${admin(assignmentIds)}`
  await admin`delete from question_banks where tenant_id = ${tenantId} and name like 'Тест-банк %'`
  await admin.end()
})

const author = () => ({ tenantId, actorId: authorId })
const mentor = () => ({ tenantId, actorId: mentorId })
const learner = () => ({ tenantId, actorId: learnerId })
const stem = (text: string) => [{ id: 'b1', type: 'text' as const, html: `<p>${text}</p>` }]
const opts = (...ids: string[]) => ids.map(id => ({ id, text: `Варіант ${id}` }))

describe('банк, тест, попытка со снапшотом', () => {
  let bankId: string
  let quizId: string
  let qSingle: string
  let qNumber: string
  let qLong: string
  let attemptId: string

  it('банк, 3 вопроса (single критический, number, free), тест из них', async () => {
    const bank = await createBank(author(), { name: `Тест-банк ${Date.now()}` })
    bankId = bank.id

    qSingle = (await createQuestion(author(), {
      bankId, kind: 'single', stem: stem('Температура зберігання риби?'), options: opts('a', 'b', 'c'),
      answer: { correctId: 'b' }, isCritical: true, difficulty: 3, points: 2, scoringMethod: 'formula', attachFiles: false, negativeMarking: false, tags: [],
    })).id
    qNumber = (await createQuestion(author(), {
      bankId, kind: 'number', stem: stem('Скільки грамів сиру на піцу 30 см?'),
      answer: { value: 120, tolerance: 10, unit: 'г' }, isCritical: false, difficulty: 2, points: 1, scoringMethod: 'formula', attachFiles: false, negativeMarking: false, tags: [],
    })).id
    qLong = (await createQuestion(author(), {
      bankId, kind: 'free', stem: stem('Що зробиш, якщо гість каже, що піца холодна?'),
      answer: { criteria: ['Вибачення', 'Заміна'], reference: 'Вибачитись, замінити' }, isCritical: false, difficulty: 3, points: 2, scoringMethod: 'formula', attachFiles: false, negativeMarking: false, tags: [],
    })).id

    const quiz = await createQuiz(author(), { title: 'Тест гарячого цеху', kind: 'quiz', tags: [], selectionMode: 'fixed', requiresOfflineConfirm: false })
    quizId = quiz.id
    quizIds.push(quizId)
    // Правила — в назначении, не в тесте (CLAUDE.md п. 11)
    assignmentIds.push(await assignWithParams(author(), 'test', quizId, { passScore: 60, attemptsAllowed: 2, shuffleQuestions: false, shuffleOptions: false }, [learnerId]))
    const updated = await setQuizQuestions(author(), quizId, [
      { questionId: qSingle, sort: 0 }, { questionId: qNumber, sort: 1 }, { questionId: qLong, sort: 2 },
    ])
    expect(updated!.questionCount).toBe(3)
    expect(Number(updated!.totalPoints)).toBe(5)
  })

  it('старт: снапшот с эталонами в БД, состояние для ученика — без эталонов (attempt-leak)', async () => {
    const intro = await quizIntro(learner(), quizId)
    expect(intro!.attemptsLeft).toBe(2)

    const r = await startAttempt(learner(), quizId)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    attemptId = r.attemptId

    const [row] = await admin`select snapshot from attempts where id = ${attemptId}`
    const snap = row!.snapshot as { id: string, answer: unknown }[]
    expect(snap.find(q => q.id === qSingle)!.answer).toEqual({ correctId: 'b' })

    const state = await getAttemptState(learner(), attemptId)
    const json = JSON.stringify(state)
    expect(json).not.toContain('correctId')
    expect(json).not.toContain('"explanation"')
    expect(json).not.toContain('Вибачитись, замінити')
    expect(state!.questions.length).toBe(3)
    expect(state!.questions[0]).not.toHaveProperty('answer')
  })

  it('повторный старт возвращает ту же активную попытку', async () => {
    const r = await startAttempt(learner(), quizId)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('in_progress')
      expect(r.attemptId).toBe(attemptId)
    }
  })

  it('правка эталона после старта не меняет попытку (снапшот иммутабелен)', async () => {
    await updateQuestion(author(), qSingle, { answer: { correctId: 'c' } })
    const [q] = await admin`select version from questions where id = ${qSingle}`
    expect(q!.version).toBe(2)
    const [row] = await admin`select snapshot from attempts where id = ${attemptId}`
    const snap = row!.snapshot as { id: string, answer: { correctId: string }, version: number }[]
    expect(snap.find(x => x.id === qSingle)!.answer.correctId).toBe('b')
    expect(snap.find(x => x.id === qSingle)!.version).toBe(1)
  })

  it('ответы сохраняются идемпотентно, submit → review (есть ручной), автопроверка по снапшоту', async () => {
    expect((await saveAnswer(learner(), attemptId, qSingle, { optionId: 'a' })).ok).toBe(true)
    expect((await saveAnswer(learner(), attemptId, qSingle, { optionId: 'b' })).ok).toBe(true) // последний побеждает
    expect((await saveAnswer(learner(), attemptId, qNumber, { value: '125' })).ok).toBe(true)
    expect((await saveAnswer(learner(), attemptId, qLong, { text: 'Вибачусь і заміню піцу за рахунок закладу' })).ok).toBe(true)

    const r = await submitAttempt(learner(), attemptId)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.status).toBe('review')
    expect(r.passed).toBeNull()
    expect(r.pendingManual).toBe(1)
    // 2 (single по снапшоту b=верно) + 1 (number 125 в допуске) из 5 = 60%
    expect(r.score).toBe(60)

    const locked = await saveAnswer(learner(), attemptId, qSingle, { optionId: 'c' })
    expect(locked.ok).toBe(false)
    if (!locked.ok) expect(locked.code).toBe('locked')
  })

  it('очередь наставника: ответ виден, свои попытки не попадают; зачёт → passed и балл 100', async () => {
    const queue = await reviewQueue(mentor())
    const item = queue.find(i => i.attemptId === attemptId)
    expect(item).toBeDefined()
    expect(item!.question!.criteria).toEqual(['Вибачення', 'Заміна'])

    const own = await reviewQueue(learner())
    expect(own.some(i => i.attemptId === attemptId)).toBe(false)

    const self = await gradeManual(learner(), item!.answerId, { isCorrect: true })
    expect(self.ok).toBe(false)

    const graded = await gradeManual(mentor(), item!.answerId, { isCorrect: true, comment: 'Добре' })
    expect(graded.ok).toBe(true)
    if (graded.ok) expect(graded.attemptStatus).toBe('passed')

    const result = await getAttemptResult(learner(), attemptId)
    expect(result!.locked).toBe(false)
    if (result!.locked) return
    expect(result!.score).toBe(100)
    expect(result!.passed).toBe(true)
    // show_answers=after_attempt → разбор виден
    const single = result!.questions.find(q => q.id === qSingle)!
    expect(single).toHaveProperty('answer')
    expect(single.reviewComment).toBeNull()
    expect(result!.questions.find(q => q.id === qLong)!.reviewComment).toBe('Добре')
  })

  it('критический вопрос: 66% но ошибка в критическом → failed; попытки исчерпаны', async () => {
    const r = await startAttempt(learner(), quizId)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // Эталон уже 'c' (после правки); отвечаем 'a' — ошибка в критическом
    await saveAnswer(learner(), r.attemptId, qSingle, { optionId: 'a' })
    await saveAnswer(learner(), r.attemptId, qNumber, { value: 120 })
    await saveAnswer(learner(), r.attemptId, qLong, { text: 'x' })
    const s = await submitAttempt(learner(), r.attemptId)
    expect(s.ok).toBe(true)
    if (!s.ok) return
    expect(s.status).toBe('review')

    const queue = await reviewQueue(mentor())
    const item = queue.find(i => i.attemptId === r.attemptId)!
    const g = await gradeManual(mentor(), item.answerId, { isCorrect: true })
    if (g.ok) expect(g.attemptStatus).toBe('failed')

    const third = await startAttempt(learner(), quizId)
    expect(third.ok).toBe(false)
    if (!third.ok) expect(third.code).toBe('attempts_exhausted')

    // Аннулирование освобождает попытку
    await annulAttempt(mentor(), r.attemptId, 'Тестова аннуляція')
    const intro = await quizIntro(learner(), quizId)
    expect(intro!.attemptsLeft).toBe(1)
  })
})

describe('тест как урок курса → сертификат', () => {
  let courseId: string
  let enrollmentId: string
  let quizId: string
  let lessonQuizId: string

  it('курс: урок-материал + урок-тест; сдача теста закрывает урок и курс', async () => {
    const bank = await createBank(author(), { name: `Тест-банк ${Date.now()}b` })
    const q = await createQuestion(author(), {
      bankId: bank.id, kind: 'single', stem: stem('2+2?'), options: opts('a', 'b'),
      answer: { correctId: 'a' }, isCritical: false, difficulty: 1, points: 1, scoringMethod: 'formula', attachFiles: false, negativeMarking: false, tags: [],
    })
    const quiz = await createQuiz(author(), { title: 'Фінальний тест', kind: 'quiz', tags: [], selectionMode: 'fixed', requiresOfflineConfirm: false })
    quizId = quiz.id
    quizIds.push(quizId)
    await setQuizQuestions(author(), quizId, [{ questionId: q.id, sort: 0 }])

    const course = await createCourse(author(), { title: `Курс із тестом ${Date.now()}`, language: 'uk', strictOrder: true, isCatalogVisible: true, tags: [], validityMonths: 12 })
    courseId = course.id
    courseIds.push(courseId)
    const mod = await addModule(author(), courseId, 'Розділ')
    await addLesson(author(), { moduleId: mod!.id, title: 'Матеріал', itemType: 'resource', resource: { body: stem('Читай') }, isRequired: true, videoThresholdPct: 90 })
    // Порог теста в плане курса (docs/11 §14.1); попытки — умолчания тенанта
    const quizLesson = await addLesson(author(), { moduleId: mod!.id, title: 'Тест', itemType: 'quiz', quizId, isRequired: true, videoThresholdPct: 90, passScorePct: 100 })
    lessonQuizId = quizLesson!.id
    expect((await publishCourse(author(), courseId, 'v1')).ok).toBe(true)

    const enr = await selfEnroll(learner(), courseId)
    if (!enr.ok) throw new Error(enr.code)
    enrollmentId = enr.enrollmentId

    const tree = await enrollmentTree(learner(), enrollmentId)
    const [mat, test] = tree!.modules[0]!.lessons
    expect(test!.itemType).toBe('quiz')
    expect(test!.status).toBe('locked')

    await openLesson(learner(), enrollmentId, mat!.id)
    await completeLesson(learner(), enrollmentId, mat!.id)
    await openLesson(learner(), enrollmentId, lessonQuizId)
    // Кнопкой урок-тест не закрыть
    const byButton = await completeLesson(learner(), enrollmentId, lessonQuizId)
    expect(byButton.ok).toBe(false)

    const start = await startAttempt(learner(), quizId, { enrollmentId, lessonId: lessonQuizId })
    if (!start.ok) throw new Error(start.code)
    await saveAnswer(learner(), start.attemptId, q.id, { optionId: 'a' })
    const s = await submitAttempt(learner(), start.attemptId)
    expect(s.ok && s.status).toBe('passed')

    const after = await enrollmentTree(learner(), enrollmentId)
    expect(after!.enrollment.status).toBe('done')
    expect(after!.modules[0]!.lessons[1]!.status).toBe('completed')
  })

  it('сертификат выдан один раз с номером LO-<год>-NNNNNN, срок 12 месяцев; повторная выдача — тот же', async () => {
    const mine = await myCertificates(learner())
    const cert = mine.find(c => c.courseTitle?.startsWith('Курс із тестом'))
    expect(cert).toBeDefined()
    expect(cert!.number).toMatch(/^LO-\d{4}-\d{6}$/)
    expect(cert!.validUntil).not.toBeNull()

    const again = await issueForEnrollment(author(), enrollmentId)
    expect(again.ok).toBe(true)
    if (again.ok) {
      expect(again.created).toBe(false)
      expect(again.number).toBe(cert!.number)
    }
    const [{ count }] = await admin<[{ count: number }]>`select count(*)::int as count from certificates where enrollment_id = ${enrollmentId}`
    expect(count).toBe(1)
  })

  it('PDF: рендер в S3 идемпотентен, ссылка подписанная, чужой и отозванный не отдаются (docs/14 §7.5, §13.7)', async () => {
    const { pdfUrl, renderAndStore } = await import('../../server/services/certificatePdf')
    const mine = await myCertificates(learner())
    const cert = mine.find(c => c.courseTitle?.startsWith('Курс із тестом'))!
    const first = await renderAndStore(tenantId, cert.id)
    expect(first).toMatchObject({ created: true })
    expect(first!.key).toMatch(/^t\/.+\/certificates\/LO-\d{4}-\d{6}\.pdf$/)
    expect(await renderAndStore(tenantId, cert.id)).toMatchObject({ key: first!.key, created: false })
    const own = await pdfUrl(learner(), cert.id, { manage: false })
    expect('url' in own && own.url).toMatch(/X-Amz-Signature/)
    expect(await pdfUrl(mentor(), cert.id, { manage: false })).toEqual({ error: 'forbidden' })
    expect('url' in (await pdfUrl(mentor(), cert.id, { manage: true }))).toBe(true)
  })

  it('публичная проверка по токену без входа; отзыв меняет статус', async () => {
    const mine = await myCertificates(learner())
    const cert = mine.find(c => c.courseTitle?.startsWith('Курс із тестом'))!
    const pub = await publicCertificate(cert.publicToken)
    expect(pub!.number).toBe(cert.number)
    expect(pub!.revoked_at).toBeNull()
    expect(pub).not.toHaveProperty('phone')

    expect(await publicCertificate('nope')).toBeNull()

    await revokeCertificate(author(), cert.id, 'Помилка при видачі')
    expect((await publicCertificate(cert.publicToken))!.revoked_at).not.toBeNull()
    const { pdfUrl } = await import('../../server/services/certificatePdf')
    expect(await pdfUrl(learner(), cert.id, { manage: false })).toEqual({ error: 'revoked' })
  })
})
