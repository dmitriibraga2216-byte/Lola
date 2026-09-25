import 'dotenv/config'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * debts-4 (docs/33 §Б): D-020/D-034 единый хук «завдання завершено» (`task_status_log`) и подтверждение
 * компетенций назначения для всех типов; D-036 роли оценщиков (вес, анонимность, functional_manager, external)
 * и взвешенный итог; D-039 состав анкеты `by_competencies` из профиля должности; D-021 политики входа
 * («Приховати форму входу», «Відключити відновлення пароля», «Дозволити відновлення за номером телефону»).
 */
const as = await import('../../server/services/assessment')
const dev = await import('../../server/services/development')
const { createResource, publishResource, viewResource } = await import('../../server/services/resources')
const { openResourcePass, tickResourcePass, completeResourcePass } = await import('../../server/services/resourcePass')
const { completeTask, lastTaskStatus } = await import('../../server/services/taskCompletion')
const { passwordRecoveryAllowed, changeOwnPassword, hashPassword } = await import('../../server/services/password')
const { loginFormHidden } = await import('../../server/services/session')
const { guestPage } = await import('../../server/services/hubExtra')
const { withTenant } = await import('../../server/utils/withTenant')
const { tenantSettingsSchema } = await import('../../shared/schemas/settings')
const { assignWithParams } = await import('./_assign')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const stamp = Date.now()

let tenantId: string
let adminId: string
let lazarevaId: string
let posId: string
let scaleId: string
let compA: string
let compB: string
const userIds: string[] = []
const groupIds: string[] = []
const formIds: string[] = []
const cycleIds: string[] = []
const resourceIds: string[] = []
const assignmentIds: string[] = []
const extraPos: string[] = []

const ctx = (actorId = adminId) => ({ tenantId, actorId })
const levels = [1, 2, 3].map(n => ({ level: n, title: `L${n}`, behavior: `Поведінка ${n}` }))

async function makePerson(name: string, positionId = posId) {
  const phone = `+38098${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, phone, full_name, status, hired_at) values (${tenantId}, ${phone}, ${name}, 'active', current_date) returning id`
  userIds.push(u!.id as string)
  await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary) values (${tenantId}, ${u!.id}, ${lazarevaId}, ${positionId}, true)`
  return u!.id as string
}

async function makeForm(kind: 'by_criteria' | 'by_competencies') {
  const g = await as.upsertGroup(ctx(), { name: `Сервіс d4 ${stamp}`, weight: 1 })
  groupIds.push(g!.id)
  const c1 = await as.upsertCriterion(ctx(), { groupId: g!.id, text: 'Вітається з гостем', competencyId: compA })
  const c2 = await as.upsertCriterion(ctx(), { groupId: g!.id, text: 'Знає меню', competencyId: compB })
  const c3 = await as.upsertCriterion(ctx(), { groupId: g!.id, text: 'Охайний вигляд' })
  const r = await as.saveForm(ctx(), {
    title: `Анкета d4 ${kind} ${stamp}`, kind, scaleId, allowCommentGroups: false, commentGroupsRequired: false, commentWhenAboveNorm: false,
    commentWhenBelowNorm: false, commentWhenEqual: false, zeroMeansNoGrade: false, tags: [], isActive: true,
    items: [{ criterionId: c1!.id, norm: 3 }, { criterionId: c2!.id, norm: 3 }, { criterionId: c3!.id, norm: 3 }],
  } as never)
  if (!r.ok) throw new Error(r.code)
  formIds.push(r.form.id)
  return { form: r.form, c1: c1!, c2: c2!, c3: c3! }
}

async function newCycle(formId: string, input: Partial<Parameters<typeof as.createCycle>[1]> & { raterKinds: Parameters<typeof as.createCycle>[1]['raterKinds'] }) {
  const c = await as.createCycle(ctx(), {
    title: `Цикл d4 ${stamp}`, formId, periodFrom: '2026-07-01', periodTo: '2026-09-30', startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    subjects: { rules: [{ type: 'position', ids: [posId] }], match: 'any' }, minRatersToShow: 3, ...input,
  })
  cycleIds.push(c.id)
  return c
}

async function fillAll(cycleId: string, subject: string, value: (kind: string) => number, criterionIds: string[]) {
  const tasks = await admin`select id, rater_user_id, rater_kind from assessment_tasks where cycle_id = ${cycleId} and subject_user_id = ${subject}`
  for (const t of tasks) {
    const rater = t.rater_user_id as string
    await as.saveAnswers(ctx(rater), t.id as string, criterionIds.map(criterionId => ({ criterionId, value: value(t.rater_kind as string) })))
    const r = await as.submitTask(ctx(rater), t.id as string)
    if (!r.ok) throw new Error(`submit ${t.rater_kind}: ${r.code}`)
  }
  return tasks
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  posId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Бариста-d4-${stamp}`}, 'barista-d4') returning id`)[0]!.id as string
  await admin`update locations set manager_id = ${adminId} where id = ${lazarevaId}`
  scaleId = (await admin`select id from scales where tenant_id = ${tenantId} and name = '1–5'`)[0]!.id as string
  compA = (await dev.createCompetency(ctx(), { name: `Гостинність d4 ${stamp}`, kind: 'soft', levels })).id
  compB = (await dev.createCompetency(ctx(), { name: `Меню d4 ${stamp}`, kind: 'hard', levels })).id
})

afterAll(async () => {
  if (cycleIds.length) await admin`delete from assessment_cycles where id in ${admin(cycleIds)}`
  if (formIds.length) await admin`delete from assessment_forms where id in ${admin(formIds)}`
  if (groupIds.length) await admin`delete from criteria_groups where id in ${admin(groupIds)}`
  if (assignmentIds.length) await admin`delete from assignments where id in ${admin(assignmentIds)}`
  if (resourceIds.length) await admin`delete from resources where id in ${admin(resourceIds)}`
  if (userIds.length) {
    await admin`delete from task_status_log where user_id in ${admin(userIds)}`
    await admin`delete from notifications where user_id in ${admin(userIds)}`
    await admin`delete from competency_assessments where user_id in ${admin(userIds)}`
    await admin`delete from sessions where user_id in ${admin(userIds)}`
    await admin`delete from users where id in ${admin(userIds)}`
  }
  await admin`delete from competency_assessments where competency_id in (${compA}, ${compB})`
  await admin`delete from position_profiles where position_id = ${posId}`
  await admin`delete from competencies where id in (${compA}, ${compB})`
  await admin`delete from positions where id = ${posId}`
  if (extraPos.length) await admin`delete from positions where id in ${admin(extraPos)}`
  await admin`update locations set manager_id = null where id = ${lazarevaId}`
  await admin.end()
})

describe('D-020 / D-034: единый хук «завдання завершено» и подтверждение компетенций для всех типов', () => {
  it('ресурс: прохождение по назначению пишет task_status_log и подтверждает компетенцию назначения (source=task)', async () => {
    const person = await makePerson('Читач ресурсу')
    await dev.upsertPositionProfile(ctx(), { positionId: posId, competencyRequirements: [{ competencyId: compA, requiredLevel: 3 }] })
    const r = await createResource(ctx(), { kind: 'article', title: `Стандарт d4-${stamp}`, language: 'uk', tags: [], categoryIds: [], allowPrint: true, body: [{ id: 'b1', type: 'text', html: '<p>v1</p>' }] } as never)
    resourceIds.push(r.id)
    const p = await publishResource(ctx(), r.id, { notifyAssigned: false })
    expect(p.ok).toBe(true)
    const assignmentId = await assignWithParams(ctx(), 'resource', r.id, {}, [person])
    assignmentIds.push(assignmentId)
    await admin`insert into assignment_competencies (tenant_id, assignment_id, competency_id) values (${tenantId}, ${assignmentId}, ${compA})`

    // Просмотр — чтение, не зачёт (docs/11 Г-11.5 «открытия мало», docs/28 fix-resource-node): журнал пуст
    expect(await viewResource(ctx(person), r.id, { assignmentId })).not.toBeNull()
    expect(await admin`select count(*)::int as n from task_status_log where user_id = ${person} and content_type = 'resource'`).toMatchObject([{ n: 0 }])

    // Прохождение по правилу типа: дочитал (прокрутка + время чтения) → «Завершити»
    expect((await openResourcePass(ctx(person), r.id, { assignmentId })).ok).toBe(true)
    await admin`update resource_progress set first_opened_at = now() - interval '10 minutes', last_tick_at = null where user_id = ${person} and resource_id = ${r.id}`
    expect(await tickResourcePass(ctx(person), r.id, { assignmentId, seconds: 20, scrollPct: 100 })).toMatchObject({ ready: true })
    expect(await completeResourcePass(ctx(person), r.id, { assignmentId })).toEqual({ ok: true, completedNow: true })
    const rows = await admin`select status, assignment_id, source_kind, request_context from task_status_log where user_id = ${person} and content_type = 'resource' and content_id = ${r.id}`
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'done', assignment_id: assignmentId, source_kind: 'resource_view' })
    const [ca] = await admin`select level, source from competency_assessments where user_id = ${person} and competency_id = ${compA} order by assessed_at desc limit 1`
    expect(ca).toMatchObject({ level: 1, source: 'task' })

    // Повторное завершение — журнал изменений статуса, не обращений: второй done не дублируется, компетенция не растёт
    expect(await completeResourcePass(ctx(person), r.id, { assignmentId })).toEqual({ ok: true, completedNow: false })
    await viewResource(ctx(person), r.id, { assignmentId })
    expect(await admin`select count(*)::int as n from task_status_log where user_id = ${person} and content_type = 'resource'`).toMatchObject([{ n: 1 }])
    expect(await admin`select count(*)::int as n from competency_assessments where user_id = ${person} and competency_id = ${compA}`).toMatchObject([{ n: 1 }])
  })

  it('прямой хук (чек-лист): done → failed → done пишет три строки, повтор статуса — нет; lastTaskStatus видит последнее', async () => {
    const person = await makePerson('Спостерігач')
    const contentId = crypto.randomUUID()
    const base = { contentType: 'check_list' as const, contentId, sourceKind: 'checklist_run' as const }
    expect((await completeTask(tenantId, person, { ...base, status: 'done', result: 91.5 })).logged).toBe(true)
    expect((await completeTask(tenantId, person, { ...base, status: 'done', result: 93 })).logged).toBe(false)
    expect((await completeTask(tenantId, person, { ...base, status: 'failed', result: 40 })).logged).toBe(true)
    expect((await completeTask(tenantId, person, { ...base, status: 'done', result: 88 })).logged).toBe(true)
    const rows = await admin`select status, result from task_status_log where user_id = ${person} and content_id = ${contentId} order by created_at`
    expect(rows.map(r => [r.status, r.result])).toEqual([['done', '91.5'], ['failed', '40'], ['done', '88']])
    const last = await withTenant(tenantId, person, tx => lastTaskStatus(tx, tenantId, person, 'check_list', contentId))
    expect(last).toMatchObject({ status: 'done', result: '88' })
  })

  it('task_status_log — журнал тенанта: RLS, request_context, CHECK по типу и статусу', async () => {
    const [pol] = await admin`select count(*)::int as n from pg_policies where tablename = 'task_status_log'`
    expect(pol!.n).toBeGreaterThan(0)
    await expect(admin`insert into task_status_log (tenant_id, user_id, content_type, content_id, status, source_kind) values (${tenantId}, ${adminId}, 'course', ${crypto.randomUUID()}, 'in_progress', 'enrollment')`).rejects.toThrow()
    await expect(admin`insert into task_status_log (tenant_id, user_id, content_type, content_id, status, source_kind) values (${tenantId}, ${adminId}, 'lesson', ${crypto.randomUUID()}, 'done', 'enrollment')`).rejects.toThrow()
  })
})

describe('D-036: роли оценщиков — вес, анонимность, functional_manager/external, взвешенный итог', () => {
  it('снимок веса/анонимности на задаче, functional_manager из functional_chiefs, overall.weighted по ролям', async () => {
    const subject = await makePerson('Оцінюваний ваги')
    const peers = [await makePerson('Колега 1'), await makePerson('Колега 2')]
    const chief = await makePerson('Функціональний керівник')
    await admin`insert into functional_chiefs (tenant_id, user_id, chief_id, kind) values (${tenantId}, ${subject}, ${chief}, 'functional')`
    const { form, c1, c2, c3 } = await makeForm('by_criteria')
    // peer: вес 3 и именной; manager: попытка сделать анонимным игнорируется (Г-20.2); functional_manager — по умолчанию (1, именной)
    const cycle = await newCycle(form.id, {
      subjects: { rules: [{ type: 'user', ids: [subject] }], match: 'any' }, peersCount: 2,
      raterKinds: ['self', 'manager', 'functional_manager', 'peer'],
      raterRoles: [{ kind: 'peer', weight: 3, isAnonymous: false }, { kind: 'manager', isAnonymous: true }],
    })
    expect((cycle.raterRoles as { kind: string, weight: number, isAnonymous: boolean }[]).find(r => r.kind === 'manager')).toMatchObject({ weight: 2, isAnonymous: false })
    const started = await as.startCycle(ctx(), cycle.id)
    expect(started).toMatchObject({ ok: true, subjects: 1 })
    const tasks = await admin`select rater_kind, rater_user_id, weight, is_anonymous from assessment_tasks where cycle_id = ${cycle.id} order by rater_kind`
    const byKind = Object.fromEntries(tasks.map(t => [t.rater_kind as string, t]))
    expect(byKind.self).toMatchObject({ weight: '0.00', is_anonymous: false })
    expect(byKind.manager).toMatchObject({ weight: '2.00', is_anonymous: false, rater_user_id: adminId })
    expect(byKind.functional_manager).toMatchObject({ weight: '1.00', is_anonymous: false, rater_user_id: chief })
    expect(byKind.peer).toMatchObject({ weight: '3.00', is_anonymous: false })
    // Пул коллег — вся точка с той же позицией (в тесте их больше двух), случайно до peersCount; один человек — одна задача
    expect(tasks.filter(t => t.rater_kind === 'peer').length).toBeGreaterThanOrEqual(1)
    expect(peers.length).toBe(2)

    // self 5, manager 3, functional_manager 4, peer 2 → weighted = (3×2 + 4×1 + 2×3)/6 = 2.67; self (вес 0) показывается, но не считается
    await fillAll(cycle.id, subject, k => ({ self: 5, manager: 3, functional_manager: 4, peer: 2 }[k] ?? 3), [c1.id, c2.id, c3.id])
    const res = await as.resultsFor(ctx(), subject, cycle.id, { asManager: true })
    expect(res!.overall).toMatchObject({ self: 5, manager: 3, functional_manager: 4, peer: 2, weighted: 2.67 })
    // Коллег двое, но роль именная — порог показа не прячет её даже для самого человека
    const mine = await as.resultsFor(ctx(subject), subject, cycle.id, { asManager: false })
    expect(mine!.hiddenKinds).toEqual([])
    expect(mine!.overall.peer).toBe(2)

    // Завершение цикла — через единый хук: запись assessment в task_status_log с взвешенным итогом (D-020)
    const fin = await as.finishCycle(ctx(), cycle.id)
    expect(fin.ok).toBe(true)
    const [log] = await admin`select status, result, source_kind, source_id from task_status_log where user_id = ${subject} and content_type = 'assessment' and content_id = ${form.id}`
    expect(log).toMatchObject({ status: 'done', result: '2.67', source_kind: 'assessment_cycle', source_id: cycle.id })
  })

  it('внешний оценщик (external) — наставники точки, анонимность роли переопределяется настройкой цикла', async () => {
    const subject = await makePerson('Оцінюваний зовнішнім')
    const mentor = await makePerson('Наставник')
    const [role] = await admin`select id from roles where tenant_id = ${tenantId} and code = 'mentor'`
    await admin`insert into user_roles (tenant_id, user_id, role_id, scope_type) values (${tenantId}, ${mentor}, ${role!.id}, 'tenant')`
    const { form } = await makeForm('by_criteria')
    const cycle = await newCycle(form.id, { subjects: { rules: [{ type: 'user', ids: [subject] }], match: 'any' }, raterKinds: ['external'], raterRoles: [{ kind: 'external', isAnonymous: true, weight: 1.5 }] })
    expect((await as.startCycle(ctx(), cycle.id)).ok).toBe(true)
    // На точке могут быть и другие наставники (сид) — все они external с настройками роли цикла
    const tasks = await admin`select rater_kind, rater_user_id, weight, is_anonymous from assessment_tasks where cycle_id = ${cycle.id}`
    expect(tasks.length).toBeGreaterThanOrEqual(1)
    expect(tasks.every(t => t.rater_kind === 'external' && t.weight === '1.50' && t.is_anonymous === true)).toBe(true)
    expect(tasks.some(t => t.rater_user_id === mentor)).toBe(true)
  })

  it('resolveRaterRoles: вес в пределах numeric(4,2), manager/self не анонимизируются, неизвестные роли не добавляются', () => {
    const roles = as.resolveRaterRoles([{ kind: 'peer', weight: 42 }, { kind: 'self', isAnonymous: true, weight: -1 }, { kind: 'boss', weight: 5 }])
    expect(roles.map(r => r.kind)).toEqual([...as.RATER_KINDS])
    expect(roles.find(r => r.kind === 'peer')).toMatchObject({ weight: 9.99, isAnonymous: true })
    expect(roles.find(r => r.kind === 'self')).toMatchObject({ weight: 0, isAnonymous: false })
  })
})

describe('D-039: состав анкеты by_competencies — из требований профиля должности', () => {
  it('у оцениваемого с профилем — только критерии требуемых компетенций; без требований — состав анкеты', async () => {
    await dev.upsertPositionProfile(ctx(), { positionId: posId, competencyRequirements: [{ competencyId: compA, requiredLevel: 2 }] })
    const subject = await makePerson('За профілем')
    const [otherPos] = await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Без профілю-${stamp}`}, 'noprof-d4') returning id`
    extraPos.push(otherPos!.id as string)
    const other = await makePerson('Без профілю', otherPos!.id as string)
    {
      const { form, c1 } = await makeForm('by_competencies')
      const cycle = await newCycle(form.id, { subjects: { rules: [{ type: 'user', ids: [subject, other] }], match: 'any' }, raterKinds: ['manager'] })
      expect((await as.startCycle(ctx(), cycle.id)).ok).toBe(true)
      const tasks = await admin`select id, subject_user_id, items from assessment_tasks where cycle_id = ${cycle.id}`
      const forSubject = tasks.find(t => t.subject_user_id === subject)!
      const forOther = tasks.find(t => t.subject_user_id === other)!
      // Норма — из анкеты, если критерий в ней есть (3); требуемый уровень профиля — только для критериев вне анкеты
      expect(forSubject.items).toEqual([{ criterionId: c1.id, norm: 3, cluster: null }])
      expect(forOther.items).toBeNull()

      const view = await as.getTask(ctx(), forSubject.id as string)
      expect(view!.byProfile).toBe(true)
      expect(view!.structure!.groups.flatMap(g => g.criteria.map(c => c.id))).toEqual([c1.id])
      const viewOther = await as.getTask(ctx(), forOther.id as string)
      expect(viewOther!.byProfile).toBe(false)
      expect(viewOther!.structure!.groups.flatMap(g => g.criteria)).toHaveLength(3)

      // Ответы по составу оцениваемого считаются по его составу
      await as.saveAnswers(ctx(), forSubject.id as string, [{ criterionId: c1.id, value: 4 }])
      expect((await as.submitTask(ctx(), forSubject.id as string)).ok).toBe(true)
      const res = await as.resultsFor(ctx(), subject, cycle.id, { asManager: true })
      expect(res!.structure.flatMap(g => g.criteria.map(c => c.id))).toEqual([c1.id])
      expect(res!.overall.manager).toBe(4)
    }
  })
})

describe('D-021: политики входа', () => {
  const policy = (over: Partial<{ disableRecovery: boolean, allowPhoneRecovery: boolean }>) => ({ ...tenantSettingsSchema.parse({}).policies.passwords, ...over })

  async function sessionWith(userId: string, loginMethod: string | null) {
    const [s] = await admin`insert into sessions (tenant_id, user_id, token_hash, expires_at, login_method) values (${tenantId}, ${userId}, ${crypto.randomUUID()}, now() + interval '1 day', ${loginMethod}) returning id`
    return s!.id as string
  }

  it('восстановление пароля: только после входа по коду; e-mail — всегда, телефон — по политике; «Відключити» запрещает всё', async () => {
    const person = await makePerson('Забув пароль')
    const byEmail = await sessionWith(person, 'otp_email')
    const bySms = await sessionWith(person, 'otp_sms')
    const byPassword = await sessionWith(person, 'password')
    await withTenant(tenantId, person, async (tx) => {
      expect(await passwordRecoveryAllowed(tx, policy({}), byEmail)).toEqual({ ok: true })
      expect(await passwordRecoveryAllowed(tx, policy({}), bySms)).toMatchObject({ ok: false, code: 'recovery_disabled' })
      expect(await passwordRecoveryAllowed(tx, policy({ allowPhoneRecovery: true }), bySms)).toEqual({ ok: true })
      expect(await passwordRecoveryAllowed(tx, policy({ disableRecovery: true }), byEmail)).toMatchObject({ ok: false, code: 'recovery_disabled' })
      expect(await passwordRecoveryAllowed(tx, policy({}), byPassword)).toMatchObject({ ok: false, code: 'wrong_current' })
      expect(await passwordRecoveryAllowed(tx, policy({}), null)).toMatchObject({ ok: false, code: 'wrong_current' })
    })
    // Сквозной сценарий: пароль есть, текущий не указан, сессия по коду на e-mail → новый пароль принят, остальные сессии закрыты
    await admin`update users set password_hash = ${await hashPassword('Старий-пароль-1')} where id = ${person}`
    const r = await changeOwnPassword(ctx(person), { password: 'Новий-пароль-2', sessionId: byEmail })
    expect(r).toEqual({ ok: true })
    const [alive] = await admin`select count(*)::int as n from sessions where user_id = ${person} and revoked_at is null`
    expect(alive!.n).toBe(1)
    const r2 = await changeOwnPassword(ctx(person), { password: 'Ще-новіший-3', sessionId: byPassword })
    expect(r2).toMatchObject({ ok: false, code: 'wrong_current' })
  })

  it('«Приховати форму входу» действует только при настроенном Google: без него форма остаётся, guest-page это отражает', async () => {
    const person = await makePerson('Ховаємо форму')
    const [t] = await admin`select settings from tenants where id = ${tenantId}`
    const before = t!.settings
    const patched = { ...(before as object), policies: { ...((before as { policies?: object }).policies ?? {}), auth: { ...(((before as { policies?: { auth?: object } }).policies?.auth) ?? {}), hideLoginForm: true } } }
    await admin`update tenants set settings = ${admin.json(patched as never)} where id = ${tenantId}`
    try {
      const googleConfigured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
      expect(await loginFormHidden(tenantId, person)).toBe(googleConfigured)
      const g = await guestPage('kappi')
      expect(g!.hideLoginForm).toBe(googleConfigured)
      if (googleConfigured) expect(g!.passwordLogin).toBe(false)
    }
    finally {
      await admin`update tenants set settings = ${admin.json(before as never)} where id = ${tenantId}`
    }
  })
})
