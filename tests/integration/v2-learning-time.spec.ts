import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readThrough } from './_lesson'
import type { BeatInput } from '../../shared/schemas/learningTime'
import type { Access } from '../../server/services/access'

/**
 * PR-21 пакета `docs/v2` (`45-plan.md`): учёт времени биениями через сервис и базу
 * (`37-review-delegation.md` §7.10–7.15, §10, §11).
 *
 * Критерии приёмки `37` §13, закреплённые за PR-21:
 * - **7** — 3 минуты без активности: зачтено не больше 30 с, сегмент закрыт `idle_timeout`,
 *   следующая активность открывает сегмент 2;
 * - **8** — свёрнутая вкладка при чтении статьи не засчитывается, при видео — засчитывается
 *   прирост воспроизведения (в пределах 1,5 × длины ролика);
 * - **9** — 95 минут подряд: зачтено 5400 с, «Ви ще тут?», после подтверждения — новый сегмент;
 * - **10** — 40 минут без связи: пакет принят, `is_offline_replay`, достоверность `partial`.
 *
 * Сквозная проверка 22 (`42` §5) — отдельный блок. Здесь же то, что PR обязан не сломать:
 * жалоба во время попытки (PR-23) сдвигает `deadline_at`, а время в форме не становится
 * «Часом на випробування»; свёртка не трогает ни дедлайн, ни снапшот, ни `updated_at` попытки.
 * Нагрузка на 200 одновременных прохождений — `v2-learning-time-load.spec.ts`.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const { recordBeat, recordBeats, closeStaleSessions, timeTotals } = await import('../../server/services/learningTime')
const { rollupTenant } = await import('../../server/services/learningTimeRollup')
const { completeLesson } = await import('../../server/services/learning')
const { createBank, createQuestion, createQuiz, setQuizQuestions } = await import('../../server/services/questions')
const { startAttempt, saveAnswer, submitAttempt } = await import('../../server/services/attempts')
const { createWorkshop, submitWorkshop } = await import('../../server/services/workshops')
const { submitReport } = await import('../../server/services/contentIssues')
const { withTenant } = await import('../../server/utils/withTenant')
const { assignWithParams } = await import('./_assign')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

let tenantId: string
let otherTenantId: string
let adminId: string
let mentorId: string
let employeeId: string
let cashierId: string
let lazarevaId: string
let courseId: string
let versionId: string
let lessonA: string
let lessonB: string
let enrollmentId: string
let foreignLessonId: string
const cleanup = {
  courses: [] as string[], resources: [] as string[], media: [] as string[], quizzes: [] as string[],
  banks: [] as string[], assignments: [] as string[], workshops: [] as string[], enrollments: [] as string[],
}

const ctxOf = (actorId: string) => ({ tenantId, actorId })

/** Биение от имени экрана: `seq` и время приёма задаёт тест. */
function beat(p: Partial<BeatInput> & { sessionKey: string, seq: number }): BeatInput {
  return {
    kind: 'content',
    subjectType: 'lesson',
    subjectId: lessonA,
    enrollmentId,
    activeMs: 30_000,
    visible: true,
    clientTs: new Date().toISOString(),
    device: 'desktop',
    ...p,
  }
}

const at = (t0: number, sec: number) => new Date(t0 + sec * 1000)

async function sessionRows(sessionKey: string) {
  return admin`select * from learning_time_sessions where session_key = ${sessionKey} order by segment_no`
}

async function send(actorId: string, b: BeatInput, now: Date) {
  const r = await recordBeat(ctxOf(actorId), b, { now })
  if (!r.ok) throw new Error(`биение отвергнуто: ${r.code}`)
  return r.result
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  const [other] = await admin`
    insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції')
    on conflict (slug) do update set name = excluded.name returning id`
  otherTenantId = other!.id as string
  const pick = async (phone: string) => (await admin`select id from users where tenant_id = ${tenantId} and phone = ${phone}`)[0]!.id as string
  adminId = await pick('+380661864742')
  mentorId = await pick('+380670000002')
  employeeId = await pick('+380670000003')
  cashierId = await pick('+380670000004')
  lazarevaId = (await admin`select location_id from user_placements where user_id = ${employeeId} and is_primary and ended_at is null`)[0]!.location_id as string

  // Курс с двумя уроками-статьями — из посева; запись на него — своя
  const [course] = await admin`select id, published_version_id from courses where tenant_id = ${tenantId} and published_version_id is not null order by created_at limit 1`
  courseId = course!.id as string
  versionId = course!.published_version_id as string
  const lessons = await admin`
    select l.id from lessons l join modules m on m.id = l.module_id
    where m.course_version_id = ${versionId} and l.item_type = 'resource' order by m.sort, l.sort limit 2`
  lessonA = lessons[0]!.id as string
  lessonB = lessons[1]!.id as string
  const [e] = await admin`
    insert into enrollments (tenant_id, user_id, subject_id, version_id, source, status, started_at)
    values (${tenantId}, ${employeeId}, ${courseId}, ${versionId}, 'self', 'in_progress', now()) returning id`
  enrollmentId = e!.id as string
  cleanup.enrollments.push(enrollmentId)
  await admin`insert into lesson_progress (tenant_id, enrollment_id, lesson_id) values (${tenantId}, ${enrollmentId}, ${lessonA}), (${tenantId}, ${enrollmentId}, ${lessonB})`

  // Урок чужого тенанта: на него нельзя начислить время из нашего (CLAUDE.md п. 15)
  const [fc] = await admin`insert into courses (tenant_id, title, slug) values (${otherTenantId}, 'Чужий курс', ${`v221-foreign-${Date.now()}`}) returning id`
  cleanup.courses.push(fc!.id as string)
  const [fv] = await admin`insert into course_versions (tenant_id, course_id, version, status) values (${otherTenantId}, ${fc!.id}, 1, 'published') returning id`
  const [fm] = await admin`insert into modules (tenant_id, course_version_id, title, sort) values (${otherTenantId}, ${fv!.id}, 'Модуль', 0) returning id`
  const [fr] = await admin`insert into resources (tenant_id, title, slug) values (${otherTenantId}, 'Чужий матеріал', ${`v221-foreign-r-${Date.now()}`}) returning id`
  cleanup.resources.push(fr!.id as string)
  const [fl] = await admin`insert into lessons (tenant_id, module_id, title, sort, item_type, item_id) values (${otherTenantId}, ${fm!.id}, 'Чужий урок', 0, 'resource', ${fr!.id}) returning id`
  foreignLessonId = fl!.id as string
})

afterAll(async () => {
  const users = [adminId, mentorId, employeeId, cashierId]
  await admin`delete from learning_time_sessions where tenant_id in (${tenantId}, ${otherTenantId})`
  await admin`delete from learning_time_totals where tenant_id in (${tenantId}, ${otherTenantId})`
  await admin`delete from content_issue_events where tenant_id = ${tenantId} and payload->>'report_id' in (select id::text from content_reports where user_id = ${employeeId})`
  await admin`delete from content_reports where tenant_id = ${tenantId} and user_id = ${employeeId}`
  await admin`delete from content_issues where tenant_id = ${tenantId} and title like 'PR21 %'`
  await admin`delete from content_reporter_stats where tenant_id = ${tenantId} and user_id = ${employeeId}`
  if (cleanup.quizzes.length) {
    await admin`delete from review_queue_items where tenant_id = ${tenantId} and source_id in (select aa.id from attempt_answers aa join attempts a on a.id = aa.attempt_id where a.quiz_id in ${admin(cleanup.quizzes)})`
    await admin`delete from attempts where quiz_id in ${admin(cleanup.quizzes)}`
    await admin`delete from quizzes where id in ${admin(cleanup.quizzes)}`
  }
  if (cleanup.workshops.length) {
    await admin`delete from review_queue_items where tenant_id = ${tenantId} and source_id in (select id from workshop_submissions where workshop_id in ${admin(cleanup.workshops)})`
    await admin`delete from workshop_submissions where workshop_id in ${admin(cleanup.workshops)}`
    await admin`delete from workshops where id in ${admin(cleanup.workshops)}`
  }
  if (cleanup.assignments.length) await admin`delete from assignments where id in ${admin(cleanup.assignments)}`
  if (cleanup.banks.length) await admin`delete from question_banks where id in ${admin(cleanup.banks)}`
  if (cleanup.enrollments.length) await admin`delete from enrollments where id in ${admin(cleanup.enrollments)}`
  if (cleanup.courses.length) await admin`delete from courses where id in ${admin(cleanup.courses)}`
  if (cleanup.resources.length) await admin`delete from resources where id in ${admin(cleanup.resources)}`
  if (cleanup.media.length) await admin`delete from media_assets where id in ${admin(cleanup.media)}`
  await admin`delete from notifications where tenant_id = ${tenantId} and user_id in ${admin(users)} and created_at > now() - interval '1 hour' and code in ('review_needed', 'workshop_submitted', 'assignment_new', 'attempt_passed', 'attempt_failed')`
  await admin.end()
})

beforeEach(async () => {
  await admin`delete from learning_time_sessions where tenant_id in (${tenantId}, ${otherTenantId})`
  await admin`delete from learning_time_totals where tenant_id in (${tenantId}, ${otherTenantId})`
  await admin`update lesson_progress set content_seconds = 0, discarded_seconds = 0, sessions_count = 0 where enrollment_id = ${enrollmentId}`
})

// ── Критерий 7 ────────────────────────────────────────────────────────────────────────────

describe('критерий 7: урок открыт и 3 минуты без активности', () => {
  it('зачтено ≤ 30 с, сегмент закрыт idle_timeout, следующая активность — сегмент 2', async () => {
    const t0 = Date.now()
    const key = randomUUID()
    const first = await send(employeeId, beat({ sessionKey: key, seq: 1 }), at(t0, 30))
    expect(first.credited).toBe(30)
    // Три минуты без биений. Фоновая задача успевает пройти: сегмент без биений > 120 с — stale
    expect(await closeStaleSessions(tenantId, { now: at(t0, 30 + 150) })).toBe(1)
    expect((await sessionRows(key))[0]!.closed_reason).toBe('stale')

    const next = await send(employeeId, beat({ sessionKey: key, seq: 2, activeMs: 11_000 }), at(t0, 30 + 180 + 30))
    expect(next.segmentNo).toBe(2)
    const rows = await sessionRows(key)
    expect(rows).toHaveLength(2)
    // Сеанс вернулся — значит, это был простой, а не аварийное завершение (Р-21.5)
    expect(rows[0]!.closed_reason).toBe('idle_timeout')
    expect(rows[0]!.credited_seconds).toBeLessThanOrEqual(30)
    expect(rows[1]!.segment_no).toBe(2)
    expect(rows[1]!.closed_reason).toBeNull()
    // Пауза не засчитана вовсе: во втором сегменте — только активность после возвращения
    expect(rows[1]!.credited_seconds).toBe(11)
  })

  it('без фоновой задачи: биение после паузы > 120 с само закрывает сегмент idle_timeout', async () => {
    const t0 = Date.now()
    const key = randomUUID()
    await send(employeeId, beat({ sessionKey: key, seq: 1 }), at(t0, 30))
    await send(employeeId, beat({ sessionKey: key, seq: 2 }), at(t0, 60))
    const r = await send(employeeId, beat({ sessionKey: key, seq: 3 }), at(t0, 60 + 181))
    const rows = await sessionRows(key)
    expect(rows[0]!.closed_reason).toBe('idle_timeout')
    expect(rows[0]!.credited_seconds).toBe(60)
    expect(r.segmentNo).toBe(2)
  })
})

// ── Критерий 8 ────────────────────────────────────────────────────────────────────────────

describe('критерий 8: вкладку свернули на 10 минут', () => {
  it('статья: время не засчитано', async () => {
    const t0 = Date.now()
    const key = randomUUID()
    await send(employeeId, beat({ sessionKey: key, seq: 1 }), at(t0, 30))
    for (let i = 0; i < 20; i++) {
      const r = await send(employeeId, beat({ sessionKey: key, seq: 2 + i, visible: false }), at(t0, 60 + i * 30))
      expect(r.credited).toBe(0)
    }
    const [row] = await sessionRows(key)
    expect(row!.credited_seconds).toBe(30)
    expect(row!.media_seconds).toBe(0)
  })

  it('видео: засчитан прирост воспроизведения, не больше 1,5 × длины ролика', async () => {
    // Урок-видео на 4 минуты: 1,5 × 240 = 360 секунд потолка при скрытой вкладке
    const stamp = Date.now()
    const [media] = await admin`
      insert into media_assets (tenant_id, key, original_name, kind, mime, bytes, duration_sec, status, origin)
      values (${tenantId}, ${`t/${tenantId}/v221-${stamp}.mp4`}, 'v221-video.mp4', 'video', 'video/mp4', 1000, 240, 'ready', 'lesson_attachment') returning id`
    cleanup.media.push(media!.id as string)
    const [res] = await admin`
      insert into resources (tenant_id, title, slug, kind, media_id)
      values (${tenantId}, 'PR21 відео', ${`v221-video-${stamp}`}, 'video', ${media!.id}) returning id`
    cleanup.resources.push(res!.id as string)
    const [c] = await admin`insert into courses (tenant_id, title, slug) values (${tenantId}, 'PR21 курс з відео', ${`v221-course-${stamp}`}) returning id`
    cleanup.courses.push(c!.id as string)
    const [v] = await admin`insert into course_versions (tenant_id, course_id, version, status) values (${tenantId}, ${c!.id}, 1, 'published') returning id`
    const [m] = await admin`insert into modules (tenant_id, course_version_id, title, sort) values (${tenantId}, ${v!.id}, 'Модуль', 0) returning id`
    const [l] = await admin`insert into lessons (tenant_id, module_id, title, sort, item_type, item_id) values (${tenantId}, ${m!.id}, 'PR21 урок-відео', 0, 'resource', ${res!.id}) returning id`
    const videoLesson = l!.id as string

    const t0 = Date.now()
    const key = randomUUID()
    await send(employeeId, beat({ sessionKey: key, seq: 1, subjectId: videoLesson, enrollmentId: null }), at(t0, 30))
    const got: number[] = []
    for (let i = 0; i < 20; i++) {
      got.push((await send(employeeId, beat({ sessionKey: key, seq: 2 + i, subjectId: videoLesson, enrollmentId: null, visible: false }), at(t0, 60 + i * 30))).credited)
    }
    // Первые 12 биений (360 с) — зачтены, дальше потолок медиа
    expect(got.slice(0, 12).every(c => c === 30)).toBe(true)
    expect(got.slice(12).every(c => c === 0)).toBe(true)
    const [row] = await sessionRows(key)
    expect(row!.media_seconds).toBe(360)
    expect(row!.credited_seconds).toBe(30 + 360)
    expect(row!.closed_reason).toBeNull()
  })
})

// ── Критерий 9 ────────────────────────────────────────────────────────────────────────────

describe('критерий 9: 95 минут непрерывной активности', () => {
  it('зачтено 5400 с, «Ви ще тут?», после подтверждения — новый сегмент', async () => {
    const t0 = Date.now()
    const key = randomUUID()
    let last = await send(employeeId, beat({ sessionKey: key, seq: 1 }), at(t0, 30))
    for (let n = 2; n <= 190; n++) {
      last = await send(employeeId, beat({ sessionKey: key, seq: n }), at(t0, n * 30))
      if (n <= 180) continue
      // После потолка время стоит, сколько бы человек ни был активен
      expect(last.credited).toBe(0)
      expect(last.stillHere).toBe(true)
    }
    let rows = await sessionRows(key)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.credited_seconds).toBe(5400)
    expect(rows[0]!.closed_reason).toBe('segment_cap')
    expect(rows[0]!.beats_count).toBe(190)

    const resumed = await send(employeeId, beat({ sessionKey: key, seq: 191, resume: true }), at(t0, 191 * 30))
    expect(resumed.segmentNo).toBe(2)
    expect(resumed.stillHere).toBe(false)
    rows = await sessionRows(key)
    expect(rows).toHaveLength(2)
    expect(rows[1]!.closed_reason).toBeNull()
    expect(rows[1]!.credited_seconds).toBe(30)
  }, 180_000)
})

// ── Критерий 10 ───────────────────────────────────────────────────────────────────────────

describe('критерий 10: телефон 40 минут без связи', () => {
  it('биения приняты, is_offline_replay = true, time_confidence = partial', async () => {
    const t0 = Date.now()
    const key = randomUUID()
    for (let n = 1; n <= 3; n++) await send(employeeId, beat({ sessionKey: key, seq: n, device: 'mobile' }), at(t0, n * 30))

    // 80 биений по 30 секунд (40 минут) копились на телефоне и уходят пакетом при восстановлении
    const now = at(t0, 120 + 80 * 30 + 5)
    const buffered = Array.from({ length: 80 }, (_, i) => beat({
      sessionKey: key, seq: 4 + i, device: 'mobile', clientTs: at(t0, 120 + i * 30).toISOString(),
    }))
    const r = await recordBeats(ctxOf(employeeId), { beats: buffered, sentAt: now.toISOString() }, { now })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.result.accepted).toBe(80)
    expect(r.result.credited).toBe(80 * 30)

    const rows = await sessionRows(key)
    expect(rows.some(s => s.is_offline_replay)).toBe(true)
    expect(rows.filter(s => !s.is_offline_replay).every(s => s.closed_reason === 'idle_timeout')).toBe(true)
    expect(rows.every(s => s.closed_reason !== null), 'догрузка не оставляет открытых сегментов').toBe(true)

    await rollupTenant(tenantId)
    const [total] = await admin`select * from learning_time_totals where user_id = ${employeeId} and subject_id = ${lessonA}`
    expect(total!.confidence).toBe('partial')
    expect(total!.content_seconds).toBe(90 + 80 * 30)
    const [lp] = await admin`select content_seconds from lesson_progress where enrollment_id = ${enrollmentId} and lesson_id = ${lessonA}`
    expect(lp!.content_seconds).toBe(90 + 80 * 30)

    // Тот же пакет повторно (ответ потерялся в сети) — ничего не удваивается
    const again = await recordBeats(ctxOf(employeeId), { beats: buffered, sentAt: now.toISOString() }, { now })
    expect(again.ok && again.result.credited).toBe(0)
    expect(again.ok && again.result.duplicates).toBe(80)
  })

  it('пакет старше 24 часов: 422 time.replay_too_old, потеря записана в выброшенное', async () => {
    const now = new Date()
    const key = randomUUID()
    const old = Array.from({ length: 4 }, (_, i) => beat({
      sessionKey: key, seq: 1 + i, activeMs: 20_000, clientTs: new Date(now.getTime() - 26 * 3600_000 + i * 30_000).toISOString(),
    }))
    const r = await recordBeats(ctxOf(employeeId), { beats: old, sentAt: now.toISOString() }, { now })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('replay_too_old')
    expect(r.discarded).toBe(80)
    const [row] = await sessionRows(key)
    expect(row!.credited_seconds).toBe(0)
    expect(row!.discarded_seconds).toBe(80)
    expect(row!.is_offline_replay).toBe(true)
  })
})

// ── Сквозная проверка 22 ──────────────────────────────────────────────────────────────────

describe('сквозная проверка 22 (docs/v2/42 §5): время — биениями, а не «открыл — закрыл»', () => {
  it('вкладка открыта 3 часа, биения не приходят (вкладка скрыта) — засчитано ноль', async () => {
    const t0 = Date.now()
    const key = randomUUID()
    // Открыл урок (5 секунд на экране) и свернул вкладку. Три часа биений нет; последнее
    // биение уходит при закрытии — скрытым. «Открыл — закрыл» дало бы 3 часа
    await send(employeeId, beat({ sessionKey: key, seq: 1, activeMs: 5_000 }), at(t0, 5))
    const r = await send(employeeId, beat({ sessionKey: key, seq: 2, visible: false, activeMs: 0, end: true }), at(t0, 3 * 3600))
    expect(r.credited).toBe(0)
    const [row] = await sessionRows(key)
    // Пять секунд — случайное открытие (< 10 с): выброшены целиком, сегмент закрыт простоем
    expect(row!.credited_seconds).toBe(0)
    expect(row!.discarded_seconds).toBe(5)
    expect(row!.closed_reason).toBe('idle_timeout')

    await rollupTenant(tenantId)
    const [lp] = await admin`select content_seconds, discarded_seconds from lesson_progress where enrollment_id = ${enrollmentId} and lesson_id = ${lessonA}`
    expect(lp).toEqual({ content_seconds: 0, discarded_seconds: 5 })
    const [total] = await admin`select content_seconds from learning_time_totals where user_id = ${employeeId} and subject_id = ${lessonA}`
    expect(total!.content_seconds).toBe(0)
  })

  it('приходят биения с active_ms — засчитано не больше суммы active_ms', async () => {
    const t0 = Date.now()
    const key = randomUUID()
    const actives = [30_000, 12_500, 7_000, 29_999, 45_000, 30_000, 1_000]
    for (const [i, a] of actives.entries()) await send(employeeId, beat({ sessionKey: key, seq: 1 + i, activeMs: a }), at(t0, 30 + i * 30))
    const [row] = await sessionRows(key)
    const sumActive = Math.floor(actives.reduce((s, a) => s + a, 0) / 1000)
    expect(row!.credited_seconds).toBeLessThanOrEqual(sumActive)
    expect(row!.credited_seconds).toBe(30 + 12 + 7 + 29 + 30 + 30 + 1)
  })

  it('повторное биение с тем же seq не увеличивает счётчик и возвращает тот же credited', async () => {
    const t0 = Date.now()
    const key = randomUUID()
    await send(employeeId, beat({ sessionKey: key, seq: 1 }), at(t0, 30))
    const first = await send(employeeId, beat({ sessionKey: key, seq: 2, activeMs: 17_000 }), at(t0, 60))
    const again = await send(employeeId, beat({ sessionKey: key, seq: 2, activeMs: 17_000 }), at(t0, 75))
    expect(again.duplicate).toBe(true)
    expect(again.credited).toBe(first.credited)
    const [row] = await sessionRows(key)
    expect(row!.credited_seconds).toBe(47)
    expect(row!.beats_count).toBe(2)
  })
})

// ── Два устройства, смена вида, завершение ────────────────────────────────────────────────

describe('пара «человек × урок»', () => {
  it('два устройства одновременно: один открытый сегмент, сумма не больше реального времени', async () => {
    const t0 = Date.now()
    const phone = randomUUID()
    const laptop = randomUUID()
    for (let i = 0; i < 10; i++) {
      await send(employeeId, beat({ sessionKey: laptop, seq: 1 + i }), at(t0, 30 + i * 30))
      await send(employeeId, beat({ sessionKey: phone, seq: 1 + i, device: 'mobile' }), at(t0, 45 + i * 30))
    }
    const rows = await admin`select * from learning_time_sessions where user_id = ${employeeId} and subject_id = ${lessonA}`
    expect(rows.filter(r => r.closed_reason === null)).toHaveLength(1)
    const total = rows.reduce((s, r) => s + (r.credited_seconds as number), 0)
    // 5 минут на двух устройствах разом — не 10 минут
    expect(total).toBeLessThanOrEqual(30 + 10 * 30)
    expect(total).toBeGreaterThanOrEqual(10 * 30 - 30)
  })

  it('урок зачтён — открытый сегмент закрыт completed', async () => {
    const t0 = Date.now()
    const key = randomUUID()
    await send(employeeId, beat({ sessionKey: key, seq: 1, subjectId: lessonB }), at(t0, 30))
    await readThrough(admin, enrollmentId, lessonB)
    const r = await completeLesson(ctxOf(employeeId), enrollmentId, lessonB)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const [row] = await sessionRows(key)
    expect(row!.closed_reason).toBe('completed')
  })
})

// ── Изоляция и права ──────────────────────────────────────────────────────────────────────

describe('изоляция: чужой тенант, чужая запись, чужой сеанс', () => {
  it('урок чужого тенанта и чужая запись на курс — «не найдено» (CLAUDE.md п. 15)', async () => {
    const now = new Date()
    const foreign = await recordBeat(ctxOf(employeeId), beat({ sessionKey: randomUUID(), seq: 1, subjectId: foreignLessonId, enrollmentId: null }), { now })
    expect(foreign).toEqual({ ok: false, code: 'not_found' })
    const notMine = await recordBeat(ctxOf(cashierId), beat({ sessionKey: randomUUID(), seq: 1 }), { now })
    expect(notMine).toEqual({ ok: false, code: 'not_found' })
    const [{ n }] = await admin`select count(*)::int as n from learning_time_sessions where tenant_id in (${tenantId}, ${otherTenantId})` as unknown as [{ n: number }]
    expect(n).toBe(0)
  })

  it('чужой session_key не даёт писать в чужой сегмент', async () => {
    const t0 = Date.now()
    const key = randomUUID()
    await send(employeeId, beat({ sessionKey: key, seq: 1 }), at(t0, 30))
    const hijack = await recordBeat(ctxOf(cashierId), beat({ sessionKey: key, seq: 2, enrollmentId: null }), { now: at(t0, 60) })
    expect(hijack).toEqual({ ok: false, code: 'invalid' })
    const rows = await sessionRows(key)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.user_id).toBe(employeeId)
    expect(rows[0]!.credited_seconds).toBe(30)
  })

  it('RLS: из чужого тенанта сегменты и витрина не видны', async () => {
    const t0 = Date.now()
    await send(employeeId, beat({ sessionKey: randomUUID(), seq: 1 }), at(t0, 30))
    await rollupTenant(tenantId)
    const seen = await withTenant(otherTenantId, null, async tx => ({
      sessions: [...await tx.execute(sql`select id from learning_time_sessions`) as unknown as unknown[]].length,
      totals: [...await tx.execute(sql`select id from learning_time_totals`) as unknown as unknown[]].length,
    }))
    expect(seen).toEqual({ sessions: 0, totals: 0 })
  })
})

describe('GET /learning/time/totals: кто чьё время видит (37 §2)', () => {
  const access = (userId: string, grants: Access['grants']): Access => ({ userId, tenantId, grants, activeRole: null, roles: [] })
  const learnerGrant = [{ scopes: ['learn.view'], scopeType: 'tenant' as const, scopeId: null }]

  beforeEach(async () => {
    await send(employeeId, beat({ sessionKey: randomUUID(), seq: 1 }), new Date(Date.now() + 30_000))
    await rollupTenant(tenantId)
  })

  it('своё время видит каждый', async () => {
    const r = await timeTotals(access(employeeId, learnerGrant), {})
    expect(r.ok && r.rows.length).toBeGreaterThan(0)
    expect(r.ok && r.rows.every(x => x.userId === employeeId)).toBe(true)
  })

  it('чужое без time.metrics.view — 403; наставник — только своей точки; администратор — всех', async () => {
    expect(await timeTotals(access(cashierId, learnerGrant), { userId: employeeId })).toEqual({ ok: false, code: 'forbidden' })
    const mentorGrant = [{ scopes: ['learn.view', 'time.metrics.view'], scopeType: 'location' as const, scopeId: lazarevaId }]
    const own = await timeTotals(access(mentorId, mentorGrant), { userId: employeeId })
    expect(own.ok && own.rows.length).toBeGreaterThan(0)
    expect(await timeTotals(access(mentorId, mentorGrant), { userId: cashierId })).toEqual({ ok: false, code: 'forbidden' })
    const adminGrant = [{ scopes: ['learn.view', 'time.metrics.view'], scopeType: 'tenant' as const, scopeId: null }]
    expect((await timeTotals(access(adminId, adminGrant), { userId: cashierId })).ok).toBe(true)
  })

  it('несуществующий и чужой человек — 404, а не 403', async () => {
    const adminGrant = [{ scopes: ['learn.view', 'time.metrics.view'], scopeType: 'tenant' as const, scopeId: null }]
    expect(await timeTotals(access(adminId, adminGrant), { userId: randomUUID() })).toEqual({ ok: false, code: 'not_found' })
    const [foreignUser] = await admin`insert into users (tenant_id, full_name) values (${otherTenantId}, 'Чужа людина') returning id`
    try {
      expect(await timeTotals(access(adminId, adminGrant), { userId: foreignUser!.id as string })).toEqual({ ok: false, code: 'not_found' })
    }
    finally {
      await admin`delete from users where id = ${foreignUser!.id}`
    }
  })
})

// ── Попытка теста: учёт, а не правило; жалоба не «съедает» время ──────────────────────────

describe('попытка с лимитом времени и жалоба на вопрос (PR-23 × PR-21)', () => {
  let quizId: string
  let qSingle: string
  let qFree: string

  beforeAll(async () => {
    const author = ctxOf(adminId)
    const stem = (text: string) => [{ id: 'b1', type: 'text' as const, html: `<p>${text}</p>` }]
    const bank = await createBank(author, { name: `PR21 банк ${Date.now()}` })
    cleanup.banks.push(bank.id)
    qSingle = (await createQuestion(author, {
      bankId: bank.id, kind: 'single', stem: stem('PR21 Температура зберігання?'), options: [{ id: 'a', text: '+4' }, { id: 'b', text: '+20' }],
      answer: { correctId: 'a' }, isCritical: false, difficulty: 2, points: 1, scoringMethod: 'formula', attachFiles: false, negativeMarking: false, tags: [],
    })).id
    qFree = (await createQuestion(author, {
      bankId: bank.id, kind: 'free', stem: stem('PR21 Що зробиш, якщо гість незадоволений?'),
      answer: { criteria: ['Вибачення'], reference: 'Вибачитись' }, isCritical: false, difficulty: 2, points: 1, scoringMethod: 'formula', attachFiles: false, negativeMarking: false, tags: [],
    })).id
    const quiz = await createQuiz(author, { title: 'PR21 Тест з лімітом часу', kind: 'quiz', tags: [], selectionMode: 'fixed', requiresOfflineConfirm: false })
    quizId = quiz.id
    cleanup.quizzes.push(quizId)
    await setQuizQuestions(author, quizId, [{ questionId: qSingle, sort: 0 }, { questionId: qFree, sort: 1 }])
    // Лимит времени — правило назначения, не теста (CLAUDE.md п. 11)
    cleanup.assignments.push(await assignWithParams(author, 'test', quizId, { timeLimitSec: 1800, attemptsAllowed: 0, shuffleQuestions: false, shuffleOptions: false }, [employeeId]))
  })

  it('время в форме жалобы: дедлайн сдвинут, «Час на випробування» его не включает; свёртка не трогает попытку', async () => {
    const learner = ctxOf(employeeId)
    const t0 = Date.now()
    // Условия теста на стартовом экране — «Час на контент» этого теста; читаются до старта
    const intro = randomUUID()
    await send(employeeId, beat({ sessionKey: intro, seq: 1, kind: 'content', subjectType: 'quiz', subjectId: quizId, enrollmentId: null, activeMs: 20_000 }), at(t0, -40))

    const started = await startAttempt(learner, quizId)
    expect(started.ok, JSON.stringify(started)).toBe(true)
    if (!started.ok) return
    const attemptId = started.attemptId
    const [before] = await admin`select deadline_at, snapshot, params, status, updated_at from attempts where id = ${attemptId}`
    expect(before!.deadline_at, 'лимит из назначения не дал дедлайна').not.toBeNull()

    // Попытка: два биения по 30 секунд — открытие попытки закрыло чтение условий
    const run = randomUUID()
    const w = (p: Partial<BeatInput> & { seq: number }) => beat({ sessionKey: run, kind: 'attempt', subjectType: 'quiz', subjectId: quizId, enrollmentId: null, ...p })
    await send(employeeId, w({ seq: 1 }), at(t0, 60))
    await send(employeeId, w({ seq: 2 }), at(t0, 90))
    expect((await sessionRows(intro))[0]!.closed_reason).toBe('navigated_away')

    // Жалоба на вопрос: 40 секунд в форме. Экран на это время ставит счётчик на паузу
    // (Р-21.9), сервер возвращает те же 40 секунд сдвигом дедлайна (PR-23, `36` §7.7 б)
    const report = await submitReport(learner, {
      targetType: 'question', targetId: qSingle, issueType: 'unclear', source: 'attempt', attemptId,
      comment: 'PR21 питання незрозуміле', context: { formSeconds: 40 },
    })
    expect(report.ok, JSON.stringify(report)).toBe(true)
    const [shifted] = await admin`select deadline_at from attempts where id = ${attemptId}`
    expect(new Date(shifted!.deadline_at).getTime() - new Date(before!.deadline_at).getTime()).toBe(40_000)

    // После формы — 30 секунд работы: биение через 70 секунд несёт только их
    const afterForm = await send(employeeId, w({ seq: 3, activeMs: 30_000 }), at(t0, 90 + 70))
    expect(afterForm.credited).toBe(30)

    // Ответы: способ ввода ставит сервер (docs/v2/30 §3.7)
    expect((await saveAnswer(learner, attemptId, qSingle, { optionId: 'a' })).ok).toBe(true)
    expect((await saveAnswer(learner, attemptId, qFree, { text: 'Вибачусь і заміню страву' })).ok).toBe(true)
    const modes = await admin`select input_mode from attempt_answers where attempt_id = ${attemptId}`
    expect(modes.map(m => m.input_mode)).toEqual(['text', 'text'])

    const submitted = await submitAttempt(learner, attemptId)
    expect(submitted.ok && submitted.status).toBe('review')
    expect((await sessionRows(run))[0]!.closed_reason).toBe('completed')
    const [afterSubmit] = await admin`select deadline_at, snapshot, params, status, updated_at from attempts where id = ${attemptId}`

    // Свёртка: чистое время попытки — 90 секунд, форма жалобы — в выброшенном (40 с)
    const s = await rollupTenant(tenantId)
    expect(s.attempts).toBe(1)
    const [after] = await admin`select * from attempts where id = ${attemptId}`
    expect(after!.net_seconds).toBe(90)
    expect(after!.discarded_seconds).toBe(40)
    // Учёт, а не правило: дедлайн со сдвигом, снапшот, параметры, статус и updated_at — как были
    expect(new Date(after!.deadline_at).getTime()).toBe(new Date(afterSubmit!.deadline_at).getTime())
    expect(new Date(after!.deadline_at).getTime()).toBe(new Date(shifted!.deadline_at).getTime())
    expect(after!.snapshot).toEqual(before!.snapshot)
    expect(after!.params).toEqual(before!.params)
    expect(after!.status).toBe(afterSubmit!.status)
    expect(new Date(after!.updated_at).getTime()).toBe(new Date(afterSubmit!.updated_at).getTime())

    // Очередь проверки: развёрнутый ответ получил «Час на контент» и «Час на випробування»
    const [item] = await admin`
      select q.content_seconds, q.attempt_seconds, q.time_confidence from review_queue_items q
      join attempt_answers aa on aa.id = q.source_id where aa.attempt_id = ${attemptId} and q.task_type = 'quiz_open_answer'`
    expect(item, 'развёрнутый ответ не попал в очередь').toBeDefined()
    expect(item!.attempt_seconds).toBe(90)
    expect(item!.content_seconds).toBe(20)

    // Повторная свёртка ничего не меняет — она идемпотентна
    const again = await rollupTenant(tenantId)
    expect(again).toMatchObject({ attempts: 0, totals: 0, queueItems: 0, lessonProgress: 0 })
  })
})

// ── Практикум: чтение задания и работа над сдачей ─────────────────────────────────────────

describe('практикум: «Час на контент» и «Час на випробування» сдачи', () => {
  it('время сдачи и строки очереди считаются из сегментов, отправка закрывает сегмент', async () => {
    const author = ctxOf(adminId)
    const learner = ctxOf(employeeId)
    const w = await createWorkshop(author, {
      title: 'PR21 Практикум: викладка вітрини', description: [{ id: 'b1', type: 'text', html: '<p>Викладіть вітрину</p>' }], submissionKinds: ['text'],
      minTextLength: 10, criteria: [{ text: 'Вітрина за стандартом' }], reviewerRule: 'any_mentor', slaHours: 24,
      allowRework: true, maxReworks: 1, status: 'published',
    })
    cleanup.workshops.push(w.id)
    // Работа над сдачей шла до её отправки: время биений — в прошлом относительно сдачи
    const t0 = Date.now() - 10 * 60_000
    const reading = randomUUID()
    const working = randomUUID()
    const b = (key: string, kind: 'content' | 'attempt', seq: number) => beat({ sessionKey: key, seq, kind, subjectType: 'workshop', subjectId: w.id, enrollmentId: null })
    await send(employeeId, b(reading, 'content', 1), at(t0, 30))
    await send(employeeId, b(reading, 'content', 2), at(t0, 60))
    await send(employeeId, b(working, 'attempt', 1), at(t0, 90))
    await send(employeeId, b(working, 'attempt', 2), at(t0, 120))
    await send(employeeId, b(working, 'attempt', 3), at(t0, 150))

    const sub = await submitWorkshop(learner, w.id, { text: 'Виклав вітрину за стандартом, фото додам' })
    expect(sub.ok, JSON.stringify(sub)).toBe(true)
    if (!sub.ok) return
    expect((await sessionRows(working))[0]!.closed_reason).toBe('completed')

    const s = await rollupTenant(tenantId)
    expect(s.submissions).toBe(1)
    const [row] = await admin`select content_seconds, attempt_seconds from workshop_submissions where id = ${sub.submissionId}`
    expect(row).toEqual({ content_seconds: 60, attempt_seconds: 90 })
    const [item] = await admin`select content_seconds, attempt_seconds, time_confidence from review_queue_items where task_type = 'workshop' and source_id = ${sub.submissionId}`
    expect(item).toEqual({ content_seconds: 60, attempt_seconds: 90, time_confidence: 'ok' })
    const [total] = await admin`select content_seconds, attempt_seconds, sessions_count from learning_time_totals where user_id = ${employeeId} and subject_id = ${w.id}`
    expect(total).toEqual({ content_seconds: 60, attempt_seconds: 90, sessions_count: 2 })
  })
})
