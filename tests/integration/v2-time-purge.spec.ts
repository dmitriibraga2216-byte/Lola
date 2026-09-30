import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * `time.purge_sessions` (docs/v2/37 §11, решение Р-T1 `docs/v2/44` §11): сегменты учёта времени
 * старше 400 дней удаляются, **и ни одна посчитанная цифра не меняется** — ни витрина, ни
 * `lesson_progress`, ни попытка теста; человек, вернувшийся к уроку через год, продолжает счёт,
 * а не начинает с нуля.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const { purgeLearningTimeSessions, rollupTenant } = await import('../../server/services/learningTimeRollup')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

let tenantId: string
let otherTenantId: string
let employeeId: string
let courseId: string
let versionId: string
let lessonOld: string
let lessonMixed: string
let quizId: string
let enrollmentId: string
let attemptId: string
const DAY = 86_400_000
const now = new Date()
const daysAgo = (d: number, plusSec = 0) => new Date(now.getTime() - d * DAY + plusSec * 1000)

/** Закрытый сегмент: `credited` секунд, начат `start`. */
async function segment(p: { subjectType: string, subjectId: string, kind?: string, start: Date, credited: number, discarded?: number, enrollment?: string | null, tenant?: string }) {
  const last = new Date(p.start.getTime() + (p.credited + 5) * 1000)
  await admin`
    insert into learning_time_sessions (tenant_id, user_id, enrollment_id, subject_type, subject_id, kind, session_key,
      segment_no, beats_count, started_at, last_beat_at, closed_reason, credited_seconds, discarded_seconds)
    values (${p.tenant ?? tenantId}, ${employeeId}, ${p.enrollment === undefined ? enrollmentId : p.enrollment}, ${p.subjectType}, ${p.subjectId},
      ${p.kind ?? 'content'}, ${randomUUID()}, 1, 3, ${p.start}, ${last}, 'session_end', ${p.credited}, ${p.discarded ?? 0})`
}

async function totalsOf(subjectId: string) {
  const [t] = await admin`select * from learning_time_totals where tenant_id = ${tenantId} and user_id = ${employeeId} and subject_id = ${subjectId} and enrollment_id is not distinct from ${enrollmentId}`
  return t
}
async function lessonSeconds(lessonId: string) {
  const [lp] = await admin`select content_seconds, discarded_seconds, sessions_count from lesson_progress where enrollment_id = ${enrollmentId} and lesson_id = ${lessonId}`
  return lp
}
const segCount = async (subjectId: string) => Number((await admin`select count(*)::int as n from learning_time_sessions where user_id = ${employeeId} and subject_id = ${subjectId}`)[0]!.n)

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  const [other] = await admin`
    insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції')
    on conflict (slug) do update set name = excluded.name returning id`
  otherTenantId = other!.id as string
  employeeId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380670000003'`)[0]!.id as string
  const [course] = await admin`select id, published_version_id from courses where tenant_id = ${tenantId} and published_version_id is not null order by created_at limit 1`
  courseId = course!.id as string
  versionId = course!.published_version_id as string
  const lessons = await admin`
    select l.id from lessons l join modules m on m.id = l.module_id
    where m.course_version_id = ${versionId} and l.item_type = 'resource' order by m.sort, l.sort limit 2`
  lessonOld = lessons[0]!.id as string
  lessonMixed = lessons[1]!.id as string
  quizId = (await admin`select id from quizzes where tenant_id = ${tenantId} order by created_at limit 1`)[0]!.id as string
  const [e] = await admin`
    insert into enrollments (tenant_id, user_id, subject_id, version_id, source, status, started_at)
    values (${tenantId}, ${employeeId}, ${courseId}, ${versionId}, 'self', 'in_progress', ${daysAgo(500)}) returning id`
  enrollmentId = e!.id as string
  await admin`insert into lesson_progress (tenant_id, enrollment_id, lesson_id) values (${tenantId}, ${enrollmentId}, ${lessonOld}), (${tenantId}, ${enrollmentId}, ${lessonMixed})`
  const [a] = await admin`
    insert into attempts (tenant_id, quiz_id, user_id, enrollment_id, attempt_no, snapshot, params, status, started_at, submitted_at)
    values (${tenantId}, ${quizId}, ${employeeId}, ${enrollmentId}, 1, '[]'::jsonb, '{}'::jsonb, 'passed', ${daysAgo(450)}, ${daysAgo(450, 900)}) returning id`
  attemptId = a!.id as string

  // Урок, замолчавший 500 дней назад: 300 + 240 с за два захода
  await segment({ subjectType: 'lesson', subjectId: lessonOld, start: daysAgo(500), credited: 300, discarded: 4 })
  await segment({ subjectType: 'lesson', subjectId: lessonOld, start: daysAgo(499), credited: 240 })
  // Урок, по которому работа ещё идёт: старый сегмент и свежий — пару уборка не трогает
  await segment({ subjectType: 'lesson', subjectId: lessonMixed, start: daysAgo(480), credited: 120 })
  await segment({ subjectType: 'lesson', subjectId: lessonMixed, start: daysAgo(3), credited: 60 })
  // Попытка теста 450 дней назад: 600 с выполнения
  await segment({ subjectType: 'quiz', subjectId: quizId, kind: 'attempt', start: daysAgo(450, 30), credited: 600 })
  // Чужой тенант: такой же старый сегмент — уборка нашего тенанта его не видит
  const [ou] = await admin`select id from users where tenant_id = ${otherTenantId} limit 1`
  if (ou) {
    await admin`
      insert into learning_time_sessions (tenant_id, user_id, subject_type, subject_id, kind, session_key, started_at, last_beat_at, closed_reason, credited_seconds)
      values (${otherTenantId}, ${ou.id}, 'lesson', ${randomUUID()}, 'content', ${randomUUID()}, ${daysAgo(600)}, ${daysAgo(600, 60)}, 'session_end', 55)`
  }
  // Сегменты вставлены сейчас — свёртка видит их изменившимися и собирает витрину
  await rollupTenant(tenantId)
})

afterAll(async () => {
  await admin`delete from learning_time_sessions where user_id = ${employeeId} and subject_id in (${lessonOld}, ${lessonMixed}, ${quizId})`
  await admin`delete from learning_time_sessions where tenant_id = ${otherTenantId}`
  await admin`delete from learning_time_totals where user_id = ${employeeId} and subject_id in (${lessonOld}, ${lessonMixed}, ${quizId})`
  await admin`delete from attempts where id = ${attemptId}`
  await admin`delete from lesson_progress where enrollment_id = ${enrollmentId}`
  await admin`delete from enrollments where id = ${enrollmentId}`
  await admin.end()
})

describe('time.purge_sessions (37 §11, Р-T1)', () => {
  it('до уборки свёртка посчитала всё из сегментов', async () => {
    expect((await totalsOf(lessonOld))!.content_seconds).toBe(540)
    expect((await lessonSeconds(lessonOld))!.content_seconds).toBe(540)
    expect((await totalsOf(lessonMixed))!.content_seconds).toBe(180)
    const [a] = await admin`select net_seconds from attempts where id = ${attemptId}`
    expect(a!.net_seconds).toBe(600)
  })

  it('убирает только замолчавшие пары, цифры не меняются, чужой тенант не тронут', async () => {
    const before = { old: await totalsOf(lessonOld), lp: await lessonSeconds(lessonOld) }
    const s = await purgeLearningTimeSessions(tenantId, { now, chunk: 1 })
    expect(s.pairs).toBeGreaterThanOrEqual(2) // урок и тест; кусками по одной паре
    expect(await segCount(lessonOld)).toBe(0)
    expect(await segCount(quizId)).toBe(0)
    expect(await segCount(lessonMixed)).toBe(2)
    const t = (await totalsOf(lessonOld))!
    expect(t.content_seconds).toBe(before.old!.content_seconds)
    expect(t.sessions_count).toBe(before.old!.sessions_count)
    expect(t.purged_content_seconds).toBe(540)
    expect(t.purged_discarded_seconds).toBe(4)
    expect(t.purged_sessions_count).toBe(2)
    expect(new Date(t.first_started_at).getTime()).toBe(new Date(before.old!.first_started_at).getTime())
    expect(await lessonSeconds(lessonOld)).toEqual(before.lp)
    expect((await totalsOf(quizId))!.attempt_seconds).toBe(600)
    // Повторный прогон ничего не делает
    expect(await purgeLearningTimeSessions(tenantId, { now })).toEqual({ pairs: 0, segments: 0 })
  })

  it('чужой тенант своей уборкой не задет', async () => {
    const [n] = await admin`select count(*)::int as n from learning_time_sessions where tenant_id = ${otherTenantId}`
    const [ou] = await admin`select id from users where tenant_id = ${otherTenantId} limit 1`
    expect(n!.n).toBe(ou ? 1 : 0)
  })

  it('возврат через год: свёртка считает «перенесено + новые сегменты», старая попытка не обнуляется', async () => {
    await segment({ subjectType: 'lesson', subjectId: lessonOld, start: daysAgo(0, -600), credited: 90 })
    await segment({ subjectType: 'quiz', subjectId: quizId, kind: 'content', start: daysAgo(0, -300), credited: 45 })
    await rollupTenant(tenantId)
    const t = (await totalsOf(lessonOld))!
    expect(t.content_seconds).toBe(630)
    expect(t.sessions_count).toBe(3)
    expect(new Date(t.first_started_at).getTime()).toBe(daysAgo(500).getTime())
    expect((await lessonSeconds(lessonOld))!.content_seconds).toBe(630)
    expect((await lessonSeconds(lessonOld))!.discarded_seconds).toBe(4)
    const [a] = await admin`select net_seconds from attempts where id = ${attemptId}`
    expect(a!.net_seconds).toBe(600)
    const q = (await totalsOf(quizId))!
    expect(q.attempt_seconds).toBe(600)
    expect(q.content_seconds).toBe(45)
    // Свёртка идемпотентна и после уборки
    await rollupTenant(tenantId)
    expect((await totalsOf(lessonOld))!.content_seconds).toBe(630)
  })
})
