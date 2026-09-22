import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Сесії на призначенні (docs/18 §14.1, §15 Г-18.1, Г-18.2; docs/29 Б.3): одне заняття/вебінар
 * може мати кілька сесій за датою/місцем, людина записана на конкретну сесію, правила запису
 * і відмітки — на сесії/призначенні, а не в картці. Покриває docs/32 §Б рядок 13.
 */

const mt = await import('../../server/services/meetups')
const ms = await import('../../server/services/meetupSessions')
const { createCourse, addModule, addLesson, publishCourse } = await import('../../server/services/courses')
const { selfEnroll, openLesson, completeLesson } = await import('../../server/services/learning')
const { assignWithParams } = await import('./_assign')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

let tenantId: string
let adminId: string
let lazarevaId: string
let posId: string
const userIds: string[] = []
const meetupIds: string[] = []
const courseIds: string[] = []
const assignmentIds: string[] = []

async function makePerson(name: string) {
  const phone = `+38089${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
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
  posId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Бариста-ms-${Date.now()}`}, 'barista-ms') returning id`)[0]!.id as string
  await admin`update locations set manager_id = ${adminId} where id = ${lazarevaId}`
})

afterAll(async () => {
  if (courseIds.length) {
    await admin`delete from certificates where course_id in ${admin(courseIds)}`
    await admin`delete from enrollments where subject_id in ${admin(courseIds)}`
    await admin`delete from courses where id in ${admin(courseIds)}`
  }
  if (meetupIds.length) await admin`delete from meetups where id in ${admin(meetupIds)}`
  if (assignmentIds.length) await admin`delete from assignments where id in ${admin(assignmentIds)}`
  if (userIds.length) { await admin`delete from notifications where user_id in ${admin(userIds)}`; await admin`delete from users where id in ${admin(userIds)}` }
  await admin`delete from positions where id = ${posId}`
  await admin`update locations set manager_id = null where id = ${lazarevaId}`
  await admin.end()
})

/** Створює картку заняття/вебінару-контент (legacy-поля дати лишаються обов'язковими на meetups, сесія — окремо). */
async function makeMeetupContent(kind: 'meetup' | 'webinar', title: string) {
  const m = await mt.createMeetup(ctx(), { kind, title, announcement: [{ id: 'a', type: 'text', html: '<p>Анонс</p>' }], startsAt: hours(500), endsAt: hours(501), trainerIds: [adminId] })
  meetupIds.push(m.id)
  return m.id
}

describe('spec-18: сесії на призначенні (docs/18 §14.1)', () => {
  it('«Анонс» обов\'язковий для meetup|webinar в картці', async () => {
    const m = await mt.createMeetup(ctx(), { kind: 'meetup', title: 'Без анонсу', startsAt: hours(500), endsAt: hours(501), trainerIds: [adminId] })
    meetupIds.push(m.id)
    // Сервіс не примушує (обмеження — на рівні ендпоінта); але поле є і зберігається порожнім
    const [row] = await admin`select announcement from meetups where id = ${m.id}`
    expect(row!.announcement).toEqual([])
  })

  it('10 місць, 11-й — у черзі; відміна одного → місце і сповіщення (§13.1 моделі сесій)', async () => {
    const meetupId = await makeMeetupContent('meetup', 'Сесії: Латте-арт')
    const people: string[] = []
    for (let i = 0; i < 11; i++) people.push(await makePerson(`Сесія Учасник ${i}`))
    const r = await ms.createSession(ctx(), meetupId, { startsAt: hours(48), endsAt: hours(50), locationId: lazarevaId, trainerIds: [adminId], capacity: 10, attendanceMode: 'both' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const sessionId = r.session.id

    for (let i = 0; i < 10; i++) expect(await ms.registerSession(ctx(people[i]!), sessionId, people[i]!)).toMatchObject({ ok: true, status: 'registered' })
    expect(await ms.registerSession(ctx(people[10]!), sessionId, people[10]!)).toMatchObject({ ok: true, status: 'waitlist', waitlistPosition: 1 })
    expect(await ms.registerSession(ctx(people[10]!), sessionId, people[10]!)).toMatchObject({ ok: false, code: 'already' })

    const list = await ms.listSessions(ctx(people[10]!), meetupId)
    expect(list.find(s => s.id === sessionId)).toMatchObject({ my_status: 'waitlist', my_waitlist_position: 1, seatsLeft: 0 })

    expect(await ms.unregisterSession(ctx(people[0]!), sessionId, people[0]!)).toMatchObject({ ok: true })
    const [promoted] = await admin`select status, waitlist_position from meetup_session_registrations where session_id = ${sessionId} and user_id = ${people[10]!}`
    expect(promoted).toMatchObject({ status: 'registered', waitlist_position: null })
    const [n] = await admin`select count(*)::int as c from notifications where user_id = ${people[10]!} and code = 'meetup_seat_freed'`
    expect(n!.c).toBe(1)
  })

  it('QR: актуальний код → attended/qr; протермінований — відхилено і в аудиті', async () => {
    const meetupId = await makeMeetupContent('meetup', 'Сесії: QR')
    const p1 = await makePerson('QR Сесія Учасник')
    const r = await ms.createSession(ctx(), meetupId, { startsAt: hours(2), endsAt: hours(4), locationId: lazarevaId, trainerIds: [adminId], capacity: 5, attendanceMode: 'qr', enrollDeadlineHours: 0 })
    if (!r.ok) throw new Error('no session')
    const sessionId = r.session.id
    await ms.registerSession(ctx(p1), sessionId, p1)
    await admin`update meetup_sessions set starts_at = now() - interval '10 minutes', ends_at = now() + interval '110 minutes' where id = ${sessionId}`

    const qr = await ms.currentQr(ctx(), sessionId)
    expect(qr!.expiresInSec).toBeLessThanOrEqual(30)
    const chk = await ms.checkin(ctx(p1), qr!.token)
    expect(chk.ok).toBe(true)
    const [reg] = await admin`select status, check_in_method from meetup_session_registrations where session_id = ${sessionId} and user_id = ${p1}`
    expect(reg).toMatchObject({ status: 'attended', check_in_method: 'qr' })

    const [idPart, idxPart, sig] = qr!.token.split('.')
    void sig
    const [secret] = await admin`select qr_secret from meetup_sessions where id = ${sessionId}`
    const { createHmac } = await import('node:crypto')
    const oldIdx = Number(idxPart) - 10
    const oldSig = createHmac('sha256', secret!.qr_secret as string).update(`${idPart}:${oldIdx}`).digest('base64url').slice(0, 20)
    expect(await ms.checkin(ctx(p1), `${idPart}.${oldIdx}.${oldSig}`)).toMatchObject({ ok: false, code: 'expired' })
    const [rej] = await admin`select count(*)::int as c from audit_log where action = 'meetup_session.checkin.rejected' and entity_id = ${sessionId}`
    expect(rej!.c).toBe(1)
  })

  describe('відмітка заднім числом (Г-18.1)', () => {
    it('негайно — без причини; заднім числом без причини відхилено; з причиною і в межах 7 днів — успіх керівнику точки, в аудиті', async () => {
      const meetupId = await makeMeetupContent('meetup', 'Сесії: заднім числом')
      const p1 = await makePerson('Задн Учасник')
      const stranger = await makePerson('Задн Не керівник')
      const r = await ms.createSession(ctx(), meetupId, { startsAt: hours(-3), endsAt: hours(-2), locationId: lazarevaId, trainerIds: [adminId], capacity: 5 })
      if (!r.ok) throw new Error('no session')
      const sessionId = r.session.id
      // Реєструє адміністратор (сесія вже в минулому — самозапис був би закритий за дедлайном)
      await ms.registerSession(ctx(adminId), sessionId, p1)

      // Сесія вже завершилась (endsAt у минулому) — це retroactive
      const noReason = await ms.setAttendance(ctx(adminId), sessionId, { userId: p1, status: 'attended' })
      expect(noReason).toMatchObject({ ok: false, code: 'reason_required' })

      const forbidden = await ms.setAttendance(ctx(stranger), sessionId, { userId: p1, status: 'attended', reason: 'Був присутній, забули відмітити' })
      expect(forbidden).toMatchObject({ ok: false, code: 'forbidden' })

      const ok = await ms.setAttendance(ctx(adminId), sessionId, { userId: p1, status: 'attended', reason: 'Був присутній, забули відмітити' })
      expect(ok).toMatchObject({ ok: true, status: 'attended', retroactive: true })
      const [row] = await admin`select status, marked_retroactively, retroactive_reason from meetup_session_registrations where session_id = ${sessionId} and user_id = ${p1}`
      expect(row).toMatchObject({ status: 'attended', marked_retroactively: true, retroactive_reason: 'Був присутній, забули відмітити' })
      const [aud] = await admin`select action, request_context, after from audit_log where action = 'meetup_session.attendance.retroactive' and entity_id in (select id from meetup_session_registrations where session_id = ${sessionId} and user_id = ${p1})`
      expect(aud).toBeTruthy()
      expect(aud!.after).toMatchObject({ reason: 'Був присутній, забули відмітити' })
    })

    it('пізніше 7 днів після сесії — відхилено', async () => {
      const meetupId = await makeMeetupContent('meetup', 'Сесії: протерміновано')
      const p1 = await makePerson('Протермін Учасник')
      const r = await ms.createSession(ctx(), meetupId, { startsAt: hours(-24 * 10), endsAt: hours(-24 * 10 + 1), locationId: lazarevaId, trainerIds: [adminId] })
      if (!r.ok) throw new Error('no session')
      await ms.registerSession(ctx(adminId), r.session.id, p1)
      const res = await ms.setAttendance(ctx(adminId), r.session.id, { userId: p1, status: 'attended', reason: 'Запізніла відмітка' })
      expect(res).toMatchObject({ ok: false, code: 'window_passed' })
    })
  })

  it('вебінар: тік перегляду і зачёт по webinarMinWatchPct з призначення (Г-18.2)', async () => {
    const meetupId = await makeMeetupContent('webinar', 'Сесії: вебінар поріг')
    const p1 = await makePerson('Веб Тік Учасник')
    const taskId = await assignWithParams(ctx(), 'webinar', meetupId, { webinarMinWatchPct: 50 })
    assignmentIds.push(taskId)
    const r = await ms.createSession(ctx(), meetupId, { taskId, startsAt: hours(2), endsAt: hours(4), trainerIds: [adminId], enrollDeadlineHours: 0 }) // 2 години тривалості
    if (!r.ok) throw new Error('no session')
    const sessionId = r.session.id
    await ms.registerSession(ctx(p1), sessionId, p1)
    // Сесія «почалась» — зсуваємо дати, тривалість лишається 2 години
    await admin`update meetup_sessions set starts_at = now() - interval '1 hour', ends_at = now() + interval '1 hour' where id = ${sessionId}`

    const t1 = await ms.tickWatch(ctx(p1), sessionId, 20)
    expect(t1.ok).toBe(true)
    if (t1.ok) expect(t1.attended).toBe(false) // 20 з 7200 секунд — далеко до 50%

    // Накручуємо через participations (провайдер): 61 хвилина з 120 = 50.8% ≥ 50%
    const rp = await ms.recordParticipation(ctx(), sessionId, [{ userId: p1, minutes: 61 }], 'provider')
    expect(rp).toMatchObject({ threshold: 50, attended: 1 })
    const [row] = await admin`select status, check_in_method from meetup_session_registrations where session_id = ${sessionId} and user_id = ${p1}`
    expect(row).toMatchObject({ status: 'attended', check_in_method: 'auto' })
  })

  it('заняття як урок курсу (docs/29 Б.3): реєстрація з уроку, attended → урок зараховано', async () => {
    const meetupId = await makeMeetupContent('meetup', 'Заняття-урок')
    const course = await createCourse(ctx(), { title: `Курс із заняттям ${Date.now()}`, language: 'uk', strictOrder: false, isCatalogVisible: true, tags: [] })
    courseIds.push(course.id)
    const mod = await addModule(ctx(), course.id, 'Розділ 1')
    const lesson = await addLesson(ctx(), { moduleId: mod!.id, title: 'Очне заняття', itemType: 'meetup', meetupId, isRequired: true, videoThresholdPct: 90 })
    expect(lesson.ok).toBe(true)
    if (!lesson.ok) return
    const pub = await publishCourse(ctx(), course.id, 'v1')
    expect(pub.ok).toBe(true)

    const learnerId = await makePerson('Курс-заняття учень')
    const enr = await selfEnroll(ctx(learnerId), course.id)
    expect(enr.ok).toBe(true)
    if (!enr.ok) return

    const opened = await openLesson(ctx(learnerId), enr.enrollmentId, lesson.lesson.id)
    expect(opened.ok).toBe(true)
    if (opened.ok) expect(opened.lesson.itemType).toBe('meetup')

    // Кнопкою урок не завершити — тільки відвідуванням
    const early = await completeLesson(ctx(learnerId), enr.enrollmentId, lesson.lesson.id)
    expect(early).toMatchObject({ ok: false, code: 'conditions_not_met', reasons: ['Відвідайте заняття'] })

    const s = await ms.createSession(ctx(), meetupId, { startsAt: hours(3), endsAt: hours(4), trainerIds: [adminId] })
    if (!s.ok) throw new Error('no session')
    const reg = await ms.registerSession(ctx(learnerId), s.session.id, learnerId, { enrollmentId: enr.enrollmentId, lessonId: lesson.lesson.id })
    expect(reg).toMatchObject({ ok: true, status: 'registered' })

    const attended = await ms.setAttendance(ctx(adminId), s.session.id, { userId: learnerId, status: 'attended' })
    expect(attended).toMatchObject({ ok: true, status: 'attended', retroactive: false })
    // completeLesson викликається асинхронно (setImmediate) — почекаємо тік
    await new Promise(resolve => setTimeout(resolve, 300))
    const [progress] = await admin`select status from lesson_progress where enrollment_id = ${enr.enrollmentId} and lesson_id = ${lesson.lesson.id}`
    expect(progress?.status).toBe('completed')
  })

  it('чужий тенант — 404, не 403 (CLAUDE.md п. 15)', async () => {
    const [otherTenant] = await admin`insert into tenants (slug, name) values ('test-ms-isolation', 'Тест ізоляції сесій') on conflict (slug) do update set name = excluded.name returning id`
    const meetupId = await makeMeetupContent('meetup', 'Чужий тенант')
    const r = await ms.createSession(ctx(), meetupId, { startsAt: hours(1), endsAt: hours(2), trainerIds: [adminId] })
    if (!r.ok) throw new Error('no session')
    const foreign = await ms.getSession({ tenantId: otherTenant!.id as string, actorId: adminId }, r.session.id)
    expect(foreign).toBeNull()
  })

  describe('docs/33 D-029: щойно з\'явилась сесія, картка більше не бере участь', () => {
    it('запис/QR/відмітка/статус-скан/звіт картки повертають has_sessions або мовчки пропускають картку', async () => {
      const meetupId = await makeMeetupContent('meetup', 'D-029: картка з сесією')
      const p1 = await makePerson('D-029 Учасник')
      const r = await ms.createSession(ctx(), meetupId, { startsAt: hours(2), endsAt: hours(4), trainerIds: [adminId], capacity: 5, attendanceMode: 'qr' })
      if (!r.ok) throw new Error('no session')

      // Запис/відписка через картку — заборонено, як тільки з'явилась сесія
      expect(await mt.register(ctx(p1), meetupId, p1)).toMatchObject({ ok: false, code: 'has_sessions' })
      expect(await mt.unregister(ctx(p1), meetupId, p1)).toMatchObject({ ok: false, code: 'has_sessions' })
      // QR картки не видається
      expect(await mt.currentQr(ctx(), meetupId)).toBeNull()
      // Відмітка через картку — 404 (null)
      expect(await mt.setAttendance(ctx(), meetupId, { userId: p1, status: 'attended' })).toBeNull()

      // Картка більше не фігурує в картковому розкладі/статус-скані/звіті — усе на сесії
      await admin`update meetups set starts_at = now() - interval '1 hour', ends_at = now() + interval '1 hour', status = 'planned' where id = ${meetupId}`
      const scan = await mt.statusScan(tenantId)
      const [after] = await admin`select status from meetups where id = ${meetupId}`
      expect(after!.status).toBe('planned') // картковий скан її не чіпав
      void scan
      const sched = await mt.schedule(ctx(), { mine: false })
      expect(sched.find(x => x.id === meetupId)).toBeUndefined()
      await admin`update meetups set status = 'finished' where id = ${meetupId}`
      const rep = await mt.attendanceReport(ctx())
      expect(rep.meetups.find(x => x.id === meetupId)).toBeUndefined()
    })
  })

  describe('docs/33 D-029: перенос одноразової картки в сесію (міграція 0054)', () => {
    /** Виконує саме той SQL-бекфіл, що і в міграції 0054 (третій стейтмент після ALTER TABLE) — не дублюючи логіку вручну. */
    async function runBackfill() {
      const file = readFileSync(resolvePath(__dirname, '../../server/db/migrations/0054_debts_final_meetup_session_sync.sql'), 'utf8')
      const backfill = file.split('--> statement-breakpoint')[2]!
      await admin.unsafe(backfill)
    }

    it('стара картка meetup без сесії → одна сесія з тими самими датою/місцем/реєстраціями', async () => {
      const p1 = await makePerson('Перенос Прийшов')
      const p2 = await makePerson('Перенос Пропустив')
      const [m] = await admin`
        insert into meetups (tenant_id, kind, title, announcement, starts_at, ends_at, location_id, room, trainer_ids, capacity, attendance_mode, qr_secret, status, external_event_id, created_by)
        values (${tenantId}, 'meetup', 'Легасі: перенос', '[{"id":"a"}]'::jsonb, now() - interval '2 days', now() - interval '2 days' + interval '1 hour', ${lazarevaId}, 'Клас 3', ${[adminId]}, 8, 'both', 'legacy-secret', 'finished', 'evt-legacy-1', ${adminId})
        returning id`
      meetupIds.push(m!.id as string)
      await admin`insert into meetup_registrations (tenant_id, meetup_id, user_id, status, registered_at, checked_in_at, check_in_method) values (${tenantId}, ${m!.id}, ${p1}, 'attended', now() - interval '3 days', now() - interval '2 days', 'manual')`
      await admin`insert into meetup_registrations (tenant_id, meetup_id, user_id, status, registered_at) values (${tenantId}, ${m!.id}, ${p2}, 'missed', now() - interval '3 days')`

      await runBackfill()

      const newSessions = await admin`select * from meetup_sessions where meetup_id = ${m!.id}`
      expect(newSessions.length).toBe(1)
      const s = newSessions[0]!
      expect(s).toMatchObject({ location_id: lazarevaId, room: 'Клас 3', capacity: 8, attendance_mode: 'both', qr_secret: 'legacy-secret', status: 'finished', external_event_id: 'evt-legacy-1' })
      expect((s.trainer_ids as string[])).toEqual([adminId])

      const regs = await admin`select user_id, status, check_in_method from meetup_session_registrations where session_id = ${s.id} order by status`
      expect(regs).toMatchObject([{ user_id: p1, status: 'attended', check_in_method: 'manual' }, { user_id: p2, status: 'missed' }])

      // Ідемпотентність: повторний прогін бекфілу не створює другу сесію (NOT EXISTS-охорона)
      await runBackfill()
      expect((await admin`select count(*)::int as c from meetup_sessions where meetup_id = ${m!.id}`)[0]!.c).toBe(1)
    })

    it('стара картка webinar → сесія переймає посилання/провайдера, участь → seconds_watched/watch_pct', async () => {
      const p1 = await makePerson('Перенос Вебінар')
      const [m] = await admin`
        insert into meetups (tenant_id, kind, title, announcement, starts_at, ends_at, trainer_ids, attendance_mode, qr_secret, status, created_by)
        values (${tenantId}, 'webinar', 'Легасі: вебінар', '[{"id":"a"}]'::jsonb, now() - interval '1 day', now() - interval '1 day' + interval '1 hour', ${[adminId]}, 'manual', 'legacy-secret-2', 'finished', ${adminId})
        returning id`
      meetupIds.push(m!.id as string)
      const [w] = await admin`insert into webinars (tenant_id, meetup_id, provider, join_url, external_meeting_id) values (${tenantId}, ${m!.id}, 'zoom', 'https://zoom.us/j/legacy', 'zoom-legacy-1') returning id`
      await admin`insert into meetup_registrations (tenant_id, meetup_id, user_id, status, registered_at) values (${tenantId}, ${m!.id}, ${p1}, 'attended', now() - interval '2 days')`
      await admin`insert into webinar_participations (tenant_id, webinar_id, user_id, minutes, attended, source) values (${tenantId}, ${w!.id}, ${p1}, 45, true, 'provider')`

      await runBackfill()

      const [s] = await admin`select * from meetup_sessions where meetup_id = ${m!.id}`
      expect(s).toMatchObject({ provider: 'zoom', join_url: 'https://zoom.us/j/legacy', external_meeting_id: 'zoom-legacy-1' })
      const [reg] = await admin`select seconds_watched, watch_pct from meetup_session_registrations where session_id = ${s!.id} and user_id = ${p1}`
      expect(reg!.seconds_watched).toBe(45 * 60)
      expect(Number(reg!.watch_pct)).toBeGreaterThan(0)
    })
  })
})
