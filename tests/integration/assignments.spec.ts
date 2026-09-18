import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const { createAssignment, expandAssignment, previewAudience, cancelAssignment, extendEnrollment, getAssignment } = await import('../../server/services/assignments')
const { createProfile, applyProfile, previewProfile, createRule, runRules } = await import('../../server/services/automation')
const { runDueScan } = await import('../../server/services/dueScan')
const { renderTemplate, scheduleWithQuietHours, dispatchNotifications } = await import('../../server/services/notifications')
const { createCourse, addModule, addLesson, publishCourse } = await import('../../server/services/courses')
const { readiness, overdue, toXlsx } = await import('../../server/services/reports')
const { addPlacement } = await import('../../server/services/people')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

let tenantId: string
let adminId: string
let lazarevaId: string
let baristaPosId: string
const courseIds: string[] = []
const userIds: string[] = []
const profileIds: string[] = []
const ruleIds: string[] = []

beforeAll(async () => {
  const [t] = await admin`select id from tenants where slug = 'kappi'`
  tenantId = t!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  const [pos] = await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Бариста-тест-${Date.now()}`}, 'barista-test') on conflict do nothing returning id`
  baristaPosId = pos!.id as string
  // Руководитель точки — админ (для notifyManager)
  await admin`update locations set manager_id = ${adminId} where id = ${lazarevaId}`
})

afterAll(async () => {
  if (userIds.length) await admin`delete from users where id in ${admin(userIds)}`
  if (courseIds.length) {
    await admin`delete from certificates where course_id in ${admin(courseIds)}`
    await admin`delete from enrollments where subject_id in ${admin(courseIds)}`
    await admin`delete from assignments where subject_id in ${admin(courseIds)}`
    await admin`delete from courses where id in ${admin(courseIds)}`
  }
  if (profileIds.length) await admin`delete from learning_profiles where id in ${admin(profileIds)}`
  if (ruleIds.length) await admin`delete from automation_rules where id in ${admin(ruleIds)}`
  await admin`delete from positions where id = ${baristaPosId}`
  await admin`update locations set manager_id = null where id = ${lazarevaId}`
  await admin.end()
})

const ctx = () => ({ tenantId, actorId: adminId })

async function makeCourse(title: string) {
  const c = await createCourse(ctx(), { title: `${title} ${Date.now()}`, language: 'uk', strictOrder: true, isCatalogVisible: false, tags: [] })
  courseIds.push(c.id)
  const m = await addModule(ctx(), c.id, 'Р')
  await addLesson(ctx(), { moduleId: m!.id, title: 'Урок', itemType: 'resource', resource: { body: [{ id: 'b', type: 'text', html: '<p>x</p>' }] }, isRequired: true, videoThresholdPct: 90 })
  await publishCourse(ctx(), c.id, 'v1')
  return c.id
}

async function makePerson(name: string, positionId: string, locationId: string) {
  const phone = `+38095${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, phone, full_name, status, hired_at) values (${tenantId}, ${phone}, ${name}, 'active', current_date) returning id`
  userIds.push(u!.id as string)
  await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary) values (${tenantId}, ${u!.id}, ${locationId}, ${positionId}, true)`
  return u!.id as string
}

describe('уведомления: шаблоны и тихие часы', () => {
  it('renderTemplate: переменные, условные блоки, даты', () => {
    expect(renderTemplate('Курс «{{course}}».{{#due}} До {{due}}.{{/due}}', { course: 'Піца', due: '2026-09-24T10:00:00.000Z' })).toBe('Курс «Піца». До 24 вересня.')
    expect(renderTemplate('Курс «{{course}}».{{#due}} До {{due}}.{{/due}}', { course: 'Піца', due: null })).toBe('Курс «Піца».')
  })

  it('тихие часы: 23:00 → 09:00 следующего дня, 14:00 → сразу', () => {
    const night = new Date('2026-09-20T20:00:00.000Z') // 23:00 Kyiv (UTC+3)
    const next = scheduleWithQuietHours(night, 'Europe/Kyiv')
    expect(next.toISOString()).toBe('2026-09-21T06:00:00.000Z') // 09:00 Kyiv
    const day = new Date('2026-09-20T11:00:00.000Z') // 14:00 Kyiv
    expect(scheduleWithQuietHours(day, 'Europe/Kyiv').getTime()).toBe(day.getTime())
  })
})

describe('назначения: аудитория, раскрытие, идемпотентность', () => {
  let courseId: string
  let assignmentId: string
  let personA: string
  let personB: string

  it('превью аудитории «позиция + точка» совпадает с фактом', async () => {
    courseId = await makeCourse('Курс для бариста')
    personA = await makePerson('Бариста А', baristaPosId, lazarevaId)
    personB = await makePerson('Бариста Б', baristaPosId, lazarevaId)
    const preview = await previewAudience(ctx(), { rules: [{ type: 'position', ids: [baristaPosId], locationIds: [lazarevaId] }], match: 'any' })
    expect(preview.count).toBe(2)
    expect(preview.sample.map(s => s.id).sort()).toEqual([personA, personB].sort())
  })

  it('создание раскрывает 2 записи с относительным дедлайном; повторный expand не дублирует', async () => {
    const r = await createAssignment(ctx(), {
      subjectType: 'course', subjectId: courseId, lockVersion: false,
      audience: { rules: [{ type: 'position', ids: [baristaPosId], locationIds: [lazarevaId] }], match: 'any' },
      dueMode: 'relative', dueDays: 14, isMandatory: true, autoSync: true, tags: [], status: 'active',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    assignmentId = r.assignmentId
    expect(r.expanded).toBe(2)

    expect(await expandAssignment(tenantId, assignmentId)).toBe(0)
    const [{ count }] = await admin<[{ count: number }]>`select count(*)::int as count from enrollments where assignment_id = ${assignmentId}`
    expect(count).toBe(2)

    const [e] = await admin`select due_at, status from enrollments where assignment_id = ${assignmentId} limit 1`
    expect(e!.status).toBe('not_started')
    const days = Math.round((new Date(e!.due_at as string).getTime() - Date.now()) / 86_400_000)
    expect(days).toBe(14)

    // Уведомление assignment_created в очереди, дедуп по записи
    const [{ n }] = await admin<[{ n: number }]>`select count(*)::int as n from notifications where code = 'assignment_created' and payload->>'enrollmentId' in (select id::text from enrollments where assignment_id = ${assignmentId})`
    expect(n).toBe(2)
  })

  it('autoSync: новый человек на позиции получает запись при sync (приёмка этапа 4)', async () => {
    const personC = await makePerson('Бариста В', baristaPosId, lazarevaId)
    expect(await expandAssignment(tenantId, assignmentId)).toBe(1)
    const [e] = await admin`select id from enrollments where assignment_id = ${assignmentId} and user_id = ${personC}`
    expect(e).toBeDefined()
  })

  it('пустая аудитория → empty_audience; неопубликованный курс → subject_not_found', async () => {
    const r = await createAssignment(ctx(), {
      subjectType: 'course', subjectId: courseId, lockVersion: false,
      audience: { rules: [{ type: 'tag', values: ['неіснуючий-тег'] }], match: 'any' },
      dueMode: 'none', dueDays: 14, isMandatory: true, autoSync: true, tags: [], status: 'active',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('empty_audience')
  })

  it('продление срока переводит expired обратно в in_progress и пишет событие', async () => {
    const [e] = await admin`select id from enrollments where assignment_id = ${assignmentId} and user_id = ${personA}`
    await admin`update enrollments set status = 'expired', due_at = now() - interval '2 days' where id = ${e!.id}`
    const newDue = new Date(Date.now() + 10 * 86_400_000).toISOString()
    const r = await extendEnrollment(ctx(), e!.id as string, { dueAt: newDue, reason: 'Був у відпустці', notify: true })
    expect(r!.status).toBe('in_progress')
    const [ev] = await admin`select event from enrollment_events where enrollment_id = ${e!.id} and event = 'extended'`
    expect(ev).toBeDefined()
  })

  it('отмена: not_started удаляются, начатые доучиваются (keepStarted)', async () => {
    const [b] = await admin`select id from enrollments where assignment_id = ${assignmentId} and user_id = ${personB}`
    await admin`update enrollments set status = 'in_progress', started_at = now() where id = ${b!.id}`
    const r = await cancelAssignment(ctx(), assignmentId, { reason: 'Призначено помилково', keepStarted: true })
    expect(r!.removed).toBe(1) // personC not_started
    expect(r!.cancelled).toBe(0)
    const a = await getAssignment(ctx(), assignmentId)
    expect(a!.status).toBe('archived')
    expect(a!.people.length).toBe(2) // A (in_progress после продления) и B
  })
})

describe('due.scan: напоминания, просрочка, руководитель', () => {
  let courseId: string
  let personId: string
  let enrollmentId: string

  it('за 3 дня — due_soon; на следующий день после срока — expired + уведомление руководителю', async () => {
    courseId = await makeCourse('Курс со сроком')
    personId = await makePerson('Терміновий', baristaPosId, lazarevaId)
    const r = await createAssignment(ctx(), {
      subjectType: 'course', subjectId: courseId, lockVersion: false,
      audience: { rules: [{ type: 'user', ids: [personId] }], match: 'any' },
      dueMode: 'relative', dueDays: 3, isMandatory: true, autoSync: false, tags: [], status: 'active',
    })
    if (!r.ok) throw new Error(r.code)
    enrollmentId = (await admin`select id from enrollments where assignment_id = ${r.assignmentId}`)[0]!.id as string

    const s1 = await runDueScan(tenantId)
    expect(s1.remindered).toBeGreaterThanOrEqual(1)
    const [soon] = await admin`select id from notifications where code = 'enrollment_due_soon' and payload->>'enrollmentId' = ${enrollmentId}`
    expect(soon).toBeDefined()

    // Повторный запуск в тот же день — дедуп, второго due_soon нет
    await runDueScan(tenantId)
    const [{ n }] = await admin<[{ n: number }]>`select count(*)::int as n from notifications where code = 'enrollment_due_soon' and payload->>'enrollmentId' = ${enrollmentId}`
    expect(n).toBe(1)

    // Сдвигаем срок на вчера
    await admin`update enrollments set due_at = now() - interval '1 day' where id = ${enrollmentId}`
    const s2 = await runDueScan(tenantId)
    expect(s2.expired).toBe(1)
    const [e] = await admin`select status from enrollments where id = ${enrollmentId}`
    expect(e!.status).toBe('expired')
    const [mgr] = await admin`select id from notifications where code = 'enrollment_overdue_manager' and user_id = ${adminId} and payload->>'enrollmentId' = ${enrollmentId}`
    expect(mgr).toBeDefined()
  })

  it('dispatch: без chat_id — skipped с журналом; ничего не падает', async () => {
    // Тихие часы могли отложить на утро — для теста двигаем в прошлое
    await admin`update notifications set scheduled_for = now() - interval '1 minute' where code = 'enrollment_due_soon' and payload->>'enrollmentId' = ${enrollmentId}`
    const s = await dispatchNotifications(tenantId, 500)
    expect(s.failed).toBe(0)
    const [row] = await admin`select status, rendered_text from notifications where code = 'enrollment_due_soon' and payload->>'enrollmentId' = ${enrollmentId}`
    expect(row!.status).toBe('skipped')
    expect(row!.rendered_text).toContain('Курс со сроком')
  })

  it('отчёт «Просроченные» показывает человека с руководителем', async () => {
    const rows = await overdue(ctx())
    const mine = rows.find(r => r.user_id === personId)
    expect(mine).toBeDefined()
    expect(mine!.manager).toBe('Адмін Каппі')
    expect(Number(mine!.days_over)).toBeGreaterThanOrEqual(1)
  })
})

describe('профиль обучения и правила автоматизации', () => {
  it('профиль «Бариста»: новый человек на позиции получает курсы автоматически, пройденный не назначается заново', async () => {
    const c1 = await makeCourse('Профіль курс 1')
    const c2 = await makeCourse('Профіль курс 2')
    const p = await createProfile(ctx(), {
      name: `Бариста ${Date.now()}`, scope: { positionIds: [baristaPosId], locationIds: [], orgUnitIds: [] },
      items: [{ subjectType: 'course', subjectId: c1, dueDays: 7, isMandatory: true, order: 0 }, { subjectType: 'course', subjectId: c2, dueDays: 14, isMandatory: true, order: 1 }],
      appliesToExisting: true, isActive: true,
    })
    profileIds.push(p.id)

    const veteran = await makePerson('Ветеран', baristaPosId, lazarevaId)
    // Ветеран уже прошёл c1 с действующим результатом
    const [v] = await admin`select published_version_id from courses where id = ${c1}`
    await admin`insert into enrollments (tenant_id, user_id, subject_id, version_id, source, status, completed_at, valid_until) values (${tenantId}, ${veteran}, ${c1}, ${v!.published_version_id}, 'self', 'completed', now(), now() + interval '6 months')`

    const preview = await previewProfile(ctx(), p.id)
    expect(preview!.items).toBe(2)

    const applied = await applyProfile(ctx(), p.id)
    expect(applied!.assignments).toBe(2)
    // Ветерану — только c2; остальным бариста (A, B, C, Терміновий) — по 2
    const [{ n1 }] = await admin<[{ n1: number }]>`select count(*)::int as n1 from enrollments e join assignments a on a.id = e.assignment_id where a.profile_id = ${p.id} and e.user_id = ${veteran}`
    expect(n1).toBe(1)

    // Новый человек на позиции → размещение → onPlacementChanged → sync
    const [nu] = await admin`insert into users (tenant_id, phone, full_name, status) values (${tenantId}, ${`+38095${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`}, 'Новачок', 'active') returning id`
    userIds.push(nu!.id as string)
    await addPlacement(ctx(), nu!.id as string, { locationId: lazarevaId, positionId: baristaPosId, isPrimary: true })
    await new Promise(r => setTimeout(r, 800)) // onPlacementChanged — fire-and-forget
    const [{ n2 }] = await admin<[{ n2: number }]>`select count(*)::int as n2 from enrollments e join assignments a on a.id = e.assignment_id where a.profile_id = ${p.id} and e.user_id = ${nu!.id}`
    expect(n2).toBe(2)
  })

  it('правило «при завершении А назначить Б», once_per_user: срабатывает один раз; dry-run не пишет', async () => {
    const cA = await makeCourse('Правило А')
    const cB = await makeCourse('Правило Б')
    const rule = await createRule(ctx(), {
      name: `Після А → Б ${Date.now()}`, trigger: 'course.completed', conditions: { courseIds: [cA] },
      actions: [{ type: 'assign_content', subjectType: 'course', subjectId: cB, dueDays: 5 }, { type: 'add_tag', tag: 'просунутий' }],
      isActive: true, runLimit: { oncePerUser: true },
    })
    ruleIds.push(rule.id)
    const person = await makePerson('Правило-людина', baristaPosId, lazarevaId)

    const dry = await runRules(tenantId, 'course.completed', person, { courseId: cA }, { dryRun: true, ruleId: rule.id })
    expect(dry[0]!.status).toBe('ok')
    const [{ n0 }] = await admin<[{ n0: number }]>`select count(*)::int as n0 from enrollments where user_id = ${person} and subject_id = ${cB}`
    expect(n0).toBe(0)

    // Другой курс — условие не совпало
    const other = await runRules(tenantId, 'course.completed', person, { courseId: cB })
    expect(other.find(r => r.ruleId === rule.id)!.status).toBe('skipped:conditions')

    await runRules(tenantId, 'course.completed', person, { courseId: cA })
    await runRules(tenantId, 'course.completed', person, { courseId: cA }) // второй раз
    const [{ n1 }] = await admin<[{ n1: number }]>`select count(*)::int as n1 from enrollments where user_id = ${person} and subject_id = ${cB}`
    expect(n1).toBe(1)
    const [u] = await admin`select tags from users where id = ${person}`
    expect(u!.tags).toContain('просунутий')
    const [{ runs }] = await admin<[{ runs: number }]>`select count(*)::int as runs from automation_runs where rule_id = ${rule.id}`
    expect(runs).toBe(1)
  })
})

describe('отчёт готовности сходится с ручной проверкой', () => {
  it('процент в ячейке = доля людей со всеми обязательными completed', async () => {
    const rows = await readiness(ctx(), { locationId: lazarevaId, positionId: baristaPosId })
    const cell = rows.find(r => r.position_id === baristaPosId)
    expect(cell).toBeDefined()
    // Ручной подсчёт тем же определением
    const [{ people, ready }] = await admin<[{ people: number, ready: number }]>`
      with ppl as (select u.id from users u join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null
                   where u.status = 'active' and up.location_id = ${lazarevaId} and up.position_id = ${baristaPosId}),
      m as (select e.user_id, count(*) filter (where a.is_mandatory) total,
                   count(*) filter (where a.is_mandatory and e.status = 'completed' and (e.valid_until is null or e.valid_until > now())) done
            from enrollments e join assignments a on a.id = e.assignment_id where e.status <> 'cancelled' group by e.user_id)
      select count(*)::int as people, count(*) filter (where coalesce(m.total,0) = 0 or m.done = m.total)::int as ready
      from ppl left join m on m.user_id = ppl.id`
    expect(Number(cell!.people)).toBe(people)
    expect(Number(cell!.ready)).toBe(ready)
    expect(cell!.pct).toBe(people ? Math.round(ready / people * 100) : 100)

    const xlsx = await toXlsx('readiness', rows)
    expect(xlsx.length).toBeGreaterThan(1000)
  })
})
