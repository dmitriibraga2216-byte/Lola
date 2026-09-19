import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const mt = await import('../../server/services/meetups')
const ct = await import('../../server/services/complexTests')
const { createBank, createQuestion, createQuiz, setQuizQuestions } = await import('../../server/services/questions')
const { saveAnswer, submitAttempt, getAttemptState } = await import('../../server/services/attempts')
const { assignWithParams } = await import('./_assign')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

let tenantId: string
let adminId: string
let lazarevaId: string
let posId: string
const userIds: string[] = []
const meetupIds: string[] = []
const quizIds: string[] = []
const assignmentIds: string[] = []
const complexIds: string[] = []
let bankId: string

async function makePerson(name: string) {
  const phone = `+38098${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, phone, full_name, status, hired_at) values (${tenantId}, ${phone}, ${name}, 'active', current_date) returning id`
  userIds.push(u!.id as string)
  await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary) values (${tenantId}, ${u!.id}, ${lazarevaId}, ${posId}, true)`
  return u!.id as string
}
const ctx = (actorId = adminId) => ({ tenantId, actorId })
const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  posId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Бариста-mt-${Date.now()}`}, 'barista-mt') returning id`)[0]!.id as string
  await admin`update locations set manager_id = ${adminId} where id = ${lazarevaId}`
  bankId = (await createBank(ctx(), { name: `Банк-mt ${Date.now()}` })).id
})

afterAll(async () => {
  if (meetupIds.length) await admin`delete from meetups where id in ${admin(meetupIds)}`
  if (complexIds.length) await admin`delete from complex_tests where id in ${admin(complexIds)}`
  if (assignmentIds.length) await admin`delete from assignments where id in ${admin(assignmentIds)}`
  if (quizIds.length) { await admin`delete from attempts where quiz_id in ${admin(quizIds)}`; await admin`delete from quizzes where id in ${admin(quizIds)}` }
  await admin`delete from questions where bank_id = ${bankId}`
  await admin`delete from question_banks where id = ${bankId}`
  if (userIds.length) { await admin`delete from notifications where user_id in ${admin(userIds)}`; await admin`delete from users where id in ${admin(userIds)}` }
  await admin`delete from positions where id = ${posId}`
  await admin`update locations set manager_id = null where id = ${lazarevaId}`
  await admin.end()
})

describe('этап 9: очные занятия (docs/18 §13)', () => {
  it('§13.1: 10 мест, 11-й — в очереди с позицией 1; отмена одного → место и уведомление', async () => {
    const people: string[] = []
    for (let i = 0; i < 11; i++) people.push(await makePerson(`Учасник ${i}`))
    const m = await mt.createMeetup(ctx(), { title: 'Латте-арт для початківців', startsAt: hours(48), endsAt: hours(50), locationId: lazarevaId, trainerIds: [adminId], capacity: 10, attendanceMode: 'both' })
    meetupIds.push(m.id)
    for (let i = 0; i < 10; i++) expect(await mt.register(ctx(people[i]!), m.id, people[i]!)).toMatchObject({ ok: true, status: 'registered' })
    expect(await mt.register(ctx(people[10]!), m.id, people[10]!)).toMatchObject({ ok: true, status: 'waitlist', waitlistPosition: 1 })
    expect(await mt.register(ctx(people[10]!), m.id, people[10]!)).toMatchObject({ ok: false, code: 'already' })

    const sched = await mt.schedule(ctx(people[10]!), { mine: true })
    expect(sched.find(s => s.id === m.id)).toMatchObject({ my_status: 'waitlist', my_waitlist_position: 1, seatsLeft: 0 })

    expect(await mt.unregister(ctx(people[0]!), m.id, people[0]!)).toMatchObject({ ok: true })
    const [promoted] = await admin`select status, waitlist_position from meetup_registrations where meetup_id = ${m.id} and user_id = ${people[10]!}`
    expect(promoted).toMatchObject({ status: 'registered', waitlist_position: null })
    const [n] = await admin`select count(*)::int as c from notifications where user_id = ${people[10]!} and code = 'meetup_seat_freed'`
    expect(n!.c).toBe(1)
  })

  it('§13.2–13.3: QR-отметка актуальным кодом → attended/qr; код 5-минутной давности отклонён; неявки → missed, руководителю список (§13.4)', async () => {
    const p1 = await makePerson('QR Учасник')
    const p2 = await makePerson('QR Прогульник')
    const stranger = await makePerson('QR Чужий')
    // Занятие уже идёт (создаём в будущем, потом двигаем)
    const m = await mt.createMeetup(ctx(), { title: 'Робота з кавомашиною', startsAt: hours(2), endsAt: hours(4), locationId: lazarevaId, trainerIds: [adminId], capacity: 5, attendanceMode: 'qr', enrollDeadlineHours: 0 })
    meetupIds.push(m.id)
    await mt.register(ctx(p1), m.id, p1)
    await mt.register(ctx(p2), m.id, p2)
    await admin`update meetups set starts_at = now() - interval '10 minutes', ends_at = now() + interval '110 minutes' where id = ${m.id}`
    expect((await mt.statusScan(tenantId)).started).toBeGreaterThanOrEqual(1)

    const qr = await mt.currentQr(ctx(), m.id)
    expect(qr!.expiresInSec).toBeLessThanOrEqual(30)
    const r = await mt.checkin(ctx(p1), qr!.token)
    expect(r.ok).toBe(true)
    const [reg] = await admin`select status, check_in_method, checked_in_at from meetup_registrations where meetup_id = ${m.id} and user_id = ${p1}`
    expect(reg).toMatchObject({ status: 'attended', check_in_method: 'qr' })
    expect(reg!.checked_in_at).toBeTruthy()

    // Скриншот 5-минутной давности: окно idx − 10
    const [id, idx, sig] = qr!.token.split('.')
    void sig
    const [secret] = await admin`select qr_secret from meetups where id = ${m.id}`
    const { createHmac } = await import('node:crypto')
    const oldIdx = Number(idx) - 10
    const oldSig = createHmac('sha256', secret!.qr_secret as string).update(`${id}:${oldIdx}`).digest('base64url').slice(0, 20)
    expect(await mt.checkin(ctx(p2), `${id}.${oldIdx}.${oldSig}`)).toMatchObject({ ok: false, code: 'expired' })
    const [rej] = await admin`select count(*)::int as c from audit_log where action = 'meetup.checkin.rejected' and entity_id = ${m.id}`
    expect(rej!.c).toBe(1)
    // Не записан
    expect(await mt.checkin(ctx(stranger), qr!.token)).toMatchObject({ ok: false, code: 'not_registered', seatsLeft: 3 })
    // Подделанный код
    expect(await mt.checkin(ctx(p2), `${id}.${idx}.AAAAAAAAAAAAAAAAAAAA`)).toMatchObject({ ok: false, code: 'bad_token' })

    // Завершение: через час после ends_at
    await admin`update meetups set ends_at = now() - interval '61 minutes' where id = ${m.id}`
    const s = await mt.statusScan(tenantId)
    expect(s.finished).toBeGreaterThanOrEqual(1)
    const [missed] = await admin`select status from meetup_registrations where meetup_id = ${m.id} and user_id = ${p2}`
    expect(missed!.status).toBe('missed')
    const [mgr] = await admin`select payload from notifications where user_id = ${adminId} and code = 'meetup_missed_manager' and payload->>'title' = 'Робота з кавомашиною'`
    expect(String(mgr!.payload && (mgr!.payload as { names: string }).names)).toContain('QR Прогульник')
    // Отчёт сходится со списком
    const rep = await mt.attendanceReport(ctx())
    expect(rep.meetups.find(x => x.id === m.id)).toMatchObject({ registered: 2, attended: 1 })
  })

  it('§13.5: вебинар 60 минут, порог 42 — 45 минут = attended, 3 минуты = missed', async () => {
    const p1 = await makePerson('Веб Уважний')
    const p2 = await makePerson('Веб Швидкий')
    const m = await mt.createMeetup(ctx(), { kind: 'webinar', title: 'Вебінар про сервіс', startsAt: hours(3), endsAt: hours(4), trainerIds: [adminId], webinar: { provider: 'meet', joinUrl: 'https://meet.google.com/abc', minMinutesForAttendance: 42 } })
    meetupIds.push(m.id)
    await mt.register(ctx(p1), m.id, p1)
    await mt.register(ctx(p2), m.id, p2)
    const card = await mt.getMeetup(ctx(p1), m.id)
    expect(card!.webinar!.joinUrl).toBeNull() // до начала ссылки нет (за 15 минут)
    const r = await mt.recordParticipation(ctx(), m.id, [{ userId: p1, minutes: 45 }, { userId: p2, minutes: 3 }], 'provider')
    expect(r).toMatchObject({ threshold: 42, attended: 1 })
    const rows = await admin`select user_id, status, check_in_method from meetup_registrations where meetup_id = ${m.id} order by status`
    expect(rows.find(x => x.user_id === p1)).toMatchObject({ status: 'attended', check_in_method: 'auto' })
    expect(rows.find(x => x.user_id === p2)).toMatchObject({ status: 'missed' })
  })

  it('отмена участником после дедлайна запрещена; отмена занятия снимает регистрации и уведомляет', async () => {
    const p = await makePerson('Пізно')
    const m = await mt.createMeetup(ctx(), { title: 'Скоро', startsAt: hours(10), endsAt: hours(11), trainerIds: [adminId], cancelDeadlineHours: 24, enrollDeadlineHours: 1 })
    meetupIds.push(m.id)
    await mt.register(ctx(p), m.id, p)
    expect(await mt.unregister(ctx(p), m.id, p)).toMatchObject({ ok: false, code: 'cancel_deadline_passed' })
    expect(await mt.setAttendance(ctx(), m.id, { userId: p, status: 'excused', reason: 'Лікарняний' })).toMatchObject({ status: 'excused' })
    const c = await mt.cancelMeetup(ctx(), m.id, { reason: 'Тренер захворів, перенесемо' })
    expect(c).toMatchObject({ cancelled: 0 }) // excused уже не активная регистрация
    const [st] = await admin`select status, cancel_reason from meetups where id = ${m.id}`
    expect(st).toMatchObject({ status: 'cancelled' })
    expect(mt.toIcs({ id: m.id, title: 'Скоро', startsAt: new Date(m.startsAt), endsAt: new Date(m.endsAt), room: 'Клас 2' })).toContain('BEGIN:VEVENT')
  })
})

describe('этап 9: комплексные тесты (docs/18 §13.6)', () => {
  async function makeQuiz(title: string, passScore: number) {
    const q1 = (await createQuestion(ctx(), { bankId, kind: 'single', stem: [{ id: 'b', type: 'text', html: `<p>${title} 1?</p>` }], options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], answer: { correctId: 'a' }, isCritical: false, difficulty: 1, points: 1, scoringMethod: 'formula', attachFiles: false, negativeMarking: false, tags: [] })).id
    const q2 = (await createQuestion(ctx(), { bankId, kind: 'single', stem: [{ id: 'b', type: 'text', html: `<p>${title} 2?</p>` }], options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], answer: { correctId: 'a' }, isCritical: false, difficulty: 1, points: 1, scoringMethod: 'formula', attachFiles: false, negativeMarking: false, tags: [] })).id
    const q3 = (await createQuestion(ctx(), { bankId, kind: 'single', stem: [{ id: 'b', type: 'text', html: `<p>${title} 3?</p>` }], options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], answer: { correctId: 'a' }, isCritical: false, difficulty: 1, points: 1, scoringMethod: 'formula', attachFiles: false, negativeMarking: false, tags: [] })).id
    const q4 = (await createQuestion(ctx(), { bankId, kind: 'single', stem: [{ id: 'b', type: 'text', html: `<p>${title} 4?</p>` }], options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], answer: { correctId: 'a' }, isCritical: false, difficulty: 1, points: 1, scoringMethod: 'formula', attachFiles: false, negativeMarking: false, tags: [] })).id
    const quiz = await createQuiz(ctx(), { title: `${title} ${Date.now()}`, kind: 'quiz', tags: [], selectionMode: 'fixed', requiresOfflineConfirm: false })
    quizIds.push(quiz.id)
    assignmentIds.push(await assignWithParams(ctx(), 'test', quiz.id, { passScore, attemptsAllowed: 0, shuffleQuestions: false, shuffleOptions: false }))
    await setQuizQuestions(ctx(), quiz.id, [q1, q2, q3, q4].map((questionId, sort) => ({ questionId, sort })))
    return quiz.id
  }
  /** Проходит часть с заданным числом правильных из 4 (score = correct × 25). */
  async function passPart(learner: { tenantId: string, actorId: string }, attemptId: string, correct: number) {
    const st = await getAttemptState(learner, attemptId)
    let i = 0
    for (const q of st!.questions) { await saveAnswer(learner, attemptId, q.id, { selectedId: i < correct ? 'a' : 'b' }); i++ }
    return submitAttempt(learner, attemptId)
  }

  it('три части, вторая с min_score=80: набрано 75 → провал независимо от общего балла; sequential блокирует третью до второй', async () => {
    const learner = ctx(await makePerson('Комплексний'))
    const [qa, qb, qc] = [await makeQuiz('Ч1', 50), await makeQuiz('Ч2', 50), await makeQuiz('Ч3', 50)]
    const c = await ct.upsertComplexTest(ctx(), { title: `Комплекс ${Date.now()}`, parts: [{ quizId: qa, weight: 1 }, { quizId: qb, weight: 1, minScore: 80 }, { quizId: qc, weight: 1 }], sequential: true })
    complexIds.push(c!.id)
    // Порог, попытки и лимит — в назначении комплексного теста (CLAUDE.md п. 11)
    assignmentIds.push(await assignWithParams(ctx(), 'complex_test', c!.id, { passScore: 70, attemptsAllowed: 2, timeLimitSec: 3600 }))
    const intro = await ct.complexIntro(learner, c!.id)
    expect(intro!.parts.length).toBe(3)
    const s = await ct.startComplex(learner, c!.id)
    expect(s.ok).toBe(true)
    if (!s.ok) return
    expect(await ct.startPart(learner, s.attemptId, qc)).toMatchObject({ ok: false, code: 'locked' })
    const p1 = await ct.startPart(learner, s.attemptId, qa)
    expect(p1.ok).toBe(true)
    if (!p1.ok) return
    await passPart(learner, p1.attemptId, 4) // 100
    const p2 = await ct.startPart(learner, s.attemptId, qb)
    if (!p2.ok) return
    await passPart(learner, p2.attemptId, 3) // 75 < 80
    const mid = await ct.syncComplex(learner, s.attemptId)
    expect(mid!.status).toBe('in_progress')
    expect(mid!.partsState[1]).toMatchObject({ status: 'failed', score: 75 })
    const p3 = await ct.startPart(learner, s.attemptId, qc)
    if (!p3.ok) return
    await passPart(learner, p3.attemptId, 4) // 100
    const fin = await ct.syncComplex(learner, s.attemptId)
    // Общий балл (100+75+100)/3 = 91.67 ≥ 70, но min_score второй части провален
    expect(fin!.score).toBe(91.67)
    expect(fin!.passed).toBe(false)
    expect(fin!.status).toBe('failed')
    expect((await ct.complexIntro(learner, c!.id))!.attemptsUsed).toBe(1)
  })
})
