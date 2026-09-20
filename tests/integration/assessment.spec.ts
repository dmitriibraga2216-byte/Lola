import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const as = await import('../../server/services/assessment')
const cl = await import('../../server/services/checklists')
const dev = await import('../../server/services/development')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

let tenantId: string
let adminId: string
let lazarevaId: string
let posId: string
let scaleId: string
let compId: string
const userIds: string[] = []
const groupIds: string[] = []
const formIds: string[] = []
const cycleIds: string[] = []
const checklistIds: string[] = []
const extraPos: string[] = []

async function makePerson(name: string, positionId = posId) {
  const phone = `+38097${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, phone, full_name, status, hired_at) values (${tenantId}, ${phone}, ${name}, 'active', current_date) returning id`
  userIds.push(u!.id as string)
  await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary) values (${tenantId}, ${u!.id}, ${lazarevaId}, ${positionId}, true)`
  return u!.id as string
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  posId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Бариста-оц-${Date.now()}`}, 'barista-as') returning id`)[0]!.id as string
  await admin`update locations set manager_id = ${adminId} where id = ${lazarevaId}`
  scaleId = (await admin`select id from scales where tenant_id = ${tenantId} and name = '1–5'`)[0]!.id as string
  const c = await dev.createCompetency({ tenantId, actorId: adminId }, { name: `Гостинність ${Date.now()}`, kind: 'soft', levels: [1, 2, 3].map(n => ({ level: n, title: `L${n}`, behavior: `Поведінка ${n}` })) })
  compId = c.id
})

afterAll(async () => {
  if (cycleIds.length) await admin`delete from assessment_cycles where id in ${admin(cycleIds)}`
  if (formIds.length) await admin`delete from assessment_forms where id in ${admin(formIds)}`
  if (groupIds.length) await admin`delete from criteria_groups where id in ${admin(groupIds)}`
  if (checklistIds.length) { await admin`delete from checklist_runs where checklist_id in ${admin(checklistIds)}`; await admin`delete from checklists where id in ${admin(checklistIds)}` }
  if (userIds.length) {
    await admin`delete from notifications where user_id in ${admin(userIds)}`
    await admin`delete from competency_assessments where user_id in ${admin(userIds)}`
    await admin`delete from users where id in ${admin(userIds)}`
  }
  await admin`delete from competency_assessments where competency_id = ${compId}`
  await admin`delete from competencies where id = ${compId}`
  await admin`delete from positions where id = ${posId}`
  if (extraPos.length) await admin`delete from positions where id in ${admin(extraPos)}`
  await admin`update locations set manager_id = null where id = ${lazarevaId}`
  await admin.end()
})

const ctx = (actorId = adminId) => ({ tenantId, actorId })

async function makeForm() {
  const g = await as.upsertGroup(ctx(), { name: `Сервіс ${Date.now()}`, weight: 1 })
  groupIds.push(g!.id)
  const c1 = await as.upsertCriterion(ctx(), { groupId: g!.id, text: 'Вітається з гостем', competencyId: compId })
  const c2 = await as.upsertCriterion(ctx(), { groupId: g!.id, text: 'Пропонує доповнення', weight: 2 })
  // Норма 3 у первого критерия: оценка ниже нормы требует комментария (docs/20 §13.2, §14.2)
  const r = await as.saveForm(ctx(), { title: `Анкета ${Date.now()}`, kind: 'by_criteria', scaleId, allowCommentGroups: false, commentGroupsRequired: false, commentWhenAboveNorm: false, commentWhenBelowNorm: true, commentWhenEqual: false, zeroMeansNoGrade: false, tags: [], isActive: true, items: [{ criterionId: c1!.id, norm: 3 }, { criterionId: c2!.id, norm: 3 }] })
  if (!r.ok) throw new Error(r.code)
  formIds.push(r.form.id)
  return { form: r.form, c1: c1!, c2: c2! }
}

describe('этап 8: процедура оценки (docs/20 §13)', () => {
  it('цикл на 20 человек: назначение self/manager/peer, заполнение, подсчёт, завершение → оценка компетенции', async () => {
    const people: string[] = []
    for (let i = 0; i < 20; i++) people.push(await makePerson(`Оцінюваний ${i}`))
    const { form, c1, c2 } = await makeForm()
    const cycle = await as.createCycle(ctx(), {
      title: 'Оцінка бариста Q4', formId: form.id, periodFrom: '2026-07-01', periodTo: '2026-09-30', startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      subjects: { rules: [{ type: 'position', ids: [posId] }], match: 'any' }, raterKinds: ['self', 'manager', 'peer'], peersCount: 2, minRatersToShow: 3,
    })
    cycleIds.push(cycle.id)
    const started = await as.startCycle(ctx(), cycle.id)
    expect(started).toMatchObject({ ok: true, subjects: 20 })
    if (!started.ok) return
    // self 20 + manager 20 + peer ≤ 40, никто не оценивает больше 5 коллег
    const [load] = await admin`select max(c) as m from (select rater_user_id, count(*) c from assessment_tasks where cycle_id = ${cycle.id} and rater_kind = 'peer' group by 1) x`
    expect(Number(load!.m)).toBeLessThanOrEqual(5)
    expect(started.tasks).toBeGreaterThanOrEqual(40)

    // Первый человек: self ставит 5/5, руководитель 3/4, коллеги — по 4/4
    const subject = people[0]!
    const tasks = await admin`select id, rater_user_id, rater_kind from assessment_tasks where cycle_id = ${cycle.id} and subject_user_id = ${subject}`
    for (const t of tasks) {
      const rater = t.rater_user_id as string
      const v = t.rater_kind === 'self' ? [5, 5] : t.rater_kind === 'manager' ? [3, 4] : [4, 4]
      await as.saveAnswers(ctx(rater), t.id as string, [{ criterionId: c1.id, value: v[0]! }, { criterionId: c2.id, value: v[1]! }])
      expect((await as.submitTask(ctx(rater), t.id as string)).ok).toBe(true)
    }
    // Взвешенное среднее руководителя: (3×1 + 4×2)/3 = 3.67
    const asMgr = await as.resultsFor(ctx(), subject, cycle.id, { asManager: true })
    expect(asMgr!.groups[0]!.byKind.manager!.avg).toBe(3.67)
    expect(asMgr!.groups[0]!.byKind.self!.avg).toBe(5)
    expect(asMgr!.gaps[0]!.selfVsManager).toBe(1.33)

    const fin = await as.finishCycle(ctx(), cycle.id)
    expect(fin.ok).toBe(true)
    // §13.6: критерий с компетенцией → оценка компетенции source=assessment; уровень по оценке руководителя 3/5 → 2
    const [ca] = await admin`select level, source from competency_assessments where user_id = ${subject} and competency_id = ${compId} and source = 'assessment'`
    expect(ca).toMatchObject({ level: 2, source: 'assessment' })
    // Незаполненные задачи истекли
    const [exp] = await admin`select count(*)::int as c from assessment_tasks where cycle_id = ${cycle.id} and status = 'expired'`
    expect(exp!.c).toBeGreaterThan(0)
  })

  it('§13.1: при min_raters_to_show=3 и двух коллегах блок коллег человеку не показывается', async () => {
    const pos2 = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Касир-оц-${Date.now()}`}, 'cashier-as') returning id`)[0]!.id as string
    extraPos.push(pos2)
    const s = await makePerson('Анонімність', pos2)
    const p1 = await makePerson('Колега 1', pos2)
    const p2 = await makePerson('Колега 2', pos2)
    const { form, c1, c2 } = await makeForm()
    const cycle = await as.createCycle(ctx(), { title: 'Анонімний', formId: form.id, periodFrom: '2026-07-01', periodTo: '2026-09-30', startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString(), subjects: { rules: [{ type: 'user', ids: [s] }], match: 'any' }, raterKinds: ['self', 'peer'], peersCount: 2, minRatersToShow: 3 })
    cycleIds.push(cycle.id)
    await as.startCycle(ctx(), cycle.id)
    const tasks = await admin`select id, rater_user_id, rater_kind from assessment_tasks where cycle_id = ${cycle.id}`
    expect(tasks.filter(t => t.rater_kind === 'peer').length).toBe(2)
    expect(tasks.filter(t => t.rater_kind === 'peer').map(t => t.rater_user_id).sort()).toEqual([p1, p2].sort())
    for (const t of tasks) {
      await as.saveAnswers(ctx(t.rater_user_id as string), t.id as string, [{ criterionId: c1.id, value: 4, comment: 'Молодець' }, { criterionId: c2.id, value: 4 }])
      await as.submitTask(ctx(t.rater_user_id as string), t.id as string)
    }
    const mine = await as.resultsFor(ctx(s), s, cycle.id, { asManager: false })
    expect(mine!.hiddenKinds).toEqual(['peer'])
    expect(mine!.groups[0]!.byKind.peer).toBeUndefined()
    expect(mine!.comments.every(c => c.kind === 'self')).toBe(true)
    // Руководитель видит всё
    const mgr = await as.resultsFor(ctx(), s, cycle.id, { asManager: true })
    expect(mgr!.groups[0]!.byKind.peer!.avg).toBe(4)
  })

  it('§13.2: оценка 2 при requires_comment_below=3 без комментария блокирует отправку; отказ коллеги назначает следующего', async () => {
    const pos3 = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Кухар-оц-${Date.now()}`}, 'cook-as') returning id`)[0]!.id as string
    extraPos.push(pos3)
    const s = await makePerson('Поріг', pos3)
    const rater = await makePerson('Оцінювач', pos3)
    await makePerson('Резерв', pos3)
    const { form, c1, c2 } = await makeForm()
    const cycle = await as.createCycle(ctx(), { title: 'Поріг', formId: form.id, periodFrom: '2026-07-01', periodTo: '2026-09-30', startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString(), subjects: { rules: [{ type: 'user', ids: [s] }], match: 'any' }, raterKinds: ['peer'], peersCount: 1 })
    cycleIds.push(cycle.id)
    await as.startCycle(ctx(), cycle.id)
    const [t] = await admin`select id, rater_user_id from assessment_tasks where cycle_id = ${cycle.id}`
    const r = t!.rater_user_id as string
    await as.saveAnswers(ctx(r), t!.id as string, [{ criterionId: c1.id, value: 2 }, { criterionId: c2.id, value: 4 }])
    expect(await as.submitTask(ctx(r), t!.id as string)).toMatchObject({ ok: false, code: 'comment_required', criterionIds: [c1.id] })
    await as.saveAnswers(ctx(r), t!.id as string, [{ criterionId: c1.id, value: 2, comment: 'Не вітається, коли черга' }])
    expect((await as.submitTask(ctx(r), t!.id as string)).ok).toBe(true)

    // Отказ: второй цикл, коллега отказывается → назначен другой
    const cycle2 = await as.createCycle(ctx(), { title: 'Відмова', formId: form.id, periodFrom: '2026-07-01', periodTo: '2026-09-30', startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString(), subjects: { rules: [{ type: 'user', ids: [s] }], match: 'any' }, raterKinds: ['peer'], peersCount: 1 })
    cycleIds.push(cycle2.id)
    await as.startCycle(ctx(), cycle2.id)
    const [t2] = await admin`select id, rater_user_id from assessment_tasks where cycle_id = ${cycle2.id}`
    const d = await as.declineTask(ctx(t2!.rater_user_id as string), t2!.id as string, 'Не працював з цією людиною')
    expect(d?.replacement).toBeTruthy()
    expect(d?.replacement).not.toBe(t2!.rater_user_id)
    void rater
  })
})

describe('этап 8: чек-листы (docs/20 §13.3–13.5)', () => {
  it('критический провал обнуляет результат; без плана действий завершить нельзя; офлайн-время сохраняется', async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ id: `i${i}`, group: i < 10 ? 'Зал' : 'Кухня', text: `Пункт ${i}`, weight: 1, isCritical: i === 0 }))
    const cr = await cl.upsertChecklist(ctx(), { title: `Відкриття зміни ${Date.now()}`, kind: 'observation', scaleId, items, scoring: 'percent', passScore: 80, criticalFailRule: 'any_critical_fails_all', whoCanRun: { roles: ['manager'] }, subjectKind: 'location', frequency: { timesPerWeek: 2 }, allowSkip: false, allowItemComment: true, itemCommentRequired: false, tags: [] })
    if (!cr.ok) throw new Error(cr.code)
    const c = cr.checklist
    checklistIds.push(c.id)
    const startedAt = new Date(Date.now() - 3600_000).toISOString() // заполнялся час назад офлайн
    const run = await cl.startRun(ctx(), c.id, { locationId: lazarevaId, startedAt, device: 'Pixel 7' })
    expect(run).toBeTruthy()
    // Все 19 остальных — 5, критический — 1
    const answers = items.map(i => ({ itemId: i.id, value: i.id === 'i0' ? 1 : 5 }))
    expect(await cl.finishRun(ctx(), run!.id, { answers: answers.slice(0, 10) })).toMatchObject({ ok: false, code: 'incomplete' })
    // §13.3 + §13.4: критический провал → не пройдено → нужен план действий
    expect(await cl.finishRun(ctx(), run!.id, { answers })).toMatchObject({ ok: false, code: 'action_plan_required' })
    const finishedAt = new Date(Date.now() - 1800_000).toISOString()
    const r = await cl.finishRun(ctx(), run!.id, { answers, actionPlan: [{ id: 'a1', text: 'Замінити табличку', responsibleId: adminId, dueAt: '2026-12-31', status: 'open' }], startedAt, finishedAt })
    expect(r).toMatchObject({ ok: true, score: { score: 0, passed: false, criticalFailed: ['i0'] } })
    const [row] = await admin`select started_at, finished_at, score, passed from checklist_runs where id = ${run!.id}`
    expect(new Date(row!.started_at as string).toISOString()).toBe(startedAt)
    expect(new Date(row!.finished_at as string).toISOString()).toBe(finishedAt)

    // Без критического: доля пункта (v − 1)/4 — 19×1 + 1×0.5 из 20 → 97.5% пройдено (docs/20 §14.3: частка від суми ваг)
    const run2 = await cl.startRun(ctx(), c.id, { locationId: lazarevaId })
    const ok = await cl.finishRun(ctx(), run2!.id, { answers: items.map(i => ({ itemId: i.id, value: i.id === 'i5' ? 3 : 5 })) })
    expect(ok).toMatchObject({ ok: true, score: { score: 97.5, points: 19.5, maxPoints: 20, passed: true, criticalFailed: [] } })

    // Отчёт и дисциплина
    const rep = await cl.checklistReport(ctx(), { checklistId: c.id })
    expect(rep.runs.length).toBe(2)
    expect(rep.topFailed.some(t => String(t.text) === 'Пункт 0')).toBe(true)
    const disc = await cl.disciplineReport(ctx())
    expect(disc.find(d => d.location_id === lazarevaId && d.checklist === c.title)?.done).toBe(2)

    // План действий: просрочка сканером
    await admin`update checklist_runs set action_plan = '[{"id":"a1","text":"Замінити табличку","responsibleId":"${admin.unsafe(adminId)}","dueAt":"2026-01-01","status":"open"}]'::jsonb where id = ${run!.id}`
    expect(await cl.actionDueScan(tenantId)).toBe(1)
    const after = await cl.getRun(ctx(), run!.id)
    expect((after!.actionPlan as { status: string }[])[0]!.status).toBe('overdue')
    const done = await cl.updateAction(ctx(), run!.id, 'a1', { status: 'done' })
    expect(done?.status).toBe('done')
  })

  it('фото обязательно там, где requires_photo', async () => {
    const cr = await cl.upsertChecklist(ctx(), { title: `Фото ${Date.now()}`, kind: 'audit', scaleId, items: [{ id: 'p', text: 'Вітрина', weight: 1, requiresPhoto: true }], scoring: 'pass_fail', passScore: 100, criticalFailRule: 'none', whoCanRun: { roles: ['manager'] }, subjectKind: 'location', allowSkip: false, allowItemComment: true, itemCommentRequired: false, tags: [] })
    if (!cr.ok) throw new Error(cr.code)
    const c = cr.checklist
    checklistIds.push(c.id)
    const run = await cl.startRun(ctx(), c.id, { locationId: lazarevaId })
    expect(await cl.finishRun(ctx(), run!.id, { answers: [{ itemId: 'p', value: 5 }] })).toMatchObject({ ok: false, code: 'photo_required', itemIds: ['p'] })
    expect(await cl.finishRun(ctx(), run!.id, { answers: [{ itemId: 'p', value: 5, photoMediaIds: [crypto.randomUUID()] }] })).toMatchObject({ ok: true })
  })

  it('Б.1: подпись проверяемого обязательна при require_signature', async () => {
    const cr = await cl.upsertChecklist(ctx(), { title: `Підпис ${Date.now()}`, kind: 'observation', scaleId, items: [{ id: 's', text: 'Форма', weight: 1 }], scoring: 'percent', passScore: 50, criticalFailRule: 'none', whoCanRun: { roles: ['manager'] }, subjectKind: 'user', requireSignature: true, allowSkip: false, allowItemComment: true, itemCommentRequired: false, tags: [] })
    if (!cr.ok) throw new Error(cr.code)
    const c = cr.checklist
    checklistIds.push(c.id)
    const run = await cl.startRun(ctx(), c.id, { locationId: lazarevaId })
    expect(await cl.finishRun(ctx(), run!.id, { answers: [{ itemId: 's', value: 5 }] })).toMatchObject({ ok: false, code: 'signature_required' })
    const [m] = await admin`insert into media_assets (tenant_id, key, original_name, kind, mime, bytes, status, uploaded_by) values (${tenantId}, ${`sig-${Date.now()}.png`}, 'signature.png', 'image', 'image/png', 100, 'ready', ${adminId}) returning id`
    try {
      expect(await cl.finishRun(ctx(), run!.id, { answers: [{ itemId: 's', value: 5 }], signatureMediaId: m!.id as string })).toMatchObject({ ok: true })
      const r = await cl.getRun(ctx(), run!.id)
      expect(r!.signatureMediaId).toBe(m!.id)
    }
    finally { await admin`delete from checklist_runs where id = ${run!.id}`; await admin`delete from media_assets where id = ${m!.id}` }
  })

  it('Б.2: тайный покупатель — волна, одноразовая ссылка без входа, результат скрыт до публикации, отчёт по волнам', async () => {
    const my = await import('../../server/services/mystery')
    const cr = await cl.upsertChecklist(ctx(), { title: `Таємний ${Date.now()}`, kind: 'mystery', scaleId, items: [{ id: 'a', text: 'Привітання', weight: 1 }, { id: 'b', text: 'Чистота', weight: 1 }], scoring: 'percent', passScore: 80, criticalFailRule: 'none', whoCanRun: { roles: ['admin'] }, subjectKind: 'location', allowSkip: false, allowItemComment: true, itemCommentRequired: false, tags: [] })
    if (!cr.ok) throw new Error(cr.code)
    const c = cr.checklist
    checklistIds.push(c.id)
    expect(await my.createWave(ctx(), { checklistId: checklistIds[0]!, title: 'Не той тип', startsAt: '2026-09-01', endsAt: '2026-09-30' })).toBeNull()
    const w = await my.createWave(ctx(), { checklistId: c.id, title: `Хвиля ${Date.now()}`, startsAt: '2026-09-01', endsAt: '2026-09-30' })
    expect(w!.status).toBe('active')
    const link = await my.createLink(ctx(), { waveId: w!.id, locationId: lazarevaId })
    expect(link!.token.length).toBeGreaterThan(20)
    // Форма без входа: чек-лист и точка, без людей
    const form = await my.publicForm(link!.token)
    expect(form.ok).toBe(true)
    if (form.ok) expect(form.form.checklist.items.length).toBe(2)
    expect(await my.publicSubmit(link!.token, { answers: [{ itemId: 'a', value: 5 }] })).toMatchObject({ ok: false, code: 'incomplete' })
    const sub = await my.publicSubmit(link!.token, { answers: [{ itemId: 'a', value: 5 }, { itemId: 'b', value: 4 }] })
    expect(sub).toMatchObject({ ok: true, score: 87.5, passed: true })
    // Одноразовость
    expect(await my.publicForm(link!.token)).toMatchObject({ ok: false, code: 'used' })
    expect(await my.publicForm('nope')).toMatchObject({ ok: false, code: 'not_found' })
    const [run] = await admin`select id, is_external, wave_id, observer_id from checklist_runs where wave_id = ${w!.id}`
    expect(run).toMatchObject({ is_external: true, observer_id: adminId })
    // До публикации — только report.tenant; руководитель точки не видит
    expect(await cl.getRun(ctx(), run!.id as string)).toBeNull()
    expect((await cl.checklistReport(ctx(), { checklistId: c.id })).runs.length).toBe(0)
    expect((await cl.checklistReport(ctx(), { checklistId: c.id, canSeeUnpublished: true })).runs.length).toBe(1)
    expect((await my.mysteryReport(ctx(), { canSeeUnpublished: false })).waves.some(x => x.id === w!.id)).toBe(false)
    await my.setWaveStatus(ctx(), w!.id, 'published')
    expect(await cl.getRun(ctx(), run!.id as string)).not.toBeNull()
    const rep = await my.mysteryReport(ctx(), { canSeeUnpublished: false })
    expect(rep.waves.some(x => x.id === w!.id)).toBe(true)
    expect(rep.cells[`${w!.id}:${lazarevaId}`]).toMatchObject({ avg: 87.5, runs: 1, passed: 1 })
    await admin`delete from mystery_links where wave_id = ${w!.id}`
    await admin`delete from checklist_runs where wave_id = ${w!.id}`
    await admin`delete from mystery_waves where id = ${w!.id}`
  })
})
