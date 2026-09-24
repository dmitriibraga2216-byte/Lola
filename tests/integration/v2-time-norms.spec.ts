import postgres from 'postgres'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { offboardingStartSchema } from '../../shared/schemas/offboarding'
import { timePlanFactQuerySchema } from '../../shared/schemas/timeNorms'

/**
 * PR-22 пакета `docs/v2` (`45-plan.md`): нормы времени на контент через сервис и базу
 * (`37-review-delegation.md` §3.5, §6.3, §7.13–7.15, §8, §9.3, §11).
 *
 * **Критерий приёмки 11** (`37` §13): «Дано норму 10 хв і факт 35 хв на вибірці 25, тоді
 * `deviation_flag = 'too_slow'`, автор отримав повідомлення, звіт §9.3 без імен, бал жодної
 * людини не змінився». Условие выхода плана — «флаг отклонения не меняет балл ни одного
 * человека» — доказывается снимком всех таблиц с баллами тенанта до и после всего, что делает
 * модуль норм: правки нормы, пересчёта с флагом и уведомлением, отчёта с выгрузкой,
 * «Застосувати» и повторного пересчёта.
 *
 * Факт собирается настоящим конвейером PR-21: сегменты измерения → свёртка `time.rollup` →
 * витрина `learning_time_totals`; норма её только читает. Автор, ушедший через офбординг, —
 * не адресат (как в PR-24): уведомление получает действующий соавтор, а если действующих
 * авторов нет — владелец категории курса.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const { applyObservedNorm, getTimeNorm, planFactExportRows, putTimeNorm, recalcNorms, timePlanFactReport } = await import('../../server/services/timeNorms')
const { rollupTenant } = await import('../../server/services/learningTimeRollup')
const { startOffboarding, completeOffboarding } = await import('../../server/services/offboarding')
const { createBank, createQuestion, createQuiz, setQuizQuestions } = await import('../../server/services/questions')
const { claim, createWorkshop, grade, submitWorkshop } = await import('../../server/services/workshops')
const { updateResource } = await import('../../server/services/resources')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const TAG = `PR22 ${Date.now()}`
const FIRED_PHONE = '+380990229999'
const LEARNER_PHONE = (i: number) => `+3809902200${String(i).padStart(2, '0')}`
const LEARNERS = 27

let tenantId: string
let otherTenantId: string
let adminId: string
let authorId: string
let mentorId: string
let employeeId: string
let cashierId: string
let firedAuthorId: string
let lazarevaId: string
let positionId: string
let categoryId: string
let courseId: string
let versionId: string
let r1: string
let r2: string
let r3: string
let l1: string
let l2: string
let l3: string
let quizId: string
let bankId: string
let workshopId: string | null = null
let foreignCourseId: string
let foreignLessonId: string
const learners: string[] = []
const enrollmentOf = new Map<string, string>()

const ctx = (actorId: string) => ({ tenantId, actorId })
const lesson = (id: string) => ({ subjectType: 'lesson' as const, subjectId: id })

async function normRow(subjectType: string, subjectId: string) {
  return (await admin`select * from content_time_norms where tenant_id = ${tenantId} and subject_type = ${subjectType} and subject_id = ${subjectId}`)[0]
}

async function deviationNotices() {
  return admin`select user_id, ref_id, channel, payload from notifications where tenant_id = ${tenantId} and code = 'content_time_deviation' order by created_at`
}

/**
 * Урок пройден и зачтён; время — сегментом измерения, как его записали бы биения (PR-21).
 * Сегмент начинается 240 минут назад; дополнительный (`extra`) — сразу за первым 35-минутным,
 * чтобы покрытие интервала осталось полным и прохождение — достоверным (§7.15).
 */
async function passLesson(userId: string, lessonId: string, seconds: number, opts: { stale?: boolean, extra?: boolean } = {}) {
  const enrollmentId = enrollmentOf.get(userId)!
  if (!opts.extra) {
    await admin`insert into lesson_progress (tenant_id, enrollment_id, lesson_id, status, first_opened_at, completed_at)
      values (${tenantId}, ${enrollmentId}, ${lessonId}, 'completed', now() - interval '5 hours', now() - interval '1 hour')`
  }
  const minutesAgo = opts.extra ? 204 : 240
  const beats = Math.ceil(seconds / 30)
  await admin`
    insert into learning_time_sessions (tenant_id, user_id, enrollment_id, subject_type, subject_id, kind, session_key, segment_no,
      beats_count, started_at, last_beat_at, closed_reason, credited_seconds, discarded_seconds, last_seq, last_credit, device)
    values (${tenantId}, ${userId}, ${enrollmentId}, 'lesson', ${lessonId}, 'content', gen_random_uuid(), 1, ${beats},
      now() - make_interval(mins => ${minutesAgo}), now() - make_interval(mins => ${minutesAgo}) + make_interval(secs => ${seconds}),
      ${opts.stale ? 'stale' : 'completed'}, ${seconds}, 0, ${beats}, 30, 'desktop')`
}

/** Попытка теста отправлена и оценена; время выполнения — сегментом измерения вида `attempt`. */
async function passQuiz(userId: string, seconds: number) {
  await admin`insert into attempts (tenant_id, quiz_id, user_id, attempt_no, snapshot, params, status, score, max_score, passed, started_at, submitted_at, graded_at)
    values (${tenantId}, ${quizId}, ${userId}, 1, '[]'::jsonb, '{}'::jsonb, 'passed', 90, 100, true, now() - interval '3 hours', now() - interval '2 hours', now() - interval '2 hours')`
  await admin`
    insert into learning_time_sessions (tenant_id, user_id, subject_type, subject_id, kind, session_key, segment_no,
      beats_count, started_at, last_beat_at, closed_reason, credited_seconds, discarded_seconds, last_seq, last_credit, device)
    values (${tenantId}, ${userId}, 'quiz', ${quizId}, 'attempt', gen_random_uuid(), 1, ${Math.ceil(seconds / 30)},
      now() - interval '3 hours' + interval '1 minute', now() - interval '3 hours' + interval '1 minute' + make_interval(secs => ${seconds}),
      'completed', ${seconds}, 0, ${Math.ceil(seconds / 30)}, 30, 'desktop')`
}

/**
 * Всё, что в тенанте называется баллом, результатом или зачётом: попытки, ответы, результаты,
 * сдачи практикумов, записи на курс, уроки, книга баллов (рейтинг, #114), шаги траекторий,
 * оценки кандидатов. Учётные колонки времени (`net_seconds`, `content_seconds`) сюда не входят —
 * их пишет свёртка PR-21, и норма к ним не прикасается.
 */
async function scoreSnapshot() {
  return {
    attempts: await admin`select id, status, score, max_score, passed, graded_at from attempts where tenant_id = ${tenantId} order by id`,
    answers: await admin`select id, is_correct, score from attempt_answers where tenant_id = ${tenantId} order by id`,
    results: await admin`select id, status, score, max_score, passed from attempt_results where tenant_id = ${tenantId} order by id`,
    submissions: await admin`select id, status, score, passed from workshop_submissions where tenant_id = ${tenantId} order by id`,
    enrollments: await admin`select id, status, progress_pct, score, completed_at from enrollments where tenant_id = ${tenantId} order by id`,
    lessons: await admin`select id, status, completed_at from lesson_progress where tenant_id = ${tenantId} order by id`,
    ledger: await admin`select id, user_id, currency, delta, balance_after, event from points_ledger where tenant_id = ${tenantId} order by id`,
    nodes: await admin`select id, status, score, passed from trajectory_node_states where tenant_id = ${tenantId} order by id`,
    candidates: await admin`select id, value_num from candidate_scores where tenant_id = ${tenantId} order by id`,
  }
}

async function cleanup() {
  await admin`delete from notifications where tenant_id = ${tenantId} and code = 'content_time_deviation'`
  await admin`delete from audit_log where tenant_id = ${tenantId} and entity = 'content_time_norm'`
  await admin`delete from content_time_norms where tenant_id in (${tenantId}, ${otherTenantId})`
  for (const r of await admin`select id from users where tenant_id = ${tenantId} and (phone = ${FIRED_PHONE} or phone like '+3809902200%')`) {
    const id = r.id as string
    await admin`delete from learning_time_sessions where user_id = ${id}`
    await admin`delete from learning_time_totals where user_id = ${id}`
    await admin`delete from review_queue_items where user_id = ${id}`
    await admin`delete from attempts where user_id = ${id}`
    await admin`delete from points_ledger where user_id = ${id}`
    await admin`delete from lesson_progress where enrollment_id in (select id from enrollments where user_id = ${id})`
    await admin`delete from enrollment_events where enrollment_id in (select id from enrollments where user_id = ${id})`
    await admin`delete from enrollments where user_id = ${id}`
    await admin`delete from offboarding_cases where user_id = ${id}`
    await admin`delete from employee_lifecycle_state where user_id = ${id}`
    await admin`delete from sessions where user_id = ${id}`
    await admin`delete from user_placements where user_id = ${id}`
    await admin`delete from notifications where user_id = ${id}`
    await admin`delete from security_log where user_id = ${id}`
    await admin`delete from audit_log where entity_id = ${id}`
    await admin`delete from users where id = ${id}`
  }
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  const [other] = await admin`
    insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції')
    on conflict (slug) do update set name = excluded.name returning id`
  otherTenantId = other!.id as string
  const pick = async (phone: string) => (await admin`select id from users where tenant_id = ${tenantId} and phone = ${phone}`)[0]!.id as string
  adminId = await pick('+380661864742')
  authorId = await pick('+380670000001')
  mentorId = await pick('+380670000002')
  employeeId = await pick('+380670000003')
  cashierId = await pick('+380670000004')
  const [pl] = await admin`select location_id, position_id from user_placements where user_id = ${employeeId} and is_primary and ended_at is null`
  lazarevaId = pl!.location_id as string
  positionId = pl!.position_id as string
  await cleanup()

  const [fired] = await admin`
    insert into users (tenant_id, kind, full_name, phone, status)
    values (${tenantId}, 'employee', ${`${TAG} Автор, що звільняється`}, ${FIRED_PHONE}, 'active') returning id`
  firedAuthorId = fired!.id as string

  // Курс в категории, которой владеет наставник: он — адресат сигнала, когда авторы ушли (§7.5 в `36`)
  categoryId = (await admin`insert into course_categories (tenant_id, name, owner_id) values (${tenantId}, ${`${TAG} Категорія`}, ${mentorId}) returning id`)[0]!.id as string
  courseId = (await admin`insert into courses (tenant_id, title, slug, category_id, status, created_by)
    values (${tenantId}, ${`${TAG} Курс`}, ${`pr22-${Date.now()}`}, ${categoryId}, 'published', ${adminId}) returning id`)[0]!.id as string
  versionId = (await admin`insert into course_versions (tenant_id, course_id, version, status) values (${tenantId}, ${courseId}, 1, 'published') returning id`)[0]!.id as string
  await admin`update courses set published_version_id = ${versionId} where id = ${courseId}`
  const moduleId = (await admin`insert into modules (tenant_id, course_version_id, title, sort) values (${tenantId}, ${versionId}, 'Модуль', 0) returning id`)[0]!.id as string
  const resource = async (title: string, authors: string[], estimatedMinutes: number | null) => (await admin`
    insert into resources (tenant_id, title, slug, kind, plain_text, author_ids, estimated_minutes, status)
    values (${tenantId}, ${`${TAG} ${title}`}, ${`pr22-${title}-${Date.now()}`}, 'article', ${'а'.repeat(5500)}, ${authors}::uuid[], ${estimatedMinutes}, 'published')
    returning id`)[0]!.id as string
  r1 = await resource('Стандарти подачі', [authorId, firedAuthorId], null)
  r2 = await resource('Каса', [firedAuthorId], 20)
  r3 = await resource('Гігієна', [authorId], null)
  const addLesson = async (title: string, resourceId: string, sort: number) => (await admin`
    insert into lessons (tenant_id, module_id, title, sort, item_type, item_id)
    values (${tenantId}, ${moduleId}, ${`${TAG} ${title}`}, ${sort}, 'resource', ${resourceId}) returning id`)[0]!.id as string
  l1 = await addLesson('Урок: стандарти подачі', r1, 0)
  l2 = await addLesson('Урок: каса', r2, 1)
  l3 = await addLesson('Урок: гігієна', r3, 2)

  // Тест из двух закрытых вопросов: авторасчёт 2 × 45 с (§7.13)
  const stem = (text: string) => [{ id: 'b1', type: 'text' as const, html: `<p>${text}</p>` }]
  bankId = (await createBank(ctx(authorId), { name: `${TAG} банк` })).id
  const q = async (text: string) => (await createQuestion(ctx(authorId), {
    bankId, kind: 'single', stem: stem(text), options: [{ id: 'a', text: 'Так' }, { id: 'b', text: 'Ні' }],
    answer: { correctId: 'a' }, isCritical: false, difficulty: 1, points: 1, scoringMethod: 'formula', attachFiles: false, negativeMarking: false, tags: [],
  })).id
  const q1 = await q(`${TAG} Руки миємо перед зміною?`)
  const q2 = await q(`${TAG} Фартух чистий?`)
  quizId = (await createQuiz(ctx(authorId), { title: `${TAG} Тест: гігієна`, kind: 'quiz', tags: [], selectionMode: 'fixed', requiresOfflineConfirm: false })).id
  await setQuizQuestions(ctx(authorId), quizId, [{ questionId: q1, sort: 0 }, { questionId: q2, sort: 1 }])

  // 27 сотрудников: первые десять — на точке «Лазарєва» (область видимости руководителя)
  for (let i = 0; i < LEARNERS; i++) {
    const [u] = await admin`insert into users (tenant_id, kind, full_name, phone, status)
      values (${tenantId}, 'employee', ${`${TAG} Учень ${i}`}, ${LEARNER_PHONE(i)}, 'active') returning id`
    const userId = u!.id as string
    learners.push(userId)
    if (i < 10) await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary) values (${tenantId}, ${userId}, ${lazarevaId}, ${positionId}, true)`
    const [e] = await admin`insert into enrollments (tenant_id, user_id, subject_id, version_id, source, status, started_at, progress_pct, score)
      values (${tenantId}, ${userId}, ${courseId}, ${versionId}, 'self', 'in_progress', now() - interval '6 hours', 60, 80) returning id`
    enrollmentOf.set(userId, e!.id as string)
    // Баллы рейтинга у каждого: снимок «до/после» не может совпасть по пустоте
    await admin`insert into points_ledger (tenant_id, user_id, currency, delta, balance_after, event, comment)
      values (${tenantId}, ${userId}, 'points', 10, 10, 'manual', ${TAG})`
    // L1: 25 достоверных прохождений по 35 минут и 2 оборванных (stale → unreliable)
    if (i < 25) await passLesson(userId, l1, 2100)
    else await passLesson(userId, l1, 600, { stale: true })
    // L2: 21 прохождение по 3 минуты при норме автора материала 20 минут
    if (i < 21) await passLesson(userId, l2, 180)
    // L3: 5 прохождений — меньше 10, данных нет
    if (i < 5) await passLesson(userId, l3, 300)
    // Тест: 12 оценённых попыток по 10 минут
    if (i < 12) await passQuiz(userId, 600)
  }

  // Урок чужого тенанта — норму на него не задать и не прочитать (CLAUDE.md п. 15)
  foreignCourseId = (await admin`insert into courses (tenant_id, title, slug) values (${otherTenantId}, 'Чужий курс', ${`pr22-foreign-${Date.now()}`}) returning id`)[0]!.id as string
  const [fv] = await admin`insert into course_versions (tenant_id, course_id, version, status) values (${otherTenantId}, ${foreignCourseId}, 1, 'published') returning id`
  const [fm] = await admin`insert into modules (tenant_id, course_version_id, title, sort) values (${otherTenantId}, ${fv!.id}, 'Модуль', 0) returning id`
  const [fr] = await admin`insert into resources (tenant_id, title, slug) values (${otherTenantId}, 'Чужий матеріал', ${`pr22-foreign-r-${Date.now()}`}) returning id`
  foreignLessonId = (await admin`insert into lessons (tenant_id, module_id, title, sort, item_type, item_id)
    values (${otherTenantId}, ${fm!.id}, 'Чужий урок', 0, 'resource', ${fr!.id}) returning id`)[0]!.id as string

  // Факт — настоящей свёрткой PR-21: сегменты → витрина
  await rollupTenant(tenantId, { windowMinutes: 600 })
})

afterAll(async () => {
  await cleanup()
  if (workshopId) {
    await admin`delete from review_queue_items where tenant_id = ${tenantId} and task_type = 'workshop' and source_id in (select id from workshop_submissions where workshop_id = ${workshopId})`
    await admin`delete from notifications where tenant_id = ${tenantId} and payload->>'submissionId' in (select id::text from workshop_submissions where workshop_id = ${workshopId})`
    await admin`delete from learning_time_sessions where subject_id = ${workshopId}`
    await admin`delete from workshop_submissions where workshop_id = ${workshopId}`
    await admin`delete from workshops where id = ${workshopId}`
  }
  await admin`delete from attempts where quiz_id = ${quizId}`
  await admin`delete from quizzes where id = ${quizId}`
  await admin`delete from question_banks where id = ${bankId}`
  await admin`delete from courses where id in (${courseId}, ${foreignCourseId})`
  await admin`delete from resources where tenant_id in (${tenantId}, ${otherTenantId}) and slug like 'pr22-%'`
  await admin`delete from course_categories where id = ${categoryId}`
  await admin`delete from audit_log where tenant_id = ${tenantId} and entity_id in (${r1}, ${r2}, ${r3})`
  await admin.end()
})

describe('критерий 11: норма 10 хв, факт 35 хв на выборке 25', () => {
  let before: Awaited<ReturnType<typeof scoreSnapshot>>

  it('соавтор уходит через офбординг — настоящим офбордингом, а не правкой статуса', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const started = await startOffboarding(ctx(adminId), offboardingStartSchema.parse({
      userId: firedAuthorId, reasonCode: 'own_wish', lastWorkingDay: today, courseIds: [], responsibleId: adminId,
    }))
    if (typeof started === 'string') throw new Error(`startOffboarding: ${started}`)
    const done = await completeOffboarding(ctx(adminId), started.id)
    expect(typeof done === 'string' ? done : done.state).toBe('done')
    expect((await admin`select status from users where id = ${firedAuthorId}`)[0]!.status).toBe('archived')
  })

  it('факт собран свёрткой PR-21: витрина есть, 25 достоверных и 2 недостоверных прохождения L1', async () => {
    const totals = await admin`select confidence, content_seconds from learning_time_totals where tenant_id = ${tenantId} and subject_id = ${l1}`
    expect(totals).toHaveLength(27)
    expect(totals.filter(t => t.confidence !== 'unreliable')).toHaveLength(25)
    expect(totals.filter(t => t.confidence !== 'unreliable').every(t => Number(t.content_seconds) === 2100)).toBe(true)
    before = await scoreSnapshot()
    // Снимок не пуст: у каждого из 27 — баллы, у 12 — оценённые попытки, у всех — записи на курс
    expect(before.ledger.length).toBeGreaterThanOrEqual(LEARNERS)
    expect(before.attempts.length).toBeGreaterThanOrEqual(12)
    expect(before.enrollments.length).toBeGreaterThanOrEqual(LEARNERS)
  })

  it('автор задаёт норму 10 хв (§6.3): строка нормы, флаг — no_data, пока факта в норме нет', async () => {
    const r = await putTimeNorm(ctx(authorId), lesson(l1), { source: 'author', authorSeconds: 600 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.norm).toMatchObject({ source: 'author', plannedSeconds: 600, persisted: true, deviationFlag: 'no_data', observedSample: 0 })
    const [audit] = await admin`select action, before, after from audit_log where tenant_id = ${tenantId} and entity = 'content_time_norm' and action = 'time_norm.update'`
    expect(audit).toBeDefined()
  })

  it('`time.norms_recalc`: deviation_flag = too_slow, медиана 35 хв, выборка 25 — недостоверные не вошли', async () => {
    const s = await recalcNorms(tenantId)
    expect(s.elements).toBeGreaterThanOrEqual(4)
    const n1 = await normRow('lesson', l1)
    expect(n1).toMatchObject({ source: 'author', author_seconds: 600, observed_seconds: 2100, observed_p25: 2100, observed_p75: 2100, observed_sample: 25, deviation_flag: 'too_slow' })
    expect(n1!.recalculated_at).not.toBeNull()
  })

  it('автор получил уведомление: in-app, «35 хв замість 10 хв»; ушедший соавтор — нет', async () => {
    const n1 = await normRow('lesson', l1)
    const notes = (await deviationNotices()).filter(n => n.ref_id === n1!.id)
    expect(notes.map(n => n.user_id)).toEqual([authorId])
    expect(notes[0]!.channel).toBe('inapp')
    expect(notes[0]!.payload).toMatchObject({ fact: '35', plan: '10', url: `/admin/reports/time-plan-fact?subjectType=lesson&subjectId=${l1}` })
    expect((await deviationNotices()).some(n => n.user_id === firedAuthorId)).toBe(false)
  })

  it('все авторы ушли — сигнал владельцу категории курса (too_fast: 3 хв при норме материала 20 хв, выборка 21)', async () => {
    const n2 = await normRow('lesson', l2)
    expect(n2).toMatchObject({ source: 'author', author_seconds: 1200, observed_seconds: 180, observed_sample: 21, deviation_flag: 'too_fast' })
    const notes = (await deviationNotices()).filter(n => n.ref_id === n2!.id)
    expect(notes.map(n => n.user_id)).toEqual([mentorId])
    expect(notes[0]!.payload).toMatchObject({ fact: '3', plan: '20' })
  })

  it('выборка 12 (10…19): флаг ставится, уведомления нет; выборка 5: no_data, медиана не хранится', async () => {
    const nq = await normRow('quiz', quizId)
    // Авторасчёт теста: 2 вопроса × 45 с = 90 с; факт 600 с — в 6,7 раза дольше
    expect(nq).toMatchObject({ source: 'auto', auto_seconds: 90, observed_sample: 12, observed_seconds: 600, deviation_flag: 'too_slow' })
    expect((await deviationNotices()).some(n => n.ref_id === nq!.id)).toBe(false)
    const n3 = await normRow('lesson', l3)
    expect(n3).toMatchObject({ observed_sample: 5, observed_seconds: null, observed_p25: null, observed_p75: null, deviation_flag: 'no_data' })
    expect((await deviationNotices()).some(n => n.ref_id === n3!.id)).toBe(false)
  })

  it('отчёт §9.3 — без имён: строка — элемент, ни одного человека ни в ответе, ни в выгрузке', async () => {
    const rep = await timePlanFactReport({ tenantId, actorId: authorId, scope: null }, timePlanFactQuerySchema.parse({}))
    const row1 = rep.rows.find(r => r.subjectId === l1)!
    expect(row1).toMatchObject({ subjectType: 'lesson', plannedSeconds: 600, source: 'author', medianSeconds: 2100, sample: 25, deviation: 'too_slow' })
    expect(row1.factor).toBeCloseTo(3.5)
    expect(row1.unreliableShare).toBeCloseTo(2 / 27)
    expect(row1.tracks).toEqual([{ id: courseId, title: `${TAG} Курс` }])
    const row3 = rep.rows.find(r => r.subjectId === l3)!
    expect(row3).toMatchObject({ medianSeconds: null, p25Seconds: null, p75Seconds: null, sample: 5, deviation: 'no_data', unreliableShare: null })
    // Одна формула с нормой: отчёт по всему тенанту с фильтрами по умолчанию совпадает с флагом
    for (const r of rep.rows) {
      const n = await normRow(r.subjectType, r.subjectId)
      expect(r.deviation, r.title).toBe(n!.deviation_flag)
    }
    // Порядок: медленнее плана — сверху
    expect(rep.rows[0]!.deviation).toBe('too_slow')

    const text = JSON.stringify(rep) + JSON.stringify(planFactExportRows(rep))
    for (const id of learners) expect(text).not.toContain(id)
    expect(text).not.toContain(`${TAG} Учень`)
    expect(text).not.toMatch(/"(userId|user_id|fullName|full_name)"/)
  })

  it('повторный пересчёт идемпотентен: флаги те же, второго уведомления нет', async () => {
    const was = (await deviationNotices()).length
    await recalcNorms(tenantId)
    expect((await deviationNotices()).length).toBe(was)
    expect((await normRow('lesson', l1))!.deviation_flag).toBe('too_slow')
  })

  it('«Застосувати» при выборке 12 — norm.sample_too_small; при 25 — медиана становится нормой, флаг снят', async () => {
    expect(await applyObservedNorm(ctx(authorId), { subjectType: 'quiz', subjectId: quizId })).toEqual({ ok: false, code: 'sample_too_small' })
    const r = await applyObservedNorm(ctx(authorId), lesson(l1))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.norm).toMatchObject({ source: 'observed', authorSeconds: 2100, plannedSeconds: 2100, deviationFlag: 'none' })
    await recalcNorms(tenantId)
    expect((await normRow('lesson', l1))!.deviation_flag).toBe('none')
  })

  it('бал жодної людини не змінився: попытки, ответы, результаты, сдачи, записи, уроки, книга баллов — как до нормы', async () => {
    // Ещё и отчёт с выгрузкой, и выдача нормы — всё, что делает модуль, уже прошло выше
    await timePlanFactReport({ tenantId, actorId: adminId, scope: null }, timePlanFactQuerySchema.parse({ deviation: 'too_slow' }))
    await getTimeNorm(ctx(authorId), lesson(l1))
    expect(await scoreSnapshot()).toEqual(before)
  })
})

describe('«Застосувати» замораживает норму (§6.3, Р-22.2)', () => {
  it('медиана выросла до 55 хв — пересчёт обновил факт, но норма осталась 35 хв и без уведомления', async () => {
    const was = (await deviationNotices()).length
    for (const userId of learners.slice(0, 20)) await passLesson(userId, l1, 1200, { extra: true })
    await rollupTenant(tenantId, { windowMinutes: 600 })
    await recalcNorms(tenantId)
    const n1 = await normRow('lesson', l1)
    expect(n1).toMatchObject({ source: 'observed', author_seconds: 2100, observed_seconds: 3300, observed_sample: 25, deviation_flag: 'none' })
    expect((await deviationNotices()).length).toBe(was)
  })
})

describe('форма нормы: границы, чужой тенант, элемент без строки', () => {
  it('вне 1 минуты … 60 часов — norm.value_range; «За фактом» на выборке 5 — norm.sample_too_small', async () => {
    expect(await putTimeNorm(ctx(authorId), lesson(l3), { source: 'author', authorSeconds: 59 })).toEqual({ ok: false, code: 'value_range' })
    expect(await putTimeNorm(ctx(authorId), lesson(l3), { source: 'author', authorSeconds: 216_060 })).toEqual({ ok: false, code: 'value_range' })
    expect(await putTimeNorm(ctx(authorId), lesson(l3), { source: 'author', authorSeconds: 90.5 })).toEqual({ ok: false, code: 'value_range' })
    expect(await putTimeNorm(ctx(authorId), lesson(l3), { source: 'observed' })).toEqual({ ok: false, code: 'sample_too_small' })
  })

  it('урок чужого тенанта и несуществующий элемент — not_found (CLAUDE.md п. 15)', async () => {
    expect(await getTimeNorm(ctx(authorId), lesson(foreignLessonId))).toEqual({ ok: false, code: 'not_found' })
    expect(await putTimeNorm(ctx(authorId), lesson(foreignLessonId), { source: 'auto' })).toEqual({ ok: false, code: 'not_found' })
    expect(await getTimeNorm(ctx(authorId), { subjectType: 'workshop', subjectId: '00000000-0000-4000-8000-000000000000' })).toEqual({ ok: false, code: 'not_found' })
    expect(await normRow('lesson', foreignLessonId)).toBeUndefined()
  })

  it('норма на выборке 5 не раскрывает медиану; «Застосувати» недоступно', async () => {
    const r = await getTimeNorm(ctx(authorId), lesson(l3))
    expect(r.ok && r.norm).toMatchObject({ persisted: true, observedSample: 5, observedSeconds: null, canApplyObserved: false, source: 'auto', autoSeconds: 300 })
  })

  it('RLS: из чужого тенанта нормы не видно ни одной', async () => {
    const theirs = await withTenant(otherTenantId, null, tx => tx.execute(sql`select count(*)::int as n from content_time_norms`)) as unknown as { n: number }[]
    const ours = await withTenant(tenantId, null, tx => tx.execute(sql`select count(*)::int as n from content_time_norms`)) as unknown as { n: number }[]
    expect(theirs[0]!.n).toBe(0)
    expect(ours[0]!.n).toBeGreaterThanOrEqual(4)
  })
})

describe('снимок нормы в очереди проверки (§7.14: «правка нормы историю не переписывает»)', () => {
  it('у практикума нормы нет, пока её не задал автор; сдача кладёт в очередь норму на момент сдачи', async () => {
    const w = await createWorkshop(ctx(authorId), {
      title: `${TAG} Практикум: викладка вітрини`, description: [{ id: 'b1', type: 'text', html: '<p>Викладіть вітрину</p>' }], submissionKinds: ['text'],
      minTextLength: 10, criteria: [{ text: 'Вітрина за стандартом' }], reviewerRule: 'any_mentor', slaHours: 24,
      allowRework: true, maxReworks: 1, status: 'published',
    })
    workshopId = w.id
    const empty = await getTimeNorm(ctx(authorId), { subjectType: 'workshop', subjectId: w.id })
    expect(empty.ok && empty.norm).toMatchObject({ persisted: false, source: 'auto', plannedSeconds: null, autoSeconds: null, deviationFlag: 'no_data' })

    await putTimeNorm(ctx(authorId), { subjectType: 'workshop', subjectId: w.id }, { source: 'author', authorSeconds: 1800 })
    const s1 = await submitWorkshop(ctx(employeeId), w.id, { text: 'Вітрину викладено за стандартом' })
    expect(s1.ok).toBe(true)
    const [item1] = await admin`select q.id, q.estimated_seconds from review_queue_items q join workshop_submissions s on s.id = q.source_id
      where q.task_type = 'workshop' and s.workshop_id = ${w.id} and s.user_id = ${employeeId}`
    expect(item1!.estimated_seconds).toBe(1800)

    await putTimeNorm(ctx(authorId), { subjectType: 'workshop', subjectId: w.id }, { source: 'author', authorSeconds: 2700 })
    const s2 = await submitWorkshop(ctx(cashierId), w.id, { text: 'Вітрину викладено за стандартом' })
    expect(s2.ok).toBe(true)
    const [again] = await admin`select estimated_seconds from review_queue_items where id = ${item1!.id}`
    expect(again!.estimated_seconds).toBe(1800)
    const [item2] = await admin`select q.estimated_seconds from review_queue_items q join workshop_submissions s on s.id = q.source_id
      where q.task_type = 'workshop' and s.workshop_id = ${w.id} and s.user_id = ${cashierId}`
    expect(item2!.estimated_seconds).toBe(2700)
  })

  it('пересдача после доработки — новая работа: та же строка очереди берёт норму на момент пересдачи', async () => {
    const [sub] = await admin`select s.id from workshop_submissions s where s.workshop_id = ${workshopId} and s.user_id = ${employeeId}`
    const submissionId = sub!.id as string
    expect(await claim(ctx(mentorId), submissionId)).toEqual({ ok: true })
    const [criterion] = (await admin`select criteria_snapshot from workshop_submissions where id = ${submissionId}`)[0]!.criteria_snapshot as { id: string }[]
    const g = await grade(ctx(mentorId), submissionId, { decision: 'rework', criteriaResults: [{ criterionId: criterion!.id, passed: false }], comment: 'Переставте товар за планограмою' })
    expect(g.ok).toBe(true)
    const again = await submitWorkshop(ctx(employeeId), workshopId!, { text: 'Вітрину переставлено за планограмою' })
    expect(again.ok).toBe(true)
    const items = await admin`select q.estimated_seconds, q.status from review_queue_items q where q.task_type = 'workshop' and q.source_id = ${submissionId}`
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ estimated_seconds: 2700, status: 'waiting' })
  })
})

describe('«Орієнтовний час» материала — поле автора (§3.5)', () => {
  it('правка материала становится нормой урока и сразу пересчитывает флаг; очищенное поле возвращает авторасчёт', async () => {
    const set = await updateResource(ctx(adminId), r1, { estimatedMinutes: 15 })
    expect(set.ok).toBe(true)
    // 55 хв факта при норме 15 — в 3,7 раза дольше; уведомляет только пересчёт, не правка
    expect(await normRow('lesson', l1)).toMatchObject({ source: 'author', author_seconds: 900, deviation_flag: 'too_slow' })
    const [audit] = await admin`select action from audit_log where tenant_id = ${tenantId} and entity = 'content_time_norm' and action = 'time_norm.sync_material'`
    expect(audit).toBeDefined()

    await updateResource(ctx(adminId), r1, { estimatedMinutes: null })
    // 5500 знаков → 5 минут авторасчёта
    expect(await normRow('lesson', l1)).toMatchObject({ source: 'auto', author_seconds: null, auto_seconds: 300 })
  })
})

describe('отчёт по области видимости: тот же расчёт, люди своих точек', () => {
  it('руководитель точки видит агрегаты только по своим людям; пустая область — пустой отчёт', async () => {
    const mine = await timePlanFactReport({ tenantId, actorId: mentorId, scope: [lazarevaId] }, timePlanFactQuerySchema.parse({}))
    const row1 = mine.rows.find(r => r.subjectId === l1)!
    expect(row1.sample).toBe(10)
    const row3 = mine.rows.find(r => r.subjectId === l3)!
    expect(row3).toMatchObject({ sample: 5, deviation: 'no_data', medianSeconds: null })
    const none = await timePlanFactReport({ tenantId, actorId: mentorId, scope: [] }, timePlanFactQuerySchema.parse({}))
    expect(none.rows).toEqual([])
  })

  it('фильтры §9.3: тип элемента, трек, отклонение, минимальная выборка', async () => {
    const all = timePlanFactQuerySchema.parse({})
    const byType = await timePlanFactReport({ tenantId, actorId: adminId, scope: null }, { ...all, subjectType: 'quiz' })
    expect(byType.rows.map(r => r.subjectId)).toEqual([quizId])
    const byTrack = await timePlanFactReport({ tenantId, actorId: adminId, scope: null }, { ...all, trackId: courseId })
    expect(new Set(byTrack.rows.map(r => r.subjectId))).toEqual(new Set([l1, l2, l3]))
    const fast = await timePlanFactReport({ tenantId, actorId: adminId, scope: null }, { ...all, deviation: 'too_fast' })
    expect(fast.rows.map(r => r.subjectId)).toEqual([l2])
    const big = await timePlanFactReport({ tenantId, actorId: adminId, scope: null }, { ...all, minSample: 20 })
    expect(new Set(big.rows.map(r => r.subjectId))).toEqual(new Set([l1, l2]))
  })
})
