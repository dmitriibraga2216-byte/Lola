import 'dotenv/config'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Spec 12 (docs/12 §14, docs/32 Б.6): группы вопросов + one_per_group, scoring_method,
 * grader_hint и вложения к free, очередь проверки по ответам с метками, запросы дополнительных
 * попыток, «Перерахувати», копия / ссылка из банка, протокол после последней попытки, 404 чужого тенанта.
 */
const { createBank, createQuestion, updateQuestion, createQuiz, setQuizQuestions, createGroup, listGroups, updateGroup, deleteGroup, importQuestions, getQuizEditor }
  = await import('../../server/services/questions')
const { startAttempt, saveAnswer, submitAttempt, getAttemptResult, gradeManual, listReviewAnswers, recalculateAttempt, recalculateQuiz, listAttemptResults, addAnswerFile, quizIntro, getAttemptState }
  = await import('../../server/services/attempts')
const { createAttemptRequest, listAttemptRequests, decideAttemptRequest, myAttemptRequests } = await import('../../server/services/attemptRequests')
const { assignWithParams } = await import('./_assign')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const stamp = Date.now()

let tenantId: string
let otherTenantId: string
let authorId: string
let mentorId: string
let learnerId: string
let bankId: string
const quizIds: string[] = []
const assignmentIds: string[] = []

const author = () => ({ tenantId, actorId: authorId })
const mentor = () => ({ tenantId, actorId: mentorId })
const learner = () => ({ tenantId, actorId: learnerId })
const stem = (text: string) => [{ id: 'b1', type: 'text' as const, html: `<p>${text}</p>` }]
const opts = (...ids: string[]) => ids.map(id => ({ id, text: `Варіант ${id}` }))
const baseQ = { isCritical: false, difficulty: 3, points: 1, scoringMethod: 'formula' as const, attachFiles: false, negativeMarking: false, tags: [] as string[] }

async function singleQ(over: Partial<Parameters<typeof createQuestion>[1]> = {}) {
  return (await createQuestion(author(), { bankId, kind: 'single', stem: stem(`Питання ${Math.random()}`), options: opts('a', 'b', 'c'), answer: { correctId: 'a' }, ...baseQ, ...over })).id
}

beforeAll(async () => {
  const [t] = await admin`select id from tenants where slug = 'kappi'`
  tenantId = t!.id as string
  const pick = async (phone: string) => (await admin`select id from users where tenant_id = ${tenantId} and phone = ${phone}`)[0]!.id as string
  authorId = await pick('+380661864742')
  mentorId = await pick('+380670000002')
  learnerId = await pick('+380670000003')
  const [other] = await admin`insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції') on conflict (slug) do update set name = excluded.name returning id`
  otherTenantId = other!.id as string
  bankId = (await createBank(author(), { name: `Тест-банк s12 ${stamp}` })).id
})

afterAll(async () => {
  if (quizIds.length) {
    await admin`delete from attempt_requests where quiz_id in ${admin(quizIds)}`
    await admin`delete from attempts where quiz_id in ${admin(quizIds)}`
    await admin`delete from quizzes where id in ${admin(quizIds)}`
  }
  if (assignmentIds.length) await admin`delete from assignments where id in ${admin(assignmentIds)}`
  await admin`delete from question_banks where id = ${bankId}`
  await admin`delete from notifications where tenant_id = ${tenantId} and code like 'attempt_request_%'`
  await admin.end()
})

describe('группы вопросов и «одне питання від кожної групи»', () => {
  let quizId: string
  let groupA: string
  let groupB: string
  const ids: string[] = []

  it('CRUD групп теста', async () => {
    quizId = (await createQuiz(author(), { title: 'Тест з групами', kind: 'quiz', tags: [], selectionMode: 'fixed', requiresOfflineConfirm: false })).id
    quizIds.push(quizId)
    groupA = (await createGroup(author(), quizId, { title: 'Каса', sortOrder: 0 }))!.id
    groupB = (await createGroup(author(), quizId, { title: 'Зал', sortOrder: 1 }))!.id
    expect((await listGroups(author(), quizId))!.map(g => g.title)).toEqual(['Каса', 'Зал'])
    await updateGroup(author(), groupB, { title: 'Зал і бар' })
    expect((await getQuizEditor(author(), quizId))!.groups.map(g => g.title)).toEqual(['Каса', 'Зал і бар'])
    // Чужая группа (другого тенанта) при создании вопроса — 404
    const [foreign] = await admin`insert into question_groups (tenant_id, quiz_id, title) select ${otherTenantId}, id, 'Чужа' from quizzes where id = ${quizId} returning id`
    await admin`update question_groups set tenant_id = ${otherTenantId} where id = ${foreign!.id}`
    await expect(createQuestion(author(), { bankId, kind: 'single', stem: stem('x'), options: opts('a', 'b'), answer: { correctId: 'a' }, ...baseQ, questionGroupId: foreign!.id as string }))
      .rejects.toMatchObject({ code: 'question_group_not_found' })
    await admin`delete from question_groups where id = ${foreign!.id}`
  })

  it('снимок с one_per_group: по одному вопросу из группы, без группы — все; выбор зафиксирован', async () => {
    for (let i = 0; i < 3; i++) ids.push(await singleQ({ questionGroupId: groupA }))
    for (let i = 0; i < 3; i++) ids.push(await singleQ({ questionGroupId: groupB }))
    ids.push(await singleQ()) // без группы — всегда в попытке
    await setQuizQuestions(author(), quizId, ids.map((questionId, sort) => ({ questionId, sort })))
    assignmentIds.push(await assignWithParams(author(), 'test', quizId, { attemptsAllowed: 0, questionsMode: 'one_per_group', shuffleQuestions: false, shuffleOptions: false }, [learnerId]))

    const intro = await quizIntro(learner(), quizId)
    expect(intro!.questionCount).toBe(3)

    const r = await startAttempt(learner(), quizId)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const [row] = await admin`select snapshot from attempts where id = ${r.attemptId}`
    const snap = row!.snapshot as { id: string, groupId: string | null }[]
    expect(snap.length).toBe(3)
    expect(snap.filter(q => q.groupId === groupA).length).toBe(1)
    expect(snap.filter(q => q.groupId === groupB).length).toBe(1)
    expect(snap.filter(q => q.groupId === null).length).toBe(1)
    // Состояние ученика — те же три вопроса, снимок стабилен
    const state = await getAttemptState(learner(), r.attemptId)
    expect(state!.questions.map(q => q.id)).toEqual(snap.map(q => q.id))
    await submitAttempt(learner(), r.attemptId)
  })

  it('удаление группы не трогает вопросы и снимки', async () => {
    await deleteGroup(author(), groupA)
    const [q] = await admin`select question_group_id from questions where id = ${ids[0]!}`
    expect(q!.question_group_id).toBeNull()
    const [a] = await admin`select snapshot from attempts where quiz_id = ${quizId} limit 1`
    expect((a!.snapshot as { groupId: string | null }[]).some(s => s.groupId === groupA)).toBe(true)
  })
})

describe('scoring_method, grader_hint и вложения к free', () => {
  let quizId: string
  let qMulti: string
  let qClass: string
  let qMap: string
  let qFree: string
  let attemptId: string
  let mediaId: string

  it('вопросы: multi all_or_nothing, classification formula, answer_by_map, free с підказкою і файлами', async () => {
    quizId = (await createQuiz(author(), { title: 'Тест scoring', kind: 'quiz', tags: [], selectionMode: 'fixed', requiresOfflineConfirm: false })).id
    quizIds.push(quizId)
    qMulti = (await createQuestion(author(), { bankId, kind: 'multi', stem: stem('Оберіть два'), options: opts('a', 'b', 'c', 'd'), answer: { correctIds: ['a', 'b'] }, ...baseQ, points: 4, scoringMethod: 'all_or_nothing' })).id
    qClass = (await createQuestion(author(), {
      bankId, kind: 'classification', stem: stem('Розкладіть по цехах'),
      options: { groups: [{ id: 'hot', title: 'Гарячий' }, { id: 'cold', title: 'Холодний' }], items: opts('pizza', 'salad', 'soup', 'ice') },
      answer: { placements: [{ itemId: 'pizza', groupId: 'hot' }, { itemId: 'soup', groupId: 'hot' }, { itemId: 'salad', groupId: 'cold' }, { itemId: 'ice', groupId: 'cold' }] },
      ...baseQ, points: 4,
    })).id
    const [media] = await admin`insert into media_assets (tenant_id, key, original_name, kind, mime, bytes, status, owner_user_id) values (${tenantId}, ${`t/${tenantId}/s12-${stamp}.png`}, 'plan.png', 'image', 'image/png', 10, 'ready', ${authorId}) returning id`
    mediaId = media!.id as string
    qMap = (await createQuestion(author(), {
      bankId, kind: 'answer_by_map', stem: stem('Де зона видачі?'),
      options: { imageMediaId: mediaId, areas: [{ id: 'z1', shape: 'rect', x: 0, y: 0, w: 0.5, h: 0.5 }, { id: 'z2', shape: 'circle', cx: 0.75, cy: 0.75, r: 0.2 }] },
      answer: { areaIds: ['z2'] }, ...baseQ, points: 2,
    })).id
    qFree = (await createQuestion(author(), { bankId, kind: 'free', stem: stem('Ваші дії при розбіжності каси?'), answer: { criteria: ['акт', 'адміністратор'] }, ...baseQ, points: 2, graderHint: 'Достатньо двох із трьох: звірити чек, акт, покликати адміністратора', attachFiles: true, tags: ['каса'] })).id
    await setQuizQuestions(author(), quizId, [qMulti, qClass, qMap, qFree].map((questionId, sort) => ({ questionId, sort })))
    assignmentIds.push(await assignWithParams(author(), 'test', quizId, { attemptsAllowed: 3, passScore: 50, shuffleQuestions: false, shuffleOptions: false }, [learnerId]))
    // Невалидная классификация — вариант без класса
    const { questionSchema } = await import('../../shared/schemas/quizzes')
    const bad = questionSchema.safeParse({ bankId, kind: 'classification', stem: stem('x'), options: { groups: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], items: opts('1', '2') }, answer: { placements: [{ itemId: '1', groupId: 'a' }] } })
    expect(bad.success).toBe(false)
  })

  it('ученик не видит grader_hint; файл к free через медиа; все або нічого и частка вірних', async () => {
    const r = await startAttempt(learner(), quizId)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    attemptId = r.attemptId
    const state = await getAttemptState(learner(), attemptId)
    expect(JSON.stringify(state)).not.toContain('Достатньо двох')
    expect(state!.questions.find(q => q.id === qFree)).toMatchObject({ attachFiles: true })

    await saveAnswer(learner(), attemptId, qMulti, { optionIds: ['a'] }) // all_or_nothing → 0
    await saveAnswer(learner(), attemptId, qClass, { placements: [{ itemId: 'pizza', groupId: 'hot' }, { itemId: 'soup', groupId: 'hot' }, { itemId: 'salad', groupId: 'cold' }, { itemId: 'ice', groupId: 'hot' }] }) // 3 з 4
    await saveAnswer(learner(), attemptId, qMap, { points: [{ x: 0.7, y: 0.7 }] }) // попадание в z2
    await saveAnswer(learner(), attemptId, qFree, { text: 'Скласти акт і покликати адміністратора' })
    const f = await addAnswerFile(learner(), attemptId, qFree, { mediaId, name: 'photo.png', kind: 'photo', bytes: 10 })
    expect(f.ok).toBe(true)
    // К multi файл не прикрепляется
    expect((await addAnswerFile(learner(), attemptId, qMulti, { mediaId, name: 'x.png', kind: 'photo', bytes: 10 })).ok).toBe(false)

    const s = await submitAttempt(learner(), attemptId)
    expect(s.ok && s.status).toBe('review')
    const rows = await admin`select question_id, score, is_correct from attempt_answers where attempt_id = ${attemptId}`
    const by = Object.fromEntries(rows.map(r => [r.question_id as string, r]))
    expect(Number(by[qMulti]!.score)).toBe(0)
    expect(Number(by[qClass]!.score)).toBe(3)
    expect(Number(by[qMap]!.score)).toBe(2)
    expect(by[qFree]!.is_correct).toBeNull()
    // Запись результата после submit
    const results = await listAttemptResults(mentor(), attemptId)
    expect(results!.map(x => x.reason)).toEqual(['submit'])
  })

  it('очередь по ответам: вкладки, метка вопроса, подсказка проверяющему, файлы; после зачёта — «Перевірені»', async () => {
    const unchecked = await listReviewAnswers(mentor(), { checked: 'unchecked', tags: ['каса'], outsidePrograms: true, outsideCourses: true, limit: 200 })
    const item = unchecked.find(i => i.attemptId === attemptId)
    expect(item).toBeDefined()
    expect(item!.question!.graderHint).toContain('Достатньо')
    expect(item!.questionTags).toEqual(['каса'])
    expect(item!.files.length).toBe(1)
    expect(item!.positionName === null || typeof item!.positionName === 'string').toBe(true)
    // Другая метка — ответ не попадает
    expect((await listReviewAnswers(mentor(), { checked: 'unchecked', tags: ['бар'], outsidePrograms: false, outsideCourses: false, limit: 200 })).some(i => i.attemptId === attemptId)).toBe(false)
    // Ученик свою же работу не проверяет
    expect((await listReviewAnswers(learner(), { checked: 'all', tags: [], outsidePrograms: false, outsideCourses: false, limit: 200 })).some(i => i.attemptId === attemptId)).toBe(false)

    const g = await gradeManual(mentor(), item!.answerId, { isCorrect: true, score: 2, comment: 'Так' })
    expect(g.ok && g.attemptStatus).toBe('passed') // 0 + 3 + 2 + 2 = 7 з 12 = 58% ≥ 50
    const checked = await listReviewAnswers(mentor(), { checked: 'checked', tags: [], outsidePrograms: false, outsideCourses: false, limit: 200 })
    expect(checked.find(i => i.answerId === item!.answerId)).toMatchObject({ isCorrect: true, score: 2 })
    expect((await listReviewAnswers(mentor(), { checked: 'unchecked', tags: [], outsidePrograms: false, outsideCourses: false, limit: 200 })).some(i => i.answerId === item!.answerId)).toBe(false)
    expect((await listAttemptResults(mentor(), attemptId))!.map(x => x.reason)).toEqual(['submit', 'review'])
  })

  it('«Перерахувати»: правка ключа меняет результат, снимок и ручная оценка не трогаются, есть запись и аудит', async () => {
    const [before] = await admin`select score, status, snapshot from attempts where id = ${attemptId}`
    // Автор понял, что верный ответ — a, c
    await updateQuestion(author(), qMulti, { answer: { correctIds: ['a', 'c'] }, scoringMethod: 'formula' })
    const r = await recalculateAttempt(author(), attemptId, 'Виправлено ключ')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.changed).toBe(true)
    const [after] = await admin`select score, status, snapshot from attempts where id = ${attemptId}`
    expect(after!.snapshot).toEqual(before!.snapshot) // снимок иммутабелен (CLAUDE.md п. 4)
    expect(Number(after!.score)).toBeGreaterThan(Number(before!.score)) // multi: 1 з 2 верных → 2 балла
    const rows = await admin`select question_id, score from attempt_answers where attempt_id = ${attemptId}`
    expect(Number(rows.find(x => x.question_id === qMulti)!.score)).toBe(2)
    expect(Number(rows.find(x => x.question_id === qFree)!.score)).toBe(2) // ручная оценка сохранена
    expect((await listAttemptResults(mentor(), attemptId))!.map(x => x.reason)).toEqual(['submit', 'review', 'recalculate'])
    const [audit] = await admin`select before, after from audit_log where action = 'attempt.recalculate' and entity_id = ${attemptId} order by created_at desc limit 1`
    expect(audit).toBeDefined()
    expect((audit!.after as { comment: string }).comment).toBe('Виправлено ключ')
    // Пересчёт по тесту целиком
    const bulk = await recalculateQuiz(author(), quizId)
    expect(bulk).toMatchObject({ total: 1 })
    // Идущую попытку пересчитывать нечего
    const r2 = await startAttempt(learner(), quizId)
    if (r2.ok) {
      expect((await recalculateAttempt(author(), r2.attemptId)).ok).toBe(false)
      await admin`delete from attempts where id = ${r2.attemptId}`
    }
  })
})

describe('запросы дополнительных попыток и протокол після останньої спроби', () => {
  let quizId: string
  let qId: string

  it('без попыток запрос не создаётся; после исчерпания — создаётся один, наставник даёт попытку → старт возможен', async () => {
    quizId = (await createQuiz(author(), { title: 'Тест з лімітом', kind: 'quiz', tags: [], selectionMode: 'fixed', requiresOfflineConfirm: false })).id
    quizIds.push(quizId)
    qId = await singleQ()
    await setQuizQuestions(author(), quizId, [{ questionId: qId, sort: 0 }])
    assignmentIds.push(await assignWithParams(author(), 'test', quizId, { attemptsAllowed: 1, passScore: 80, protocolAfterLastAttempt: true, shuffleQuestions: false, shuffleOptions: false }, [learnerId]))

    expect((await createAttemptRequest(learner(), quizId, { reason: 'Впав інтернет на точці' })).ok).toBe(false)

    const a1 = await startAttempt(learner(), quizId)
    expect(a1.ok).toBe(true)
    if (!a1.ok) return
    await saveAnswer(learner(), a1.attemptId, qId, { optionId: 'b' })
    await submitAttempt(learner(), a1.attemptId)
    const res1 = await getAttemptResult(learner(), a1.attemptId)
    // Последняя из одной попытки → протокол показывается
    expect(res1 && !res1.locked && res1.protocol).toBe('shown')

    expect((await startAttempt(learner(), quizId)).ok).toBe(false)
    expect((await quizIntro(learner(), quizId))!.attemptsLeft).toBe(0)

    const req = await createAttemptRequest(learner(), quizId, { reason: 'Впав інтернет на точці, не встиг' })
    expect(req.ok).toBe(true)
    if (!req.ok) return
    expect((await createAttemptRequest(learner(), quizId, { reason: 'Ще раз прошу спробу' })).ok).toBe(false) // уже есть pending
    expect((await quizIntro(learner(), quizId))!.pendingRequestId).toBe(req.id)
    expect((await myAttemptRequests(learner(), quizId)).map(r => r.status)).toEqual(['pending'])

    const queue = await listAttemptRequests(mentor(), { status: 'pending' })
    expect(queue.find(r => r.id === req.id)).toMatchObject({ attemptsUsed: 1, attemptsAllowed: 1, quizTitle: 'Тест з лімітом' })
    expect((await decideAttemptRequest(learner(), req.id, { approved: true })).ok).toBe(false) // не себе
    const d = await decideAttemptRequest(mentor(), req.id, { approved: true, comment: 'Добре' })
    expect(d.ok && d.status).toBe('approved')
    expect((await decideAttemptRequest(mentor(), req.id, { approved: false })).ok).toBe(false) // повторно нельзя
    expect((await listAttemptRequests(mentor(), { status: 'approved' })).some(r => r.id === req.id)).toBe(true)

    // Уведомления ушли и в аудит записано
    const [n] = await admin`select count(*)::int as n from notifications where user_id = ${learnerId} and code = 'attempt_request_decided'`
    expect(n!.n).toBeGreaterThan(0)
    const [au] = await admin`select count(*)::int as n from audit_log where action = 'attempt_request.decide' and entity_id = ${req.id}`
    expect(au!.n).toBe(1)

    // Лишняя попытка сверх лимита назначения; назначение не менялось
    expect((await quizIntro(learner(), quizId))!.attemptsLeft).toBe(1)
    const a2 = await startAttempt(learner(), quizId)
    expect(a2.ok).toBe(true)
    if (!a2.ok) return
    const [asg] = await admin`select params from assignments where id = ${assignmentIds[assignmentIds.length - 1]!}`
    expect((asg!.params as { attemptsAllowed: number }).attemptsAllowed).toBe(1)
    await saveAnswer(learner(), a2.attemptId, qId, { optionId: 'a' })
    await submitAttempt(learner(), a2.attemptId)
    expect((await startAttempt(learner(), quizId)).ok).toBe(false)
  })

  it('протокол лише після останньої спроби: при незачёте и оставшихся попытках разбор скрыт', async () => {
    const quiz2 = (await createQuiz(author(), { title: 'Тест протокол', kind: 'quiz', tags: [], selectionMode: 'fixed', requiresOfflineConfirm: false })).id
    quizIds.push(quiz2)
    await setQuizQuestions(author(), quiz2, [{ questionId: qId, sort: 0 }])
    assignmentIds.push(await assignWithParams(author(), 'test', quiz2, { attemptsAllowed: 2, passScore: 80, protocolAfterLastAttempt: true, hideCorrectInProtocol: true, shuffleQuestions: false, shuffleOptions: false }, [learnerId]))
    const a1 = await startAttempt(learner(), quiz2)
    if (!a1.ok) throw new Error(a1.code)
    await saveAnswer(learner(), a1.attemptId, qId, { optionId: 'b' })
    await submitAttempt(learner(), a1.attemptId)
    const r1 = await getAttemptResult(learner(), a1.attemptId)
    expect(r1 && !r1.locked && r1.protocol).toBe('after_last_attempt')
    expect(r1 && !r1.locked && r1.questions.length).toBe(0)
    expect(r1 && !r1.locked && r1.attemptsLeft).toBe(1)

    const a2 = await startAttempt(learner(), quiz2)
    if (!a2.ok) throw new Error(a2.code)
    await saveAnswer(learner(), a2.attemptId, qId, { optionId: 'b' })
    await submitAttempt(learner(), a2.attemptId)
    const r2 = await getAttemptResult(learner(), a2.attemptId)
    expect(r2 && !r2.locked && r2.protocol).toBe('shown')
    expect(r2 && !r2.locked && r2.questions[0]).not.toHaveProperty('answer') // «Приховати правильні відповіді»
    expect(r2 && !r2.locked && r2.questions[0]!.isCorrect).toBe(false)
  })
})

describe('копия из другого теста и ссылка из банка', () => {
  it('copy — независимая копия, link — та же запись; версия растёт при правке содержания', async () => {
    const src = (await createQuiz(author(), { title: 'Джерело', kind: 'quiz', tags: [], selectionMode: 'fixed', requiresOfflineConfirm: false })).id
    const dst = (await createQuiz(author(), { title: 'Приймач', kind: 'quiz', tags: [], selectionMode: 'fixed', requiresOfflineConfirm: false })).id
    quizIds.push(src, dst)
    const q1 = await singleQ()
    const q2 = await singleQ()
    await setQuizQuestions(author(), src, [{ questionId: q1, sort: 0 }, { questionId: q2, sort: 1 }])

    const copied = await importQuestions(author(), dst, { mode: 'copy', fromQuizId: src, questionIds: [q1] })
    expect(copied.ok && copied.added).toBe(1)
    if (!copied.ok) return
    const copyId = copied.questionIds[0]!
    expect(copyId).not.toBe(q1)
    await updateQuestion(author(), copyId, { stem: stem('Змінена копія') })
    const [orig] = await admin`select stem, version from questions where id = ${q1}`
    expect(JSON.stringify(orig!.stem)).not.toContain('Змінена копія')
    expect(orig!.version).toBe(1)
    const [cp] = await admin`select version from questions where id = ${copyId}`
    expect(cp!.version).toBe(2) // правка содержания подняла версию (Г-12.2)

    const linked = await importQuestions(author(), dst, { mode: 'link', questionIds: [q2] })
    expect(linked.ok && linked.questionIds).toEqual([q2])
    const editor = await getQuizEditor(author(), dst)
    expect(editor!.items.map(i => i.questionId)).toEqual([copyId, q2])
    expect(editor!.quiz.questionCount).toBe(2)
    // Повторная ссылка не дублирует
    expect((await importQuestions(author(), dst, { mode: 'link', questionIds: [q2] })).ok && editor!.quiz.questionCount).toBe(2)
    // Чужого/несуществующего вопроса — не найдено
    expect((await importQuestions(author(), dst, { mode: 'copy', fromQuizId: src, questionIds: ['00000000-0000-0000-0000-000000000000'] })).ok).toBe(false)
    // Аудит копии
    const [au] = await admin`select before from audit_log where action = 'question.copy' and entity_id = ${copyId}`
    expect((au!.before as { sourceId: string }).sourceId).toBe(q1)
  })
})

describe('чужой тенант — 404 / пусто', () => {
  it('группы, запросы и результаты другого тенанта не видны', async () => {
    const [q] = await admin`select id from quizzes where id = ${quizIds[0]!}`
    const foreignCtx = { tenantId: otherTenantId, actorId: authorId }
    expect(await listGroups(foreignCtx, q!.id as string)).toBeNull()
    expect((await listAttemptRequests(foreignCtx, { status: 'all' })).length).toBe(0)
    const [att] = await admin`select id from attempts where quiz_id in ${admin(quizIds)} limit 1`
    expect(await listAttemptResults(foreignCtx, att!.id as string)).toBeNull()
    expect((await recalculateAttempt(foreignCtx, att!.id as string)).ok).toBe(false)
    expect((await decideAttemptRequest(foreignCtx, '00000000-0000-0000-0000-000000000000', { approved: true })).ok).toBe(false)
  })
})
