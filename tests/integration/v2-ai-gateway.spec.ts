import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PromptDef } from '../../server/services/ai/prompts'

/**
 * PR-27 пакета `docs/v2` (`45-plan.md`): шлюз модели и учёт вызовов (`30-ai-interview.md`
 * §3.2, §7.12, §7.16, §7.18; `35-billing-limits.md` §7.1, §7.7, §12).
 *
 * Критерии приёмки, закреплённые за PR-27:
 * - **`30` §13 к. 7** — `ai_interview_ops` исчерпан: сессия не резервируется (альтернативный
 *   путь — `degradation = 'finish_started'`), счётчик не изменился, админу ушёл `limit_exceeded`
 *   с `axis = 'ai_interview_ops'` (`ai_ops_exhausted` сведён к нему решением `44` В-16);
 * - **`35` §13 к. 3** — `ai_review_ops` исчерпан: ИИ-сверка не делается (`degraded`), задание
 *   принято и стоит в очереди ручной проверки;
 * - **`35` §13 к. 4** — `ai_status = 'expired'` при действующем тарифе: генерация недоступна,
 *   прохождение и ручная проверка работают, ранее выданная ИИ-оценка видна в карточке.
 *
 * Плюс то, что PR-27 обещает постановкой: каждый вызов модели — строка `ai_calls` (генерация
 * вакансии, эмбеддинги библиотеки и базы знаний), списание одной транзакцией с результатом,
 * запасной профиль, таймаут, идемпотентность, `ai_provider_down`, уборка журнала.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'
process.env.SESSION_SECRET ??= 'test-session-secret'

const { callModel, reserveSessionOp, embedTexts, embedModelId } = await import('../../server/services/ai/gateway')
const { setAiHttp } = await import('../../server/services/ai/drivers')
const { createProvider, updateProvider, listProviders } = await import('../../server/services/ai/providers')
const { aiCallsCleanup, listAiCalls } = await import('../../server/services/ai/calls')
const { LIBRARY_EMBEDDING_PROMPT } = await import('../../server/services/ai/prompts')
const { currentUsage, currentWindow } = await import('../../server/services/usageCounters')
const { invalidateLimits } = await import('../../server/services/tenantLimits')
const { limitScan, activeNotices } = await import('../../server/services/limitNotices')
const { recordAudit } = await import('../../server/services/audit')
const { generateVacancyText } = await import('../../server/services/vacancyAi')
const { createVacancy, viewerOf } = await import('../../server/services/vacancies')
const { createWorkshop, submitWorkshop, claim, grade } = await import('../../server/services/workshops')
const { listScores, viewerOf: candidateViewerOf } = await import('../../server/services/candidates')
const { createArticle } = await import('../../server/services/knowledge')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const P = 'pr27-'
const TITLE = 'PR27 '
let tenantId: string
let otherTenantId: string
let adminId: string
let mentorId: string
let learnerId: string
let courseId: string
let locationId: string
const workshopIds: string[] = []
const articleIds: string[] = []
const scoreIds: string[] = []

const ctx = () => ({ tenantId, actorId: adminId })

// ── Промпты теста: по одному на роль, заглушка — эхо входа ───────────────────────────────

const echo = z.object({ echo: z.number() })
function testPrompt(key: string, purpose: PromptDef<{ n: number }, { echo: number }>['purpose']): PromptDef<{ n: number }, { echo: number }> {
  return {
    key: `pr27.test.${key}`, version: 'v1', purpose, cacheable: true,
    stub: input => ({ echo: input.n }),
    chat: input => [{ role: 'system', content: 'Echo' }, { role: 'user', content: JSON.stringify(input) }],
    parse: raw => echo.parse(raw),
  }
}
const GENERATE = testPrompt('generate', 'generate')
const REVIEW = testPrompt('review', 'review_hint')
const SCORE = testPrompt('score', 'interview_score')
const SUMMARY = testPrompt('summary', 'summary')

// ── Помощники ───────────────────────────────────────────────────────────────────────────

async function setLimits(v: { ai_generate_ops?: number | null, ai_review_ops?: number | null, ai_interview_ops?: number | null, ai_status?: string, status?: string }) {
  await admin`insert into tenant_limits (tenant_id) values (${tenantId}) on conflict (tenant_id) do nothing`
  if ('ai_generate_ops' in v) await admin`update tenant_limits set ai_generate_ops = ${v.ai_generate_ops ?? null} where tenant_id = ${tenantId}`
  if ('ai_review_ops' in v) await admin`update tenant_limits set ai_review_ops = ${v.ai_review_ops ?? null} where tenant_id = ${tenantId}`
  if ('ai_interview_ops' in v) await admin`update tenant_limits set ai_interview_ops = ${v.ai_interview_ops ?? null} where tenant_id = ${tenantId}`
  if (v.ai_status) await admin`update tenant_limits set ai_status = ${v.ai_status} where tenant_id = ${tenantId}`
  if (v.status) await admin`update tenant_limits set status = ${v.status} where tenant_id = ${tenantId}`
  invalidateLimits(tenantId)
}

async function resetAxes() {
  for (const axis of ['ai_generate_ops', 'ai_review_ops', 'ai_interview_ops']) {
    await admin`delete from usage_events where tenant_id = ${tenantId} and axis = ${axis}`
    await admin`delete from usage_counters where tenant_id = ${tenantId} and axis = ${axis}`
    await admin`delete from limit_notices where tenant_id = ${tenantId} and axis = ${axis}`
  }
  await admin`delete from notifications where tenant_id = ${tenantId} and (code in ('limit_exceeded', 'limit_warning', 'ai_provider_down'))`
}

/** Счётчик оси прямо в строке периода — «ось уже исчерпана», без подъёма предупреждения. */
async function exhaust(axis: string, used: number) {
  const w = await currentWindow(tenantId)
  await admin`insert into usage_counters (tenant_id, axis, period_start, period_end, used)
    values (${tenantId}, ${axis}, ${w.start}, ${w.end}, ${used})
    on conflict (tenant_id, axis, period_start) do update set used = ${used}`
}

async function callsOf(promptKey: string) {
  return admin`select * from ai_calls where tenant_id = ${tenantId} and prompt_key = ${promptKey} order by id`
}

async function dropTestProfiles() {
  await admin`update ai_providers set fallback_provider_id = null where tenant_id in ${admin([tenantId, otherTenantId])} and code like ${`${P}%`}`
  await admin`delete from tenant_secrets where tenant_id = ${tenantId} and provider = 'ai'`
  await admin`delete from ai_providers where tenant_id in ${admin([tenantId, otherTenantId])} and code like ${`${P}%`}`
}

/** Профиль с приоритетом выше платформенного — основной для роли на время теста. */
async function netProfile(code: string, over: Record<string, unknown> = {}) {
  const r = await createProvider(ctx(), {
    code: `${P}${code}`, name: `PR27 ${code}`, purpose: 'generate', driver: 'openai_compatible',
    endpointUrl: 'https://api.example.test/v1', modelName: 'net-model', params: {}, dataRegion: 'eu',
    providerRetention: 'none', maxLatencyMs: 5000, isActive: true, priority: 1, ...over,
  } as Parameters<typeof createProvider>[1])
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return r.ok ? r.provider : (null as never)
}

function httpReply(status: number, body: unknown, seen?: { url: string, auth: string | null }[]) {
  setAiHttp(async (url, init) => {
    seen?.push({ url: String(url), auth: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  })
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  const pick = async (phone: string) => (await admin`select id from users where tenant_id = ${tenantId} and phone = ${phone}`)[0]!.id as string
  adminId = await pick('+380661864742')
  mentorId = await pick('+380670000002')
  learnerId = await pick('+380670000003')
  courseId = (await admin`select id from courses where tenant_id = ${tenantId} and status = 'published' order by title limit 1`)[0]!.id as string
  locationId = (await admin`select id from locations where tenant_id = ${tenantId} order by name limit 1`)[0]!.id as string
  const [other] = await admin`insert into tenants (slug, name) values ('test-ai-27', 'Тест ШІ PR-27')
    on conflict (slug) do update set name = excluded.name returning id`
  otherTenantId = other!.id as string
  await dropTestProfiles()
  await resetAxes()
  await listProviders(ctx()) // профили платформы у тенанта из посева есть уже после ensureTenantDefaults
})

beforeEach(async () => {
  await setLimits({ ai_generate_ops: null, ai_review_ops: null, ai_interview_ops: null, ai_status: 'active', status: 'active' })
  await resetAxes()
})

afterEach(() => {
  setAiHttp(null)
  delete process.env.AI_PROVIDER_URL
  delete process.env.AI_PROVIDER_API_KEY
})

afterAll(async () => {
  await dropTestProfiles()
  await resetAxes()
  await admin`update ai_providers set is_active = true where tenant_id = ${tenantId} and code like 'platform-%'`
  await setLimits({ ai_generate_ops: null, ai_review_ops: null, ai_interview_ops: null, ai_status: 'active', status: 'trial' })
  await admin`delete from ai_calls where tenant_id = ${tenantId} and prompt_key like 'pr27.%'`
  if (scoreIds.length) await admin`delete from candidate_scores where id in ${admin(scoreIds)}`
  if (articleIds.length) {
    await admin`delete from knowledge_revisions where article_id in ${admin(articleIds)}`
    await admin`delete from knowledge_articles where id in ${admin(articleIds)}`
  }
  if (workshopIds.length) {
    await admin`delete from review_queue_items where task_type = 'workshop' and source_id in (select id from workshop_submissions where workshop_id in ${admin(workshopIds)})`
    await admin`delete from workshop_comments where submission_id in (select id from workshop_submissions where workshop_id in ${admin(workshopIds)})`
    await admin`delete from workshop_submissions where workshop_id in ${admin(workshopIds)}`
    await admin`delete from workshops where id in ${admin(workshopIds)}`
  }
  await admin`delete from vacancy_ai_generations where tenant_id = ${tenantId} and vacancy_id in (select id from vacancies where title like ${`${TITLE}%`})`
  await admin`delete from audit_log where tenant_id = ${tenantId} and entity_id in (select id from vacancies where title like ${`${TITLE}%`})`
  await admin`delete from vacancies where title like ${`${TITLE}%`}`
  await admin`delete from tenants where id = ${otherTenantId}`
  await admin.end()
})

// ── Журнал и списание ───────────────────────────────────────────────────────────────────

describe('каждый вызов — строка ai_calls; списание одной транзакцией с результатом (30 §7.16, 35 §12)', () => {
  it('успешный вызов заглушкой: журнал, одна операция оси и сохранённый результат', async () => {
    const before = await currentUsage(tenantId, 'ai_generate_ops')
    const refId = randomUUID()
    const r = await callModel(ctx(), GENERATE, { n: 7 }, {
      ref: { kind: 'vacancy_generation', id: refId },
      persist: tx => recordAudit(tx, { tenantId, actorId: adminId, action: 'pr27.persisted', entity: 'pr27', entityId: refId }),
    })
    expect(r).toMatchObject({ ok: true, output: { echo: 7 }, cached: false })
    expect(await currentUsage(tenantId, 'ai_generate_ops')).toBe(before + 1)

    const [call] = await callsOf(GENERATE.key)
    expect(call).toMatchObject({ status: 'ok', purpose: 'generate', usage_axis: 'ai_generate_ops', billed: true, model_name: 'stub-template-v1', ref_kind: 'vacancy_generation', ref_id: refId, try_no: 1 })
    expect(call!.input_digest).toMatch(/^[0-9a-f]{64}$/)
    expect(call!.output).toEqual({ echo: 7 })
    expect(call!.finished_at).not.toBeNull()
    const [platform] = await admin`select id from ai_providers where tenant_id = ${tenantId} and code = 'platform-generate'`
    expect(call!.provider_id).toBe(platform!.id)

    const events = await admin`select meta from usage_events where tenant_id = ${tenantId} and axis = 'ai_generate_ops'`
    expect(events.map(e => (e.meta as { aiCallId: number }).aiCallId)).toEqual([Number(call!.id)])
    expect((await admin`select count(*)::int as n from audit_log where action = 'pr27.persisted' and entity_id = ${refId}`)[0]!.n).toBe(1)
  })

  it('результат не сохранился — операция не списана, вызов помечен persist_failed', async () => {
    const before = await currentUsage(tenantId, 'ai_generate_ops')
    await expect(callModel(ctx(), GENERATE, { n: 8 }, {
      ref: { kind: 'vacancy_generation', id: randomUUID() },
      persist: async () => { throw new Error('сущность удалили, пока модель думала') },
    })).rejects.toThrow()
    expect(await currentUsage(tenantId, 'ai_generate_ops')).toBe(before)
    const calls = await callsOf(GENERATE.key)
    expect(calls.at(-1)).toMatchObject({ status: 'failed', error_code: 'persist_failed', billed: false })
    expect((await admin`select count(*)::int as n from usage_events where tenant_id = ${tenantId} and axis = 'ai_generate_ops'`)[0]!.n).toBe(0)
  })

  it('исчерпанная жёсткая ось: вызова нет, строка refused, счётчик тот же (29 §13 к. 10, 35 §7.1)', async () => {
    await setLimits({ ai_generate_ops: 1 })
    await exhaust('ai_generate_ops', 1)
    const r = await callModel(ctx(), GENERATE, { n: 9 }, { ref: { kind: 'vacancy_generation', id: randomUUID() } })
    expect(r).toMatchObject({ ok: false, status: 'refused', code: 'limit_exceeded', degradation: 'reject' })
    if (!r.ok) expect(r.check?.axis).toBe('ai_generate_ops')
    expect(await currentUsage(tenantId, 'ai_generate_ops')).toBe(1)
    expect((await callsOf(GENERATE.key)).at(-1)).toMatchObject({ status: 'refused', error_code: 'limit_exceeded', billed: false })
  })

  /**
   * `[fix-night-debts §3]` Тариф без ИИ вовсе (`ai_generate_ops = 0`) — не то же самое, что
   * ось никто не трогал: PR-27 (`#134`) отклонял такой вызов правильно (`checkLimit()` не
   * менялся), но `levelOf()` считал любой `limit <= 0` за `'ok'` — баннер оператора и
   * уведомление `limit_exceeded` не поднимались никогда, даже при реальном отказе.
   */
  it('лимит оси 0 с первой же попытки: вызов отклонён, и теперь баннер exceeded поднимается', async () => {
    await setLimits({ ai_generate_ops: 0 })
    expect(await currentUsage(tenantId, 'ai_generate_ops'), 'до попытки счётчик пуст').toBe(0)
    const r = await callModel(ctx(), GENERATE, { n: 22 }, { ref: { kind: 'vacancy_generation', id: randomUUID() } })
    expect(r).toMatchObject({ ok: false, status: 'refused', code: 'limit_exceeded', degradation: 'reject' })
    expect(await currentUsage(tenantId, 'ai_generate_ops'), 'отказ до учёта — счётчик не сдвинулся').toBe(0)

    const [notice] = await admin`select level from limit_notices where tenant_id = ${tenantId} and axis = 'ai_generate_ops' and resolved_at is null`
    expect(notice?.level, 'баннер не поднялся при лимите 0 — долг §3').toBe('exceeded')
    const sent = await admin`select payload from notifications where tenant_id = ${tenantId} and code = 'limit_exceeded'`
    expect(sent.some(n => (n.payload as { axis: string }).axis === 'ai_generate_ops'), 'адміну не пішло limit_exceeded').toBe(true)
  })

  it('лимит оси 0, но ось никто не трогал — баннер не мигает (ни сразу, ни при плановом обходе)', async () => {
    await setLimits({ ai_review_ops: 0 })
    // Смотрим только на свою ось: `activeNotices()` — общий список тенанта «Каппі» на весь файл
    // billing-тестов (`v2-billing-usage.spec.ts`), и параллельный воркер вполне может в этот
    // момент держать открытым баннер другой оси — это не имеет отношения к тому, что проверяет
    // этот тест. Немасштабированная проверка «весь список пуст» однажды уже словила такой
    // баннер и упала ложно (CI #136).
    const forAxis = async () => (await activeNotices(tenantId)).filter(n => n.axis === 'ai_review_ops')
    expect(await forAxis()).toEqual([])
    // Плановый ежечасный обход (`billing.limit_scan`) не должен сам по себе поднять баннер
    // неиспользуемой оси — только реальная попытка вызова умеет это (см. тест выше).
    await limitScan(tenantId)
    expect(await forAxis(), 'неиспользуемая ось замигала баннером').toEqual([])
  })

  it('повтор с тем же ключом и тем же входом отдаёт сохранённый выход и не тратит лимит (30 §7.18)', async () => {
    const refId = randomUUID()
    const first = await callModel(ctx(), GENERATE, { n: 11 }, { ref: { kind: 'vacancy_generation', id: refId } })
    const usedAfterFirst = await currentUsage(tenantId, 'ai_generate_ops')
    const again = await callModel(ctx(), GENERATE, { n: 11 }, { ref: { kind: 'vacancy_generation', id: refId } })
    expect(again).toMatchObject({ ok: true, cached: true, output: { echo: 11 } })
    if (first.ok && again.ok) expect(again.callId).toBe(first.callId)
    expect(await currentUsage(tenantId, 'ai_generate_ops')).toBe(usedAfterFirst)
    expect((await callsOf(GENERATE.key)).filter(c => c.ref_id === refId)).toHaveLength(1)
    // Другой номер попытки — уже новый вызов
    const retry = await callModel(ctx(), GENERATE, { n: 11 }, { ref: { kind: 'vacancy_generation', id: refId }, tryNo: 2 })
    expect(retry).toMatchObject({ ok: true, cached: false })
  })
})

// ── Деградация осей: три критерия приёмки ───────────────────────────────────────────────

describe('35 §13 к. 3: ai_review_ops исчерпан — задание принято и ждёт ручной проверки', () => {
  it('сверка деградирует без вызова, сдача стоит в очереди, ментор проверяет сам', async () => {
    await setLimits({ ai_review_ops: 2 })
    await exhaust('ai_review_ops', 2)
    const w = await createWorkshop({ tenantId, actorId: adminId }, {
      title: `${TITLE}Практикум з ручною перевіркою`, description: [{ id: 'b1', type: 'text', html: '<p>Опис</p>' }],
      submissionKinds: ['text'], minTextLength: 10, criteria: [{ text: 'Виконано за інструкцією' }], reviewerRule: 'any_mentor',
      slaHours: 24, allowRework: true, maxReworks: 1, status: 'published',
    })
    workshopIds.push(w.id)
    const sub = await submitWorkshop({ tenantId, actorId: learnerId }, w.id, { text: 'Зробив усе за чек-листом, фото додам' })
    expect(sub.ok, 'сдачу отклонили из-за оси ИИ').toBe(true)
    if (!sub.ok) return

    // Подсказка к этой сдаче — вызов роли review_hint; ось исчерпана — вызова нет, операция идёт вручную
    const hint = await callModel({ tenantId, actorId: null }, REVIEW, { n: 1 }, { ref: { kind: 'review_hint', id: sub.submissionId } })
    expect(hint).toMatchObject({ ok: false, status: 'degraded', code: 'limit_exceeded', degradation: 'manual_review' })
    expect(await currentUsage(tenantId, 'ai_review_ops')).toBe(2)
    expect((await callsOf(REVIEW.key)).at(-1)).toMatchObject({ status: 'degraded', usage_axis: 'ai_review_ops', billed: false })

    const [queued] = await admin`select status from review_queue_items where task_type = 'workshop' and source_id = ${sub.submissionId}`
    expect(queued?.status).toBe('waiting')
    expect((await claim({ tenantId, actorId: mentorId }, sub.submissionId)).ok).toBe(true)
    const [snap] = await admin`select criteria_snapshot from workshop_submissions where id = ${sub.submissionId}`
    const g = await grade({ tenantId, actorId: mentorId }, sub.submissionId, {
      decision: 'accepted', criteriaResults: [{ criterionId: (snap!.criteria_snapshot as { id: string }[])[0]!.id, passed: true }], comment: 'Добре',
    })
    expect(g.ok, 'ручная проверка не сработала при исчерпанной оси ИИ').toBe(true)
  })
})

describe('35 §13 к. 4: ИИ истёк при действующем тарифе', () => {
  let vacancyId: string

  beforeAll(async () => {
    const created = await createVacancy(ctx(), {
      title: `${TITLE}Кухар`, courseId, locationId, recruiterId: adminId, salaryCurrency: 'UAH', salaryVisible: false,
      publicApplyOtp: true, applyDailyCap: 200,
      assignmentTemplate: { dueMode: 'relative', dueDays: 7, isMandatory: true, params: {}, reminders: {}, notifyOnAssign: true },
    } as Parameters<typeof createVacancy>[1])
    vacancyId = created.id
  })

  it('генерация недоступна: 409 ai.unavailable по причине expired, операция не списана', async () => {
    await setLimits({ ai_status: 'expired' })
    const hr = viewerOf({ userId: adminId, tenantId, grants: [{ scopes: ['vacancy.view', 'vacancy.edit', 'vacancy.ai.use'], scopeType: 'tenant', scopeId: null }] })
    const r = await generateVacancyText(hr, vacancyId, { target: 'description', tone: null })
    expect(r).toEqual({ ok: false, code: 'ai_unavailable', reason: 'expired' })
    expect(await currentUsage(tenantId, 'ai_generate_ops')).toBe(0)
    const [gen] = await admin`select status, error_code, ops_charged from vacancy_ai_generations where vacancy_id = ${vacancyId} order by created_at desc limit 1`
    expect(gen).toMatchObject({ status: 'limited', error_code: 'ai_unavailable', ops_charged: 0 })
    const [call] = await admin`select status, error_code from ai_calls where ref_kind = 'vacancy_generation' and ref_id in (select id from vacancy_ai_generations where vacancy_id = ${vacancyId}) order by id desc limit 1`
    expect(call).toMatchObject({ status: 'refused', error_code: 'ai_unavailable' })
    const [text] = await admin`select description_html from vacancies where id = ${vacancyId}`
    expect(text!.description_html ?? '').not.toContain('Ми шукаємо')
  })

  it('ИИ-сверка и новое собеседование тоже выключены, а поиск (эмбеддинг вне тарифа) работает', async () => {
    await setLimits({ ai_status: 'expired' })
    expect(await callModel({ tenantId, actorId: null }, REVIEW, { n: 2 }, { ref: { kind: 'review_hint', id: randomUUID() } }))
      .toMatchObject({ ok: false, status: 'degraded', code: 'ai_unavailable', reason: 'expired' })
    expect(await reserveSessionOp(ctx(), 'ai_interview_ops', { kind: 'interview_session', id: randomUUID() }))
      .toEqual({ ok: false, code: 'ai_unavailable', reason: 'expired' })
    const e = await embedTexts(ctx(), { prompt: LIBRARY_EMBEDDING_PROMPT, texts: ['розведення хімії'], dims: 768, ref: { kind: 'search_query', id: null } })
    expect(e.ok).toBe(true)
  })

  it('прохождение и ручная проверка работают, ранее выданная ИИ-оценка видна в карточке', async () => {
    await setLimits({ ai_status: 'expired' })
    const w = await createWorkshop({ tenantId, actorId: adminId }, {
      title: `${TITLE}Практикум при вимкненому ШІ`, description: [{ id: 'b1', type: 'text', html: '<p>Опис</p>' }],
      submissionKinds: ['text'], minTextLength: 10, criteria: [{ text: 'Готово' }], reviewerRule: 'any_mentor',
      slaHours: 24, allowRework: false, maxReworks: 0, status: 'published',
    })
    workshopIds.push(w.id)
    const sub = await submitWorkshop({ tenantId, actorId: learnerId }, w.id, { text: 'Здаю роботу без ШІ-підказки' })
    expect(sub.ok).toBe(true)

    const [cand] = await admin`select id from users where tenant_id = ${tenantId} and kind = 'candidate' order by created_at limit 1`
    const [score] = await admin`insert into candidate_scores (tenant_id, candidate_id, kind, value_num, comment)
      values (${tenantId}, ${cand!.id}, 'ai', 72, 'PR27 оцінка до завершення підписки') returning id`
    scoreIds.push(score!.id as string)
    const hr = candidateViewerOf({ userId: adminId, tenantId, grants: [{ scopes: ['candidate.view'], scopeType: 'tenant', scopeId: null }] })
    const scores = await listScores(hr, cand!.id as string, { kind: 'ai' })
    expect(scores?.map(s => s.id)).toContain(score!.id)
  })
})

describe('30 §13 к. 7: ai_interview_ops исчерпан — сессия не стартует, счётчик цел, админу — limit_exceeded', () => {
  it('резерв сессии отклонён с «новые не запускаются», предупреждение ушло админу', async () => {
    await setLimits({ ai_interview_ops: 3 })
    await exhaust('ai_interview_ops', 3)
    const r = await reserveSessionOp(ctx(), 'ai_interview_ops', { kind: 'interview_session', id: randomUUID() })
    expect(r).toMatchObject({ ok: false, code: 'limit_exceeded', degradation: 'finish_started' })
    expect(await currentUsage(tenantId, 'ai_interview_ops')).toBe(3)
    expect((await admin`select count(*)::int as n from usage_events where tenant_id = ${tenantId} and axis = 'ai_interview_ops'`)[0]!.n).toBe(0)

    const sent = await admin`select user_id, payload from notifications where tenant_id = ${tenantId} and code = 'limit_exceeded'`
    const toAdmin = sent.filter(n => n.user_id === adminId && (n.payload as { axis: string }).axis === 'ai_interview_ops')
    expect(toAdmin, 'админу не ушёл limit_exceeded с axis=ai_interview_ops').toHaveLength(1)
    const [notice] = await admin`select level from limit_notices where tenant_id = ${tenantId} and axis = 'ai_interview_ops' and resolved_at is null`
    expect(notice?.level).toBe('exceeded')
  })

  it('начатая сессия доводится: вызовы внутри неё не списывают и не упираются в ось', async () => {
    await setLimits({ ai_interview_ops: 3 })
    await exhaust('ai_interview_ops', 3)
    const sessionId = randomUUID()
    const r = await callModel({ tenantId, actorId: null }, SCORE, { n: 3 }, { ref: { kind: 'interview_session', id: sessionId } })
    expect(r).toMatchObject({ ok: true, output: { echo: 3 } })
    expect(await currentUsage(tenantId, 'ai_interview_ops')).toBe(3)
    expect((await callsOf(SCORE.key)).at(-1)).toMatchObject({ status: 'ok', usage_axis: 'ai_interview_ops', billed: false })
  })

  it('при свободной оси сессия резервируется ровно один раз', async () => {
    await setLimits({ ai_interview_ops: 5 })
    const session = { kind: 'interview_session' as const, id: randomUUID() }
    expect(await reserveSessionOp(ctx(), 'ai_interview_ops', session)).toEqual({ ok: true, reserved: true })
    expect(await reserveSessionOp(ctx(), 'ai_interview_ops', session)).toEqual({ ok: true, reserved: false })
    expect(await currentUsage(tenantId, 'ai_interview_ops')).toBe(1)
    await expect(reserveSessionOp(ctx(), 'ai_generate_ops', session)).rejects.toThrow(/сессией/)
  })
})

// ── Профиль, запасной, таймаут, ключ платформы ──────────────────────────────────────────

describe('запасной профиль и отказ провайдера (30 §7.12, §8)', () => {
  afterEach(dropTestProfiles)

  it('основной упал — ответил запасной: две строки журнала, одна операция', async () => {
    const spare = await netProfile('spare', { driver: 'stub', endpointUrl: null, priority: 900, modelName: 'spare-stub' })
    await netProfile('primary', { fallbackProviderId: spare.id })
    httpReply(500, { error: 'overloaded' })
    const before = await currentUsage(tenantId, 'ai_generate_ops')
    const r = await callModel(ctx(), GENERATE, { n: 21 }, { ref: { kind: 'vacancy_generation', id: randomUUID() } })
    expect(r).toMatchObject({ ok: true, output: { echo: 21 } })
    if (r.ok) expect(r.model.modelName).toBe('spare-stub')
    const calls = (await callsOf(GENERATE.key)).slice(-2)
    expect(calls.map(c => [c.status, c.error_code, c.http_status, c.billed])).toEqual([['failed', 'http_error', 500, false], ['ok', null, null, true]])
    expect(await currentUsage(tenantId, 'ai_generate_ops')).toBe(before + 1)
  })

  it('таймаут основного — строка timeout, ответ запасного', async () => {
    const spare = await netProfile('spare-t', { driver: 'stub', endpointUrl: null, priority: 900 })
    await netProfile('slow', { fallbackProviderId: spare.id, maxLatencyMs: 1000 })
    setAiHttp(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })))
    }))
    const r = await callModel(ctx(), GENERATE, { n: 22 }, { ref: { kind: 'vacancy_generation', id: randomUUID() } })
    expect(r.ok).toBe(true)
    expect((await callsOf(GENERATE.key)).slice(-2).map(c => c.status)).toEqual(['timeout', 'ok'])
  })

  it('ни один профиль не ответил — provider_failed без списания; пять отказов подряд — ai_provider_down админу, один раз', async () => {
    const down = await netProfile('down')
    httpReply(503, { error: 'down' })
    const before = await currentUsage(tenantId, 'ai_generate_ops')
    for (let i = 0; i < 6; i++) {
      const r = await callModel(ctx(), GENERATE, { n: 30 + i }, { ref: { kind: 'vacancy_generation', id: randomUUID() } })
      expect(r).toMatchObject({ ok: false, status: 'failed', code: 'provider_failed', providerError: 'http_error' })
    }
    expect(await currentUsage(tenantId, 'ai_generate_ops')).toBe(before)
    const sent = await admin`select user_id, payload from notifications where tenant_id = ${tenantId} and code = 'ai_provider_down'`
    expect(sent.filter(n => n.user_id === adminId)).toHaveLength(1)
    expect((sent[0]!.payload as { provider: string }).provider).toBe(down.name)
  })

  it('ключ платформы уходит только на адрес платформы; чужому адресу — без авторизации', async () => {
    process.env.AI_PROVIDER_URL = 'https://platform.example.test/v1/'
    process.env.AI_PROVIDER_API_KEY = 'sk-platform-secret'
    const seen: { url: string, auth: string | null }[] = []
    httpReply(200, { choices: [{ message: { content: '{"echo": 5}' } }] }, seen)

    await netProfile('foreign', { endpointUrl: 'https://attacker.example.test/v1' })
    expect(await callModel(ctx(), GENERATE, { n: 5 }, { ref: { kind: 'vacancy_generation', id: randomUUID() } })).toMatchObject({ ok: true, output: { echo: 5 } })
    expect(seen.at(-1)).toEqual({ url: 'https://attacker.example.test/v1/chat/completions', auth: null })
    await dropTestProfiles()

    // Профиль на адресе платформы: адрес платформы вписывает оператор, поэтому здесь — прямо в БД
    const p = await netProfile('platform', { endpointUrl: 'https://api.example.test/v1' })
    await admin`update ai_providers set endpoint_url = 'https://platform.example.test/v1' where id = ${p.id}`
    await callModel(ctx(), GENERATE, { n: 6 }, { ref: { kind: 'vacancy_generation', id: randomUUID() } })
    expect(seen.at(-1)).toEqual({ url: 'https://platform.example.test/v1/chat/completions', auth: 'Bearer sk-platform-secret' })
  })

  it('свой ключ тенанта расшифровывается и уходит своему провайдеру', async () => {
    const seen: { url: string, auth: string | null }[] = []
    httpReply(200, { choices: [{ message: { content: '{"echo": 1}' } }] }, seen)
    await netProfile('own-key', { apiKey: 'sk-tenant-own-key' })
    await callModel(ctx(), GENERATE, { n: 1 }, { ref: { kind: 'vacancy_generation', id: randomUUID() } })
    expect(seen.at(-1)?.auth).toBe('Bearer sk-tenant-own-key')
  })

  it('у роли нет активного профиля — refused no_provider, модель не вызывалась', async () => {
    await admin`update ai_providers set is_active = false where tenant_id = ${tenantId} and purpose = 'summary'`
    const r = await callModel({ tenantId, actorId: null }, SUMMARY, { n: 1 }, { ref: { kind: 'summary', id: randomUUID() } })
    expect(r).toMatchObject({ ok: false, status: 'refused', code: 'no_provider' })
    expect((await callsOf(SUMMARY.key)).at(-1)).toMatchObject({ status: 'refused', error_code: 'no_provider', model_name: 'none', provider_id: null })
    await admin`update ai_providers set is_active = true where tenant_id = ${tenantId} and purpose = 'summary'`
  })
})

// ── Сведённые в шлюз вызовы: генерация вакансии и эмбеддинги ────────────────────────────

describe('генерация вакансии (PR-17) идёт через шлюз', () => {
  let vacancyId: string
  const hr = () => viewerOf({ userId: adminId, tenantId, grants: [{ scopes: ['vacancy.view', 'vacancy.edit', 'vacancy.ai.use'], scopeType: 'tenant', scopeId: null }] })

  beforeAll(async () => {
    const created = await createVacancy(ctx(), {
      title: `${TITLE}Бармен`, courseId, locationId, recruiterId: adminId, salaryCurrency: 'UAH', salaryVisible: false,
      publicApplyOtp: true, applyDailyCap: 200,
      assignmentTemplate: { dueMode: 'relative', dueDays: 7, isMandatory: true, params: {}, reminders: {}, notifyOnAssign: true },
    } as Parameters<typeof createVacancy>[1])
    vacancyId = created.id
  })
  afterEach(dropTestProfiles)

  it('генерация — строка ai_calls, связанная со строкой журнала генераций, и одна операция', async () => {
    const r = await generateVacancyText(hr(), vacancyId, { target: 'duties', tone: null })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const [call] = await admin`select * from ai_calls where ref_kind = 'vacancy_generation' and ref_id = ${r.generationId}`
    expect(call).toMatchObject({ prompt_key: 'vacancy.text', prompt_version: 'v1', status: 'ok', billed: true, usage_axis: 'ai_generate_ops', model_name: 'stub-template-v1' })
    const [gen] = await admin`select status, ops_charged, model from vacancy_ai_generations where id = ${r.generationId}`
    expect(gen).toMatchObject({ status: 'ok', ops_charged: 1, model: 'stub-template-v1' })
    const [ev] = await admin`select ref_id, meta from usage_events where tenant_id = ${tenantId} and axis = 'ai_generate_ops'`
    expect(ev).toMatchObject({ ref_id: r.generationId, meta: { aiCallId: Number(call!.id) } })
  })

  it('провайдер не ответил — генерация failed, текст не тронут, операция не списана', async () => {
    await netProfile('vac-down')
    httpReply(502, {})
    const [before] = await admin`select requirements_html from vacancies where id = ${vacancyId}`
    const r = await generateVacancyText(hr(), vacancyId, { target: 'requirements', tone: null })
    expect(r).toEqual({ ok: false, code: 'provider_failed', reason: 'http_error' })
    const [after] = await admin`select requirements_html from vacancies where id = ${vacancyId}`
    expect(after!.requirements_html).toEqual(before!.requirements_html)
    const [gen] = await admin`select status, ops_charged, error_code from vacancy_ai_generations where vacancy_id = ${vacancyId} order by created_at desc limit 1`
    expect(gen).toMatchObject({ status: 'failed', ops_charged: 0, error_code: 'http_error' })
    expect(await currentUsage(tenantId, 'ai_generate_ops')).toBe(0)
  })
})

describe('эмбеддинги (PR-25) идут через шлюз вне тарифа', () => {
  afterEach(dropTestProfiles)

  it('библиотека: строка ai_calls на запрос, без оси, метка модели прежняя', async () => {
    expect(await embedModelId(tenantId, 768)).toBe('stub:hash-v1:768')
    const r = await embedTexts(ctx(), { prompt: LIBRARY_EMBEDDING_PROMPT, texts: ['розведення хімії', 'графік змін'], dims: 768, ref: { kind: 'library_module', id: null } })
    expect(r).toMatchObject({ ok: true, model: 'stub:hash-v1:768' })
    if (r.ok) expect(r.vectors.map(v => v?.length)).toEqual([768, 768])
    const [call] = await admin`select * from ai_calls where id = ${r.ok ? r.callId : 0}`
    expect(call).toMatchObject({ purpose: 'embed', usage_axis: null, billed: false, status: 'ok', output: { count: 2, empty: 0 } })
  })

  it('база знаний: профиль-заглушка — вызова нет и вектора нет; настоящий профиль — вектор и строка журнала', async () => {
    const before = (await admin`select count(*)::int as n from ai_calls where tenant_id = ${tenantId} and prompt_key = 'knowledge.embedding'`)[0]!.n
    const a1 = await createArticle(ctx(), { title: `${TITLE}Стаття без вектора`, body: [{ id: 'b1', type: 'text', html: '<p>Розведення засобів 1:10</p>' }] })
    articleIds.push(a1.id)
    expect((await admin`select embedding is null as empty from knowledge_articles where id = ${a1.id}`)[0]!.empty).toBe(true)
    expect((await admin`select count(*)::int as n from ai_calls where tenant_id = ${tenantId} and prompt_key = 'knowledge.embedding'`)[0]!.n).toBe(before)

    await netProfile('embed', { purpose: 'embed', modelName: 'text-embedding-3-small' })
    httpReply(200, { data: [{ index: 0, embedding: Array.from({ length: 1536 }, (_, i) => (i % 7) / 7) }], usage: { prompt_tokens: 9 } })
    const a2 = await createArticle(ctx(), { title: `${TITLE}Стаття з вектором`, body: [{ id: 'b1', type: 'text', html: '<p>Розведення засобів 1:20</p>' }] })
    articleIds.push(a2.id)
    expect((await admin`select embedding is not null as has from knowledge_articles where id = ${a2.id}`)[0]!.has).toBe(true)
    const [call] = await admin`select * from ai_calls where tenant_id = ${tenantId} and prompt_key = 'knowledge.embedding' order by id desc limit 1`
    expect(call).toMatchObject({ ref_kind: 'knowledge_article', ref_id: a2.id, purpose: 'embed', usage_axis: null, billed: false, tokens_in: 9 })
  })
})

// ── Журнал: список, изоляция, уборка ────────────────────────────────────────────────────

describe('журнал ИИ-вызовов: курсор, фильтры, чужой тенант, уборка (30 §10, §11)', () => {
  it('страницы по курсору без потерь и дублей, фильтр по статусу, чужому тенанту журнал не виден', async () => {
    for (let i = 0; i < 3; i++) await callModel(ctx(), GENERATE, { n: 100 + i }, { ref: { kind: 'vacancy_generation', id: randomUUID() } })
    const page1 = await listAiCalls(ctx(), { purpose: 'generate', status: 'ok', limit: 2 })
    expect(page1.items).toHaveLength(2)
    expect(page1.nextCursor).not.toBeNull()
    const page2 = await listAiCalls(ctx(), { purpose: 'generate', status: 'ok', limit: 2, cursor: page1.nextCursor! })
    const ids = [...page1.items, ...page2.items].map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(page1.items.every(c => c.status === 'ok' && c.purpose === 'generate')).toBe(true)

    const [otherAdmin] = await admin`insert into users (tenant_id, kind, full_name, phone) values (${otherTenantId}, 'employee', 'Адмін чужого', '+380679927001')
      on conflict (tenant_id, phone) do update set full_name = excluded.full_name returning id`
    const foreign = await listAiCalls({ tenantId: otherTenantId, actorId: otherAdmin!.id as string }, { limit: 50 })
    expect(foreign.items).toEqual([])
    const seen = await withTenant(otherTenantId, null, tx => tx.execute(sql`select count(*)::int as n from ai_calls where tenant_id = ${tenantId}::uuid`))
    expect((seen as unknown as { n: number }[])[0]!.n).toBe(0)
  })

  it('ai.calls_cleanup: ссылка на вход старше 90 дней обнуляется, строка старше 400 дней удаляется', async () => {
    const digest = 'a'.repeat(64)
    const [old] = await admin`insert into ai_calls (tenant_id, purpose, prompt_key, prompt_version, model_name, ref_kind, input_digest, status, created_at)
      values (${tenantId}, 'generate', 'pr27.cleanup', 'v1', 'm', 'vacancy_generation', ${digest}, 'ok', now() - interval '401 days') returning id`
    const [mid] = await admin`insert into ai_calls (tenant_id, purpose, prompt_key, prompt_version, model_name, ref_kind, input_digest, input_ref, status, created_at)
      values (${tenantId}, 'generate', 'pr27.cleanup', 'v1', 'm', 'vacancy_generation', ${digest}, 't/x/ai/input.json', 'ok', now() - interval '91 days') returning id`
    const r = await aiCallsCleanup(tenantId)
    expect(r.rows).toBeGreaterThanOrEqual(1)
    expect(r.inputRefs).toBeGreaterThanOrEqual(1)
    expect(await admin`select id from ai_calls where id = ${old!.id}`).toHaveLength(0)
    expect((await admin`select input_ref from ai_calls where id = ${mid!.id}`)[0]!.input_ref).toBeNull()
    await admin`delete from ai_calls where prompt_key = 'pr27.cleanup'`
  })
})

describe('журнал неизменен в главном: вызов не пишет в сущности сам (инвариант 18)', () => {
  it('шлюз возвращает выход и ничего не меняет, пока вызывающий не сохранил результат', async () => {
    const refId = randomUUID()
    const auditBefore = (await admin`select count(*)::int as n from audit_log where tenant_id = ${tenantId}`)[0]!.n
    const r = await callModel(ctx(), SCORE, { n: 1 }, { ref: { kind: 'interview_session', id: refId } })
    expect(r.ok).toBe(true)
    expect((await admin`select count(*)::int as n from audit_log where tenant_id = ${tenantId}`)[0]!.n).toBe(auditBefore)
    // Профиль правится только сервисом профилей — шлюз его не трогает
    const p = await updateProvider(ctx(), (await admin`select id from ai_providers where tenant_id = ${tenantId} and code = 'platform-interview-score'`)[0]!.id as string, { priority: 100 })
    expect(p.ok).toBe(true)
  })
})
