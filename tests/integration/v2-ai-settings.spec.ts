import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

/**
 * Блок «ИИ» из «что осталось» (`docs/v2/46-progress.md`): переоценка собеседования
 * `POST /candidates/:id/interview/rescore` (`docs/v2/30` §10), выгрузка журнала вызовов и фильтр
 * стоимости (`30` §5.6), отчёты «Якість моделі», «Допомога перевіряючому», «Вартість ШІ»
 * (`30` §9.3–§9.5). Сервисный слой; коды и скоупы по HTTP — `v2-ai-http.spec.ts`.
 *
 * Инвариант 18: ни переоценка, ни отчёты ничего не решают о человеке — проверяется тем, что
 * состояние кандидата и колонка канбана после переоценки прежние, а прежняя оценка ИИ остаётся
 * в истории.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'
process.env.SESSION_SECRET ??= 'test-session-secret'

const { createScenario, updateScenario, addCriterion } = await import('../../server/services/interview/scenarios')
const { getEntry, decideConsent, startSession } = await import('../../server/services/interview/candidate')
const { answerTurn } = await import('../../server/services/interview/session')
const { scoreSession } = await import('../../server/services/interview/pipeline')
const { rescoreInterview, rescoreCharged } = await import('../../server/services/interview/rescore')
const { overrideCriterion } = await import('../../server/services/interview/override')
const { viewerOf } = await import('../../server/services/candidates')
const { createProvider } = await import('../../server/services/ai/providers')
const { setAiHttp } = await import('../../server/services/ai/drivers')
const { listAiCalls, exportAiCalls } = await import('../../server/services/ai/calls')
const { aiQualityReport, aiReviewHelpReport, aiCostReport, qualityExportRows, costExportRows, reviewHelpExportRows } = await import('../../server/services/aiReports')
const { invalidateLimits } = await import('../../server/services/tenantLimits')
const { startAttempt, saveAnswer, submitAttempt, gradeManual } = await import('../../server/services/attempts')
const { buildReviewHint, getReviewHint } = await import('../../server/services/reviewHints')
const { updateAiSettings } = await import('../../server/services/settings')
const { aiCallsQuerySchema, aiCallsExportSchema, aiReportQuerySchema } = await import('../../shared/schemas/ai')
const { interviewRescoreSchema } = await import('../../shared/schemas/interview')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const MARK = 'AISET'
const PHONE = '+38067994'
let tenantId: string
let adminId: string
let mentorId: string
let learnerId: string
let recruiter: ReturnType<typeof viewerOf>
const cand: string[] = []
const quizzesMade: string[] = []
const banks: string[] = []
const scenariosMade: string[] = []
let seq = 0

const actor = (userId: string) => ({ tenantId, actorId: userId })
const hr = () => ({ tenantId, actorId: adminId })
const meta = { ip: '10.2.3.5', userAgent: 'vitest-ai-settings' }
const REASON = 'Оновили промпт оцінки — перевіримо ще раз'

async function makeCandidate(): Promise<string> {
  seq++
  const [status] = await admin`select id from candidate_statuses where tenant_id = ${tenantId} and code = 'in_progress'`
  const [row] = await admin`
    insert into users ${admin({
      tenant_id: tenantId, kind: 'candidate', candidate_state: 'active', candidate_state_at: new Date(),
      candidate_status_id: status!.id, full_name: `${MARK} Кандидат ${seq}`, phone: `${PHONE}${String(seq).padStart(4, '0')}`,
      email: `aiset-${seq}-${Date.now()}@example.test`, status: 'active', source: 'manual', recruiter_id: adminId, comm_language: 'uk',
      consent_given_at: new Date(), consent_expires_at: new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10),
    })} returning id`
  cand.push(row!.id as string)
  return row!.id as string
}

async function makeQuiz(n: number, assignTo: string[], opts: { kind?: string, criteria?: string[] } = {}): Promise<{ quizId: string, questionIds: string[] }> {
  const [bank] = await admin`insert into question_banks (tenant_id, name) values (${tenantId}, ${`${MARK} банк ${++seq}`}) returning id`
  banks.push(bank!.id as string)
  const [quiz] = await admin`
    insert into quizzes (tenant_id, title, kind, status, selection_mode, question_count)
    values (${tenantId}, ${`${MARK} тест ${seq}`}, ${opts.kind ?? 'interview'}, 'published', 'fixed', ${n}) returning id`
  quizzesMade.push(quiz!.id as string)
  const questionIds: string[] = []
  for (let i = 1; i <= n; i++) {
    const [q] = await admin`
      insert into questions (tenant_id, bank_id, kind, stem, answer, points)
      values (${tenantId}, ${bank!.id}, 'free', ${admin.json([{ type: 'text', html: `<p>Питання ${i}: як ви працюєте з гостями?</p>` }])},
              ${admin.json({ criteria: opts.criteria ?? ['досвід'], reference: 'еталон' })}, 2)
      returning id`
    questionIds.push(q!.id as string)
    await admin`insert into quiz_questions (tenant_id, quiz_id, question_id, sort) values (${tenantId}, ${quiz!.id}, ${q!.id}, ${i})`
  }
  for (const userId of assignTo) {
    await admin`
      insert into assignments (tenant_id, title, subject_type, subject_id, audience, status, is_mandatory, params, created_by)
      values (${tenantId}, ${`${MARK} призначення`}, 'test', ${quiz!.id}, ${admin.json({ rules: [{ type: 'user', ids: [userId] }], match: 'any' })}, 'active', false, ${admin.json({ attemptsAllowed: 3 })}, ${adminId})`
  }
  return { quizId: quiz!.id as string, questionIds }
}

async function publishScenario(quizId: string, criterionName: string) {
  const c = await createScenario(hr(), {
    quizId, name: `${MARK} сценарій ${seq}`, interviewerName: 'Лола', introText: 'Вітаю! Мене звати Лола. Я поставлю кілька запитань про ваш досвід.', outroText: 'Дякуємо! Відповіді надіслано рекрутеру.',
    answerModes: ['voice', 'text'], minAnswerSec: 5, maxAnswerSec: 180, thinkTimeSec: 15, silenceTimeoutSec: 45,
    retakeLimit: 2, recordVideo: false, transcribeLang: 'uk', minConfidence: 0.6, alternativePath: 'human_interview',
  })
  if (!c.ok) throw new Error(JSON.stringify(c))
  scenariosMade.push(c.scenario.id)
  for (const name of [criterionName, `${criterionName} друге`]) {
    expect((await addCriterion(hr(), c.scenario.id, { name, description: 'Ясно і спокійно пояснює гостю ситуацію та пропонує рішення', weight: 1, scaleMax: 5, isCritical: false })).ok).toBe(true)
  }
  const p = await updateScenario(hr(), c.scenario.id, { status: 'published' })
  if (!p.ok) throw new Error(JSON.stringify(p))
}

/** Кандидат ответил текстом на два вопроса — сессия готова к оценке. */
async function answeredSession(criterionName: string): Promise<{ userId: string, sessionId: string }> {
  const userId = await makeCandidate()
  const { quizId } = await makeQuiz(2, [userId])
  await publishScenario(quizId, criterionName)
  const e = await getEntry(actor(userId), quizId, {})
  if (!e.ok) throw new Error(`entry ${e.code}`)
  expect(await decideConsent(actor(userId), quizId, { decision: 'accepted', textVersion: e.state.consent.textVersion, textHash: e.state.consent.textHash }, meta)).toMatchObject({ ok: true })
  const s = await startSession(actor(userId), quizId, { answerMode: 'text' }, meta)
  if (!s.ok) throw new Error(JSON.stringify(s))
  for (const i of [1, 2]) {
    const r = await answerTurn(actor(userId), s.sessionId, i, { mode: 'text', text: `Я працював баристою два роки, відповідь ${i}, спокійно пояснюю гостю і пропоную рішення.` }, meta)
    expect(r.ok, JSON.stringify(r)).toBe(true)
  }
  return { userId, sessionId: s.sessionId }
}

/** Ответ «модели»: первый критерий — `first`, второй — 3; `explained: false` — без цитат. */
function scoreReply(first: number, opts: { explained?: boolean, confidence?: number, status?: number } = {}) {
  setAiHttp(async (_url, init) => {
    if (opts.status) return new Response('down', { status: opts.status })
    const body = JSON.parse(String(init!.body)) as { messages: { role: string, content: string }[] }
    const user = JSON.parse(body.messages.find(m => m.role === 'user')!.content) as { criteria: { criterionId: string }[], answers: { turnId: string }[] }
    const content = JSON.stringify({
      criteria: user.criteria.map((c, i) => ({
        criterionId: c.criterionId, value: i === 0 ? first : 3, confidence: opts.confidence ?? 0.9,
        rationale: 'Кандидат описує роботу з гостями, наводить приклад спокійного пояснення.',
        evidence: opts.explained === false ? [] : [{ turnId: user.answers[0]!.turnId, quote: 'спокійно пояснюю гостю' }],
      })),
    })
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
}

async function setInterviewLimit(n: number | null) {
  await admin`insert into tenant_limits (tenant_id) values (${tenantId}) on conflict (tenant_id) do nothing`
  await admin`update tenant_limits set ai_status = 'active', ai_interview_ops = ${n} where tenant_id = ${tenantId}`
  invalidateLimits(tenantId)
}

const interviewOps = async (sessionId: string) => Number((await admin`select coalesce(sum(delta), 0)::int as n from usage_events where axis = 'ai_interview_ops' and ref_id = ${sessionId}`)[0]!.n)

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  mentorId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380670000002'`)[0]!.id as string
  learnerId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380670000003'`)[0]!.id as string
  recruiter = viewerOf({ userId: adminId, tenantId, grants: [{ scopes: ['candidate.view', 'candidate.edit', 'interview.view', 'interview.override'], scopeType: 'tenant', scopeId: null }] })
  await admin`delete from ai_providers where tenant_id = ${tenantId} and code like 'aiset-%'`
  await admin`update tenants set candidates_enabled = true where id = ${tenantId}`
  await setInterviewLimit(null)
  const r = await createProvider(hr(), {
    code: 'aiset-score', name: 'AISET score', purpose: 'interview_score', driver: 'openai_compatible', endpointUrl: 'https://api.example.test/v1',
    modelName: 'net-model', params: {}, dataRegion: 'eu', providerRetention: 'none', maxLatencyMs: 5000, isActive: true, priority: 1,
  } as Parameters<typeof createProvider>[1])
  expect(r.ok, JSON.stringify(r)).toBe(true)
})

afterEach(() => { setAiHttp(null) })

afterAll(async () => {
  await setInterviewLimit(null)
  await updateAiSettings(hr(), { reviewHints: false })
  await admin`delete from ai_calls where tenant_id = ${tenantId} and prompt_version = 'aiset-v0'`
  const everyone = [...cand, learnerId]
  if (cand.length) {
    const ids = admin(cand)
    await admin`delete from candidate_summaries where candidate_id in ${ids}`
    await admin`delete from ai_quality_reviews where ref_id in (select id from interview_criterion_scores where session_id in (select id from interview_sessions where candidate_id in ${ids}))`
    await admin`delete from usage_events where ref_id in (select id from interview_sessions where candidate_id in ${ids})`
    await admin`delete from interview_sessions where candidate_id in ${ids}`
    await admin`delete from interview_consents where user_id in ${ids}`
    await admin`delete from media_assets where owner_user_id in ${ids}`
    await admin`delete from candidate_scores where candidate_id in ${ids}`
    await admin`delete from candidate_status_history where candidate_id in ${ids}`
  }
  const all = admin(everyone)
  await admin`delete from ai_quality_reviews where ref_id in (select id from ai_review_hints where user_id in ${all})`
  await admin`delete from ai_review_hints where user_id in ${all}`
  await admin`delete from ai_calls where subject_user_id in ${all}`
  await admin`delete from notifications where user_id in ${all} or (payload->>'name') like ${`${MARK}%`}`
  await admin`delete from review_queue_items where user_id in ${all}`
  const quizIds = admin(quizzesMade.length ? quizzesMade : ['00000000-0000-0000-0000-000000000000'])
  await admin`delete from attempt_answers where attempt_id in (select id from attempts where user_id in ${all} and quiz_id in ${quizIds})`
  await admin`delete from attempt_results where attempt_id in (select id from attempts where user_id in ${all} and quiz_id in ${quizIds})`
  await admin`delete from task_access_log where user_id in ${all}`
  await admin`delete from user_activity_events where user_id in ${all}`
  if (quizzesMade.length) {
    await admin`delete from attempts where quiz_id in ${quizIds}`
    await admin`delete from assignments where subject_id in ${quizIds}`
    await admin`delete from interview_scenarios where quiz_id in ${quizIds}`
    await admin`delete from quiz_questions where quiz_id in ${quizIds}`
    await admin`delete from quizzes where id in ${quizIds}`
  }
  if (banks.length) {
    await admin`delete from questions where bank_id in ${admin(banks)}`
    await admin`delete from question_banks where id in ${admin(banks)}`
  }
  if (cand.length) await admin`delete from users where id in ${admin(cand)}`
  await admin`delete from ai_providers where tenant_id = ${tenantId} and code like 'aiset-%'`
  await admin.end()
})

// ── Переоценка (`30` §10) ───────────────────────────────────────────────────────────────

describe('переоценка собеседования — POST /candidates/:id/interview/rescore (30 §10)', () => {
  it('правило тарифа: после нашего сбоя бесплатно, повтор состоявшейся оценки — одна операция', () => {
    expect(rescoreCharged('scored', null)).toBe(true)
    expect(rescoreCharged('needs_human', 'low_confidence')).toBe(true)
    for (const r of ['provider_down', 'limit_exhausted', 'unexplained', 'transcribe_failed']) expect(rescoreCharged('needs_human', r)).toBe(false)
    expect(interviewRescoreSchema.safeParse({ reason: 'коротко' }).success).toBe(false)
    expect(interviewRescoreSchema.safeParse({ reason: REASON, extra: 1 }).success).toBe(false)
  })

  it('scored → новая оценка новой строкой ai, прежняя в истории, новый try_no, аудит с причиной, одна операция; кандидат не тронут', async () => {
    const { userId, sessionId } = await answeredSession(`${MARK} Комунікація А`)
    scoreReply(4)
    expect(await scoreSession(tenantId, sessionId)).toBe('scored')
    const [before] = await admin`select id from candidate_scores where candidate_id = ${userId} and kind = 'ai' and is_current`
    const [cand0] = await admin`select candidate_state, candidate_status_id from users where id = ${userId}`
    const ops0 = await interviewOps(sessionId)

    scoreReply(2)
    const r = await rescoreInterview(recruiter, userId, { reason: REASON })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (!r.ok) return
    expect(r.rescore).toMatchObject({ sessionId, state: 'scored', charged: true, aiScore: 50 })

    const [call] = await admin`select id, try_no, actor_user_id, billed from ai_calls where id = ${r.rescore.aiCallId}`
    expect(call).toMatchObject({ try_no: 2, actor_user_id: adminId, billed: true })
    expect(await interviewOps(sessionId)).toBe(ops0 + 1)
    const scores = await admin`select id, is_current, value_num from candidate_scores where candidate_id = ${userId} and kind = 'ai' order by created_at`
    expect(scores).toHaveLength(2)
    expect(scores.find(s => s.id === before!.id)).toMatchObject({ is_current: false })
    expect(scores.find(s => s.id !== before!.id)).toMatchObject({ is_current: true, value_num: '50.00' })
    const [first] = await admin`select value, ai_call_id from interview_criterion_scores s join interview_criteria c on c.id = s.criterion_id where s.session_id = ${sessionId} and c.name_uk = ${`${MARK} Комунікація А`}`
    expect(first).toMatchObject({ value: '2.00', ai_call_id: String(r.rescore.aiCallId) })
    const [audit] = await admin`select actor_id, after from audit_log where action = 'interview.rescore' and entity_id = ${sessionId}`
    expect(audit).toMatchObject({ actor_id: adminId, after: expect.objectContaining({ reason: REASON, charged: true, tryNo: 2 }) })
    // Инвариант 18: ни состояние кандидата, ни колонка канбана не изменились
    expect((await admin`select candidate_state, candidate_status_id from users where id = ${userId}`)[0]).toEqual(cand0)
  })

  it('человек уже не согласился с критерием — 409 human_checked, переоценки нет', async () => {
    const { userId, sessionId } = await answeredSession(`${MARK} Комунікація Б`)
    scoreReply(4)
    expect(await scoreSession(tenantId, sessionId)).toBe('scored')
    const [crit] = await admin`select c.id from interview_criteria c join interview_sessions s on s.scenario_id = c.scenario_id where s.id = ${sessionId} order by c.sort limit 1`
    const o = await overrideCriterion(recruiter, userId, crit!.id as string, { humanValue: 2, humanComment: 'Кандидат не навів жодного конкретного прикладу', major: false, expectedHumanAt: null })
    expect(o.ok).toBe(true)
    expect(await rescoreInterview(recruiter, userId, { reason: REASON })).toEqual({ ok: false, code: 'human_checked' })
    expect((await admin`select state from interview_sessions where id = ${sessionId}`)[0]!.state).toBe('scored')
  })

  it('всё или ничего: провайдер не ответил, модель не объяснила баллы, ось исчерпана — прежняя оценка на месте', async () => {
    const { userId, sessionId } = await answeredSession(`${MARK} Комунікація В`)
    scoreReply(4)
    expect(await scoreSession(tenantId, sessionId)).toBe('scored')
    const snapshot = async () => (await admin`select s.state, s.ai_score, s.candidate_score_id, (select json_agg(value order by criterion_id) from interview_criterion_scores where session_id = s.id) as values from interview_sessions s where s.id = ${sessionId}`)[0]
    const was = await snapshot()

    scoreReply(1, { status: 500 })
    expect(await rescoreInterview(recruiter, userId, { reason: REASON })).toMatchObject({ ok: false, code: 'provider_failed' })
    expect(await snapshot()).toEqual(was)

    scoreReply(1, { explained: false })
    expect(await rescoreInterview(recruiter, userId, { reason: REASON })).toEqual({ ok: false, code: 'unexplained' })
    expect(await snapshot()).toEqual(was)

    await setInterviewLimit(0)
    try {
      scoreReply(1)
      expect(await rescoreInterview(recruiter, userId, { reason: REASON })).toMatchObject({ ok: false, code: 'limit_exceeded', check: { axis: 'ai_interview_ops' } })
      expect(await snapshot()).toEqual(was)
    }
    finally {
      await setInterviewLimit(null)
    }
    // Упавшие попытки — строки журнала, но ни одна операция сверх первой не списана
    expect(await interviewOps(sessionId)).toBe(1)
  })

  it('после нашего сбоя (needs_human provider_down) переоценка бесплатна и доводит до scored', async () => {
    const { userId, sessionId } = await answeredSession(`${MARK} Комунікація Г`)
    await admin`update interview_sessions set state = 'needs_human', degraded_reason = 'provider_down', needs_human_reason = 'провайдер ШІ не відповів' where id = ${sessionId}`
    await setInterviewLimit(0)
    try {
      scoreReply(5)
      const r = await rescoreInterview(recruiter, userId, { reason: REASON })
      expect(r, JSON.stringify(r)).toMatchObject({ ok: true, rescore: { state: 'scored', charged: false } })
      expect((await admin`select state, degraded_reason, needs_human_reason from interview_sessions where id = ${sessionId}`)[0]).toEqual({ state: 'scored', degraded_reason: null, needs_human_reason: null })
      expect(await interviewOps(sessionId)).toBe(1)
    }
    finally {
      await setInterviewLimit(null)
    }
  })

  it('новая оценка ниже порога — needs_human, прежнее число модели снято с карточки (история остаётся)', async () => {
    const { userId, sessionId } = await answeredSession(`${MARK} Комунікація Д`)
    scoreReply(4)
    expect(await scoreSession(tenantId, sessionId)).toBe('scored')
    scoreReply(4, { confidence: 0.3 })
    const r = await rescoreInterview(recruiter, userId, { reason: REASON })
    expect(r).toMatchObject({ ok: true, rescore: { state: 'needs_human' } })
    expect((await admin`select state, degraded_reason, candidate_score_id from interview_sessions where id = ${sessionId}`)[0]).toEqual({ state: 'needs_human', degraded_reason: 'low_confidence', candidate_score_id: null })
    expect(await admin`select id from candidate_scores where candidate_id = ${userId} and kind = 'ai' and is_current`).toHaveLength(0)
    expect(await admin`select id from candidate_scores where candidate_id = ${userId} and kind = 'ai'`).toHaveLength(1)
  })

  it('в работе у модели — 409 scoring; отозванное согласие — not_rescorable; чужой и неизвестный — not_found', async () => {
    const { userId, sessionId } = await answeredSession(`${MARK} Комунікація Е`)
    await admin`update interview_sessions set state = 'scoring' where id = ${sessionId}`
    expect(await rescoreInterview(recruiter, userId, { reason: REASON })).toEqual({ ok: false, code: 'scoring' })
    await admin`update interview_sessions set state = 'abandoned', degraded_reason = 'consent_withdrawn' where id = ${sessionId}`
    expect(await rescoreInterview(recruiter, userId, { reason: REASON })).toEqual({ ok: false, code: 'not_rescorable' })
    expect(await rescoreInterview(recruiter, '00000000-0000-0000-0000-000000000000', { reason: REASON })).toEqual({ ok: false, code: 'not_found' })
    // Сотрудник — не кандидат: карточки кандидата у него нет
    expect(await rescoreInterview(recruiter, learnerId, { reason: REASON })).toEqual({ ok: false, code: 'not_found' })
  })
})

// ── Журнал вызовов: стоимость и выгрузка (`30` §5.6) ────────────────────────────────────

describe('журнал ИИ-вызовов: фильтр стоимости и выгрузка без выхода модели (30 §5.6)', () => {
  const OLD = '2020-01-01T23:30:00Z' // в поясе Europe/Kyiv — уже 2 января
  const digest = 'a'.repeat(64)

  beforeAll(async () => {
    await admin`delete from ai_calls where tenant_id = ${tenantId} and prompt_version = 'aiset-v0'`
    const row = (p: Record<string, string | number | null>) => ({
      tokens_in: null as number | null, tokens_out: null as number | null, cost_minor: 0, latency_ms: null as number | null,
      tenant_id: tenantId, purpose: 'generate', prompt_key: 'aiset', prompt_version: 'aiset-v0', model_name: 'm', ref_kind: 'vacancy_generation',
      input_digest: digest, status: 'ok', created_at: OLD, output: admin.json({ secret: 'вихід моделі' }), currency: 'EUR', error_code: null as string | null, ...p,
    })
    await admin`insert into ai_calls ${admin([
      row({ tokens_in: 100, tokens_out: 50, cost_minor: 30, latency_ms: 1000 }),
      row({ tokens_in: 10, tokens_out: 0, cost_minor: 5, latency_ms: 3000, status: 'failed', error_code: 'http_error' }),
      row({ tokens_in: null, tokens_out: null, cost_minor: 0, latency_ms: null, status: 'refused', error_code: 'limit_exceeded' }),
      row({ tokens_in: 1, tokens_out: 1, cost_minor: 7, latency_ms: 500, currency: 'UAH' }),
      row({ purpose: 'embed', ref_kind: 'search_query', tokens_in: 5, tokens_out: 0, cost_minor: 1, latency_ms: 100, created_at: '2020-01-05T10:00:00Z' }),
    ])}`
  })

  it('costMin — нижняя граница cost_minor; фильтры те же у экрана и выгрузки', async () => {
    const q = aiCallsQuerySchema.parse({ from: '2019-12-31', to: '2020-01-06', costMin: 6 })
    const page = await listAiCalls(hr(), q)
    expect(page.items.map(i => i.costMinor).sort((a, b) => a - b)).toEqual([7, 30])
    expect(aiCallsQuerySchema.safeParse({ costMin: -1 }).success).toBe(false)
  })

  it('выгрузка: без output, с числом строк в audit_log; csv/xlsx', async () => {
    const q = aiCallsExportSchema.parse({ from: '2019-12-31', to: '2020-01-06', format: 'csv' })
    const r = await exportAiCalls(hr(), q)
    expect(r.truncated).toBe(false)
    expect(r.rows).toHaveLength(5)
    expect(Object.keys(r.rows[0]!)).not.toContain('output')
    expect(JSON.stringify(r.rows)).not.toContain('вихід моделі')
    const [audit] = await admin`select after from audit_log where action = 'ai.calls.export' and actor_id = ${adminId} order by created_at desc limit 1`
    expect(audit!.after).toMatchObject({ rows: 5, format: 'csv' })
  })

  it('«Вартість ШІ» (§9.5): по роли и дню в поясе тенанта, валюты не складываются, refused — не ошибка', async () => {
    const r = await aiCostReport(hr(), aiReportQuerySchema.parse({ from: '2020-01-01', to: '2020-01-05' }))
    const eur = r.rows.find(x => x.day === '2020-01-02' && x.purpose === 'generate' && x.currency === 'EUR')
    expect(eur).toEqual({ day: '2020-01-02', purpose: 'generate', currency: 'EUR', calls: 3, tokensIn: 110, tokensOut: 50, costMinor: 35, avgLatencyMs: 2000, errorPct: 33.3 })
    expect(r.rows.find(x => x.day === '2020-01-02' && x.currency === 'UAH')).toMatchObject({ calls: 1, costMinor: 7 })
    expect(r.rows.some(x => x.day === '2020-01-01')).toBe(false)
    expect(r.totals.find(x => x.purpose === 'embed')).toMatchObject({ calls: 1, costMinor: 1, errorPct: 0 })
    const only = await aiCostReport(hr(), aiReportQuerySchema.parse({ from: '2020-01-01', to: '2020-01-05', purpose: 'embed' }))
    expect(only.rows.map(x => x.purpose)).toEqual(['embed'])
    expect(costExportRows(only)[0]).toEqual({ day: '2020-01-05', purpose: 'embed', calls: 1, tokens_in: 5, tokens_out: 0, cost_minor: 1, currency: 'EUR', avg_latency_ms: 100, error_pct: 0 })
    expect(aiReportQuerySchema.safeParse({ format: 'pdf' }).success).toBe(false)
  })
})

// ── Отчёты качества (`30` §9.3, §9.4) ───────────────────────────────────────────────────

describe('«Якість моделі» и «Допомога перевіряючому» (30 §9.3, §9.4)', () => {
  it('качество: доли — от решений человека, разрез по критерию, needs_human по версии; кандидатов в отчёте нет', async () => {
    const name = `${MARK} Критерій якості`
    const { userId, sessionId } = await answeredSession(name)
    scoreReply(5)
    expect(await scoreSession(tenantId, sessionId)).toBe('scored')
    const [crit] = await admin`select c.id from interview_criteria c join interview_sessions s on s.scenario_id = c.scenario_id where s.id = ${sessionId} and c.name_uk = ${name}`
    expect((await overrideCriterion(recruiter, userId, crit!.id as string, { humanValue: 1, humanComment: 'Жодного конкретного прикладу у відповіді немає', major: false, expectedHumanAt: null })).ok).toBe(true)
    const [{ prompt_version: version }] = await admin`select prompt_version from ai_calls where ref_id = ${sessionId} and purpose = 'interview_score' order by id desc limit 1` as unknown as [{ prompt_version: string }]

    // «Сегодня» — в поясе тенанта, как считает отчёт: с 21:00 до 24:00 UTC даты UTC и Киева расходятся
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    const r = await aiQualityReport(hr(), aiReportQuerySchema.parse({ from: today, to: today }))
    const mine = r.criteria.filter(c => c.criterion.startsWith(name))
    expect(mine.find(c => c.criterion === name)).toMatchObject({ promptVersion: version, scores: 1, decided: 1, majorPct: 100, matchPct: 0, avgConfidence: 0.9, smallSample: true })
    expect(mine.find(c => c.criterion === `${name} друге`)).toMatchObject({ scores: 1, decided: 0, majorPct: null })
    const v = r.rows.find(x => x.promptVersion === version)!
    expect(v.scores).toBeGreaterThanOrEqual(2)
    expect(v.sessions).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(r)).not.toContain(`${MARK} Кандидат`)
    const rows = qualityExportRows(r)
    expect(rows.filter(x => x.level === 'version')).toHaveLength(r.rows.length)
    expect(JSON.stringify(rows)).not.toMatch(/rationale|evidence|спокійно пояснюю/)
  })

  it('помощь проверяющему: проверки наставника, показанные подсказки, agreement, время с подсказкой', async () => {
    await updateAiSettings(hr(), { reviewHints: true })
    // «Сегодня» — в поясе тенанта, как считает отчёт: с 21:00 до 24:00 UTC даты UTC и Киева расходятся
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    const before = (await aiReviewHelpReport(hr(), aiReportQuerySchema.parse({ from: today, to: today }))).rows.find(x => x.reviewerId === mentorId)

    const { quizId, questionIds } = await makeQuiz(1, [learnerId], { kind: 'quiz', criteria: ['температура зберігання продуктів', 'термін придатності кожної позиції'] })
    const a = await startAttempt(actor(learnerId), quizId)
    if (!a.ok) throw new Error(JSON.stringify(a))
    expect((await saveAnswer(actor(learnerId), a.attemptId, questionIds[0]!, { text: 'Кожного ранку перевіряю умови зберігання: холодильник має бути в нормі.' })).ok).toBe(true)
    expect(await submitAttempt(actor(learnerId), a.attemptId)).toMatchObject({ ok: true, status: 'review' })
    const [ans] = await admin`select id from attempt_answers where attempt_id = ${a.attemptId}`
    const [h] = await admin`select id from ai_review_hints where target_id = ${ans!.id}`
    expect(await buildReviewHint(tenantId, h!.id as string)).toBe('ready')
    expect(await getReviewHint(actor(mentorId), 'attempt_answer', ans!.id as string, { admin: false })).toMatchObject({ ok: true })
    expect((await gradeManual(actor(mentorId), ans!.id as string, { isCorrect: true, score: 2 })).ok).toBe(true)
    await admin`update review_queue_items set claimed_at = completed_at - interval '12 minutes' where source_id = ${ans!.id}`

    const after = (await aiReviewHelpReport(hr(), aiReportQuerySchema.parse({ from: today, to: today }))).rows.find(x => x.reviewerId === mentorId)!
    expect(after.reviews).toBe((before?.reviews ?? 0) + 1)
    expect(after.shown).toBe((before?.shown ?? 0) + 1)
    expect(after.hints).toBe((before?.hints ?? 0) + 1)
    expect(after.minor + after.match + after.major).toBe((before?.minor ?? 0) + (before?.match ?? 0) + (before?.major ?? 0) + 1)
    expect(after.withHintMeasured).toBe((before?.withHintMeasured ?? 0) + 1)
    expect(after.avgMinWithHint).not.toBeNull()
    const row = reviewHelpExportRows({ rows: [after] })[0]!
    expect(Object.keys(row)).toEqual(['reviewer', 'reviews', 'hints', 'shown', 'match', 'minor', 'major', 'not_shown', 'match_pct', 'avg_min_with_hint', 'avg_min_without_hint'])
  })
})
