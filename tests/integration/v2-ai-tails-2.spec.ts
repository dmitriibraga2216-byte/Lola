import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

/**
 * Блок «ИИ» из «что осталось» (`docs/v2/46-progress.md`), часть 1 задачи ai-tails-2:
 * флаги `duplicate_answer` / `long_silence_pattern` (`30` §7.17), `cost_minor` по цене профиля
 * (`44` Р-AI2.3), журнал ИИ оператору — только метрики (`30` §2), `interview.invited` (`30` §8),
 * отчёты «Воронка співбесід», «Згоди», «Вивантаження співбесід» (`30` §9.1, §9.2, §9.6).
 *
 * Инвариант 18: флаги не меняют ни балла, ни пути сессии, ни кандидата; отчёты — счётчики и числа,
 * без расшифровок, цитат и аудио.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'
process.env.SESSION_SECRET ??= 'test-session-secret'

const { createScenario, updateScenario, addCriterion } = await import('../../server/services/interview/scenarios')
const { getEntry, decideConsent, startSession } = await import('../../server/services/interview/candidate')
const { answerTurn } = await import('../../server/services/interview/session')
const { scoreSession } = await import('../../server/services/interview/pipeline')
const { viewerOf } = await import('../../server/services/candidates')
const { createProvider } = await import('../../server/services/ai/providers')
const { setAiHttp } = await import('../../server/services/ai/drivers')
const { aiOperatorMetrics } = await import('../../server/services/ai/operatorMetrics')
const { expandAssignment } = await import('../../server/services/assignments')
const { interviewFunnelReport, interviewConsentReport, interviewSessionsReport, sessionsExportRows, funnelExportRows, consentExportRows } = await import('../../server/services/interviewReports')
const { invalidateLimits } = await import('../../server/services/tenantLimits')
const { interviewReportQuerySchema } = await import('../../shared/schemas/interview')
const { aiOperatorMetricsQuerySchema, aiProviderParamsSchema } = await import('../../shared/schemas/ai')
const { callCostMinor } = await import('../../shared/domain/aiCost')
const { isDuplicateAnswer, longSilencePattern, interviewEstimateMinutes } = await import('../../shared/domain/interview')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const MARK = 'AIT2'
const PHONE = '+38067995'
let tenantId: string
let adminId: string
let learnerId: string
let recruiter: ReturnType<typeof viewerOf>
const cand: string[] = []
const quizzesMade: string[] = []
const banks: string[] = []
let seq = 0

const actor = (userId: string) => ({ tenantId, actorId: userId })
const hr = () => ({ tenantId, actorId: adminId })
const meta = { ip: '10.2.3.6', userAgent: 'vitest-ai-tails-2' }
const LONG = 'Я два роки працював баристою у кав’ярні біля вокзалу, щоранку відкривав зміну, приймав постачання молока та зерна, спокійно пояснював гостям затримки і пропонував їм напій за рахунок закладу'

async function makeCandidate(opts: { recruiterId?: string } = {}): Promise<string> {
  seq++
  const [status] = await admin`select id from candidate_statuses where tenant_id = ${tenantId} and code = 'in_progress'`
  const [row] = await admin`
    insert into users ${admin({
      tenant_id: tenantId, kind: 'candidate', candidate_state: 'active', candidate_state_at: new Date(),
      candidate_status_id: status!.id, full_name: `${MARK} Кандидат ${seq}`, phone: `${PHONE}${String(seq).padStart(4, '0')}`,
      email: `ait2-${seq}-${Date.now()}@example.test`, status: 'active', source: 'manual', recruiter_id: opts.recruiterId ?? adminId, comm_language: 'uk',
      consent_given_at: new Date(), consent_expires_at: new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10),
      access_until: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10),
    })} returning id`
  cand.push(row!.id as string)
  return row!.id as string
}

/** Тест собеседования с `n` вопросами и одним назначением на всех `assignTo`. */
async function makeQuiz(n: number, assignTo: string[]): Promise<{ quizId: string, assignmentId: string }> {
  const [bank] = await admin`insert into question_banks (tenant_id, name) values (${tenantId}, ${`${MARK} банк ${++seq}`}) returning id`
  banks.push(bank!.id as string)
  const [quiz] = await admin`
    insert into quizzes (tenant_id, title, kind, status, selection_mode, question_count)
    values (${tenantId}, ${`${MARK} тест ${seq}`}, 'interview', 'published', 'fixed', ${n}) returning id`
  quizzesMade.push(quiz!.id as string)
  for (let i = 1; i <= n; i++) {
    const [q] = await admin`
      insert into questions (tenant_id, bank_id, kind, stem, answer, points)
      values (${tenantId}, ${bank!.id}, 'free', ${admin.json([{ type: 'text', html: `<p>Питання ${i}: розкажіть про досвід</p>` }])},
              ${admin.json({ criteria: ['досвід'], reference: 'еталон' })}, 2)
      returning id`
    await admin`insert into quiz_questions (tenant_id, quiz_id, question_id, sort) values (${tenantId}, ${quiz!.id}, ${q!.id}, ${i})`
  }
  const [a] = await admin`
    insert into assignments (tenant_id, title, subject_type, subject_id, audience, status, is_mandatory, params, created_by, due_mode, due_days)
    values (${tenantId}, ${`${MARK} призначення`}, 'test', ${quiz!.id}, ${admin.json({ rules: [{ type: 'user', ids: assignTo }], match: 'any' })}, 'active', false,
            ${admin.json({ attemptsAllowed: 3 })}, ${adminId}, 'relative', 3)
    returning id`
  return { quizId: quiz!.id as string, assignmentId: a!.id as string }
}

async function publishScenario(quizId: string) {
  const c = await createScenario(hr(), {
    quizId, name: `${MARK} сценарій ${seq}`, interviewerName: 'Лола', introText: 'Вітаю! Мене звати Лола. Я поставлю кілька запитань про ваш досвід.', outroText: 'Дякуємо! Відповіді надіслано рекрутеру.',
    answerModes: ['voice', 'text'], minAnswerSec: 5, maxAnswerSec: 180, thinkTimeSec: 15, silenceTimeoutSec: 45,
    retakeLimit: 2, recordVideo: false, transcribeLang: 'uk', minConfidence: 0.6, alternativePath: 'human_interview',
  })
  if (!c.ok) throw new Error(JSON.stringify(c))
  expect((await addCriterion(hr(), c.scenario.id, { name: `${MARK} Комунікація`, description: 'Ясно і спокійно пояснює гостю ситуацію та пропонує рішення', weight: 1, scaleMax: 5, isCritical: false })).ok).toBe(true)
  const p = await updateScenario(hr(), c.scenario.id, { status: 'published' })
  if (!p.ok) throw new Error(JSON.stringify(p))
}

async function consent(userId: string, quizId: string, decision: 'accepted' | 'declined') {
  const e = await getEntry(actor(userId), quizId, {})
  if (!e.ok) throw new Error(`entry ${e.code}`)
  const r = await decideConsent(actor(userId), quizId, {
    decision, textVersion: e.state.consent.textVersion, textHash: e.state.consent.textHash,
    ...(decision === 'declined' ? { alternative: 'human_interview' } : {}),
  } as Parameters<typeof decideConsent>[2], meta)
  expect(r, JSON.stringify(r)).toMatchObject({ ok: true })
}

type Answer = { mode: 'text', text: string } | { mode: 'none', silenceMs: number }

async function interview(userId: string, quizId: string, answers: Answer[]): Promise<string> {
  await consent(userId, quizId, 'accepted')
  const s = await startSession(actor(userId), quizId, { answerMode: 'text' }, meta)
  if (!s.ok) throw new Error(JSON.stringify(s))
  for (const [i, a] of answers.entries()) {
    const r = await answerTurn(actor(userId), s.sessionId, i + 1, a, meta)
    expect(r.ok, JSON.stringify(r)).toBe(true)
  }
  return s.sessionId
}

const flagsOf = async (sessionId: string) => ((await admin`select flags from interview_sessions where id = ${sessionId}`)[0]!.flags as { code: string, ordinal: number | null }[])

/** Ответ «модели» оценки: балл 4, цитата из первого ответа, 10 токенов входа и 5 выхода. */
function scoreReply() {
  setAiHttp(async (_url, init) => {
    const body = JSON.parse(String(init!.body)) as { messages: { role: string, content: string }[] }
    const user = JSON.parse(body.messages.find(m => m.role === 'user')!.content) as { criteria: { criterionId: string }[], answers: { turnId: string, answer: string }[] }
    const content = JSON.stringify({
      criteria: user.criteria.map(c => ({
        criterionId: c.criterionId, value: 4, confidence: 0.9,
        rationale: 'Кандидат описує роботу з гостями, наводить приклад спокійного пояснення.',
        evidence: [{ turnId: user.answers[0]!.turnId, quote: user.answers[0]!.answer.split(' ').slice(0, 4).join(' ') }],
      })),
    })
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  learnerId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380670000003'`)[0]!.id as string
  recruiter = viewerOf({ userId: adminId, tenantId, grants: [{ scopes: ['candidate.view', 'interview.view'], scopeType: 'tenant', scopeId: null }] })
  await admin`delete from ai_providers where tenant_id = ${tenantId} and code like 'ait2-%'`
  await admin`update tenants set candidates_enabled = true where id = ${tenantId}`
  await admin`insert into tenant_limits (tenant_id) values (${tenantId}) on conflict (tenant_id) do nothing`
  await admin`update tenant_limits set ai_status = 'active', ai_interview_ops = null where tenant_id = ${tenantId}`
  invalidateLimits(tenantId)
  const r = await createProvider(hr(), {
    code: 'ait2-score', name: 'AIT2 score', purpose: 'interview_score', driver: 'openai_compatible', endpointUrl: 'https://api.example.test/v1',
    modelName: 'ait2-model', params: { priceInPer1M: 150_000, priceOutPer1M: 600_000, currency: 'UAH' }, dataRegion: 'eu', providerRetention: 'none',
    maxLatencyMs: 5000, isActive: true, priority: 0,
  } as Parameters<typeof createProvider>[1])
  expect(r.ok, JSON.stringify(r)).toBe(true)
})

afterEach(() => { setAiHttp(null) })

afterAll(async () => {
  const everyone = [...cand, learnerId]
  if (cand.length) {
    const ids = admin(cand)
    await admin`delete from candidate_summaries where candidate_id in ${ids}`
    await admin`delete from ai_quality_reviews where ref_id in (select id from interview_criterion_scores where session_id in (select id from interview_sessions where candidate_id in ${ids}))`
    await admin`delete from usage_events where ref_id in (select id from interview_sessions where candidate_id in ${ids})`
    await admin`delete from interview_sessions where candidate_id in ${ids}`
    await admin`delete from interview_consents where user_id in ${ids}`
    await admin`delete from candidate_scores where candidate_id in ${ids}`
    await admin`delete from candidate_status_history where candidate_id in ${ids}`
  }
  const all = admin(everyone)
  await admin`delete from ai_calls where subject_user_id in ${all} or prompt_version = 'ait2-v0'`
  await admin`delete from notifications where user_id in ${all} and (code like 'interview_%' or code like 'summary_%' or code = 'candidate_invited')`
  await admin`delete from notifications where (payload->>'name') like ${`${MARK}%`}`
  await admin`delete from review_queue_items where user_id in ${all}`
  await admin`delete from audit_log where action = 'interview.sessions.export' and actor_id = ${adminId} and (after->>'rows')::int >= 0 and created_at > now() - interval '1 hour'`
  const quizIds = admin(quizzesMade.length ? quizzesMade : ['00000000-0000-0000-0000-000000000000'])
  await admin`delete from attempt_answers where attempt_id in (select id from attempts where quiz_id in ${quizIds})`
  await admin`delete from attempt_results where attempt_id in (select id from attempts where quiz_id in ${quizIds})`
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
  await admin`delete from ai_providers where tenant_id = ${tenantId} and code like 'ait2-%'`
  await admin.end()
})

// ── Флаги (`30` §7.17) ──────────────────────────────────────────────────────────────────────

describe('флаги duplicate_answer и long_silence_pattern (30 §7.17)', () => {
  it('правила: совпадение > 85 % длинного ответа; два и больше молчаний и не меньше трети реплик', () => {
    expect(isDuplicateAnswer(LONG, [LONG])).toBe(true)
    expect(isDuplicateAnswer(`Добрий день. ${LONG}`, [LONG])).toBe(true)
    expect(isDuplicateAnswer('Так, працював баристою два роки', ['Так, працював баристою два роки'])).toBe(false)
    expect(isDuplicateAnswer(LONG, ['Зовсім інша відповідь про роботу офіціантом у ресторані на набережній і про гостей які поспішають'])).toBe(false)
    const none = { answerMode: 'none', silenceMs: null, firstSoundDelayMs: null }
    const text = { answerMode: 'text', silenceMs: null, firstSoundDelayMs: null }
    expect(longSilencePattern([none, none, text], 45)).toBe(true)
    expect(longSilencePattern([none, text, text], 45)).toBe(false)
    expect(longSilencePattern([none, none, text, text, text, text, text], 45)).toBe(false)
    expect(longSilencePattern([{ answerMode: 'voice', silenceMs: 50_000, firstSoundDelayMs: null }, { answerMode: 'voice', silenceMs: null, firstSoundDelayMs: 46_000 }], 45)).toBe(true)
    expect(interviewEstimateMinutes(4, { thinkTimeSec: 15, minAnswerSec: 5, maxAnswerSec: 180 })).toBe(10)
  })

  it('второй кандидат повторил ответ первого — флаг только у второго, на свой вопрос; балл и путь сессии прежние', async () => {
    const [a, b] = [await makeCandidate(), await makeCandidate()]
    const { quizId } = await makeQuiz(2, [a, b])
    await publishScenario(quizId)
    // Порядок вопросов в попытке у каждого свой — первый кандидат отвечает одинаково на оба,
    // чтобы совпадение по вопросу не зависело от перемешивания; свои ответы друг с другом не сравниваются
    const s1 = await interview(a, quizId, [{ mode: 'text', text: LONG }, { mode: 'text', text: LONG }])
    const s2 = await interview(b, quizId, [{ mode: 'text', text: `Коротко: ${LONG}` }, { mode: 'text', text: 'Люблю каву і людей, хочу навчитися готувати фільтр і еспресо на професійній машині разом з командою' }])
    expect(await flagsOf(s1)).toEqual([])
    expect((await flagsOf(s2)).map(f => [f.code, f.ordinal])).toEqual([['duplicate_answer', 1]])
    // Флаг — факт для человека: сессия всё равно идёт к оценке, кандидат не тронут
    expect((await admin`select state from interview_sessions where id = ${s2}`)[0]!.state).toBe('scoring')
    expect((await admin`select candidate_state from users where id = ${b}`)[0]!.candidate_state).toBe('active')
  })

  it('два молчания из трёх реплик — long_silence_pattern сессии, без привязки к реплике', async () => {
    const u = await makeCandidate()
    const { quizId } = await makeQuiz(3, [u])
    await publishScenario(quizId)
    const s = await interview(u, quizId, [{ mode: 'none', silenceMs: 60_000 }, { mode: 'none', silenceMs: 60_000 }, { mode: 'text', text: 'Готовий працювати позмінно, маю санітарну книжку' }])
    expect((await flagsOf(s)).map(f => [f.code, f.ordinal])).toEqual([['long_silence_pattern', null]])
  })
})

// ── Стоимость и метрики оператора ─────────────────────────────────────────────────────────────

describe('cost_minor по цене профиля (44 Р-AI2.3) и журнал оператору — только метрики (30 §2)', () => {
  it('цена: за миллион токенов, вверх до минорной единицы; без цены — 0; схема параметров', () => {
    expect(callCostMinor(10, 5, { priceInPer1M: 150_000, priceOutPer1M: 600_000 })).toBe(5)
    expect(callCostMinor(1_000_000, 0, { priceInPer1M: 150 })).toBe(150)
    expect(callCostMinor(10, 5, {})).toBe(0)
    expect(callCostMinor(null, null, { priceInPer1M: 1 })).toBe(0)
    expect(aiProviderParamsSchema.safeParse({ priceInPer1M: 1.5, currency: 'UAH' }).success).toBe(true)
    expect(aiProviderParamsSchema.safeParse({ currency: 'uah' }).success).toBe(false)
    expect(aiProviderParamsSchema.safeParse({ priceInPer1M: -1 }).success).toBe(false)
  })

  it('успешный вызов оценки пишет стоимость и валюту профиля', async () => {
    const u = await makeCandidate()
    const { quizId } = await makeQuiz(1, [u])
    await publishScenario(quizId)
    const s = await interview(u, quizId, [{ mode: 'text', text: LONG }])
    scoreReply()
    expect(await scoreSession(tenantId, s)).toBe('scored')
    const [call] = await admin`select cost_minor, currency, tokens_in, tokens_out from ai_calls where ref_id = ${s} and purpose = 'interview_score' and status = 'ok'`
    expect(call).toMatchObject({ cost_minor: 5, currency: 'UAH', tokens_in: 10, tokens_out: 5 })
  })

  it('оператор видит агрегаты по тенанту, роли и модели — без содержимого, людей и ссылок', async () => {
    await admin`
      insert into ai_calls (tenant_id, purpose, prompt_key, prompt_version, model_name, ref_kind, input_digest, status, latency_ms, tokens_in, tokens_out, cost_minor, currency, output, subject_user_id)
      values (${tenantId}, 'summary', 'summary', 'ait2-v0', 'ait2-op-model', 'summary', ${'a'.repeat(64)}, 'ok', 100, 20, 10, 7, 'EUR', ${admin.json({ text: 'СЕКРЕТНИЙ ВИХІД' })}, ${learnerId}),
             (${tenantId}, 'summary', 'summary', 'ait2-v0', 'ait2-op-model', 'summary', ${'b'.repeat(64)}, 'timeout', 300, null, null, 0, 'EUR', null, ${learnerId})`
    const m = await aiOperatorMetrics(aiOperatorMetricsQuerySchema.parse({ tenantId, purpose: 'summary' }))
    const row = m.rows.find(r => r.modelName === 'ait2-op-model')
    expect(row).toMatchObject({ tenantId, calls: 2, ok: 1, timeout: 1, errorPct: 50, avgLatencyMs: 200, tokensIn: 20, tokensOut: 10, costMinor: 7, currency: 'EUR' })
    const text = JSON.stringify(m)
    expect(text).not.toContain('СЕКРЕТНИЙ')
    expect(text).not.toContain(learnerId)
    for (const k of ['output', 'inputRef', 'inputDigest', 'refId', 'subjectUserId', 'actorUserId', 'promptKey']) expect(Object.keys(row!)).not.toContain(k)
    expect(aiOperatorMetricsQuerySchema.safeParse({ from: '2026-09-10', to: '2026-09-01' }).success).toBe(false)
  })
})

// ── interview.invited (`30` §8) ───────────────────────────────────────────────────────────────

describe('interview.invited — приглашение при назначении теста собеседования (30 §8)', () => {
  it('кандидатам e-mail и Telegram один раз; сотруднику и без опубликованного сценария — нет', async () => {
    const [a, b] = [await makeCandidate(), await makeCandidate()]
    const { quizId, assignmentId } = await makeQuiz(4, [a, b, learnerId])
    const sent = async () => admin`select user_id, channel, payload from notifications where code = 'interview_invited' and dedup_key like ${`interview_invited:${assignmentId}:%`} order by user_id, channel`
    await expandAssignment(tenantId, assignmentId)
    expect(await sent()).toHaveLength(0) // сценарий не опубликован — звать некуда

    await publishScenario(quizId)
    await expandAssignment(tenantId, assignmentId)
    const rows = await sent()
    expect(rows.map(r => `${r.user_id === a ? 'a' : r.user_id === b ? 'b' : 'x'}:${r.channel}`).sort()).toEqual(['a:email', 'a:telegram', 'b:email', 'b:telegram'])
    const createdAt = (await admin`select created_at from assignments where id = ${assignmentId}`)[0]!.created_at as Date
    // Срок — ближайший: назначение через 3 дня раньше доступа через 10
    expect(rows[0]!.payload).toMatchObject({ minutes: 10, url: expect.stringContaining(`/interview/${quizId}`), until: new Date(new Date(createdAt).getTime() + 3 * 86_400_000).toISOString() })

    await expandAssignment(tenantId, assignmentId)
    expect(await sent()).toHaveLength(4)
  })
})

// ── Отчёты §9.1, §9.2, §9.6 ─────────────────────────────────────────────────────────────────

describe('отчёты собеседований (30 §9.1, §9.2, §9.6)', () => {
  let quizId: string
  let scored: string
  const people: string[] = []

  beforeAll(async () => {
    const other = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380670000002'`)[0]!.id as string
    for (let i = 0; i < 3; i++) people.push(await makeCandidate())
    people.push(await makeCandidate({ recruiterId: other })) // чужой рекрутер — вне области керівника
    ;({ quizId } = await makeQuiz(1, people))
    await publishScenario(quizId)
    scored = await interview(people[0]!, quizId, [{ mode: 'text', text: LONG }])
    scoreReply()
    expect(await scoreSession(tenantId, scored)).toBe('scored')
    await consent(people[1]!, quizId, 'declined')
    await consent(people[2]!, quizId, 'accepted')
  })

  const q = (extra: Record<string, string> = {}) => interviewReportQuerySchema.parse({ quizId, ...extra })

  it('воронка: назначено 4 · согласились 2 · отказались 1 · завершили 1 · балл сессии', async () => {
    const r = await interviewFunnelReport(recruiter, q())
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toMatchObject({ quizId, assigned: 4, agreed: 2, declined: 1, finished: 1, needsHuman: 0, avgScore: 80, agreedPct: 50, finishedPct: 50 })
    expect(r.rows[0]!.medianMinutes).not.toBeNull()
    expect(r.total).toMatchObject({ assigned: 4, agreed: 2 })
    expect(funnelExportRows(r)[0]).toMatchObject({ assigned: 4, needs_human: 0 })
    // Период до создания назначения и решений — пусто
    expect((await interviewFunnelReport(recruiter, q({ from: '2020-01-01', to: '2020-01-31' }))).rows).toEqual([])
  })

  it('область: керівник с точками видит только своих кандидатов; наставник — ничего', async () => {
    const manager = viewerOf({ userId: adminId, tenantId, grants: [{ scopes: ['interview.view'], scopeType: 'location', scopeId: '00000000-0000-0000-0000-000000000001' }] })
    expect(manager.locations).not.toBeNull()
    expect((await interviewFunnelReport(manager, q())).rows[0]).toMatchObject({ assigned: 3 })
    const mentor = { ...recruiter, reviewOnly: true }
    expect((await interviewFunnelReport(mentor, q())).rows).toEqual([])
    expect((await interviewSessionsReport(mentor, q())).rows).toEqual([])
  })

  it('согласия: последнее решение по вакансии и языку, альтернатива отказа', async () => {
    const r = await interviewConsentReport(recruiter, q())
    expect(r.rows).toEqual([expect.objectContaining({ vacancyId: null, lang: 'uk', decisions: 3, accepted: 2, declined: 1, withdrawn: 0, declinedPct: 33.3, altHuman: 1, altText: 0 })])
    expect(r.alternatives).toEqual({ human_interview: 1, text_form: 0 })
    expect(consentExportRows(r)[0]).toMatchObject({ declined: 1, alt_human_interview: 1 })
  })

  it('выгрузка: числа, флаги, agreement — без расшифровок и обоснований; файл пишет журнал с числом строк', async () => {
    const r = await interviewSessionsReport(recruiter, q(), { audit: { format: 'xlsx' } })
    const row = r.rows.find(x => x.sessionId === scored)!
    expect(row).toMatchObject({ candidateId: people[0], state: 'scored', aiScore: 80, aiConfidence: 0.9, flags: [], agreement: { match: 0, minor: 0, major: 0, pending: 1 } })
    expect(row.criteria).toEqual([{ name: `${MARK} Комунікація`, value: 4, scaleMax: 5, humanValue: null, agreement: 'pending' }])
    // Сессия без ответов (согласие дано, собеседование не начато) в выгрузку не попадает
    expect(r.rows).toHaveLength(1)
    const text = JSON.stringify([r, sessionsExportRows(r)])
    expect(text).not.toContain('баристою')
    expect(text).not.toContain('спокійного пояснення')
    const [audit] = await admin`select after from audit_log where action = 'interview.sessions.export' and actor_id = ${adminId} order by created_at desc limit 1`
    expect(audit!.after).toMatchObject({ rows: 1, format: 'xlsx', filters: expect.objectContaining({ quizId }) })
    expect(interviewReportQuerySchema.safeParse({ format: 'pdf' }).success).toBe(false)
  })
})
