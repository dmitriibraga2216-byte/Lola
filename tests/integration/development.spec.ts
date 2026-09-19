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
    const goal = await dev.createGoal(asBarista(), { userId: baristaId, planId: plan.id, title: 'Еспресо до рівня 3', kind: 'competency', competencyId: espresso.id, targetLevel: 3, dueAt: '2026-11-30' })
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
    const goal = await dev.createGoal(asBarista(), { userId: baristaId, title: 'Латте-арт', kind: 'competency', competencyId: espresso.id, targetLevel: 2, dueAt: '2026-12-01' })

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
    const goal = await dev.createGoal(asBarista(), { userId: baristaId, title: 'Пауза', kind: 'learning', dueAt: '2026-12-01' })
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
    expect(await req.decideRequest(asAdmin(), 'external', r.id, 'approve', { isHr: true, comment: 'Бюджет є' })).toMatchObject({ ok: true, status: 'approved' })
    const mine = await req.myRequests(asBarista())
    expect(mine.external[0]).toMatchObject({ status: 'approved' })
    expect((mine.external[0]!.approvals as unknown[]).length).toBe(2)
    expect(await req.completeExternal(asBarista(), r.id, 'Пройшов, сертифікат отримав')).toBeTruthy()
    const [n] = await admin`select count(*)::int as c from notifications where user_id = ${baristaId} and code in ('request_step','request_approved')`
    expect(n!.c).toBe(2)
  })
})
