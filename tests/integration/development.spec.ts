import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const dev = await import('../../server/services/development')
const req = await import('../../server/services/requests')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

let tenantId: string
let adminId: string
let lazarevaId: string
let baristaPosId: string
let baristaId: string
const compIds: string[] = []

const OWN = ['development.own']
const TEAM = ['development.own', 'development.team', 'development.manage']

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  baristaPosId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Бариста-dev-${Date.now()}`}, 'barista-dev') returning id`)[0]!.id as string
  await admin`update locations set manager_id = ${adminId} where id = ${lazarevaId}`
  const phone = `+38096${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  baristaId = (await admin`insert into users (tenant_id, phone, full_name, status, hired_at) values (${tenantId}, ${phone}, 'Бариста Тестовий', 'active', current_date) returning id`)[0]!.id as string
  await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary) values (${tenantId}, ${baristaId}, ${lazarevaId}, ${baristaPosId}, true)`
})

afterAll(async () => {
  await admin`delete from development_goals where user_id = ${baristaId}`
  await admin`delete from external_training_requests where user_id = ${baristaId}`
  await admin`delete from notifications where user_id = ${baristaId}`
  await admin`delete from users where id = ${baristaId}`
  await admin`delete from position_profiles where position_id = ${baristaPosId}`
  if (compIds.length) await admin`delete from competencies where id in ${admin(compIds)}`
  await admin`delete from positions where id = ${baristaPosId}`
  await admin`update locations set manager_id = null where id = ${lazarevaId}`
  await admin.end()
})

const asAdmin = () => ({ tenantId, actorId: adminId })
const asBarista = () => ({ tenantId, actorId: baristaId })
const levels = [{ level: 1, title: 'Новачок', behavior: 'Готує еспресо за картою' }, { level: 2, title: 'Впевнений', behavior: 'Стабільний смак, латте-арт' }, { level: 3, title: 'Експерт', behavior: 'Навчає інших, калібрує помел' }]

describe('этап 7: компетенции, профиль должности, разрыв (docs/19 приёмка)', () => {
  it('бариста видит профиль должности, свой ИПР и разрыв по компетенциям', async () => {
    const espresso = await dev.createCompetency(asAdmin(), { name: `Еспресо ${Date.now()}`, kind: 'hard', levels })
    const service = await dev.createCompetency(asAdmin(), { name: `Сервіс ${Date.now()}`, kind: 'soft', levels })
    compIds.push(espresso.id, service.id)

    await dev.upsertPositionProfile(asAdmin(), { positionId: baristaPosId, competencyRequirements: [
      { competencyId: espresso.id, requiredLevel: 3, isCritical: true }, { competencyId: service.id, requiredLevel: 2 },
    ], probationDays: 60 })

    // Самооценка 1 и оценка руководителя 2 — приоритет у руководителя
    await dev.assessCompetency(asBarista(), { userId: baristaId, competencyId: espresso.id, level: 1, source: 'self' })
    await dev.assessCompetency(asAdmin(), { userId: baristaId, competencyId: espresso.id, level: 2, source: 'manager' })

    const gap = await dev.competencyGap(asBarista(), baristaId)
    expect(gap.position?.positionName).toContain('Бариста')
    expect(gap.profile?.probationDays).toBe(60)
    const e = gap.items.find(i => i.competencyId === espresso.id)!
    expect(e).toMatchObject({ currentLevel: 2, requiredLevel: 3, gap: 1, source: 'manager', isCritical: true })
    const s = gap.items.find(i => i.competencyId === service.id)!
    expect(s).toMatchObject({ currentLevel: 0, requiredLevel: 2, gap: 2 })

    // ИПР: план, цель по компетенции, отправка на согласование
    const plan = await dev.createPlan(asBarista(), { userId: baristaId, periodFrom: '2026-09-01', periodTo: '2026-12-31' })
    expect(plan.status).toBe('draft')
    const goalRes = await dev.createGoal(asBarista(), { userId: baristaId, planId: plan.id, title: 'Еспресо до рівня 3', kind: 'competency', competencyId: espresso.id, targetLevel: 3, dueAt: '2026-11-30' })
    if (!goalRes.ok) throw new Error(goalRes.code)
    const goal = goalRes.goal
    expect(goal.statusCode).toBe('planned')
    const mine = await dev.myPlan(asBarista(), baristaId)
    expect(mine.plan?.id).toBe(plan.id)
    expect(mine.goals.map(g => g.id)).toContain(goal.id)

    expect((await dev.transitionPlan(asBarista(), plan.id, 'submit')).ok).toBe(true)
    // Сотрудник не может утвердить свой план — только submit/review; approve делает руководитель
    expect(await dev.transitionPlan(asBarista(), plan.id, 'submit')).toMatchObject({ ok: false })
    expect((await dev.transitionPlan(asAdmin(), plan.id, 'approve')).ok).toBe(true)
    expect((await dev.myPlan(asBarista(), baristaId)).plan?.status).toBe('active')
  })

  it('руководитель согласует цель и видит протокол; достигнутая цель поднимает уровень компетенции', async () => {
    const espresso = await dev.createCompetency(asAdmin(), { name: `Молоко ${Date.now()}`, kind: 'hard', levels })
    compIds.push(espresso.id)
    const goalRes = await dev.createGoal(asBarista(), { userId: baristaId, title: 'Латте-арт', kind: 'competency', competencyId: espresso.id, targetLevel: 2, dueAt: '2026-12-01' })
    if (!goalRes.ok) throw new Error(goalRes.code)
    const goal = goalRes.goal

    // planned → in_progress (сотрудник), → on_review (сотрудник), achieved ставит только руководитель
    expect((await dev.transitionGoal(asBarista(), goal.id, 'in_progress', { scopes: OWN })).ok).toBe(true)
    expect(await dev.transitionGoal(asBarista(), goal.id, 'achieved', { scopes: OWN })).toMatchObject({ ok: false, code: 'not_allowed' })
    expect((await dev.transitionGoal(asBarista(), goal.id, 'on_review', { scopes: OWN })).ok).toBe(true)
    expect(await dev.transitionGoal(asBarista(), goal.id, 'achieved', { scopes: OWN })).toMatchObject({ ok: false, code: 'forbidden' })
    // not_achieved требует комментарий
    expect(await dev.transitionGoal(asAdmin(), goal.id, 'not_achieved', { scopes: TEAM })).toMatchObject({ ok: false, code: 'comment_required' })
    expect((await dev.transitionGoal(asAdmin(), goal.id, 'achieved', { scopes: TEAM, evaluation: 'Чудова піна' })).ok).toBe(true)

    const g = await dev.getGoal(asAdmin(), goal.id)
    expect(g?.status?.code).toBe('achieved')
    expect(g?.progressPct).toBe(100)
    expect(g?.evaluation).toBe('Чудова піна')
    expect(g?.log.map(l => l.toStatus)).toEqual(['achieved', 'on_review', 'in_progress', 'planned'])
    expect(g?.log[0]?.actorName).toBe('Адмін Каппі')
    expect(g?.transitions).toEqual([]) // финальный

    const gap = await dev.competencyGap(asAdmin(), baristaId)
    // Профиль не требует «Молоко», но уровень зафиксирован в оценках
    const [a] = await admin`select level, source, evidence_id from competency_assessments where user_id = ${baristaId} and competency_id = ${espresso.id}`
    expect(a).toMatchObject({ level: 2, source: 'manager', evidence_id: goal.id })
    expect(gap.items.length).toBeGreaterThan(0)

    const team = await dev.teamGoals(asAdmin(), { status: 'achieved' })
    expect(team.some(t => t.id === goal.id && t.full_name === 'Бариста Тестовий')).toBe(true)
  })

  it('настройка статусов: новый статус с переходом становится доступен', async () => {
    await dev.upsertGoalStatus(asAdmin(), { code: 'paused', name: 'На паузі', color: 'muted', sort: 10, allowedTransitions: ['in_progress'], whoCanSet: ['development.team'] })
    const cur = (await dev.listGoalStatuses(asAdmin())).find(s => s.code === 'in_progress')!
    await dev.upsertGoalStatus(asAdmin(), { ...cur, allowedTransitions: [...cur.allowedTransitions, 'paused'] })
    const goalRes = await dev.createGoal(asBarista(), { userId: baristaId, title: 'Пауза', kind: 'learning', dueAt: '2026-12-01' })
    if (!goalRes.ok) throw new Error(goalRes.code)
    const goal = goalRes.goal
    await dev.transitionGoal(asBarista(), goal.id, 'in_progress', { scopes: OWN })
    expect(await dev.transitionGoal(asBarista(), goal.id, 'paused', { scopes: OWN })).toMatchObject({ ok: false, code: 'forbidden' })
    expect((await dev.transitionGoal(asAdmin(), goal.id, 'paused', { scopes: TEAM })).ok).toBe(true)
    await admin`update goal_statuses set allowed_transitions = array_remove(allowed_transitions, 'paused') where tenant_id = ${tenantId} and code = 'in_progress'`
    await admin`delete from development_goals where id = ${goal.id}`
    await admin`delete from goal_statuses where tenant_id = ${tenantId} and code = 'paused'`
  })

  it('заявка на внешнее обучение: руководитель → HR → approved, самому себе решать нельзя', async () => {
    const r = await req.createExternalRequest(asBarista(), { title: 'SCA Barista Skills', format: 'offline', cost: 12000 })
    expect(r.status).toBe('new')
    expect(await req.decideRequest(asBarista(), 'external', r.id, 'approve', { isHr: false })).toMatchObject({ ok: false, code: 'self' })
    expect(await req.decideRequest(asAdmin(), 'external', r.id, 'approve', { isHr: false })).toMatchObject({ ok: true, status: 'manager_approved' })
    // на HR-шаге руководитель без development.manage не решает
    expect(await req.decideRequest(asAdmin(), 'external', r.id, 'approve', { isHr: false })).toMatchObject({ ok: false, code: 'bad_step' })
    // §13.4: 12000 при пороге 5000 → после HR нужен администратор
    expect(await req.decideRequest(asAdmin(), 'external', r.id, 'approve', { isHr: true, comment: 'Бюджет є' })).toMatchObject({ ok: true, status: 'hr_approved' })
    expect(await req.decideRequest(asAdmin(), 'external', r.id, 'approve', { isHr: true })).toMatchObject({ ok: false, code: 'admin_required' })
    expect(await req.decideRequest(asAdmin(), 'external', r.id, 'approve', { isHr: true, isAdmin: true })).toMatchObject({ ok: true, status: 'approved' })
    const mine = await req.myRequests(asBarista())
    expect(mine.external[0]).toMatchObject({ status: 'approved' })
    expect((mine.external[0]!.approvals as unknown[]).length).toBe(3)
    expect(await req.completeExternal(asBarista(), r.id, 'Пройшов, сертифікат отримав')).toBeTruthy()
    const [n] = await admin`select count(*)::int as c from notifications where user_id = ${baristaId} and code in ('request_step','request_approved')`
    expect(n!.c).toBe(3)
    // Заявка ниже порога — без шага администратора
    const small = await req.createExternalRequest(asBarista(), { title: 'Латте-арт майстерклас', format: 'offline', cost: 1500 })
    await req.decideRequest(asAdmin(), 'external', small.id, 'approve', { isHr: false })
    expect(await req.decideRequest(asAdmin(), 'external', small.id, 'approve', { isHr: true })).toMatchObject({ ok: true, status: 'approved' })
  })
})

describe('docs/19 часть 2: матрица, курс → компетенция, закрытие ИПР, профиль → люди, согласование целей', () => {
  const X = () => import('../../server/services/developmentExtra')

  it('§13.6: матрица точки — ячейки teal/sun/coral по разрыву, история оценок по клику', async () => {
    const { competencyMatrix, competencyHistory } = await X()
    const m = await competencyMatrix(asAdmin(), { locationId: lazarevaId })
    const row = m.rows.find(r => r.userId === baristaId)!
    expect(row.hasProfile).toBe(true)
    const espresso = row.cells.find(c => c.required === 3)!
    // После прошлых тестов уровень эспрессо = 3 (цель достигнута) → teal; латте-арт по-прежнему без оценки
    expect(['teal', 'sun', 'coral']).toContain(espresso.color)
    expect(row.cells.some(c => c.gap >= 2 && c.color === 'coral') || row.cells.every(c => c.gap < 2)).toBe(true)
    const h = await competencyHistory(asAdmin(), baristaId, espresso.competencyId)
    expect(h.competency).not.toBeNull()
    expect(h.history.length).toBeGreaterThan(0)
  })

  it('§13.2 (Б.4): курс с компетенцией и сданным итоговым тестом повышает уровень; без сданного теста — нет', async () => {
    const { onCourseCompletedCompetency } = await X()
    const [comp] = await admin`insert into competencies (tenant_id, name, kind, levels) values (${tenantId}, ${`Каса-${Date.now()}`}, 'hard', ${JSON.stringify(levels)}) returning id`
    compIds.push(comp!.id as string)
    const [quiz] = await admin`insert into quizzes (tenant_id, title, status) values (${tenantId}, ${`Тест каси ${Date.now()}`}, 'published') returning id`
    const [course] = await admin`insert into courses (tenant_id, title, slug, status, competency_id, competency_level) values (${tenantId}, ${`Курс каси ${Date.now()}`}, ${`kasa-${Date.now()}`}, 'published', ${comp!.id}, 2) returning id`
    const [ver] = await admin`insert into course_versions (tenant_id, course_id, version) values (${tenantId}, ${course!.id}, 1) returning id`
    await admin`update courses set published_version_id = ${ver!.id} where id = ${course!.id}`
    const [mod] = await admin`insert into modules (tenant_id, course_version_id, title, sort) values (${tenantId}, ${ver!.id}, 'М', 1) returning id`
    await admin`insert into lessons (tenant_id, module_id, title, sort, item_type, item_id) values (${tenantId}, ${mod!.id}, 'Підсумковий тест', 1, 'quiz', ${quiz!.id})`
    const [enr] = await admin`insert into enrollments (tenant_id, user_id, subject_id, version_id, source, required_total, status) values (${tenantId}, ${baristaId}, ${course!.id}, ${ver!.id}, 'self', 1, 'done') returning id`
    try {
      expect(await onCourseCompletedCompetency(tenantId, baristaId, course!.id as string, enr!.id as string)).toBe(false)
      await admin`insert into attempts (tenant_id, quiz_id, user_id, attempt_no, snapshot, params, status, passed, started_at, submitted_at) values (${tenantId}, ${quiz!.id}, ${baristaId}, 1, '{}', '{}', 'passed', true, now(), now())`
      expect(await onCourseCompletedCompetency(tenantId, baristaId, course!.id as string, enr!.id as string)).toBe(true)
      const [a] = await admin`select level, source from competency_assessments where user_id = ${baristaId} and competency_id = ${comp!.id}`
      expect(a).toMatchObject({ level: 2, source: 'test' })
      // Повторно — уровень уже есть, новой оценки нет
      expect(await onCourseCompletedCompetency(tenantId, baristaId, course!.id as string, enr!.id as string)).toBe(false)
    }
    finally {
      await admin`delete from attempts where quiz_id = ${quiz!.id}`
      await admin`delete from enrollments where id = ${enr!.id}`
      await admin`delete from lessons where module_id = ${mod!.id}`; await admin`delete from modules where id = ${mod!.id}`
      await admin`update courses set published_version_id = null where id = ${course!.id}`; await admin`delete from course_versions where id = ${ver!.id}`
      await admin`delete from courses where id = ${course!.id}`; await admin`delete from quizzes where id = ${quiz!.id}`
    }
  })

  it('§13.5: период ИПР закончился → цели без результата «Не досягнуто», план в review, руководителю напоминание', async () => {
    const { planPeriodScan } = await X()
    const plan = await dev.createPlan(asAdmin(), { userId: baristaId, periodFrom: '2026-01-01', periodTo: '2026-01-31' })
    await admin`update development_plans set status = 'active' where id = ${plan.id}`
    const [g] = await admin`insert into development_goals (tenant_id, plan_id, user_id, title, kind, due_at, status_code, created_by, approved_at) values (${tenantId}, ${plan.id}, ${baristaId}, 'Стара ціль', 'learning', '2026-01-20', 'in_progress', ${adminId}, now()) returning id`
    const r = await planPeriodScan(tenantId)
    expect(r.ended).toBeGreaterThanOrEqual(1)
    const [goal] = await admin`select status_code from development_goals where id = ${g!.id}`
    expect(goal!.status_code).toBe('not_achieved')
    const [p] = await admin`select status from development_plans where id = ${plan.id}`
    expect(p!.status).toBe('review')
    const [n] = await admin`select count(*)::int as c from notifications where code = 'plan_period_ended' and payload->>'planId' = ${plan.id}`
    expect(n!.c).toBe(1)
    await admin`delete from development_goals where id = ${g!.id}`; await admin`delete from development_plans where id = ${plan.id}`
  })

  it('§6.1 + §7.4: срок в прошлом / вне плана / уровень не выше — отказ; при включённом согласовании цель ждёт руководителя', async () => {
    const { updateDevelopmentSettings } = await X()
    const espressoId = compIds[0]!
    expect(await dev.createGoal(asBarista(), { userId: baristaId, title: 'Вчора', kind: 'learning', dueAt: '2020-01-01' })).toMatchObject({ ok: false, code: 'due_past' })
    expect(await dev.createGoal(asBarista(), { userId: baristaId, title: 'Рівень 1', kind: 'competency', competencyId: espressoId, targetLevel: 1, dueAt: '2026-12-31' })).toMatchObject({ ok: false, code: 'level_not_higher' })
    expect(await dev.createGoal(asBarista(), { userId: baristaId, title: 'Без компетенції', kind: 'competency', dueAt: '2026-12-31' })).toMatchObject({ ok: false, code: 'competency_required' })
    const plan = await dev.createPlan(asAdmin(), { userId: baristaId, periodFrom: '2026-10-01', periodTo: '2026-10-31' })
    expect(await dev.createGoal(asBarista(), { userId: baristaId, planId: plan.id, title: 'Поза планом', kind: 'learning', dueAt: '2026-12-31' })).toMatchObject({ ok: false, code: 'due_outside_plan' })

    await updateDevelopmentSettings(asAdmin(), { goalsNeedApproval: true })
    try {
      const r = await dev.createGoal(asBarista(), { userId: baristaId, title: 'Потребує погодження', kind: 'learning', dueAt: '2026-12-31' })
      expect(r.ok).toBe(true)
      const goal = (r as { ok: true, goal: { id: string, approvedAt: Date | null } }).goal
      expect(goal.approvedAt).toBeNull()
      expect(await dev.transitionGoal(asBarista(), goal.id, 'in_progress', { scopes: OWN })).toMatchObject({ ok: false, code: 'not_approved' })
      expect(await dev.approveGoal(asAdmin(), goal.id, 'return')).toMatchObject({ ok: false, code: 'comment_required' })
      expect(await dev.approveGoal(asAdmin(), goal.id, 'approve')).toMatchObject({ ok: true })
      expect((await dev.transitionGoal(asBarista(), goal.id, 'in_progress', { scopes: OWN })).ok).toBe(true)
      const [n] = await admin`select count(*)::int as c from notifications where user_id = ${adminId} and code = 'goal_needs_approval' and payload->>'goalId' = ${goal.id}`
      expect(n!.c).toBe(1)
      await admin`delete from development_goals where id = ${goal.id}`
    }
    finally {
      await updateDevelopmentSettings(asAdmin(), { goalsNeedApproval: false })
      await admin`delete from development_plans where id = ${plan.id}`
    }
  })

  it('§5.5: «Застосувати профіль до людей на посаді» создаёт назначения обязательного контента; покрытие профиля считается', async () => {
    const { applyPositionProfile, profileCoverage } = await X()
    const [course] = await admin`insert into courses (tenant_id, title, slug, status) values (${tenantId}, ${`Обовʼязковий ${Date.now()}`}, ${`mand-${Date.now()}`}, 'published') returning id`
    const [ver] = await admin`insert into course_versions (tenant_id, course_id, version) values (${tenantId}, ${course!.id}, 1) returning id`
    await admin`update courses set published_version_id = ${ver!.id} where id = ${course!.id}`
    const [profile] = await admin`select id from position_profiles where position_id = ${baristaPosId}`
    await admin`update position_profiles set mandatory_content = ${JSON.stringify([{ subjectType: 'course', subjectId: course!.id, dueDays: 10 }])} where id = ${profile!.id}`
    try {
      const r = await applyPositionProfile(asAdmin(), profile!.id as string)
      expect(r).toMatchObject({ assignments: 1 })
      expect(r!.enrolled).toBeGreaterThanOrEqual(1)
      const [e] = await admin`select status from enrollments where user_id = ${baristaId} and subject_id = ${course!.id}`
      expect(e).toBeDefined()
      const cov = await profileCoverage(asAdmin(), profile!.id as string)
      expect(cov!.people).toBeGreaterThanOrEqual(1)
    }
    finally {
      await admin`delete from enrollments where subject_id = ${course!.id}`
      await admin`delete from assignments where subject_id = ${course!.id}`
      await admin`update courses set published_version_id = null where id = ${course!.id}`; await admin`delete from course_versions where id = ${ver!.id}`; await admin`delete from courses where id = ${course!.id}`
    }
  })

  it('§3.8: стратегический план — создание, список, удаление', async () => {
    const { upsertStrategicPlan, listStrategicPlans, deleteStrategicPlan } = await X()
    const p = await upsertStrategicPlan(asAdmin(), { title: 'План навчання Q4', periodFrom: '2026-10-01', periodTo: '2026-12-31', goals: [{ title: 'Усі бариста на рівні 2' }], budget: 50000, kpi: [{ name: 'Чинна атестація', target: '95', unit: '%' }] })
    expect(p!.status).toBe('draft')
    expect((await listStrategicPlans(asAdmin())).some(x => x.id === p!.id)).toBe(true)
    expect(await deleteStrategicPlan(asAdmin(), p!.id)).toBe(true)
  })
})
