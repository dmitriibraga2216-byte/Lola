import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PARAM_KEYS_BY_CONTENT_TYPE, parseTaskParams, remindersSchema } from '../../shared/schemas/assignments'
import { CONTENT_TYPES } from '../../shared/enums'

/**
 * Spec 15 (docs/15 §14, Г-15.1–15.4): параметры по типу контента, напоминания, аудитория
 * списком / CSV / конструктором, «Спосіб призначення», on_leave_condition, компетенции,
 * доп. параметры, баннер «N завдань змінено».
 */

const { createAssignment, expandAssignment, syncAssignments } = await import('../../server/services/assignments')
const tasks = await import('../../server/services/tasks')
const { createCourse, addModule, addLesson, publishCourse } = await import('../../server/services/courses')
const { createQuiz } = await import('../../server/services/questions')
const { createCompetency } = await import('../../server/services/development')
const { createRule, runRules } = await import('../../server/services/automation')
const { runDueScan } = await import('../../server/services/dueScan')
const { listContent } = await import('../../server/services/taskContent')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

let tenantId: string
let adminId: string
let lazarevaId: string
let baristaPosId: string
let cookPosId: string
const courseIds: string[] = []
const quizIds: string[] = []
const userIds: string[] = []
const ruleIds: string[] = []
const competencyIds: string[] = []
const paramIds: string[] = []

beforeAll(async () => {
  const [t] = await admin`select id from tenants where slug = 'kappi'`
  tenantId = t!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  const stamp = Date.now()
  baristaPosId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Бариста-s15-${stamp}`}, ${`barista-s15-${stamp}`}) returning id`)[0]!.id as string
  cookPosId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Кухар-s15-${stamp}`}, ${`cook-s15-${stamp}`}) returning id`)[0]!.id as string
  await admin`update locations set manager_id = ${adminId} where id = ${lazarevaId}`
})

afterAll(async () => {
  if (userIds.length) await admin`delete from users where id in ${admin(userIds)}`
  if (courseIds.length) {
    await admin`delete from enrollments where subject_id in ${admin(courseIds)}`
    await admin`delete from assignments where subject_id in ${admin(courseIds)}`
    await admin`delete from resources where id in (select l.item_id from lessons l join modules m on m.id = l.module_id join course_versions v on v.id = m.course_version_id where l.item_type = 'resource' and v.course_id in ${admin(courseIds)})`
    await admin`delete from courses where id in ${admin(courseIds)}`
  }
  if (quizIds.length) { await admin`delete from assignments where subject_id in ${admin(quizIds)}`; await admin`delete from quizzes where id in ${admin(quizIds)}` }
  if (ruleIds.length) await admin`delete from automation_rules where id in ${admin(ruleIds)}`
  if (competencyIds.length) await admin`delete from competencies where id in ${admin(competencyIds)}`
  if (paramIds.length) await admin`delete from task_parameters where id in ${admin(paramIds)}`
  await admin`delete from import_jobs where kind = 'task_audience' and tenant_id = ${tenantId}`
  await admin`delete from positions where id in (${baristaPosId}, ${cookPosId})`
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

async function makePerson(name: string, positionId: string, extra: { email?: string, externalId?: string, tags?: string[] } = {}) {
  const phone = `+38095${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, phone, full_name, status, hired_at, email, external_id, tags) values (${tenantId}, ${phone}, ${name}, 'active', current_date, ${extra.email ?? null}, ${extra.externalId ?? null}, ${extra.tags ?? []}) returning id`
  userIds.push(u!.id as string)
  await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary) values (${tenantId}, ${u!.id}, ${lazarevaId}, ${positionId}, true)`
  return { id: u!.id as string, phone }
}

async function makeAssignment(subjectType: 'course' | 'test', subjectId: string, ids: string[], extra: Record<string, unknown> = {}) {
  const r = await createAssignment(ctx(), {
    subjectType, subjectId, lockVersion: false,
    audience: { rules: [{ type: 'user', ids }], match: 'any' },
    dueMode: 'relative', dueDays: 10, isMandatory: true, autoSync: true, tags: [], status: 'active',
    reminders: { notifyOnAssign: false }, ...extra,
  } as never)
  if (!r.ok) throw new Error(r.code)
  return r.assignmentId
}

describe('параметры по типу контента (docs/15 §14.3, docs/02 §2.7)', () => {
  it('у каждого из 11 типов свой состав; у курса нет спроб и перемішування, у теста есть', () => {
    expect(Object.keys(PARAM_KEYS_BY_CONTENT_TYPE).sort()).toEqual([...CONTENT_TYPES].sort())
    expect(PARAM_KEYS_BY_CONTENT_TYPE.course).not.toContain('attemptsAllowed')
    expect(PARAM_KEYS_BY_CONTENT_TYPE.course).not.toContain('shuffleOptions')
    expect(PARAM_KEYS_BY_CONTENT_TYPE.test).toContain('attemptsAllowed')
    expect(PARAM_KEYS_BY_CONTENT_TYPE.test).toContain('questionsMode')
    expect(PARAM_KEYS_BY_CONTENT_TYPE.workshop).not.toContain('questionsMode')
    expect(PARAM_KEYS_BY_CONTENT_TYPE.webinar).toContain('webinarMinWatchPct')
    // Четыре общие группы — у всех
    for (const t of CONTENT_TYPES) for (const k of ['deadlineMode', 'passScore', 'resultSource', 'points', 'bonuses', 'certificateId', 'allowComments']) expect(PARAM_KEYS_BY_CONTENT_TYPE[t], `${t}.${k}`).toContain(k)
  })

  it('zod: валидные и невалидные параметры по типу', () => {
    expect(parseTaskParams('test', { questionsMode: 'one_per_group', attemptsAllowed: 3, passScore: 85, viaCatalog: true }).success).toBe(true)
    expect(parseTaskParams('course', { attemptsAllowed: 3 }).success).toBe(false) // у курса спроб нет
    expect(parseTaskParams('test', { passScore: 150 }).success).toBe(false)
    expect(parseTaskParams('test', { questionsMode: 'random' }).success).toBe(false)
    expect(parseTaskParams('poll', { allowComments: false, deadlineMode: 'calendar' }).success).toBe(true)
    expect(parseTaskParams('meetup', { webinarMinWatchPct: 80 }).success).toBe(false)
    expect(parseTaskParams('webinar', { webinarMinWatchPct: 80 }).success).toBe(true)
  })

  it('напоминания Г-15.1: умолчания [7,3,1], после срока каждые 3 дня не больше 5 раз, руководителю через 7', () => {
    const r = remindersSchema.parse({})
    expect(r).toMatchObject({ enabled: true, beforeDueDays: [7, 3, 1], onDueDate: true, afterDueEveryDays: 3, afterDueMaxCount: 5, escalateToManagerAfterDays: 7, channel: null })
    expect(remindersSchema.safeParse({ afterDueMaxCount: 6 }).success).toBe(false)
  })

  let quizId: string
  let taskId: string
  it('PUT params: тест — сохраняются только допустимые ключи; «Метод призначення» пишется колонками; чужие поля — ошибка', async () => {
    const quiz = await createQuiz(ctx(), { title: `Тест s15 ${Date.now()}`, kind: 'quiz', tags: [], selectionMode: 'fixed', requiresOfflineConfirm: false })
    quizIds.push(quiz.id)
    quizId = quiz.id
    const p = await makePerson('Параметри', baristaPosId)
    taskId = await makeAssignment('test', quiz.id, [p.id])
    const ok = await tasks.putTaskParams(ctx(), taskId, { questionsMode: 'one_per_group', attemptsAllowed: 3, passScore: 85, resultSource: 'best', points: 10, viaCatalog: true, useInDevPlans: true })
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    expect(ok.data.params).toMatchObject({ questionsMode: 'one_per_group', attemptsAllowed: 3, passScore: 85, resultSource: 'best', points: 10 })
    expect(ok.data.method).toEqual({ viaCatalog: true, automationRuleId: null, useInDevPlans: true })
    const [row] = await admin`select params, via_catalog, use_in_dev_plans from assignments where id = ${taskId}`
    expect(row!.via_catalog).toBe(true)
    expect((row!.params as Record<string, unknown>).viaCatalog).toBeUndefined()
    const bad = await tasks.putTaskParams(ctx(), taskId, { strictOrder: true }) // ключ курса у теста
    expect(bad.ok).toBe(false)
    const missing = await tasks.putTaskParams(ctx(), '00000000-0000-0000-0000-000000000000', {})
    expect(missing.ok && missing.ok).toBe(false)
    const [audit] = await admin`select id from audit_log where action = 'assignment.params' and entity_id = ${taskId}`
    expect(audit).toBeDefined()
    // правила подхватываются при старте попытки: findAssignmentFor видит новые params
    const { resolveQuizParams } = await import('../../server/services/taskParams')
    const { withTenant } = await import('../../server/utils/withTenant')
    const resolved = await withTenant(tenantId, adminId, tx => resolveQuizParams(tx, { tenantId, userId: p.id, quizId }))
    expect(resolved.params.passScore).toBe(85)
    expect(resolved.params.questionsMode).toBe('one_per_group')
  })

  it('PUT reminders: слияние с умолчаниями, аудит', async () => {
    const r = await tasks.putReminders(ctx(), taskId, { beforeDueDays: [1], afterDueEveryDays: null })
    expect(r).toMatchObject({ beforeDueDays: [1], afterDueEveryDays: null, onDueDate: true, escalateToManagerAfterDays: 7 })
    expect(await tasks.getReminders(ctx(), taskId)).toMatchObject({ beforeDueDays: [1] })
    expect(await tasks.getReminders(ctx(), '00000000-0000-0000-0000-000000000000')).toBeNull()
  })

  it('«Обрати з існуючих»: список контента по типу для всех 11 типов не падает', async () => {
    for (const t of CONTENT_TYPES) expect(Array.isArray(await listContent(ctx(), t))).toBe(true)
    expect((await listContent(ctx(), 'test', 's15')).some(c => c.id === quizId)).toBe(true)
  })
})

describe('аудитория (docs/15 §14.4): список, конструктор, CSV, «Спосіб призначення», снятие', () => {
  let courseId: string
  let taskId: string
  let a: { id: string, phone: string }
  let b: { id: string, phone: string }
  let c: { id: string, phone: string }

  it('вкладки Всі/Призначено/Не призначено и колонка «Спосіб призначення» = manual', async () => {
    courseId = await makeCourse('Аудиторія')
    a = await makePerson('Аудиторія А', baristaPosId, { email: `a-${Date.now()}@lola.test` })
    b = await makePerson('Аудиторія Б', baristaPosId, { externalId: `EXT-${Date.now()}`, tags: ['новачок'] })
    c = await makePerson('Аудиторія В', cookPosId)
    taskId = await makeAssignment('course', courseId, [a.id])
    const all = await tasks.listAudience(ctx(), taskId, { tab: 'all', limit: 1000 })
    expect(all!.counts.assigned).toBeGreaterThanOrEqual(1)
    const rowA = all!.items.find(i => i.userId === a.id)!
    expect(rowA.assigned).toBe(true)
    expect(rowA.via).toBe('manual')
    expect(rowA.enrollmentId).not.toBeNull()
    expect(rowA.position).toContain('Бариста-s15')
    const un = await tasks.listAudience(ctx(), taskId, { tab: 'unassigned', limit: 1000 })
    expect(un!.items.some(i => i.userId === b.id)).toBe(true)
    expect(un!.items.every(i => !i.assigned)).toBe(true)
    // фильтр по должности и по способу
    const byPos = await tasks.listAudience(ctx(), taskId, { tab: 'all', positionId: cookPosId, limit: 1000 })
    expect(byPos!.items.map(i => i.userId)).toEqual([c.id])
    const byVia = await tasks.listAudience(ctx(), taskId, { tab: 'all', via: 'manual', limit: 1000 })
    expect(byVia!.items.every(i => i.via === 'manual')).toBe(true)
  })

  it('«Призначити вибраним»: явный список → запись создана; повтор не дублирует', async () => {
    const r = await tasks.assignAudience(ctx(), taskId, { userIds: [b.id] })
    expect(r).toMatchObject({ ok: true, added: 1, expanded: 1 })
    const again = await tasks.assignAudience(ctx(), taskId, { userIds: [b.id] })
    expect(again).toMatchObject({ ok: true, added: 0, expanded: 0 })
    const [{ n }] = await admin<[{ n: number }]>`select count(*)::int as n from enrollments where assignment_id = ${taskId} and user_id = ${b.id}`
    expect(n).toBe(1)
    expect((await tasks.assignAudience(ctx(), taskId, { userIds: ['00000000-0000-0000-0000-000000000000'] })).ok).toBe(false)
  })

  it('конструктор: посада Кухар, всі окрім мітки «новачок» — превью и назначение', async () => {
    const preview = await tasks.previewBuilder(ctx(), taskId, { dimensions: [
      { dimension: 'position', mode: 'include', values: [cookPosId] },
      { dimension: 'tag', mode: 'exclude', values: ['новачок'] },
    ] })
    expect(preview!.count).toBe(1)
    expect(preview!.sample[0]!.id).toBe(c.id)
    const excl = await tasks.previewBuilder(ctx(), taskId, { dimensions: [{ dimension: 'position', mode: 'include', values: [baristaPosId] }, { dimension: 'tag', mode: 'exclude', values: ['новачок'] }] })
    expect(excl!.sample.map(s => s.id)).not.toContain(b.id) // b исключён по метке
    expect(excl!.sample.map(s => s.id)).toContain(a.id)
    expect(excl!.alreadyAssigned).toBe(1) // a уже назначен
    const r = await tasks.assignAudience(ctx(), taskId, { filter: { dimensions: [{ dimension: 'position', mode: 'include', values: [cookPosId] }] } })
    expect(r).toMatchObject({ ok: true, added: 1, expanded: 1 })
    const row = (await tasks.listAudience(ctx(), taskId, { tab: 'assigned', limit: 1000 }))!.items.find(i => i.userId === c.id)
    expect(row?.assigned).toBe(true)
    // измерение «місто» и «підрозділ» — не падают, mode any не ограничивает
    const any = await tasks.previewBuilder(ctx(), taskId, { dimensions: [{ dimension: 'city', mode: 'any', values: [] }, { dimension: 'org_unit', mode: 'include', values: ['00000000-0000-0000-0000-000000000000'] }] })
    expect(any!.count).toBe(0)
  })

  it('снятие: DELETE /audience/:userId → cancelled_at (не удаление), человек в exclude, вкладка «Не призначено»; повторное назначение открывает запись', async () => {
    const r = await tasks.removeFromAudience(ctx(), taskId, c.id)
    expect(r).toMatchObject({ ok: true, cancelled: 1 })
    const [e] = await admin`select cancelled_at, cancel_reason from enrollments where assignment_id = ${taskId} and user_id = ${c.id}`
    expect(e!.cancelled_at).not.toBeNull()
    const [asg] = await admin`select exclude from assignments where id = ${taskId}`
    expect(JSON.stringify(asg!.exclude)).toContain(c.id)
    const un = await tasks.listAudience(ctx(), taskId, { tab: 'unassigned', limit: 1000 })
    expect(un!.items.some(i => i.userId === c.id)).toBe(true)
    // sync не возвращает снятого
    await expandAssignment(tenantId, taskId)
    expect((await admin`select cancelled_at from enrollments where assignment_id = ${taskId} and user_id = ${c.id}`)[0]!.cancelled_at).not.toBeNull()
    const back = await tasks.assignAudience(ctx(), taskId, { userIds: [c.id] })
    expect(back).toMatchObject({ ok: true, reopened: 1 })
    expect((await admin`select cancelled_at from enrollments where assignment_id = ${taskId} and user_id = ${c.id}`)[0]!.cancelled_at).toBeNull()
    expect((await tasks.removeFromAudience(ctx(), '00000000-0000-0000-0000-000000000000', c.id)).ok).toBe(false)
  })

  it('CSV (Г-15.4): ключ по заголовку, due_at из файла, предпросмотр → протокол → применение', async () => {
    const d = await makePerson('CSV Д', baristaPosId, { email: `d-${Date.now()}@lola.test` })
    const csv = ['email;due_at', `${(await admin`select email from users where id = ${d.id}`)[0]!.email};25.12.2026`, `${(await admin`select email from users where id = ${a.id}`)[0]!.email};`, 'nobody@lola.test;', ';'].join('\n')
    const preview = await tasks.previewCsv(ctx(), taskId, 'people.csv', Buffer.from(csv, 'utf-8'))
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.stats).toEqual({ total: 4, found: 1, notFound: 1, alreadyAssigned: 1, errors: 1 })
    expect(preview.rows.find(r => r.userId === d.id)?.dueAt).toContain('2026-12-25')
    // не применилось до подтверждения
    expect((await admin`select count(*)::int as n from enrollments where assignment_id = ${taskId} and user_id = ${d.id}`)[0]!.n).toBe(0)
    const applied = await tasks.applyCsv(ctx(), taskId, preview.jobId)
    expect(applied).toMatchObject({ ok: true, added: 1, expanded: 1, withDates: 1 })
    const [e] = await admin`select due_at, source from enrollments where assignment_id = ${taskId} and user_id = ${d.id}`
    expect(new Date(e!.due_at as string).toISOString()).toContain('2026-12-25')
    const [job] = await admin`select status, stats from import_jobs where id = ${preview.jobId}`
    expect(job!.status).toBe('applied')
    expect((await tasks.applyCsv(ctx(), taskId, preview.jobId)).ok).toBe(false) // второй раз — bad_status
    // ключ phone и external_id; CP1251; нет ключевой колонки
    const byPhone = await tasks.previewCsv(ctx(), taskId, 'p.csv', Buffer.from(`Телефон\n${b.phone}\n`, 'utf-8'))
    expect(byPhone.ok && byPhone.stats.alreadyAssigned).toBe(1)
    const ext = (await admin`select external_id from users where id = ${b.id}`)[0]!.external_id as string
    const cp1251 = Buffer.concat([Buffer.from([0xc7, 0xee, 0xe2, 0xed, 0xb3, 0xf8, 0xed, 0xb3, 0xe9, 0x20, 0xb9]), Buffer.from(`\n${ext}\n`, 'latin1')]) // «Зовнішній №» в windows-1251
    const byExt = await tasks.previewCsv(ctx(), taskId, 'e.csv', cp1251)
    expect(byExt.ok && byExt.keyColumn).toBe('Зовнішній №')
    const noKey = await tasks.previewCsv(ctx(), taskId, 'x.csv', Buffer.from('name\nХтось\n', 'utf-8'))
    expect(noKey).toEqual({ ok: false, code: 'no_key_column' })
    expect((await tasks.previewCsv(ctx(), taskId, 'x.csv', Buffer.from('email\n', 'utf-8'))).ok).toBe(false)
  })
})

describe('Г-15.2 on_leave_condition, Г-15.3 компетенции, §14.5 параметры, §14.6 баннер', () => {
  it('keep — остаётся; cancel_unstarted — снимается неначатая, начатая остаётся; cancel_all — снимаются обе', async () => {
    const courseId = await makeCourse('On leave')
    const x = await makePerson('Ушёл X', baristaPosId)
    const y = await makePerson('Ушёл Y', baristaPosId)
    const keep = await makeAssignment('course', courseId, [], { audience: { rules: [{ type: 'position', ids: [baristaPosId] }], match: 'any' }, onLeaveCondition: 'keep' })
    expect((await admin`select count(*)::int as n from enrollments where assignment_id = ${keep} and user_id in (${x.id}, ${y.id})`)[0]!.n).toBe(2)
    // X перевели на другую должность
    await admin`update user_placements set position_id = ${cookPosId} where user_id = ${x.id}`
    await syncAssignments(tenantId)
    expect((await admin`select count(*)::int as n from enrollments where assignment_id = ${keep} and cancelled_at is null`)[0]!.n).toBeGreaterThanOrEqual(2)

    await admin`update user_placements set position_id = ${baristaPosId} where user_id = ${x.id}`
    const course2 = await makeCourse('On leave 2')
    const cu = await makeAssignment('course', course2, [], { audience: { rules: [{ type: 'position', ids: [baristaPosId] }], match: 'any' }, onLeaveCondition: 'cancel_unstarted' })
    await admin`update enrollments set status = 'in_progress', started_at = now() where assignment_id = ${cu} and user_id = ${y.id}`
    await admin`update user_placements set position_id = ${cookPosId} where user_id in (${x.id}, ${y.id})`
    expect(await tasks.applyOnLeave(tenantId, cu)).toBe(1)
    expect((await admin`select cancelled_at, cancel_reason from enrollments where assignment_id = ${cu} and user_id = ${x.id}`)[0]).toMatchObject({ cancel_reason: 'left_condition' })
    expect((await admin`select cancelled_at from enrollments where assignment_id = ${cu} and user_id = ${y.id}`)[0]!.cancelled_at).toBeNull()
    const [ev] = await admin`select payload from enrollment_events e join enrollments en on en.id = e.enrollment_id where en.assignment_id = ${cu} and e.event = 'cancelled'`
    expect(ev!.payload).toMatchObject({ reason: 'left_condition', onLeaveCondition: 'cancel_unstarted' })

    const { updateAssignment } = await import('../../server/services/assignments')
    await updateAssignment(ctx(), cu, { onLeaveCondition: 'cancel_all' })
    expect(await tasks.applyOnLeave(tenantId, cu)).toBe(1) // теперь снята и начатая
    expect((await admin`select cancelled_at from enrollments where assignment_id = ${cu} and user_id = ${y.id}`)[0]!.cancelled_at).not.toBeNull()
    expect((await admin`select id from audit_log where action = 'assignment.on_leave' and entity_id = ${cu}`).length).toBeGreaterThanOrEqual(1)
  })

  it('назначение правила наследует on_leave_condition; условие правила проверяется при sync', async () => {
    const courseId = await makeCourse('Правило on leave')
    const rule = await createRule(ctx(), {
      name: `Бариста s15 ${Date.now()}`, trigger: 'user.placement_changed', assignDelayDays: 0, isActive: true, runLimit: { oncePerUser: true },
      conditions: { positionIds: [baristaPosId] }, onLeaveCondition: 'cancel_unstarted',
      actions: [{ type: 'assign_content', subjectType: 'course', subjectId: courseId, dueDays: 7 }],
    })
    ruleIds.push(rule.id)
    const z = await makePerson('Правило Z', baristaPosId)
    await runRules(tenantId, 'user.placement_changed', z.id)
    const [asg] = await admin`select id, on_leave_condition, automation_rule_id from assignments where kind = 'auto' and subject_id = ${courseId}`
    expect(asg).toMatchObject({ on_leave_condition: 'cancel_unstarted', automation_rule_id: rule.id })
    expect((await admin`select count(*)::int as n from enrollments where assignment_id = ${asg!.id} and user_id = ${z.id} and cancelled_at is null`)[0]!.n).toBe(1)
    await admin`update user_placements set position_id = ${cookPosId} where user_id = ${z.id}`
    expect(await tasks.applyOnLeave(tenantId, asg!.id as string)).toBe(1)
  })

  it('компетенции: set/get, счётчик в списке, чужие id отбрасываются', async () => {
    const courseId = await makeCourse('Компетенції')
    const p = await makePerson('Компетенції П', baristaPosId)
    const comp = await createCompetency(ctx(), { name: `Каса s15 ${Date.now()}`, kind: 'hard', levels: [{ level: 1, title: 'Базовий', behavior: 'x' }] })
    competencyIds.push(comp.id)
    const taskId = await makeAssignment('course', courseId, [p.id], { competencyIds: [comp.id] })
    expect((await tasks.getCompetencies(ctx(), taskId))!.map(c => c.id)).toEqual([comp.id])
    expect(await tasks.setCompetencies(ctx(), taskId, ['00000000-0000-0000-0000-000000000000'])).toEqual([])
    expect(await tasks.setCompetencies(ctx(), taskId, [comp.id])).toEqual([comp.id])
    const { listAssignments, getAssignment } = await import('../../server/services/assignments')
    expect((await listAssignments(ctx())).find(r => r.id === taskId)?.competenciesCount).toBe(1)
    const card = await getAssignment(ctx(), taskId)
    expect(card).toMatchObject({ competencyIds: [comp.id], assignedCount: 1 })
    expect(card!.content?.title).toContain('Компетенції')
    expect(card!.peopleTotal).toBeGreaterThan(0)
  })

  it('«Додаткові параметри»: справочник text/select/number, значения проверяются по типу, обязательный — не пустой', async () => {
    const stamp = Date.now()
    const txt = (await tasks.createTaskParameter(ctx(), { name: `Замовник ${stamp}`, kind: 'text', options: [], isRequired: true }))!
    const sel = (await tasks.createTaskParameter(ctx(), { name: `Формат ${stamp}`, kind: 'select', options: ['онлайн', 'офлайн'], isRequired: false }))!
    const num = (await tasks.createTaskParameter(ctx(), { name: `Бюджет ${stamp}`, kind: 'number', options: [], isRequired: false }))!
    paramIds.push(txt.id, sel.id, num.id)
    expect(await tasks.createTaskParameter(ctx(), { name: `Замовник ${stamp}`, kind: 'text', options: [], isRequired: false })).toBeNull() // имя занято
    expect((await tasks.listTaskParameters(ctx())).some(p => p.id === sel.id)).toBe(true)
    const courseId = await makeCourse('Параметри')
    const p = await makePerson('Параметри П', baristaPosId)
    const taskId = await makeAssignment('course', courseId, [p.id])
    const bad = await tasks.putTaskParameterValues(ctx(), taskId, { values: { [sel.id]: 'гібрид', [num.id]: 'багато' } })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.issues.map(i => i.path[0]).sort()).toEqual([num.id, sel.id, txt.id].sort()) // + обязательный пуст
    const ok = await tasks.putTaskParameterValues(ctx(), taskId, { values: { [txt.id]: 'Каппі', [sel.id]: 'онлайн', [num.id]: 1500 } })
    expect(ok.ok).toBe(true)
    const vals = await tasks.getTaskParameterValues(ctx(), taskId)
    expect(vals!.find(v => v.id === num.id)?.value).toBe(1500)
    expect((await tasks.updateTaskParameter(ctx(), num.id, { isRequired: true }))?.isRequired).toBe(true)
    expect(await tasks.deleteTaskParameter(ctx(), num.id)).toBe(true)
    expect(await tasks.deleteTaskParameter(ctx(), num.id)).toBe(false)
    expect((await tasks.getTaskParameterValues(ctx(), taskId))!.some(v => v.id === num.id)).toBe(false) // каскад
  })

  it('баннер «N завдань було змінено»: публикация курса помечает назначения, уведомление по команде, dismiss', async () => {
    const courseId = await makeCourse('Змінений курс')
    const p = await makePerson('Баннер П', baristaPosId)
    const taskId = await makeAssignment('course', courseId, [p.id])
    expect((await tasks.listChanged(ctx())).items.some(i => i.id === taskId)).toBe(false)
    // правка и повторная публикация
    const { addModule: addM, addLesson: addL } = await import('../../server/services/courses')
    const m = await addM(ctx(), courseId, 'Р2')
    await addL(ctx(), { moduleId: m!.id, title: 'Урок 2', itemType: 'resource', resource: { body: [{ id: 'b2', type: 'text', html: '<p>y</p>' }] }, isRequired: true, videoThresholdPct: 90 })
    const pub = await publishCourse(ctx(), courseId, 'v2')
    expect(pub.ok).toBe(true)
    const changed = await tasks.listChanged(ctx())
    expect(changed.items.some(i => i.id === taskId)).toBe(true)
    // уведомления не ушли сами
    expect((await admin`select count(*)::int as n from notifications where code = 'assignment_content_updated' and payload->>'assignmentId' = ${taskId}`)[0]!.n).toBe(0)
    const n = await tasks.notifyChanged(ctx(), [taskId])
    expect(n).toMatchObject({ assignments: 1, notified: 1 })
    expect((await admin`select count(*)::int as n from notifications where code = 'assignment_content_updated' and user_id = ${p.id}`)[0]!.n).toBe(1)
    expect((await tasks.listChanged(ctx())).items.some(i => i.id === taskId)).toBe(false)
    // повторная правка → снова в баннере; dismiss снимает без рассылки
    await publishCourse(ctx(), courseId, 'v3').catch(() => null)
    await admin`update assignments set content_changed_at = now() where id = ${taskId}`
    expect((await tasks.listChanged(ctx())).count).toBeGreaterThanOrEqual(1)
    const d = await tasks.dismissChanged(ctx())
    expect(d.dismissed).toBeGreaterThanOrEqual(1)
    expect((await tasks.listChanged(ctx())).items.some(i => i.id === taskId)).toBe(false)
  })

  it('due.scan по Г-15.1: после срока — каждые 3 дня не больше 5 раз; эскалация руководителю после 7 дней один раз', async () => {
    const courseId = await makeCourse('Нагадування')
    const p = await makePerson('Нагадування П', baristaPosId)
    const taskId = await makeAssignment('course', courseId, [p.id])
    const [e] = await admin`select id from enrollments where assignment_id = ${taskId}`
    const eid = e!.id as string
    const count = async (code: string) => (await admin`select count(*)::int as n from notifications where code = ${code} and payload->>'enrollmentId' = ${eid}`)[0]!.n as number
    await admin`update enrollments set due_at = now() - interval '2 days' where id = ${eid}`
    await runDueScan(tenantId)
    expect(await count('enrollment_overdue')).toBe(0) // 2 не кратно 3
    await admin`update enrollments set due_at = now() - interval '3 days' where id = ${eid}`
    await runDueScan(tenantId)
    expect(await count('enrollment_overdue')).toBe(1)
    expect(await count('enrollment_overdue_manager')).toBe(0) // руководителю — только с 7-го дня
    await admin`update enrollments set due_at = now() - interval '9 days' where id = ${eid}`
    await runDueScan(tenantId)
    expect(await count('enrollment_overdue')).toBe(2)
    expect(await count('enrollment_overdue_manager')).toBe(1)
    await admin`update enrollments set due_at = now() - interval '12 days' where id = ${eid}`
    await runDueScan(tenantId)
    expect(await count('enrollment_overdue')).toBe(3)
    expect(await count('enrollment_overdue_manager')).toBe(1) // один раз на запись
    // после пятого напоминания (15 дней) бот молчит: 18 дней — шестое не уходит (и автозакрытие через 14 — запись закрыта)
    await admin`update enrollments set due_at = now() - interval '18 days', status = 'not_started', expired_at = null where id = ${eid}`
    await admin`update tenants set settings = jsonb_set(coalesce(settings, '{}'), '{learning,autoCloseAfterDays}', '30') where id = ${tenantId}`
    try {
      await runDueScan(tenantId)
      expect(await count('enrollment_overdue')).toBe(3) // 18/3 = 6 > 5 → шестое не уходит
    }
    finally {
      await admin`update tenants set settings = settings #- '{learning,autoCloseAfterDays}' where id = ${tenantId}`
    }
  })
})
