import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const { createArticle, updateArticle, search, revisions, blocksToText, linkArticle } = await import('../../server/services/knowledge')
const { createSurvey, updateSurvey, mySurveys, respond, surveyReport, triggerCourseFeedback } = await import('../../server/services/surveys')
const { createNews, listNews, getNews, ackNews, newsReaders } = await import('../../server/services/news')
const { createWorkshop, submitWorkshop, reviewQueue, claim, grade, workshopForLearner, workshopSlaScan, addComment } = await import('../../server/services/workshops')
const { createCourse, addModule, addLesson, publishCourse } = await import('../../server/services/courses')
const { selfEnroll, enrollmentTree, openLesson, completeLesson } = await import('../../server/services/learning')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

let tenantId: string
let adminId: string
let mentorId: string
let learnerId: string
const courseIds: string[] = []
const articleIds: string[] = []
const surveyIds: string[] = []
const newsIds: string[] = []
const workshopIds: string[] = []

beforeAll(async () => {
  const [t] = await admin`select id from tenants where slug = 'kappi'`
  tenantId = t!.id as string
  const pick = async (phone: string) => (await admin`select id from users where tenant_id = ${tenantId} and phone = ${phone}`)[0]!.id as string
  adminId = await pick('+380661864742')
  mentorId = await pick('+380670000002')
  learnerId = await pick('+380670000003')
})

afterAll(async () => {
  if (workshopIds.length) {
    await admin`delete from workshop_submissions where workshop_id in ${admin(workshopIds)}`
    await admin`delete from workshops where id in ${admin(workshopIds)}`
  }
  if (courseIds.length) {
    await admin`delete from certificates where course_id in ${admin(courseIds)}`
    await admin`delete from enrollments where subject_id in ${admin(courseIds)}`
    await admin`delete from courses where id in ${admin(courseIds)}`
  }
  if (articleIds.length) await admin`delete from knowledge_articles where id in ${admin(articleIds)}`
  if (surveyIds.length) await admin`delete from surveys where id in ${admin(surveyIds)}`
  if (newsIds.length) await admin`delete from news where id in ${admin(newsIds)}`
  await admin.end()
})

const ctx = () => ({ tenantId, actorId: adminId })
const mentor = () => ({ tenantId, actorId: mentorId })
const learner = () => ({ tenantId, actorId: learnerId })
const text = (html: string) => [{ id: `b${Math.random().toString(36).slice(2, 6)}`, type: 'text' as const, html }]

describe('база знаний: поиск находит и статью, и урок (приёмка этапа 5)', () => {
  it('blocksToText извлекает текст из блоков', () => {
    expect(blocksToText([{ id: 'a', type: 'heading', level: 2, text: 'Риба' }, { id: 'b', type: 'text', html: '<p>Температура <b>0…+4</b></p>' }])).toBe('Риба Температура 0…+4')
  })

  it('статья + урок с «риба температура» → оба в выдаче; черновик статьи не ищется', async () => {
    const stamp = Date.now()
    const art = await createArticle(ctx(), { title: `Зберігання риби ${stamp}`, body: text('<p>Температура зберігання риби у холодильній камері — від 0 до +4 градусів.</p>'), tags: ['кухня'] })
    articleIds.push(art.id)
    await updateArticle(ctx(), art.id, { status: 'published' })

    const draft = await createArticle(ctx(), { title: `Чернетка риба ${stamp}`, body: text('<p>Риба температура чернетка</p>') })
    articleIds.push(draft.id)

    const courseId = await (async () => {
      const c = await createCourse(ctx(), { title: `Кухня ${stamp}`, language: 'uk', strictOrder: true, isCatalogVisible: true, tags: [] })
      courseIds.push(c.id)
      const m = await addModule(ctx(), c.id, 'Р')
      await addLesson(ctx(), { moduleId: m!.id, title: `Урок: температура риби ${stamp}`, itemType: 'resource', resource: { body: text('<p>Перевіряй температуру риби щозміни.</p>') }, isRequired: true, videoThresholdPct: 90 })
      await publishCourse(ctx(), c.id, 'v1')
      return c.id
    })()
    expect(courseId).toBeDefined()

    const hits = await search(learner(), 'риба температура')
    const kinds = new Set(hits.map(h => h.kind))
    expect(kinds.has('article')).toBe(true)
    expect(kinds.has('lesson')).toBe(true)
    expect(hits.some(h => h.id === art.id)).toBe(true)
    expect(hits.some(h => h.id === draft.id)).toBe(false)
    expect(hits[0]!.snippet.length).toBeGreaterThan(0)

    expect(await search(learner(), 'x')).toEqual([])
  })

  it('версии: правка тела создаёт ревизию; привязка к позиции', async () => {
    const art = await createArticle(ctx(), { title: `Версії ${Date.now()}`, body: text('<p>v1</p>') })
    articleIds.push(art.id)
    await updateArticle(ctx(), art.id, { body: text('<p>v2</p>'), comment: 'уточнення' })
    await updateArticle(ctx(), art.id, { tags: ['x'] }) // без контента — версия не растёт
    const revs = await revisions(ctx(), art.id)
    expect(revs.map(r => r.version)).toEqual([2, 1])
    expect(revs[0]!.comment).toBe('уточнення')

    const [pos] = await admin`select id from positions where tenant_id = ${tenantId} limit 1`
    const link = await linkArticle(ctx(), art.id, 'position', pos!.id as string)
    expect(link).not.toBeNull()
    expect(await linkArticle(ctx(), art.id, 'position', pos!.id as string)).toBeNull() // дубль
  })
})

describe('опросы', () => {
  it('анонимный опрос: дедуп ответов, порог 5 скрывает отчёт, потом распределение и среднее', async () => {
    const s = await createSurvey(ctx(), {
      title: `Анонімне ${Date.now()}`, kind: 'survey', isAnonymous: true,
      questions: [{ id: 'q1', type: 'scale', text: 'Оцініть 1–5', required: true }, { id: 'q2', type: 'yesno', text: 'Рекомендуєте?' }, { id: 'q3', type: 'text', text: 'Коментар', required: false }],
    })
    surveyIds.push(s.id)
    await updateSurvey(ctx(), s.id, { status: 'active' })

    expect((await mySurveys(learner())).some(x => x.id === s.id)).toBe(true)

    const bad = await respond(learner(), s.id, { q2: 'yes' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.code).toBe('incomplete')

    expect((await respond(learner(), s.id, { q1: 4, q2: 'yes' })).ok).toBe(true)
    const again = await respond(learner(), s.id, { q1: 5, q2: 'no' })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.code).toBe('already')
    expect((await mySurveys(learner())).some(x => x.id === s.id)).toBe(false)

    // Ответ анонимен: user_id null
    const [row] = await admin`select user_id from survey_responses where survey_id = ${s.id}`
    expect(row!.user_id).toBeNull()

    const hidden = await surveyReport(ctx(), s.id)
    expect(hidden!.hidden).toBe(true)

    // Досыпаем 4 ответа напрямую — порог достигнут
    for (let i = 0; i < 4; i++) {
      await admin`insert into survey_responses (tenant_id, survey_id, respondent_hash, answers) values (${tenantId}, ${s.id}, ${`h${i}`}, ${JSON.stringify({ q1: 5, q2: i % 2 ? 'yes' : 'no' })}::jsonb)`
    }
    const rep = await surveyReport(ctx(), s.id)
    expect(rep!.hidden).toBe(false)
    expect(rep!.total).toBe(5)
    const q1 = rep!.questions.find(q => q.id === 'q1') as { avg: number, distribution: Record<string, number> }
    expect(q1.avg).toBe(4.8)
    expect(q1.distribution).toEqual({ '4': 1, '5': 4 })
  })

  it('автозапуск после курса: course_feedback → уведомление survey_invite', async () => {
    const c = await createCourse(ctx(), { title: `Фідбек ${Date.now()}`, language: 'uk', strictOrder: true, isCatalogVisible: true, tags: [] })
    courseIds.push(c.id)
    const m = await addModule(ctx(), c.id, 'Р')
    await addLesson(ctx(), { moduleId: m!.id, title: 'У', itemType: 'resource', resource: { body: text('<p>x</p>') }, isRequired: true, videoThresholdPct: 90 })
    await publishCourse(ctx(), c.id, 'v1')

    const s = await createSurvey(ctx(), { title: `Оцінка курсу ${Date.now()}`, kind: 'course_feedback', isAnonymous: false, questions: [{ id: 'q1', type: 'scale', text: 'Як вам курс?' }], triggerCourseId: c.id })
    surveyIds.push(s.id)
    await updateSurvey(ctx(), s.id, { status: 'active' })

    const e = await selfEnroll(learner(), c.id)
    if (!e.ok) throw new Error(e.code)
    await triggerCourseFeedback(tenantId, learnerId, c.id, e.enrollmentId)
    const [n] = await admin`select id from notifications where code = 'survey_invite' and user_id = ${learnerId} and payload->>'surveyId' = ${s.id}`
    expect(n).toBeDefined()
  })
})

describe('новости', () => {
  it('лента: закреплённая сверху, просмотр и подтверждение, список читателей', async () => {
    const stamp = Date.now()
    const plain = await createNews(ctx(), { title: `Звичайна ${stamp}`, body: text('<p>a</p>'), publish: true })
    const pinned = await createNews(ctx(), { title: `Важлива ${stamp}`, body: text('<p>b</p>'), isPinned: true, requiresAck: true, publish: true })
    const draft = await createNews(ctx(), { title: `Чернетка ${stamp}`, body: text('<p>c</p>') })
    newsIds.push(plain.id, pinned.id, draft.id)

    const feed = await listNews(learner())
    expect(feed[0]!.id).toBe(pinned.id)
    expect(feed.some(n => n.id === draft.id)).toBe(false)

    const opened = await getNews(learner(), pinned.id)
    expect(opened!.ackedAt).toBeNull()
    await ackNews(learner(), pinned.id)
    const readers = await newsReaders(ctx(), pinned.id)
    expect(readers.find(r => r.userId === learnerId)!.ackedAt).not.toBeNull()
    expect((await listNews(learner())).find(n => n.id === pinned.id)!.acked).toBe(true)
  })
})

describe('практикум: сдача → захват → доработка → зачёт → урок закрыт', () => {
  let workshopId: string

  let enrollmentId: string
  let lessonId: string
  let submissionId: string

  it('создание с критериями, курс с уроком-практикумом', async () => {
    const w = await createWorkshop(ctx(), {
      title: `Збери сет ${Date.now()}`, description: text('<p>Сфотографуй зібраний сет за чек-листом</p>'),
      submissionKinds: ['text', 'photo'], minTextLength: 20,
      criteria: [{ text: 'Температура 0…+4 на фото', isCritical: true }, { text: 'Всі позиції на місці' }],
      passRule: { type: 'all_criteria' }, reviewerRule: 'any_mentor', maxReworks: 1, slaHours: 48, status: 'published',
    })
    workshopId = w.id
    workshopIds.push(w.id)

    const c = await createCourse(ctx(), { title: `Курс з практикумом ${Date.now()}`, language: 'uk', strictOrder: false, isCatalogVisible: true, tags: [] })

    courseIds.push(c.id)
    const m = await addModule(ctx(), c.id, 'Р')
    const l = await addLesson(ctx(), { moduleId: m!.id, title: 'Практикум', itemType: 'workshop', workshopId, isRequired: true, videoThresholdPct: 90 })
    lessonId = l!.id
    await publishCourse(ctx(), c.id, 'v1')
    const e = await selfEnroll(learner(), c.id)
    if (!e.ok) throw new Error(e.code)
    enrollmentId = e.enrollmentId
    await openLesson(learner(), enrollmentId, lessonId)
    expect((await completeLesson(learner(), enrollmentId, lessonId)).ok).toBe(false) // кнопкой не закрыть
  })

  it('сдача: короткий текст → 422; нормальная → submitted с SLA; вторая → 409', async () => {
    const short = await submitWorkshop(learner(), workshopId, { text: 'мало', enrollmentId, lessonId })
    expect(short.ok).toBe(false)
    if (!short.ok) expect(short.reasons![0]).toMatch(/Мінімум 20/)

    const ok = await submitWorkshop(learner(), workshopId, { text: 'Зібрав сет за чек-листом, температура в нормі, фото додаю.', enrollmentId, lessonId, device: 'mobile' })
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    submissionId = ok.submissionId
    const [s] = await admin`select status, sla_due_at from workshop_submissions where id = ${submissionId}`
    expect(s!.status).toBe('submitted')
    expect(Math.round((new Date(s!.sla_due_at as string).getTime() - Date.now()) / 3_600_000)).toBe(48)

    const dup = await submitWorkshop(learner(), workshopId, { text: 'Ще раз відправляю, бо здається не дійшло', enrollmentId, lessonId })
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.code).toBe('already_submitted')
  })

  it('очередь: наставник видит, сам сдавший — нет; захват блокирует других; самопроверка 403', async () => {
    expect((await reviewQueue(mentor())).some(i => i.id === submissionId)).toBe(true)
    expect((await reviewQueue(learner())).some(i => i.id === submissionId)).toBe(false)

    expect((await claim(learner(), submissionId)).ok).toBe(false)
    expect((await claim(mentor(), submissionId)).ok).toBe(true)
    const byAdmin = await claim(ctx(), submissionId)
    expect(byAdmin.ok).toBe(false)
    if (!byAdmin.ok) expect(byAdmin.code).toBe('already_claimed')
    // Админ не видит захваченную (не протухшую) карточку
    expect((await reviewQueue(ctx())).some(i => i.id === submissionId)).toBe(false)
  })

  it('зачёт при проваленном критерии недоступен; доработка требует комментарий; лимит доработок', async () => {
    const partial = [{ criterionId: 'c1', passed: false }, { criterionId: 'c2', passed: true }]
    const acc = await grade(mentor(), submissionId, { decision: 'accepted', criteriaResults: partial })
    expect(acc.ok).toBe(false)
    if (!acc.ok) expect(acc.code).toBe('criteria_not_met')

    const noComment = await grade(mentor(), submissionId, { decision: 'rework', criteriaResults: partial, comment: 'ні' })
    expect(noComment.ok).toBe(false)
    if (!noComment.ok) expect(noComment.code).toBe('comment_required')

    const rw = await grade(mentor(), submissionId, { decision: 'rework', criteriaResults: partial, comment: 'На фото не видно температуру — зніми ще раз з термометром' })
    expect(rw.ok).toBe(true)
    const [n] = await admin`select id from notifications where code = 'workshop_rework' and user_id = ${learnerId}`
    expect(n).toBeDefined()

    const view = await workshopForLearner(learner(), workshopId, enrollmentId)
    expect(view!.current!.status).toBe('rework')
    expect(view!.current!.reworkCount).toBe(1)

    // Переотправка (та же сдача возвращается в submitted) → maxReworks=1 исчерпан → rework недоступен
    const re = await submitWorkshop(learner(), workshopId, { text: 'Переробив: додав фото з термометром, температура +2.', enrollmentId, lessonId })
    expect(re.ok).toBe(true)
    await claim(mentor(), submissionId)
    const rw2 = await grade(mentor(), submissionId, { decision: 'rework', criteriaResults: partial, comment: 'Ще раз перероби, будь ласка' })
    expect(rw2.ok).toBe(false)
    if (!rw2.ok) expect(rw2.code).toBe('rework_exhausted')
  })

  it('зачёт всех критериев → accepted, урок и курс completed; комментарий уведомляет', async () => {
    const all = [{ criterionId: 'c1', passed: true }, { criterionId: 'c2', passed: true }]
    const acc = await grade(mentor(), submissionId, { decision: 'accepted', criteriaResults: all })
    expect(acc.ok).toBe(true)
    const tree = await enrollmentTree(learner(), enrollmentId)
    expect(tree!.modules[0]!.lessons[0]!.status).toBe('completed')
    expect(tree!.enrollment.status).toBe('completed')

    await addComment(mentor(), submissionId, 'Гарна робота')
    const [c] = await admin`select id from notifications where code = 'workshop_comment' and user_id = ${learnerId}`
    expect(c).toBeDefined()
    const view = await workshopForLearner(learner(), workshopId, enrollmentId)
    expect(view!.comments.some(x => x.body === 'Гарна робота')).toBe(true)
  })

  it('sla_scan: протухший захват освобождается, просрочка > 2×SLA уходит руководителю', async () => {
    const w = await createWorkshop(ctx(), { title: `SLA ${Date.now()}`, description: text('<p>x</p>'), submissionKinds: ['text'], criteria: [{ text: 'к' }], reviewerRule: 'any_mentor', slaHours: 1, status: 'published' })
    workshopIds.push(w.id)
    const sub = await submitWorkshop(learner(), w.id, { text: 'Достатньо довгий текст для здачі практикуму' })
    if (!sub.ok) throw new Error(sub.code)
    await claim(mentor(), sub.submissionId)
    await admin`update workshop_submissions set claimed_at = now() - interval '31 minutes', sla_due_at = now() - interval '3 hours', submitted_at = now() - interval '4 hours' where id = ${sub.submissionId}`
    const [loc] = await admin`select l.id from locations l join user_placements up on up.location_id = l.id where up.user_id = ${learnerId} and up.ended_at is null limit 1`
    await admin`update locations set manager_id = ${adminId} where id = ${loc!.id}`

    const s = await workshopSlaScan(tenantId)
    expect(s.released).toBeGreaterThanOrEqual(1)
    expect(s.breached).toBeGreaterThanOrEqual(1)
    const [row] = await admin`select status, reviewer_id from workshop_submissions where id = ${sub.submissionId}`
    expect(row!.status).toBe('submitted')
    expect(row!.reviewer_id).toBeNull()
    await admin`update locations set manager_id = null where id = ${loc!.id}`
  })
})
