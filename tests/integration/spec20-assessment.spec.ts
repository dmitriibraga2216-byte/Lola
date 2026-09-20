import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Spec 20 (docs/20 §14, docs/32 Б.15): заморозка анкеты/чек-листа/опроса после первого заполнения,
 * тип и нормы анкеты, правила комментирования, опрос — конфиденциально / анонимно (без автора на уровне данных) /
 * свій варіант / по шкалі / з умовами, чек-лист по весам с обязательным комментарием, изоляция тенанта.
 */

const as = await import('../../server/services/assessment')
const cl = await import('../../server/services/checklists')
const sv = await import('../../server/services/surveys')
const sc = await import('../../server/services/scales')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

let tenantId: string
let adminId: string
let lazarevaId: string
let posId: string
let scaleId: string
let binaryId: string
let otherTenantId: string
let otherUserId: string
const userIds: string[] = []
const groupIds: string[] = []
const formIds: string[] = []
const cycleIds: string[] = []
const checklistIds: string[] = []
const surveyIds: string[] = []
const scaleIds: string[] = []

const ctx = (actorId = adminId) => ({ tenantId, actorId })

async function makePerson(name: string) {
  const phone = `+38097${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, phone, full_name, status, hired_at) values (${tenantId}, ${phone}, ${name}, 'active', current_date) returning id`
  userIds.push(u!.id as string)
  await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary) values (${tenantId}, ${u!.id}, ${lazarevaId}, ${posId}, true)`
  return u!.id as string
}

const FORM_DEFAULTS = { kind: 'by_criteria' as const, allowCommentGroups: false, commentGroupsRequired: false, commentWhenAboveNorm: false, commentWhenBelowNorm: true, commentWhenEqual: false, zeroMeansNoGrade: false, tags: [], isActive: true }

async function makeForm(overrides: Partial<Parameters<typeof as.saveForm>[1]> = {}) {
  const g = await as.upsertGroup(ctx(), { name: `Група ${Date.now()}-${Math.random()}`, weight: 1, tags: ['soft'] })
  groupIds.push(g!.id)
  const c1 = await as.upsertCriterion(ctx(), { groupId: g!.id, text: 'Вислуховує до кінця' })
  const c2 = await as.upsertCriterion(ctx(), { groupId: g!.id, text: 'Налагоджує контакт', weight: 2 })
  const r = await as.saveForm(ctx(), { title: `Анкета ${Date.now()}`, scaleId, ...FORM_DEFAULTS, items: [{ criterionId: c1!.id, norm: 3 }, { criterionId: c2!.id, norm: 4 }], ...overrides })
  if (!r.ok) throw new Error(r.code)
  formIds.push(r.form.id)
  return { form: r.form, group: g!, c1: c1!, c2: c2! }
}

async function startCycleFor(formId: string, subject: string) {
  const cycle = await as.createCycle(ctx(), {
    title: `Цикл ${Date.now()}`, formId, periodFrom: '2026-07-01', periodTo: '2026-09-30', startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    subjects: { rules: [{ type: 'user', ids: [subject] }], match: 'any' }, raterKinds: ['self', 'manager'], minRatersToShow: 3,
  })
  cycleIds.push(cycle.id)
  const st = await as.startCycle(ctx(), cycle.id)
  if (!st.ok) throw new Error(st.code)
  const [task] = await admin`select id from assessment_tasks where cycle_id = ${cycle.id} and rater_user_id = ${subject} and rater_kind = 'self'`
  return { cycle, selfTaskId: task!.id as string }
}

const CL_DEFAULTS = { kind: 'observation' as const, criticalFailRule: 'none' as const, whoCanRun: { roles: ['manager'] }, subjectKind: 'location' as const, allowSkip: false, allowItemComment: true, itemCommentRequired: false, tags: [] }

const SURVEY_DEFAULTS = { kind: 'survey' as const, mode: 'linear' as const, isAnonymous: false, isConfidential: false, showResults: false, tags: [] }

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  posId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Бариста-s20-${Date.now()}`}, 'barista-s20') returning id`)[0]!.id as string
  await admin`update locations set manager_id = ${adminId} where id = ${lazarevaId}`
  scaleId = (await admin`select id from scales where tenant_id = ${tenantId} and name = '1–5'`)[0]!.id as string
  binaryId = (await admin`select id from scales where tenant_id = ${tenantId} and name = 'Зараховано / Не зараховано'`)[0]!.id as string
  const [other] = await admin`insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції') on conflict (slug) do update set name = excluded.name returning id`
  otherTenantId = other!.id as string
  otherUserId = (await admin`insert into users (tenant_id, phone, full_name, status) values (${otherTenantId}, ${`+38099${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`}, 'Чужий', 'active') returning id`)[0]!.id as string
})

afterAll(async () => {
  if (cycleIds.length) await admin`delete from assessment_cycles where id in ${admin(cycleIds)}`
  if (formIds.length) await admin`delete from assessment_forms where id in ${admin(formIds)}`
  if (groupIds.length) await admin`delete from criteria_groups where id in ${admin(groupIds)}`
  if (checklistIds.length) { await admin`delete from checklist_runs where checklist_id in ${admin(checklistIds)}`; await admin`delete from checklists where id in ${admin(checklistIds)}` }
  if (surveyIds.length) await admin`delete from surveys where id in ${admin(surveyIds)}`
  if (scaleIds.length) await admin`delete from scales where id in ${admin(scaleIds)}`
  if (userIds.length) { await admin`delete from notifications where user_id in ${admin(userIds)}`; await admin`delete from users where id in ${admin(userIds)}` }
  await admin`delete from users where id = ${otherUserId}`
  await admin`delete from positions where id = ${posId}`
  await admin`update locations set manager_id = null where id = ${lazarevaId}`
  await admin.end()
})

describe('Spec 20: анкета оценки — тип, нормы, заморозка (docs/20 §14.2, §14.4)', () => {
  it('норма вне шкалы — bad_norm; анкета создаётся с типом, шкалой и нормами; список показывает шкалу и число критериев', async () => {
    const { form, c1 } = await makeForm()
    expect(form.kind).toBe('by_criteria')
    const bad = await as.saveForm(ctx(), { id: form.id, title: form.title, scaleId, ...FORM_DEFAULTS, items: [{ criterionId: c1.id, norm: 9 }] })
    expect(bad).toMatchObject({ ok: false, code: 'bad_norm', max: 5 })
    const list = await as.listForms(ctx())
    const row = list.find(r => r.id === form.id)!
    expect(row).toMatchObject({ scale_name: '1–5', criteria_count: 2, is_locked: false })
    const full = await as.getForm(ctx(), form.id)
    expect(full!.items.map(i => i.norm)).toEqual([3, 4])
    expect(full!.scale!.options.length).toBe(5)
    expect(full!.raterRoles.find(r => r.kind === 'manager')!.weight).toBe(2)
  })

  it('заморозка: первое сохранение ответа замораживает анкету — шкала, состав, нормы и правила → locked; название и описание — можно; критерий из замороженной анкеты не удаляется', async () => {
    const subject = await makePerson('Оцінюваний Заморозка')
    const { form, c1, c2 } = await makeForm()
    const { selfTaskId } = await startCycleFor(form.id, subject)
    expect((await as.getForm(ctx(), form.id))!.isLocked).toBe(false)

    await as.saveAnswers(ctx(subject), selfTaskId, [{ criterionId: c1.id, value: 4 }])
    expect((await as.getForm(ctx(), form.id))!.isLocked).toBe(true)

    const base = { id: form.id, title: form.title, scaleId, ...FORM_DEFAULTS, items: [{ criterionId: c1.id, norm: 3 }, { criterionId: c2.id, norm: 4 }] }
    expect(await as.saveForm(ctx(), { ...base, items: [{ criterionId: c1.id, norm: 2 }, { criterionId: c2.id, norm: 4 }] })).toMatchObject({ ok: false, code: 'locked', fields: ['norms'] })
    expect(await as.saveForm(ctx(), { ...base, items: [{ criterionId: c1.id, norm: 3 }] })).toMatchObject({ ok: false, code: 'locked', fields: ['items'] })
    expect(await as.saveForm(ctx(), { ...base, scaleId: binaryId, items: [{ criterionId: c1.id, norm: 1 }, { criterionId: c2.id, norm: 1 }] })).toMatchObject({ ok: false, code: 'locked' })
    expect(await as.saveForm(ctx(), { ...base, commentWhenBelowNorm: false })).toMatchObject({ ok: false, code: 'locked', fields: ['commentWhenBelowNorm'] })
    expect(await as.saveForm(ctx(), { ...base, kind: 'by_competencies' })).toMatchObject({ ok: false, code: 'locked', fields: ['kind'] })

    const ok = await as.saveForm(ctx(), { ...base, title: 'Нова назва', description: 'Опис', tags: ['x'] })
    expect(ok.ok).toBe(true)
    expect((await as.getForm(ctx(), form.id))!.title).toBe('Нова назва')

    expect(await as.deleteCriterion(ctx(), c1.id)).toMatchObject({ ok: false, code: 'in_use', forms: 1 })
    const [audit] = await admin`select action from audit_log where entity = 'assessment_form' and entity_id = ${form.id} and action = 'assessment.form.lock'`
    expect(audit).toBeDefined()
  })

  it('правила комментирования: ниже нормы — обязателен; выше/равно — разрешён; «0 = нет оценки» не считается; коментар до групи обовʼязковий', async () => {
    const subject = await makePerson('Оцінюваний Норми')
    const { form, group, c1, c2 } = await makeForm({ allowCommentGroups: true, commentGroupsRequired: true, commentWhenAboveNorm: true })
    const { selfTaskId } = await startCycleFor(form.id, subject)
    // значение вне шкалы
    expect(await as.saveAnswers(ctx(subject), selfTaskId, [{ criterionId: c1.id, value: 7 }])).toMatchObject({ saved: 0, badValue: c1.id })
    // c1: 2 < норма 3 без комментария; c2: 5 > норма 4 без комментария (разрешён, не обязателен)
    await as.saveAnswers(ctx(subject), selfTaskId, [{ criterionId: c1.id, value: 2 }, { criterionId: c2.id, value: 5 }])
    expect(await as.submitTask(ctx(subject), selfTaskId)).toMatchObject({ ok: false, code: 'comment_required', criterionIds: [c1.id] })
    await as.saveAnswers(ctx(subject), selfTaskId, [{ criterionId: c1.id, value: 2, comment: 'Перебиває гостя' }])
    // коментар до групи обовʼязковий
    expect(await as.submitTask(ctx(subject), selfTaskId)).toMatchObject({ ok: false, code: 'group_comment_required' })
    await as.saveAnswers(ctx(subject), selfTaskId, [], { [group.id]: 'Загалом добре' })
    expect(await as.submitTask(ctx(subject), selfTaskId)).toMatchObject({ ok: true })
    // rule helper
    expect(as.commentRule({ commentWhenBelowNorm: true, commentWhenAboveNorm: false, commentWhenEqual: false, zeroMeansNoGrade: true }, 0, 3)).toBe('none')
    expect(as.commentRule({ commentWhenBelowNorm: true, commentWhenAboveNorm: false, commentWhenEqual: true, zeroMeansNoGrade: false }, 3, 3)).toBe('allowed')
    expect(as.commentRule({ commentWhenBelowNorm: false, commentWhenAboveNorm: false, commentWhenEqual: false, zeroMeansNoGrade: false }, 1, 3)).toBe('none')
  })

  it('«значення 0 означає відсутність оцінки»: ноль вне знаменателя; отчёт по каркасу — роль, заполнено, розрив із нормою', async () => {
    const subject = await makePerson('Оцінюваний Нуль')
    const zeroScale = await sc.createScale(ctx(), { name: `0–10 s20 ${Date.now()}`, kind: 'levels', displayAs: 'value', levels: Array.from({ length: 11 }, (_, i) => ({ label: String(i), value: i, showInReports: true })) })
    if (!zeroScale.ok) throw new Error(zeroScale.code)
    scaleIds.push(zeroScale.scale.id)
    const { form, c1, c2 } = await makeForm({ scaleId: zeroScale.scale.id, zeroMeansNoGrade: true })
    // нормы из makeForm (3 и 4) — перезапишем нормами 8 по шкале 0–10
    await as.saveForm(ctx(), { id: form.id, title: form.title, scaleId: zeroScale.scale.id, ...FORM_DEFAULTS, zeroMeansNoGrade: true, items: [{ criterionId: c1.id, norm: 8 }, { criterionId: c2.id, norm: 8 }] })
    const { cycle } = await startCycleFor(form.id, subject)
    const [mgr] = await admin`select id from assessment_tasks where cycle_id = ${cycle.id} and rater_kind = 'manager'`
    await as.saveAnswers(ctx(adminId), mgr!.id as string, [{ criterionId: c1.id, value: 0 }, { criterionId: c2.id, value: 6, comment: 'Треба підтягнути' }])
    expect(await as.submitTask(ctx(adminId), mgr!.id as string)).toMatchObject({ ok: true })
    const res = await as.resultsFor(ctx(adminId), subject, cycle.id, { asManager: true })
    // ноль не считается: средняя по группе = 6 (только c2), розрив 6 − 8 = −2
    expect(res!.groups[0]!.byKind.manager!.avg).toBe(6)
    expect(res!.criteriaGaps.find(g => g.criterionId === c2.id)).toMatchObject({ norm: 8, avg: 6, gap: -2 })
    expect(res!.criteriaGaps.find(g => g.criterionId === c1.id)!.avg).toBeNull()
    const rows = await cl.assessmentReport(ctx(), { cycleId: cycle.id })
    const mine = rows.find(r => r.task_id === mgr!.id)!
    expect(mine).toMatchObject({ rater_kind: 'manager', filled: true, status: 'done' })
    expect(Number(mine.avg_score)).toBe(6)
    expect((mine.gaps as { gap: string }[]).map(g => Number(g.gap))).toEqual([-2])
  })

  it('чужой тенант: анкета и её состав не видны (RLS assessment_items)', async () => {
    const { form } = await makeForm()
    expect(await as.getForm({ tenantId: otherTenantId, actorId: otherUserId }, form.id)).toBeNull()
    const rows = await admin`select count(*)::int as n from assessment_items where form_id = ${form.id}`
    expect(rows[0]!.n).toBe(2)
    const { withTenant } = await import('../../server/utils/withTenant')
    const { sql } = await import('drizzle-orm')
    const seen = await withTenant(otherTenantId, otherUserId, tx => tx.execute(sql`select count(*)::int as n from assessment_items where form_id = ${form.id}::uuid`)) as unknown as { n: number }[]
    expect(seen[0]!.n).toBe(0)
  })
})

describe('Spec 20: чек-лист — шкала одна, вес пункта, комментарий, заморозка (docs/20 §14.3, §14.4)', () => {
  it('«За вагами»: доля от суммы весов; провал пункта требует комментария; без «пропускати» n/a не принимается; после первого прогона — locked', async () => {
    const r = await cl.upsertChecklist(ctx(), { title: `Чек-лист зміни ${Date.now()}`, scaleId: binaryId, scoring: 'points', passScore: 80, ...CL_DEFAULTS, itemCommentRequired: true, items: [
      { id: 'a', text: 'Вітрина чиста', weight: 3 }, { id: 'b', text: 'Форма охайна', weight: 2 }, { id: 'c', text: 'Каса', weight: 3 }, { id: 'd', text: 'Температура', weight: 3 },
    ] })
    if (!r.ok) throw new Error(r.code)
    const c = r.checklist
    checklistIds.push(c.id)
    expect((await cl.getChecklist(ctx(), c.id))!.maxPoints).toBe(11)
    const run = await cl.startRun(ctx(), c.id, { locationId: lazarevaId })
    expect((await cl.getChecklist(ctx(), c.id))!.isLocked).toBe(true)

    // n/a без allow_skip → пункт не отвечен
    expect(await cl.finishRun(ctx(), run!.id, { answers: [{ itemId: 'a', value: 0 }, { itemId: 'b', value: 1 }, { itemId: 'c', value: 1 }, { itemId: 'd', value: null, isNa: true }] })).toMatchObject({ ok: false, code: 'incomplete', itemIds: ['d'] })
    // провал «a» без комментария
    expect(await cl.finishRun(ctx(), run!.id, { answers: [{ itemId: 'a', value: 0 }, { itemId: 'b', value: 1 }, { itemId: 'c', value: 1 }, { itemId: 'd', value: 1 }] })).toMatchObject({ ok: false, code: 'comment_required', itemIds: ['a'] })
    const answers = [{ itemId: 'a', value: 0, comment: 'Сліди від пальців на склі' }, { itemId: 'b', value: 1 }, { itemId: 'c', value: 1 }, { itemId: 'd', value: 1 }]
    // не пройдено → план дій обовʼязковий (docs/20 §7.5)
    expect(await cl.finishRun(ctx(), run!.id, { answers })).toMatchObject({ ok: false, code: 'action_plan_required' })
    const done = await cl.finishRun(ctx(), run!.id, { answers, actionPlan: [{ id: 'p1', text: 'Протерти вітрину', responsibleId: adminId, dueAt: '2026-12-31', status: 'open' }] })
    // 8 из 11 балів = 72.73% — за вагами прохідний 80 балів не набран
    expect(done).toMatchObject({ ok: true, score: { points: 8, maxPoints: 11, percent: 72.73, passed: false, failedItems: ['a'] } })

    // заморозка: вес и шкала — нельзя; название и роли — можно
    const base = { id: c.id, title: c.title, scaleId: binaryId, scoring: 'points' as const, passScore: 80, ...CL_DEFAULTS, itemCommentRequired: true, items: c.items as { id: string, text: string, weight: number }[] }
    expect(await cl.upsertChecklist(ctx(), { ...base, items: base.items.map(i => i.id === 'a' ? { ...i, weight: 5 } : i) })).toMatchObject({ ok: false, code: 'locked', fields: ['items'] })
    expect(await cl.upsertChecklist(ctx(), { ...base, scaleId })).toMatchObject({ ok: false, code: 'locked', fields: ['scaleId'] })
    expect(await cl.upsertChecklist(ctx(), { ...base, allowSkip: true })).toMatchObject({ ok: false, code: 'locked', fields: ['allowSkip'] })
    expect(await cl.upsertChecklist(ctx(), { ...base, title: 'Чек-лист зміни · Б10', whoCanRun: { roles: ['admin'] }, frequency: { timesPerWeek: 2 } })).toMatchObject({ ok: true })
    expect((await cl.getChecklist(ctx(), c.id))!.title).toBe('Чек-лист зміни · Б10')
  })

  it('допускати пропуск: n/a вне знаменателя; шкала 1–5 — доля (v−1)/4', async () => {
    const r = await cl.upsertChecklist(ctx(), { title: `Пропуски ${Date.now()}`, scaleId, scoring: 'percent', passScore: 50, ...CL_DEFAULTS, allowSkip: true, items: [{ id: 'a', text: 'A', weight: 1 }, { id: 'b', text: 'B', weight: 1 }] })
    if (!r.ok) throw new Error(r.code)
    checklistIds.push(r.checklist.id)
    const run = await cl.startRun(ctx(), r.checklist.id, { locationId: lazarevaId })
    const done = await cl.finishRun(ctx(), run!.id, { answers: [{ itemId: 'a', value: 3 }, { itemId: 'b', value: null, isNa: true }] })
    expect(done).toMatchObject({ ok: true, score: { score: 50, points: 0.5, maxPoints: 1, passed: true, answered: 2 } })
  })
})

describe('Spec 20: опрос — конфіденційно / анонімно / свій варіант / по шкалі / з умовами (docs/20 §14.5, §14.7)', () => {
  it('конфиденциально: ответы с именами видит только владелец; остальным — сводка и ответы без имён; после первого ответа — locked', async () => {
    const respondent = await makePerson('Респондент Конф')
    const s = await sv.createSurvey(ctx(), { title: `Конфіденційне ${Date.now()}`, ...SURVEY_DEFAULTS, isConfidential: true, questions: [{ id: 'q1', type: 'single', text: 'Стиль керівництва?', options: [{ id: 'a', text: 'Самостійно' }, { id: 'b', text: 'Колективно' }] }] })
    surveyIds.push(s.id)
    await sv.updateSurvey(ctx(), s.id, { status: 'active' })
    expect((await sv.startSurvey(ctx(respondent), s.id)).ok).toBe(true)
    expect((await sv.getSurvey(ctx(), s.id))!.isLocked).toBe(true)
    // заморозка: вопросы и приватность нельзя, название и сроки можно
    expect(await sv.updateSurvey(ctx(), s.id, { isAnonymous: true })).toMatchObject({ ok: false, code: 'locked', fields: ['isAnonymous'] })
    expect(await sv.updateSurvey(ctx(), s.id, { questions: [{ id: 'q1', type: 'free', text: 'Інше' }] })).toMatchObject({ ok: false, code: 'locked', fields: ['questions'] })
    expect(await sv.updateSurvey(ctx(), s.id, { title: 'Нова назва', tags: ['x'], closesAt: null })).toMatchObject({ ok: true })
    expect(await sv.answerQuestion(ctx(respondent), s.id, 'q1', { optionId: 'b' })).toMatchObject({ ok: true, done: true })
    const [row] = await admin`select user_id from survey_responses where survey_id = ${s.id}`
    expect(row!.user_id).toBe(respondent)
    const owner = await sv.surveyReport(ctx(adminId), s.id)
    expect(owner!.isOwner).toBe(true)
    expect(owner!.respondents![0]!.name).toBe('Респондент Конф')
    const other = await sv.surveyReport(ctx(respondent), s.id)
    expect(other!.isOwner).toBe(false)
    expect(other!.respondents![0]!.name).toBeNull()
    expect((other!.questions[0] as { distribution: Record<string, number> }).distribution).toEqual({ 'Самостійно': 0, 'Колективно': 1 })
  })

  it('анонимно: ответ без user_id, участие без ссылки на ответ, черновик стёрт — связь восстановить нельзя; повторно ответить нельзя', async () => {
    const respondent = await makePerson('Респондент Анон')
    const s = await sv.createSurvey(ctx(), { title: `Анонімне ${Date.now()}`, ...SURVEY_DEFAULTS, isAnonymous: true, questions: [{ id: 'q1', type: 'free', text: 'Що змінити?' }] })
    surveyIds.push(s.id)
    await sv.updateSurvey(ctx(), s.id, { status: 'active' })
    await sv.startSurvey(ctx(respondent), s.id)
    // пока заполняет — черновик у участия (нужен для продолжения), ответа ещё нет
    let [p] = await admin`select status, draft, user_id from survey_participations where survey_id = ${s.id}`
    expect(p).toMatchObject({ status: 'in_progress', user_id: respondent })
    expect(await sv.answerQuestion(ctx(respondent), s.id, 'q1', { text: 'Більше світла' })).toMatchObject({ ok: true, done: true })
    const [r] = await admin`select * from survey_responses where survey_id = ${s.id}`
    expect(r!.user_id).toBeNull()
    ;[p] = await admin`select status, draft from survey_participations where survey_id = ${s.id}`
    expect(p).toMatchObject({ status: 'submitted', draft: {} })
    // На уровне данных: в survey_responses нет ни одной колонки, ведущей к человеку или участию
    const cols = (await admin`select column_name from information_schema.columns where table_name = 'survey_responses'`).map(c => c.column_name as string)
    expect(cols.some(c => /hash|participation|respondent/.test(c))).toBe(false)
    expect(cols.filter(c => c.endsWith('_id')).sort()).toEqual(['enrollment_id', 'survey_id', 'tenant_id', 'user_id'])
    const fks = await admin`select ccu.table_name as ref from information_schema.table_constraints tc join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name where tc.table_name = 'survey_participations' and tc.constraint_type = 'FOREIGN KEY'`
    expect(fks.map(f => f.ref)).not.toContain('survey_responses')
    expect(await sv.startSurvey(ctx(respondent), s.id)).toMatchObject({ ok: false, code: 'already' })
    expect(await sv.answerQuestion(ctx(respondent), s.id, 'q1', { text: 'ще раз' })).toMatchObject({ ok: false, code: 'already' })
  })

  it('свій варіант: принимается только при allowOwnOption; множинне — варианты + свій; по шкалі — только значения шкалы, сводка по подписям', async () => {
    const respondent = await makePerson('Респондент Варіант')
    const s = await sv.createSurvey(ctx(), { title: `Варіанти ${Date.now()}`, ...SURVEY_DEFAULTS, questions: [
      { id: 'q1', type: 'single', text: 'Рішення?', options: [{ id: 'a', text: 'Самостійно' }, { id: 'b', text: 'Колективно' }], allowOwnOption: true },
      { id: 'q2', type: 'single', text: 'Без свого', options: [{ id: 'a', text: 'Так' }, { id: 'b', text: 'Ні' }] },
      { id: 'q3', type: 'multi', text: 'Що подобається?', options: [{ id: 'x', text: 'Команда' }, { id: 'y', text: 'Графік' }], allowOwnOption: true },
      { id: 'q4', type: 'scale', text: 'Наскільки згодні?', scaleId },
    ] })
    surveyIds.push(s.id)
    await sv.updateSurvey(ctx(), s.id, { status: 'active' })
    await sv.startSurvey(ctx(respondent), s.id)
    expect(await sv.answerQuestion(ctx(respondent), s.id, 'q1', { optionId: 'zzz' })).toMatchObject({ ok: false, code: 'bad_option' })
    expect(await sv.answerQuestion(ctx(respondent), s.id, 'q1', { own: '50 на 50' })).toMatchObject({ ok: true, done: false, question: { id: 'q2' } })
    expect(await sv.answerQuestion(ctx(respondent), s.id, 'q2', { own: 'своє' })).toMatchObject({ ok: false, code: 'own_not_allowed' })
    expect(await sv.answerQuestion(ctx(respondent), s.id, 'q2', { optionId: 'a' })).toMatchObject({ ok: true, done: false, question: { id: 'q3' } })
    expect(await sv.answerQuestion(ctx(respondent), s.id, 'q3', { optionIds: ['x'], own: 'Кава' })).toMatchObject({ ok: true, done: false, question: { id: 'q4', scale: { options: expect.any(Array) } } })
    // клиент не получает граф переходов
    const step = await sv.startSurvey(ctx(respondent), s.id)
    expect(step.ok && step.question && 'next' in step.question).toBe(false)
    expect(await sv.answerQuestion(ctx(respondent), s.id, 'q4', { value: 7 })).toMatchObject({ ok: false, code: 'bad_value' })
    expect(await sv.answerQuestion(ctx(respondent), s.id, 'q4', { value: 4 })).toMatchObject({ ok: true, done: true })
    const rep = await sv.surveyReport(ctx(), s.id)
    expect((rep!.questions[0] as { own: string[] }).own).toEqual(['50 на 50'])
    expect((rep!.questions[2] as { distribution: Record<string, number>, own: string[] })).toMatchObject({ distribution: { 'Команда': 1, 'Графік': 0 }, own: ['Кава'] })
    expect((rep!.questions[3] as { avg: number, distribution: Record<string, number>, scale: string })).toMatchObject({ avg: 4, distribution: { 'Вище очікувань': 1 }, scale: '1–5' })
  })

  it('з умовами: следующий вопрос по выбранному варианту, иначе по умолчанию; «end» завершает; путь сохраняется', async () => {
    const r1 = await makePerson('Респондент Умови 1')
    const r2 = await makePerson('Респондент Умови 2')
    const s = await sv.createSurvey(ctx(), { title: `З умовами ${Date.now()}`, ...SURVEY_DEFAULTS, mode: 'conditional', questions: [
      { id: 'q1', type: 'single', text: 'Ви керівник?', options: [{ id: 'yes', text: 'Так' }, { id: 'no', text: 'Ні' }], next: [{ optionId: 'yes', goTo: 'q3' }, { goTo: 'q2' }] },
      { id: 'q2', type: 'free', text: 'Чого бракує?', next: [{ goTo: 'end' }] },
      { id: 'q3', type: 'single', text: 'Скільки людей у команді?', options: [{ id: 's', text: 'до 5' }, { id: 'l', text: 'більше' }] },
      { id: 'q4', type: 'free', text: 'Побажання', required: false },
    ] })
    surveyIds.push(s.id)
    await sv.updateSurvey(ctx(), s.id, { status: 'active' })
    // Ветка «так»: q1 → q3 → q4 → конец
    await sv.startSurvey(ctx(r1), s.id)
    expect(await sv.answerQuestion(ctx(r1), s.id, 'q1', { optionId: 'yes' })).toMatchObject({ ok: true, done: false, question: { id: 'q3' }, index: 2, total: 4 })
    expect(await sv.answerQuestion(ctx(r1), s.id, 'q2', { text: 'x' })).toMatchObject({ ok: false, code: 'wrong_question' })
    expect(await sv.answerQuestion(ctx(r1), s.id, 'q3', { optionId: 's' })).toMatchObject({ ok: true, done: false, question: { id: 'q4' } })
    expect(await sv.answerQuestion(ctx(r1), s.id, 'q4', null)).toMatchObject({ ok: true, done: true })
    // Ветка «ні»: q1 → q2 → end (q3, q4 пропущены)
    await sv.startSurvey(ctx(r2), s.id)
    expect(await sv.answerQuestion(ctx(r2), s.id, 'q1', { optionId: 'no' })).toMatchObject({ ok: true, done: false, question: { id: 'q2' } })
    expect(await sv.answerQuestion(ctx(r2), s.id, 'q2', { text: 'Часу' })).toMatchObject({ ok: true, done: true })
    const paths = (await admin`select path from survey_responses where survey_id = ${s.id} order by submitted_at`).map(r => r.path)
    expect(paths).toEqual([['q1', 'q3', 'q4'], ['q1', 'q2']])
    // Валидация контракта: переход на несуществующий вопрос и условия в линейном режиме
    const { pollSchema } = await import('../../shared/schemas/assessment')
    expect(pollSchema.safeParse({ title: 'Погане', mode: 'conditional', questions: [{ id: 'a', type: 'free', text: 'Текст', next: [{ goTo: 'zzz' }] }] }).success).toBe(false)
    expect(pollSchema.safeParse({ title: 'Погане', mode: 'linear', questions: [{ id: 'a', type: 'free', text: 'Текст', next: [{ goTo: 'end' }] }] }).success).toBe(false)
  })

  it('чужой тенант не видит опрос и участие (RLS survey_participations)', async () => {
    const s = await sv.createSurvey(ctx(), { title: `Ізоляція ${Date.now()}`, ...SURVEY_DEFAULTS, questions: [{ id: 'q1', type: 'free', text: 'Текст' }] })
    surveyIds.push(s.id)
    await sv.updateSurvey(ctx(), s.id, { status: 'active' })
    await sv.startSurvey(ctx(adminId), s.id)
    expect(await sv.getSurvey({ tenantId: otherTenantId, actorId: otherUserId }, s.id)).toBeNull()
    expect(await sv.startSurvey({ tenantId: otherTenantId, actorId: otherUserId }, s.id)).toMatchObject({ ok: false, code: 'not_found' })
    const { withTenant } = await import('../../server/utils/withTenant')
    const { sql } = await import('drizzle-orm')
    const seen = await withTenant(otherTenantId, otherUserId, tx => tx.execute(sql`select count(*)::int as n from survey_participations where survey_id = ${s.id}::uuid`)) as unknown as { n: number }[]
    expect(seen[0]!.n).toBe(0)
  })
})
