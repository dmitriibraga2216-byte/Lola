import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Решения владельца 01.10.2026 (`docs/v2/44` Р-AI2.10, Р-BT.3; ветка `owner-decisions-ai-track`).
 *
 * 1. **ИИ-критерии сценария** (`30` §6.2, §10): `POST /interview-scenarios/:id/criteria/generate`
 *    — модель предлагает, строк `interview_criteria` не появляется, пока человек не сохранит
 *    каждый (`source = 'ai_suggested'`, инвариант 18); вызов — через шлюз, строка `ai_calls`
 *    с `ref_kind = 'interview_scenario'`, одна операция `ai_generate_ops`.
 * 2. **«Згенерувати трек»** (`35` §7.1, §7.7 п. 4, к. 4): черновик курса из опубликованных
 *    модулей библиотеки тенанта, без назначений; `ref_kind = 'course'`. К. 4 буквально:
 *    **дано** `ai_status = 'expired'` при `status = 'active'`, **тоді** «Згенерувати трек»
 *    недоступна — курса нет, операция не списана; прохождение треков работает.
 *
 * Провайдер — заглушка платформы (детерминированный ответ) и фейковый HTTP (`setAiHttp`):
 * сеть не нужна.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'
process.env.SESSION_SECRET ??= 'test-session-secret'

const { setAiHttp } = await import('../../server/services/ai/drivers')
const { createProvider } = await import('../../server/services/ai/providers')
const { currentUsage } = await import('../../server/services/usageCounters')
const { invalidateLimits } = await import('../../server/services/tenantLimits')
const { createScenario, updateScenario, addCriterion, listCriteria } = await import('../../server/services/interview/scenarios')
const { generateScenarioCriteria } = await import('../../server/services/interview/criteriaAi')
const { generateTrack } = await import('../../server/services/trackAi')
const lib = await import('../../server/services/library')
const { setEmbeddingProvider, stubEmbeddingProvider } = await import('../../server/services/embeddings')
const { interviewCriteriaGenerateSchema } = await import('../../shared/schemas/interview')
const { trackGenerateSchema } = await import('../../shared/schemas/content')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const MARK = 'OD-AI'
const P = 'od-ai-'
let tenantId: string
let otherTenantId: string
let adminId: string
let seq = 0
const banks: string[] = []
const quizzesMade: string[] = []
const modulesMade: string[] = []

const hr = () => ({ tenantId, actorId: adminId })
const libActor = () => ({ tenantId, actorId: adminId, manage: true, publish: true, use: true, courseEdit: true, programManage: true })
const text = (id: string, html: string) => ({ id, type: 'text' as const, html })

async function setLimits(v: { ai_generate_ops?: number | null, ai_status?: string, status?: string }) {
  await admin`insert into tenant_limits (tenant_id) values (${tenantId}) on conflict (tenant_id) do nothing`
  if ('ai_generate_ops' in v) await admin`update tenant_limits set ai_generate_ops = ${v.ai_generate_ops ?? null} where tenant_id = ${tenantId}`
  if (v.ai_status) await admin`update tenant_limits set ai_status = ${v.ai_status} where tenant_id = ${tenantId}`
  if (v.status) await admin`update tenant_limits set status = ${v.status} where tenant_id = ${tenantId}`
  invalidateLimits(tenantId)
}

async function resetAxis() {
  await admin`delete from usage_events where tenant_id = ${tenantId} and axis = 'ai_generate_ops'`
  await admin`delete from usage_counters where tenant_id = ${tenantId} and axis = 'ai_generate_ops'`
  await admin`delete from limit_notices where tenant_id = ${tenantId} and axis = 'ai_generate_ops'`
  await admin`delete from notifications where tenant_id = ${tenantId} and code in ('limit_exceeded', 'limit_warning')`
  await admin`delete from ai_calls where tenant_id = ${tenantId} and prompt_key in ('interview.criteria', 'track.draft')`
}

const used = () => currentUsage(tenantId, 'ai_generate_ops')
const callsOf = (key: string) => admin`select * from ai_calls where tenant_id = ${tenantId} and prompt_key = ${key} order by id`

/** Тест вида `interview` из двух вопросов «розгорнута відповідь». */
async function makeQuiz(): Promise<string> {
  const [bank] = await admin`insert into question_banks (tenant_id, name) values (${tenantId}, ${`${MARK} банк ${++seq}`}) returning id`
  banks.push(bank!.id as string)
  const [quiz] = await admin`
    insert into quizzes (tenant_id, title, kind, status, selection_mode, question_count)
    values (${tenantId}, ${`${MARK} співбесіда ${seq}`}, 'interview', 'published', 'fixed', 2) returning id`
  quizzesMade.push(quiz!.id as string)
  for (let i = 1; i <= 2; i++) {
    const [q] = await admin`
      insert into questions (tenant_id, bank_id, kind, stem, answer)
      values (${tenantId}, ${bank!.id}, 'free', ${admin.json([{ type: 'text', html: `<p>Питання ${i}: як ви зустрінете гостя?</p>` }])}, ${admin.json({ criteria: ['гість'], reference: 'еталон' })})
      returning id`
    await admin`insert into quiz_questions (tenant_id, quiz_id, question_id, sort) values (${tenantId}, ${quiz!.id}, ${q!.id}, ${i})`
  }
  return quiz!.id as string
}

async function draftScenario(): Promise<string> {
  const c = await createScenario(hr(), {
    quizId: await makeQuiz(), name: `${MARK} бариста`, interviewerName: 'Лола',
    introText: 'Вітаю! Мене звати Лола. Я поставлю кілька запитань про ваш досвід.', outroText: 'Дякуємо! Відповіді надіслано рекрутеру.',
    answerModes: ['voice', 'text'], minAnswerSec: 5, maxAnswerSec: 180, thinkTimeSec: 15, silenceTimeoutSec: 45,
    retakeLimit: 2, recordVideo: false, transcribeLang: 'uk', minConfidence: 0.6, alternativePath: 'human_interview',
  })
  if (!c.ok) throw new Error(JSON.stringify(c))
  return c.scenario.id
}

async function publishedModule(title: string): Promise<string> {
  const created = await lib.createModule(libActor(), {
    title: `${P}${title}`, contentKind: 'article', tags: [], coauthorIds: [], language: 'uk', body: [text('b1', `<p>${title}</p>`)],
  })
  if (!created.ok) throw new Error(created.code)
  const v = await lib.publishVersion(libActor(), created.module.id, { changelog: 'Перша версія модуля', isHotfix: false, notify: false })
  if (!v.ok) throw new Error(v.code)
  modulesMade.push(created.module.id)
  return created.module.id
}

/** Фейковый OpenAI-совместимый провайдер роли `generate`, основной на время теста. */
async function fakeProvider(content: unknown) {
  const r = await createProvider(hr(), {
    code: `${P}net`, name: 'OD fake', purpose: 'generate', driver: 'openai_compatible',
    endpointUrl: 'https://api.example.test/v1', modelName: 'fake-model', params: {}, dataRegion: 'eu',
    providerRetention: 'none', maxLatencyMs: 5000, isActive: true, priority: 1,
  } as Parameters<typeof createProvider>[1])
  expect(r.ok, JSON.stringify(r)).toBe(true)
  setAiHttp(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
}

async function dropFakeProvider() {
  setAiHttp(null)
  await admin`delete from ai_providers where tenant_id = ${tenantId} and code like ${`${P}%`}`
}

async function myCourses() {
  return admin`select * from courses where tenant_id = ${tenantId} and title like ${`${MARK}%`} order by created_at`
}

async function cleanup() {
  const courses = (await myCourses()).map(c => c.id as string)
  if (courses.length) {
    await admin`delete from library_module_usages where tenant_id = ${tenantId} and container_id in ${admin(courses)}`
    await admin`delete from courses where id in ${admin(courses)}`
  }
  const mods = (await admin`select id from library_modules where tenant_id = ${tenantId} and title like ${`${P}%`}`).map(m => m.id as string)
  if (mods.length) {
    await admin`delete from library_module_usages where library_module_id in ${admin(mods)}`
    await admin`update library_modules set current_version_id = null, draft_lesson_id = null where id in ${admin(mods)}`
    await admin`update lessons set library_version_id = null where library_version_id in (select id from library_module_versions where library_module_id in ${admin(mods)})`
    await admin`delete from library_module_versions where library_module_id in ${admin(mods)}`
    await admin`delete from lessons where library_module_id in ${admin(mods)}`
    await admin`delete from library_modules where id in ${admin(mods)}`
  }
  await admin`delete from resources where tenant_id = ${tenantId} and title like ${`${P}%`}`
  await admin`delete from interview_scenarios where tenant_id = ${tenantId} and name like ${`${MARK}%`}`
  if (quizzesMade.length) {
    await admin`delete from quiz_questions where quiz_id in ${admin(quizzesMade)}`
    await admin`delete from quizzes where id in ${admin(quizzesMade)}`
  }
  if (banks.length) {
    await admin`delete from questions where bank_id in ${admin(banks)}`
    await admin`delete from question_banks where id in ${admin(banks)}`
  }
  await admin`delete from ai_calls where tenant_id = ${tenantId} and prompt_key in ('interview.criteria', 'track.draft')`
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  const [other] = await admin`insert into tenants (slug, name) values ('test-owner-decisions-ai', 'Тест рішень власника ШІ')
    on conflict (slug) do update set name = excluded.name returning id`
  otherTenantId = other!.id as string
  setEmbeddingProvider(stubEmbeddingProvider(768))
  await dropFakeProvider()
  await cleanup()
})

beforeEach(async () => {
  await setLimits({ ai_generate_ops: null, ai_status: 'active', status: 'active' })
  await resetAxis()
})

afterEach(async () => {
  await dropFakeProvider()
})

afterAll(async () => {
  setEmbeddingProvider(null)
  await cleanup()
  await resetAxis()
  await setLimits({ ai_generate_ops: null, ai_status: 'active', status: 'trial' })
  await admin`delete from tenants where id = ${otherTenantId}`
  await admin.end()
})

// ── 1. ИИ-критерии сценария ─────────────────────────────────────────────────────────────

describe('«Згенерувати критерії (ШІ)» (`30` §6.2, §10; `44` Р-AI2.10)', () => {
  it('черновик: предложения есть, строк interview_criteria нет; ai_calls ref_kind=interview_scenario, одна операция', async () => {
    const id = await draftScenario()
    const r = await generateScenarioCriteria(hr(), id, 4)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (!r.ok) return
    expect(r.criteria).toHaveLength(4)
    for (const c of r.criteria) {
      expect(c.name.length).toBeGreaterThanOrEqual(3)
      expect(c.description.length).toBeGreaterThanOrEqual(20)
      expect(c.isCritical).toBe(false) // «Критичний» — решение человека
    }
    // Инвариант 18: модель предложила — в сценарии ничего не появилось
    expect(await listCriteria(hr(), id)).toEqual([])
    const [call] = await callsOf('interview.criteria')
    expect(call).toMatchObject({ ref_kind: 'interview_scenario', ref_id: id, status: 'ok', purpose: 'generate', usage_axis: 'ai_generate_ops', billed: true })
    expect(await used()).toBe(1)
  })

  it('человек сохраняет предложение — критерий с source=ai_suggested; ручной — manual', async () => {
    const id = await draftScenario()
    const r = await generateScenarioCriteria(hr(), id, 2)
    if (!r.ok) throw new Error(r.code)
    const d = r.criteria[0]!
    const saved = await addCriterion(hr(), id, { name: `${d.name} (правка)`, description: d.description, weight: d.weight, scaleMax: d.scaleMax, isCritical: true, source: 'ai_suggested' })
    expect(saved.ok && saved.criterion.source).toBe('ai_suggested')
    const manual = await addCriterion(hr(), id, { name: 'Пунктуальність', description: 'Приходить вчасно і попереджає про запізнення заздалегідь', weight: 1, scaleMax: 5, isCritical: false })
    expect(manual.ok && manual.criterion.source).toBe('manual')
    // Повтор видит уже заведённые критерии и не предлагает их снова
    const again = await generateScenarioCriteria(hr(), id, 8)
    if (!again.ok) throw new Error(again.code)
    expect(again.criteria.map(c => c.name)).not.toContain('Пунктуальність')
    expect(await used()).toBe(2)
  })

  it('фейковый провайдер: невалидные строки отбрасываются, ответ без годных строк — failed без списания', async () => {
    const id = await draftScenario()
    await fakeProvider({ criteria: [
      { name: 'Гостинність', description: 'Зустрічає гостя привітно, пропонує допомогу першим', weight: 3 },
      { name: 'X', description: 'занадто коротко', weight: 1 },
    ] })
    const r = await generateScenarioCriteria(hr(), id, 5)
    expect(r.ok && r.criteria).toEqual([{ name: 'Гостинність', description: 'Зустрічає гостя привітно, пропонує допомогу першим', weight: 3, scaleMax: 5, isCritical: false }])
    const [call] = await callsOf('interview.criteria')
    expect(call).toMatchObject({ ref_kind: 'interview_scenario', model_name: 'fake-model', status: 'ok' })

    await dropFakeProvider()
    await fakeProvider({ criteria: [{ name: 'Y', description: 'коротко', weight: 1 }] })
    const bad = await generateScenarioCriteria(hr(), id, 5)
    expect(bad.ok).toBe(false)
    expect(await used()).toBe(1)
  })

  it('опубликованный сценарий — published; ИИ истёк — ai_unavailable; ось исчерпана — limit_exceeded; ничего не списано', async () => {
    const id = await draftScenario()
    await addCriterion(hr(), id, { name: 'Досвід', description: 'Має досвід роботи з гостями та говорить про нього конкретно', weight: 1, scaleMax: 5, isCritical: false })
    const pub = await updateScenario(hr(), id, { status: 'published' })
    expect(pub.ok, JSON.stringify(pub)).toBe(true)
    expect(await generateScenarioCriteria(hr(), id, 3)).toEqual({ ok: false, code: 'published' })

    const draft = await draftScenario()
    await setLimits({ ai_status: 'expired' })
    expect(await generateScenarioCriteria(hr(), draft, 3)).toEqual({ ok: false, code: 'ai_unavailable', reason: 'expired' })
    await setLimits({ ai_status: 'active', ai_generate_ops: 0 })
    expect(await generateScenarioCriteria(hr(), draft, 3)).toMatchObject({ ok: false, code: 'limit_exceeded', check: { axis: 'ai_generate_ops' } })
    expect(await used()).toBe(0)
  })

  it('чужой тенант — not_found (404), вызова модели нет', async () => {
    const id = await draftScenario()
    expect(await generateScenarioCriteria({ tenantId: otherTenantId, actorId: adminId }, id, 3)).toEqual({ ok: false, code: 'not_found' })
    expect(await callsOf('interview.criteria')).toHaveLength(0)
  })

  it('контракт {count}: по умолчанию 5, больше 8 — 422', () => {
    expect(interviewCriteriaGenerateSchema.parse({})).toEqual({ count: 5 })
    expect(interviewCriteriaGenerateSchema.safeParse({ count: 9 }).success).toBe(false)
  })
})

// ── 2. «Згенерувати трек» ──────────────────────────────────────────────────────────────

describe('«Згенерувати трек» (`35` к. 4; `44` Р-BT.3)', () => {
  let m1: string
  let m2: string
  let m3: string

  beforeAll(async () => {
    m1 = await publishedModule('Стандарти сервісу')
    m2 = await publishedModule('Робота з касою')
    m3 = await publishedModule('Безпека на кухні')
  })

  const goal = `${MARK} Онбординг бариста: сервіс і каса за перший тиждень`

  it('черновик курса из модулей библиотеки: draft, уроки — ссылки на модули, назначений нет; ai_calls ref_kind=course', async () => {
    const r = await generateTrack(libActor(), trackGenerateSchema.parse({ goal, libraryModuleIds: [m1, m2] }))
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (!r.ok) return
    expect(r).toMatchObject({ sections: 1, lessons: 2 })
    const [course] = await admin`select * from courses where id = ${r.courseId}`
    expect(course).toMatchObject({ status: 'draft', published_version_id: null, created_by: adminId })
    const [ver] = await admin`select * from course_versions where course_id = ${r.courseId}`
    expect(ver).toMatchObject({ version: 1, status: 'draft' })
    const lessonsRows = await admin`select l.title, l.library_version_id, l.item_type from lessons l join modules m on m.id = l.module_id where m.course_version_id = ${ver!.id} order by l.sort`
    expect(lessonsRows.map(l => l.title)).toEqual([`${P}Стандарти сервісу`, `${P}Робота з касою`])
    expect(lessonsRows.every(l => l.library_version_id && l.item_type === 'resource')).toBe(true)
    const usages = await admin`select library_module_id, holder_type, container_type from library_module_usages where container_id = ${r.courseId} and detached_at is null`
    expect(usages.map(u => u.library_module_id).sort()).toEqual([m1, m2].sort())
    expect(usages.every(u => u.holder_type === 'course_lesson' && u.container_type === 'course')).toBe(true)
    // Автоназначений нет: человек публикует и назначает сам
    expect(await admin`select id from assignments where tenant_id = ${tenantId} and subject_id = ${r.courseId}`).toHaveLength(0)
    const [call] = await callsOf('track.draft')
    expect(call).toMatchObject({ ref_kind: 'course', ref_id: r.courseId, status: 'ok', usage_axis: 'ai_generate_ops', billed: true })
    expect(await used()).toBe(1)
    const [audit] = await admin`select * from audit_log where tenant_id = ${tenantId} and action = 'course.ai_generated' and entity_id = ${r.courseId}`
    expect(audit).toBeTruthy()
  })

  it('к. 4: ai_status=expired при status=active — «Згенерувати трек» недоступна, курса нет, операция не списана; прохождение треков работает', async () => {
    await setLimits({ ai_status: 'expired', status: 'active' })
    const before = (await myCourses()).length
    const r = await generateTrack(libActor(), trackGenerateSchema.parse({ goal }))
    expect(r).toEqual({ ok: false, code: 'ai_unavailable', reason: 'expired' })
    expect((await myCourses()).length).toBe(before)
    expect(await used()).toBe(0)
    const [call] = (await callsOf('track.draft')).slice(-1)
    expect(call).toMatchObject({ status: 'refused', error_code: 'ai_unavailable', billed: false })
    // Ранее созданные курсы и их прохождение ИИ не трогает: опубликованный курс посева на месте
    const [published] = await admin`select id from courses where tenant_id = ${tenantId} and status = 'published' limit 1`
    expect(published).toBeTruthy()
  })

  it('ось ai_generate_ops исчерпана — limit_exceeded, курса нет', async () => {
    await setLimits({ ai_generate_ops: 0 })
    const before = (await myCourses()).length
    expect(await generateTrack(libActor(), trackGenerateSchema.parse({ goal }))).toMatchObject({ ok: false, code: 'limit_exceeded', check: { axis: 'ai_generate_ops' } })
    expect((await myCourses()).length).toBe(before)
  })

  it('этап без ai_generate (атестація) — stage_ai_forbidden, модель не вызывается', async () => {
    const [att] = await admin`select id from lifecycle_stages where tenant_id = ${tenantId} and code = 'attestation'`
    const n = (await callsOf('track.draft')).length
    expect(await generateTrack(libActor(), trackGenerateSchema.parse({ goal, lifecycleStageId: att!.id }))).toEqual({ ok: false, code: 'stage_ai_forbidden' })
    expect((await callsOf('track.draft')).length).toBe(n)

    const [onb] = await admin`select id from lifecycle_stages where tenant_id = ${tenantId} and code = 'onboarding' and is_enabled`
    if (onb) {
      const r = await generateTrack(libActor(), trackGenerateSchema.parse({ goal, lifecycleStageId: onb.id, libraryModuleIds: [m3] }))
      expect(r.ok, JSON.stringify(r)).toBe(true)
      if (r.ok) expect((await admin`select lifecycle_stage_id from courses where id = ${r.courseId}`)[0]!.lifecycle_stage_id).toBe(onb.id)
    }
  })

  it('фейковый провайдер: разделы, номера вне пула и повторы отбрасываются; план без годных номеров — откат без списания', async () => {
    await fakeProvider({
      title: `${MARK} Трек від моделі`, summary: 'Два розділи',
      sections: [{ title: 'Сервіс', modules: [1, 99] }, { title: 'Каса', modules: [2, 1] }, { title: 'Порожній', modules: [42] }],
    })
    const r = await generateTrack(libActor(), trackGenerateSchema.parse({ goal, libraryModuleIds: [m1, m2] }))
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (!r.ok) return
    expect(r).toMatchObject({ title: `${MARK} Трек від моделі`, sections: 2, lessons: 2 })

    await dropFakeProvider()
    await fakeProvider({ title: `${MARK} Порожній`, summary: '', sections: [{ title: 'Ніщо', modules: [77] }] })
    const before = (await myCourses()).length
    const usedBefore = await used()
    expect(await generateTrack(libActor(), trackGenerateSchema.parse({ goal, libraryModuleIds: [m1] }))).toEqual({ ok: false, code: 'empty_plan' })
    expect((await myCourses()).length).toBe(before)
    expect(await used()).toBe(usedBefore)
  })

  it('пул пуст (чужие или неопубликованные модули) — no_modules без вызова модели', async () => {
    const n = (await callsOf('track.draft')).length
    expect(await generateTrack({ ...libActor(), tenantId: otherTenantId }, trackGenerateSchema.parse({ goal }))).toEqual({ ok: false, code: 'no_modules' })
    expect((await callsOf('track.draft')).length).toBe(n)
  })
})
