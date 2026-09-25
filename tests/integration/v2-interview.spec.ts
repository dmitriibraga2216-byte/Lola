import { randomUUID } from 'node:crypto'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

/**
 * PR-28 пакета `docs/v2` (`45-plan.md`, решение В-12): сценарий, согласие, прохождение
 * собеседования (`30-ai-interview.md` §3.3–§3.5, §4, §7.1–§7.12, §10–§12).
 *
 * Критерии приёмки `30` §13, закреплённые за PR-28:
 * - **1** — до создания попытки показан экран согласия; `start` без согласия — `consent_required`
 *   (по HTTP — `409 interview_consent.required`, `v2-interview-http.spec.ts`), попытки нет;
 * - **2** — «Не погоджуюсь»: сессии нет, назначение активно, рекрутеру `interview_declined`, в
 *   истории нейтральная строка, оценок нет;
 * - **3** — публикация без `alternative_path` — `alternative_required`, статус `draft`;
 * - **4** — модель вернула балл без цитаты: строк оценок нет, сессия `needs_human`,
 *   `candidate_scores` пуста; мимо сервиса такую строку не пропускает сама база;
 * - **5** — сессия `scored` с баллом 12 из 100: кандидат `active`, не в «Відхилені», отказа нет
 *   ни при какой настройке тенанта;
 * - **8** — обрыв на 4-й реплике из 8, возврат через 20 минут: продолжение с 4-й, `disconnects = 1`,
 *   попытка цела;
 * - **9** — отзыв согласия: аудио в `pending_delete` той же транзакцией, расшифровки пусты,
 *   попытка не `failed`, рекрутер уведомлён.
 * (**12** — `403` без `interview.listen` и нет строки журнала — по HTTP, `v2-interview-http.spec.ts`.)
 *
 * Плюс хвосты PR-27, отданные этому PR: расшифровка по HTTP (multipart из S3), полный вход вызова
 * в S3 (`input_ref`) и его уборка, возврат резерва сессии без ответов, явный признак оценки
 * заглушки (`candidate_scores.ai_stub`) — и обезличивание по механике `candidate.consent_sweep`.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'
process.env.SESSION_SECRET ??= 'test-session-secret'

const { createScenario, updateScenario, addCriterion, getScenario } = await import('../../server/services/interview/scenarios')
const { getEntry, decideConsent, startSession, takeAlternativePath, startTextForm, answerTextForm, submitTextForm } = await import('../../server/services/interview/candidate')
const { getSession, heartbeat, pause, uploadAnswer, answerTurn, finishSession, withdrawConsent } = await import('../../server/services/interview/session')
const { transcribeTurn, scoreSession, reapSessions } = await import('../../server/services/interview/pipeline')
const { candidateInterview, listenTurn } = await import('../../server/services/interview/recruiter')
const { startAttempt } = await import('../../server/services/attempts')
const { listScores, listHistory, viewerOf } = await import('../../server/services/candidates')
const { anonymizeCandidate } = await import('../../server/services/candidateHire')
const { candidateAutoArchive, candidateConsentSweep } = await import('../../server/services/candidateJobs')
const { recruitingSettings, updateRecruiting } = await import('../../server/services/settings')
const { createProvider } = await import('../../server/services/ai/providers')
const { setAiHttp } = await import('../../server/services/ai/drivers')
const { aiCallsCleanup } = await import('../../server/services/ai/calls')
const { invalidateLimits } = await import('../../server/services/tenantLimits')
const { S3_BUCKET, ensureBucket, s3 } = await import('../../server/services/media')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const MARK = 'PR28'
const PHONE = '+38067992'
const INTRO = 'Вітаю! Мене звати Лола. Я поставлю кілька запитань про ваш досвід роботи з гостями.'
const OUTRO = 'Дякуємо! Відповіді надіслано рекрутеру.'

let tenantId: string
let adminId: string
let recruiter: ReturnType<typeof viewerOf>
const cand: string[] = []
const quizzesMade: string[] = []
const banks: string[] = []
let seq = 0

const actor = (userId: string) => ({ tenantId, actorId: userId })
const hr = () => ({ tenantId, actorId: adminId })
const meta = { ip: '10.1.2.3', userAgent: 'vitest-pr28' }

// ── Помощники ───────────────────────────────────────────────────────────────────────────

async function makeCandidate(patch: Record<string, unknown> = {}): Promise<string> {
  seq++
  const [status] = await admin`select id from candidate_statuses where tenant_id = ${tenantId} and code = 'in_progress'`
  const [row] = await admin`
    insert into users ${admin({
      tenant_id: tenantId, kind: 'candidate', candidate_state: 'active', candidate_state_at: new Date(),
      candidate_status_id: status!.id, full_name: `${MARK} Кандидат ${seq}`, phone: `${PHONE}${String(seq).padStart(4, '0')}`,
      status: 'active', source: 'manual', recruiter_id: adminId, comm_language: 'uk',
      consent_given_at: new Date(), consent_expires_at: new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10),
      ...patch,
    })} returning id`
  await admin`insert into candidate_status_history (tenant_id, candidate_id, to_status_id, actor_id) values (${tenantId}, ${row!.id}, ${status!.id}, ${adminId})`
  cand.push(row!.id as string)
  return row!.id as string
}

/** Тест вида `interview` из N вопросов «розгорнута відповідь», назначенный людям. */
async function makeQuiz(n: number, assignTo: string[], kind = 'interview'): Promise<string> {
  const [bank] = await admin`insert into question_banks (tenant_id, name) values (${tenantId}, ${`${MARK} банк ${++seq}`}) returning id`
  banks.push(bank!.id as string)
  const [quiz] = await admin`
    insert into quizzes (tenant_id, title, kind, status, selection_mode, question_count)
    values (${tenantId}, ${`${MARK} співбесіда ${seq}`}, ${kind}, 'published', 'fixed', ${n}) returning id`
  quizzesMade.push(quiz!.id as string)
  for (let i = 1; i <= n; i++) {
    const [q] = await admin`
      insert into questions (tenant_id, bank_id, kind, stem, answer)
      values (${tenantId}, ${bank!.id}, 'free', ${admin.json([{ type: 'text', html: `<p>Питання ${i}: розкажіть про досвід ${i}</p>` }])}, ${admin.json({ criteria: ['досвід'], reference: 'еталон' })})
      returning id`
    await admin`insert into quiz_questions (tenant_id, quiz_id, question_id, sort) values (${tenantId}, ${quiz!.id}, ${q!.id}, ${i})`
  }
  for (const userId of assignTo) {
    await admin`
      insert into assignments (tenant_id, title, subject_type, subject_id, audience, status, is_mandatory, params, created_by)
      values (${tenantId}, ${`${MARK} призначення`}, 'test', ${quiz!.id}, ${admin.json({ rules: [{ type: 'user', ids: [userId] }], match: 'any' })}, 'active', false, ${admin.json({ attemptsAllowed: 3 })}, ${adminId})`
  }
  return quiz!.id as string
}

const CRITERIA = [
  { name: 'Комунікація', description: 'Ясно і спокійно пояснює гостю ситуацію та пропонує рішення', weight: 1, scaleMax: 5, isCritical: false },
  { name: 'Досвід', description: 'Має досвід роботи з гостями та говорить про нього конкретно', weight: 1, scaleMax: 5, isCritical: false },
]

async function publishScenario(quizId: string, opts: { alternative?: 'human_interview' | 'text_form', modes?: ('voice' | 'text')[] } = {}) {
  const c = await createScenario(hr(), {
    quizId, name: `${MARK} сценарій`, interviewerName: 'Лола', introText: INTRO, outroText: OUTRO,
    answerModes: opts.modes ?? ['voice', 'text'], minAnswerSec: 5, maxAnswerSec: 180, thinkTimeSec: 15, silenceTimeoutSec: 45,
    retakeLimit: 2, recordVideo: false, transcribeLang: 'uk', minConfidence: 0.6, alternativePath: opts.alternative ?? 'human_interview',
  })
  expect(c.ok, JSON.stringify(c)).toBe(true)
  if (!c.ok) throw new Error('scenario')
  for (const cr of CRITERIA) expect((await addCriterion(hr(), c.scenario.id, cr)).ok).toBe(true)
  const p = await updateScenario(hr(), c.scenario.id, { status: 'published' })
  expect(p.ok, JSON.stringify(p)).toBe(true)
  return p.ok ? p.scenario : (null as never)
}

async function accept(userId: string, quizId: string) {
  const e = await getEntry(actor(userId), quizId, {})
  if (!e.ok) throw new Error(`entry ${e.code}`)
  const r = await decideConsent(actor(userId), quizId, { decision: 'accepted', textVersion: e.state.consent.textVersion, textHash: e.state.consent.textHash }, meta)
  expect(r).toMatchObject({ ok: true, next: 'start' })
  return e.state
}

async function startText(userId: string, quizId: string): Promise<string> {
  await accept(userId, quizId)
  const s = await startSession(actor(userId), quizId, { answerMode: 'text' }, meta)
  expect(s.ok, JSON.stringify(s)).toBe(true)
  return s.ok ? s.sessionId : (null as never)
}

async function answerAll(userId: string, sessionId: string, from: number, to: number, text = (i: number) => `Я працював баристою два роки, відповідь ${i}, спокійно пояснюю гостю і пропоную рішення.`) {
  for (let i = from; i <= to; i++) {
    const r = await answerTurn(actor(userId), sessionId, i, { mode: 'text', text: text(i) }, meta)
    expect(r.ok, JSON.stringify(r)).toBe(true)
  }
}

async function setLimits(v: { ai_interview_ops?: number | null, ai_status?: string, status?: string }) {
  await admin`insert into tenant_limits (tenant_id) values (${tenantId}) on conflict (tenant_id) do nothing`
  if ('ai_interview_ops' in v) await admin`update tenant_limits set ai_interview_ops = ${v.ai_interview_ops ?? null} where tenant_id = ${tenantId}`
  if (v.ai_status) await admin`update tenant_limits set ai_status = ${v.ai_status} where tenant_id = ${tenantId}`
  if (v.status) await admin`update tenant_limits set status = ${v.status} where tenant_id = ${tenantId}`
  invalidateLimits(tenantId)
}

async function resetInterviewAxis() {
  await admin`delete from usage_events where tenant_id = ${tenantId} and axis = 'ai_interview_ops'`
  await admin`delete from usage_counters where tenant_id = ${tenantId} and axis = 'ai_interview_ops'`
  await admin`delete from limit_notices where tenant_id = ${tenantId} and axis = 'ai_interview_ops'`
}

/** Профиль сети с приоритетом выше заглушки — основной для роли на время теста. */
async function netProfile(code: string, purpose: 'interview_score' | 'transcribe') {
  const r = await createProvider(hr(), {
    code: `pr28-${code}`, name: `PR28 ${code}`, purpose, driver: 'openai_compatible', endpointUrl: 'https://api.example.test/v1',
    modelName: 'net-model', params: {}, dataRegion: 'eu', providerRetention: 'none', maxLatencyMs: 5000, isActive: true, priority: 1,
  } as Parameters<typeof createProvider>[1])
  expect(r.ok, JSON.stringify(r)).toBe(true)
}

async function dropProfiles() {
  await admin`delete from ai_providers where tenant_id = ${tenantId} and code like 'pr28-%'`
}

/** Ответ модели оценки: `criteria` — как вернёт вендор (`chat/completions`, JSON в content). */
function scoreReply(build: (turns: { turnId: string, answer: string }[], criteria: { criterionId: string }[]) => unknown) {
  setAiHttp(async (_url, init) => {
    const body = JSON.parse(String(init!.body)) as { messages: { role: string, content: string }[] }
    const user = JSON.parse(body.messages.find(m => m.role === 'user')!.content) as { criteria: { criterionId: string }[], answers: { turnId: string, answer: string }[] }
    const content = JSON.stringify(build(user.answers, user.criteria))
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
}

async function sessionRow(id: string) {
  return (await admin`select * from interview_sessions where id = ${id}`)[0]!
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  recruiter = viewerOf({ userId: adminId, tenantId, grants: [{ scopes: ['candidate.view', 'interview.view', 'interview.listen'], scopeType: 'tenant', scopeId: null }] })
  await dropProfiles()
  await resetInterviewAxis()
  await setLimits({ ai_interview_ops: null, ai_status: 'active', status: 'active' })
})

afterEach(() => setAiHttp(null))

afterAll(async () => {
  await dropProfiles()
  await resetInterviewAxis()
  await setLimits({ ai_interview_ops: null, ai_status: 'active', status: 'trial' })
  if (cand.length) {
    const ids = admin(cand)
    await admin`delete from interview_sessions where candidate_id in ${ids}`
    await admin`delete from interview_consents where user_id in ${ids}`
    await admin`delete from ai_calls where subject_user_id in ${ids}`
    await admin`delete from media_assets where owner_user_id in ${ids}`
    await admin`delete from candidate_scores where candidate_id in ${ids}`
    await admin`delete from candidate_status_history where candidate_id in ${ids}`
    await admin`delete from notifications where user_id in ${ids} or (payload->>'name') like ${`${MARK}%`}`
    await admin`delete from review_queue_items where user_id in ${ids}`
    await admin`delete from attempt_answers where attempt_id in (select id from attempts where user_id in ${ids})`
    await admin`delete from attempt_results where attempt_id in (select id from attempts where user_id in ${ids})`
    await admin`delete from task_access_log where user_id in ${ids}`
    await admin`delete from user_activity_events where user_id in ${ids}`
    await admin`delete from attempts where user_id in ${ids}`
  }
  if (quizzesMade.length) {
    await admin`delete from assignments where subject_id in ${admin(quizzesMade)}`
    await admin`delete from interview_scenarios where quiz_id in ${admin(quizzesMade)}`
    await admin`delete from quiz_questions where quiz_id in ${admin(quizzesMade)}`
    await admin`delete from quizzes where id in ${admin(quizzesMade)}`
  }
  if (banks.length) {
    await admin`delete from questions where bank_id in ${admin(banks)}`
    await admin`delete from question_banks where id in ${admin(banks)}`
  }
  if (cand.length) {
    await admin`delete from users where id in ${admin(cand)}`
  }
  await admin.end()
})

// ── Сценарий (к. 3) ─────────────────────────────────────────────────────────────────────

describe('сценарий: без альтернативы не публикуется (30 §7.5, §13 к. 3)', () => {
  it('публикация без alternative_path — alternative_required, статус остаётся draft; без критериев — criteria_required', async () => {
    const quizId = await makeQuiz(2, [])
    const c = await createScenario(hr(), {
      quizId, name: `${MARK} без альтернативи`, interviewerName: 'Лола', introText: INTRO, outroText: OUTRO,
      answerModes: ['voice', 'text'], minAnswerSec: 5, maxAnswerSec: 180, thinkTimeSec: 15, silenceTimeoutSec: 45,
      retakeLimit: 2, recordVideo: false, transcribeLang: 'uk', minConfidence: 0.6, alternativePath: null,
    })
    expect(c.ok).toBe(true)
    const id = c.ok ? c.scenario.id : ''
    expect(await updateScenario(hr(), id, { status: 'published' })).toEqual({ ok: false, code: 'alternative_required' })
    expect((await getScenario(hr(), id))!.status).toBe('draft')

    expect(await updateScenario(hr(), id, { alternativePath: 'text_form', status: 'published' })).toEqual({ ok: false, code: 'criteria_required' })
    for (const cr of CRITERIA) await addCriterion(hr(), id, cr)
    const ok = await updateScenario(hr(), id, { status: 'published' })
    expect(ok).toMatchObject({ ok: true, scenario: { status: 'published', alternativePath: 'text_form', version: 1 } })
  })

  it('мимо сервиса опубликовать без альтернативы не даёт CHECK таблицы; сценарий — только для теста вида interview', async () => {
    const quizId = await makeQuiz(1, [])
    const c = await createScenario(hr(), {
      quizId, name: `${MARK} обхід`, interviewerName: 'Лола', introText: INTRO, outroText: OUTRO, answerModes: ['text'], minAnswerSec: 5,
      maxAnswerSec: 180, thinkTimeSec: 15, silenceTimeoutSec: 45, retakeLimit: 2, recordVideo: false, transcribeLang: 'uk', minConfidence: 0.6, alternativePath: null,
    })
    const id = c.ok ? c.scenario.id : ''
    await expect(admin`update interview_scenarios set status = 'published' where id = ${id}`).rejects.toThrow(/interview_scenarios_alt_published_chk/)

    const plain = await makeQuiz(1, [], 'quiz')
    const bad = await createScenario(hr(), { quizId: plain, name: `${MARK} не той тест`, interviewerName: 'Лола', introText: INTRO, outroText: OUTRO, answerModes: ['text'], minAnswerSec: 5, maxAnswerSec: 180, thinkTimeSec: 15, silenceTimeoutSec: 45, retakeLimit: 2, recordVideo: false, transcribeLang: 'uk', minConfidence: 0.6, alternativePath: 'text_form' })
    expect(bad).toEqual({ ok: false, code: 'quiz_not_interview' })
  })

  it('правка опубликованного — новая версия-черновик с копией критериев; прежняя остаётся у идущих сессий', async () => {
    const quizId = await makeQuiz(1, [])
    const v1 = await publishScenario(quizId)
    const r = await updateScenario(hr(), v1.id, { name: `${MARK} друга редакція` })
    expect(r).toMatchObject({ ok: true, versionCreated: true, scenario: { status: 'draft', version: 2 } })
    if (!r.ok) return
    expect(r.scenario.criteria.map(c => c.name)).toEqual(CRITERIA.map(c => c.name))
    expect((await getScenario(hr(), v1.id))!.status).toBe('published')
    const pub = await updateScenario(hr(), r.scenario.id, { status: 'published' })
    expect(pub).toMatchObject({ ok: true, scenario: { status: 'published', version: 2 } })
    expect((await getScenario(hr(), v1.id))!.status).toBe('archived')
  })
})

// ── Согласие до попытки (к. 1) ──────────────────────────────────────────────────────────

describe('согласие до создания попытки (30 §7.4, §13 к. 1)', () => {
  it('на входе — экран согласия, попытки нет; старт без согласия и обычный путь теста отказывают', async () => {
    const userId = await makeCandidate()
    const quizId = await makeQuiz(3, [userId])
    await publishScenario(quizId)

    const e = await getEntry(actor(userId), quizId, {})
    expect(e).toMatchObject({ ok: true, state: { next: 'consent', sessionId: null } })
    if (!e.ok) return
    expect(e.state.consent.lines).toHaveLength(6)
    expect(e.state.consent.textHash).toMatch(/^[0-9a-f]{64}$/)

    expect(await startSession(actor(userId), quizId, { answerMode: 'text' }, meta)).toEqual({ ok: false, code: 'consent_required' })
    expect(await startAttempt(actor(userId), quizId)).toMatchObject({ ok: false, code: 'interview_required' })
    expect(await admin`select id from attempts where user_id = ${userId}`).toHaveLength(0)

    // Другая редакция текста — согласие не пишется
    const stale = await decideConsent(actor(userId), quizId, { decision: 'accepted', textVersion: e.state.consent.textVersion, textHash: 'a'.repeat(64) }, meta)
    expect(stale).toEqual({ ok: false, code: 'invalid' })
    expect(await admin`select id from interview_consents where user_id = ${userId}`).toHaveLength(0)

    await accept(userId, quizId)
    const [consent] = await admin`select * from interview_consents where user_id = ${userId}`
    expect(consent).toMatchObject({ decision: 'accepted', text_version: e.state.consent.textVersion, text_hash: e.state.consent.textHash, lang: 'uk', ip: '10.1.2.3', user_agent: 'vitest-pr28' })
    expect(consent!.scopes).toEqual({ audio: true, video: false, transcript: true, share_with_hiring_manager: true })
    // Повторное решение по тому же согласию — 409 already_decided
    expect(await decideConsent(actor(userId), quizId, { decision: 'declined', textVersion: e.state.consent.textVersion, textHash: e.state.consent.textHash }, meta)).toEqual({ ok: false, code: 'already_decided' })

    const s = await startSession(actor(userId), quizId, { answerMode: 'text' }, meta)
    expect(s).toMatchObject({ ok: true, resumed: false })
    if (!s.ok) return
    const row = await sessionRow(s.sessionId)
    expect(row).toMatchObject({ state: 'in_progress', answer_mode: 'text', turns_total: 3, consent_id: consent!.id, candidate_id: userId })
    expect(await admin`select id from attempts where user_id = ${userId} and status = 'in_progress'`).toHaveLength(1)
    // Одна операция ai_interview_ops на сессию; повторный старт — та же сессия, без второго резерва
    const again = await startSession(actor(userId), quizId, { answerMode: 'text' }, meta)
    expect(again).toMatchObject({ ok: true, sessionId: s.sessionId, resumed: true })
    const [net] = await admin`select coalesce(sum(delta), 0)::int as n from usage_events where axis = 'ai_interview_ops' and ref_id = ${s.sessionId}`
    expect(net!.n).toBe(1)
  })
})

// ── Отказ (к. 2) ────────────────────────────────────────────────────────────────────────

describe('отказ не закрывает отбор (30 §7.5, §13 к. 2)', () => {
  it('«Не погоджуюсь»: сессии нет, назначение активно, рекрутеру interview_declined, нейтральная строка в истории, оценок нет', async () => {
    const userId = await makeCandidate()
    const quizId = await makeQuiz(2, [userId])
    await publishScenario(quizId, { alternative: 'human_interview' })
    const e = await getEntry(actor(userId), quizId, {})
    if (!e.ok) throw new Error('entry')
    const r = await decideConsent(actor(userId), quizId, { decision: 'declined', textVersion: e.state.consent.textVersion, textHash: e.state.consent.textHash, preferredTime: 'після 18:00' }, meta)
    expect(r).toEqual({ ok: true, next: 'alternative', alternative: 'human_interview' })

    expect(await admin`select id from interview_sessions where candidate_id = ${userId}`).toHaveLength(0)
    expect(await admin`select id from attempts where user_id = ${userId}`).toHaveLength(0)
    expect((await admin`select status from assignments where subject_id = ${quizId}`)[0]!.status).toBe('active')
    expect(await admin`select id from candidate_scores where candidate_id = ${userId}`).toHaveLength(0)
    const [n] = await admin`select payload from notifications where user_id = ${adminId} and code = 'interview_declined' and ref_id = ${userId}`
    expect(n!.payload).toMatchObject({ alternative: 'співбесіда з рекрутером', preferredTime: 'після 18:00', live: true })
    // Живое собеседование — карточка «На перевірці»; состояние воронки не тронуто, отказа нет
    const [u] = await admin`select u.candidate_state, s.code from users u join candidate_statuses s on s.id = u.candidate_status_id where u.id = ${userId}`
    expect(u).toMatchObject({ candidate_state: 'active', code: 'on_review' })
    const history = await listHistory(recruiter, userId)
    expect(history!.some(h => h.event === 'interview_declined' && h.alternative === 'human_interview')).toBe(true)
    expect(history!.some(h => h.event === 'status' && h.reasonCode === 'interview_alternative')).toBe(true)
    // Отказ окончателен для теста: повторного решения нет, старта нет
    expect(await startSession(actor(userId), quizId, { answerMode: 'text' }, meta)).toEqual({ ok: false, code: 'consent_required' })
    expect((await getEntry(actor(userId), quizId, {}))).toMatchObject({ ok: true, state: { next: 'alternative' } })
  })

  it('письменная форма: те же вопросы обычной попыткой без ИИ и записи, ручная проверка', async () => {
    const userId = await makeCandidate()
    const quizId = await makeQuiz(2, [userId])
    await publishScenario(quizId, { alternative: 'text_form' })
    // До решения письменная форма не открывается — сначала экран согласия
    expect(await startTextForm(actor(userId), quizId, {})).toEqual({ ok: false, code: 'consent_required' })
    const e = await getEntry(actor(userId), quizId, {})
    if (!e.ok) throw new Error('entry')
    expect(await decideConsent(actor(userId), quizId, { decision: 'declined', textVersion: e.state.consent.textVersion, textHash: e.state.consent.textHash }, meta))
      .toEqual({ ok: true, next: 'text_form', alternative: 'text_form' })
    const t = await startTextForm(actor(userId), quizId, {})
    expect(t.ok).toBe(true)
    if (!t.ok) return
    const qs = await admin`select snapshot from attempts where id = ${t.attemptId}`
    for (const q of qs[0]!.snapshot as { id: string }[]) {
      expect((await answerTextForm(actor(userId), t.attemptId, q.id, 'Відповідь письмово, без запису')).ok).toBe(true)
    }
    const sub = await submitTextForm(actor(userId), t.attemptId)
    expect(sub).toMatchObject({ ok: true, status: 'review' })
    expect(await admin`select id from interview_sessions where attempt_id = ${t.attemptId}`).toHaveLength(0)
    expect(await admin`select id from ai_calls where subject_user_id = ${userId}`).toHaveLength(0)
    // Колонку канбана письменная форма не двигает; нейтральная строка в истории — есть
    const history = await listHistory(recruiter, userId)
    expect(history!.some(h => h.event === 'interview_declined' && h.alternative === 'text_form')).toBe(true)
  })
})

// ── Обрыв связи и возврат (к. 8) ────────────────────────────────────────────────────────

describe('обрыв связи на 4-й реплике из 8 и возврат через 20 минут (30 §7.12, §13 к. 8)', () => {
  it('пауза при уходе со страницы: продолжение с 4-й реплики, disconnects = 1, попытка цела', async () => {
    const userId = await makeCandidate()
    const quizId = await makeQuiz(8, [userId])
    await publishScenario(quizId)
    const sessionId = await startText(userId, quizId)
    await answerAll(userId, sessionId, 1, 3)
    expect((await getSession(actor(userId), sessionId))!.current!.ordinal).toBe(4)

    expect(await pause(actor(userId), sessionId)).toBe(true)
    expect(await sessionRow(sessionId)).toMatchObject({ state: 'paused', disconnects: 1 })
    await admin`update interview_sessions set last_activity_at = now() - interval '20 minutes' where id = ${sessionId}`

    const back = await heartbeat(actor(userId), sessionId, {}, meta)
    expect(back).toMatchObject({ ok: true, resumed: true, session: { state: 'in_progress', current: { ordinal: 4 } } })
    const row = await sessionRow(sessionId)
    expect(row).toMatchObject({ state: 'in_progress', disconnects: 1, resumes: 1, turns_answered: 3 })
    const [attempt] = await admin`select status from attempts where id = ${row.attempt_id}`
    expect(attempt!.status).toBe('in_progress')
    // Следующее биение без паузы — обычное, не новый обрыв
    expect(await heartbeat(actor(userId), sessionId, {}, meta)).toMatchObject({ ok: true, resumed: false })
    expect((await sessionRow(sessionId)).disconnects).toBe(1)
  })

  it('без паузы: молчание канала дольше порога засчитывается обрывом задним числом при возврате', async () => {
    const userId = await makeCandidate()
    const quizId = await makeQuiz(8, [userId])
    await publishScenario(quizId)
    const sessionId = await startText(userId, quizId)
    await answerAll(userId, sessionId, 1, 3)
    await admin`update interview_sessions set last_activity_at = now() - interval '20 minutes' where id = ${sessionId}`
    const back = await heartbeat(actor(userId), sessionId, { tabSwitches: 7 }, { ip: '10.9.9.9', userAgent: 'vitest-pr28' })
    expect(back).toMatchObject({ ok: true, resumed: true, session: { current: { ordinal: 4 } } })
    const row = await sessionRow(sessionId)
    expect(row).toMatchObject({ disconnects: 1, resumes: 1, ip_changes: 1, tab_switches: 7 })
    expect((row.flags as { code: string }[]).map(f => f.code).sort()).toEqual(['ip_changed', 'tab_switches'])
    // Попытка ИИ-сессии сутками простоя не сгорает: `attempt.expire` её не закрывает
    await admin`update attempts set updated_at = now() - interval '3 days' where id = ${row.attempt_id}`
    await admin`update attempt_answers set answered_at = now() - interval '3 days' where attempt_id = ${row.attempt_id}`
    const { expireStaleAttempts } = await import('../../server/services/attempts')
    await expireStaleAttempts(tenantId)
    expect((await admin`select status from attempts where id = ${row.attempt_id}`)[0]!.status).toBe('in_progress')
  })

  it('сутки без активности — abandoned; письмо кандидату, рекрутеру уведомление; возврат продолжает с той же реплики', async () => {
    const userId = await makeCandidate()
    const quizId = await makeQuiz(3, [userId])
    await publishScenario(quizId)
    const sessionId = await startText(userId, quizId)
    await answerAll(userId, sessionId, 1, 1)
    await admin`update interview_sessions set last_activity_at = now() - interval '25 hours' where id = ${sessionId}`
    const r = await reapSessions(tenantId)
    expect(r.abandoned).toBeGreaterThanOrEqual(1)
    expect((await sessionRow(sessionId)).state).toBe('abandoned')
    expect(await admin`select id from notifications where user_id = ${userId} and code = 'interview_abandoned' and channel = 'email'`).toHaveLength(1)
    expect(await admin`select id from notifications where user_id = ${adminId} and code = 'interview_abandoned_recruiter' and ref_id = ${userId}`).toHaveLength(1)
    const back = await heartbeat(actor(userId), sessionId, {}, meta)
    expect(back).toMatchObject({ ok: true, resumed: true, session: { state: 'in_progress', current: { ordinal: 2 } } })
  })
})

// ── Завершение и оценка (к. 4, к. 5) ────────────────────────────────────────────────────

describe('оценка ИИ: одно число рядом с человеческими, объяснённое, без решений о человеке (30 §7.1, §7.2)', () => {
  it('заглушка: ответ на последнюю реплику завершает сессию, ответы — в ручную проверку, оценка с пометкой заглушки', async () => {
    const userId = await makeCandidate()
    const quizId = await makeQuiz(2, [userId])
    await publishScenario(quizId)
    const sessionId = await startText(userId, quizId)
    await answerAll(userId, sessionId, 1, 2)
    const row = await sessionRow(sessionId)
    expect(row.state).toBe('scoring')
    const [attempt] = await admin`select status from attempts where id = ${row.attempt_id}`
    expect(attempt!.status).toBe('review')
    expect(await admin`select input_mode from attempt_answers where attempt_id = ${row.attempt_id}`).toEqual([{ input_mode: 'text' }, { input_mode: 'text' }])

    expect(await scoreSession(tenantId, sessionId)).toBe('scored')
    const scored = await sessionRow(sessionId)
    expect(scored).toMatchObject({ state: 'scored', ai_stub: true })
    const ics = await admin`select * from interview_criterion_scores where session_id = ${sessionId}`
    expect(ics).toHaveLength(2)
    for (const x of ics) {
      expect(String(x.rationale).length).toBeGreaterThanOrEqual(20)
      expect((x.evidence as unknown[]).length).toBeGreaterThanOrEqual(1)
    }
    const scores = await listScores(recruiter, userId, { kind: 'ai' })
    expect(scores).toHaveLength(1)
    expect(scores![0]).toMatchObject({ kind: 'ai', aiStub: true, sourceType: 'interview', sourceId: sessionId })
    const [n] = await admin`select payload from notifications where user_id = ${adminId} and code = 'interview_completed' and ref_id = ${userId}`
    expect(n!.payload).toMatchObject({ stub: true })

    // Полный вход оценки — файлом в S3 (`origin = 'ai_artifact'`), в журнале — ключ и дайджест
    const [call] = await admin`select * from ai_calls where ref_id = ${sessionId} and prompt_key = 'interview.score'`
    expect(call!.input_ref).toMatch(/^t\/.+\/ai-input-.+\.json$/)
    const [file] = await admin`select origin, owner_user_id, lifecycle from media_assets where key = ${call!.input_ref}`
    expect(file).toEqual({ origin: 'ai_artifact', owner_user_id: userId, lifecycle: 'active' })
    // Через 90 дней ссылка обнуляется, файл — в корзину с немедленной очисткой
    await admin`update ai_calls set created_at = now() - interval '91 days' where id = ${call!.id}`
    const c = await aiCallsCleanup(tenantId)
    expect(c.files).toBeGreaterThanOrEqual(1)
    expect((await admin`select input_ref from ai_calls where id = ${call!.id}`)[0]!.input_ref).toBeNull()
    expect((await admin`select lifecycle from media_assets where key = ${call!.input_ref}`)[0]!.lifecycle).toBe('pending_delete')

    // Вкладка «Співбесіда»: техпаспорт, уверенность словом, признак заглушки
    const view = await candidateInterview(recruiter, userId)
    expect(view!.sessions[0]).toMatchObject({ id: sessionId, aiStub: true, state: 'scored', model: { promptKey: 'interview.score', promptVersion: 'v1' } })
    expect(view!.sessions[0]!.criteria[0]!.rationale).toBeTruthy()
  })

  it('к. 5: сессия scored с баллом 12 из 100 — кандидат active, не отклонён, отказа нет ни при какой настройке тенанта', async () => {
    await netProfile('score', 'interview_score')
    const userId = await makeCandidate()
    const quizId = await makeQuiz(2, [userId])
    await publishScenario(quizId)
    const sessionId = await startText(userId, quizId)
    await answerAll(userId, sessionId, 1, 2)
    const statusBefore = (await admin`select candidate_status_id from users where id = ${userId}`)[0]!.candidate_status_id
    scoreReply((answers, criteria) => ({
      criteria: criteria.map((c, i) => ({
        criterionId: c.criterionId, value: 0.6, confidence: 0.9,
        rationale: 'Відповідь загальна, конкретики про роботу з гостями мало.',
        evidence: [{ turnId: answers[i % answers.length]!.turnId, quote: 'спокійно пояснюю гостю' }],
      })),
    }))
    expect(await scoreSession(tenantId, sessionId)).toBe('scored')
    const row = await sessionRow(sessionId)
    expect(Number(row.ai_score)).toBe(12)
    expect(row.ai_stub).toBe(false)
    const [score] = await admin`select value_num, ai_stub from candidate_scores where candidate_id = ${userId} and kind = 'ai' and is_current`
    expect(score).toEqual({ value_num: '12.00', ai_stub: false })

    // «Ни при какой настройке тенанта»: авто-архивация включена и выключена, ночные задачи
    // воронки отработали — отказа нет, кандидат там же, где был
    const original = await recruitingSettings(hr())
    try {
      for (const settings of [{ autoArchiveRejected: true, archiveAfterDays: 7 }, { autoArchiveRejected: false, archiveAfterDays: 365 }]) {
        await updateRecruiting(hr(), settings as Parameters<typeof updateRecruiting>[1])
        await candidateAutoArchive(tenantId)
        await candidateConsentSweep(tenantId)
        const [u] = await admin`select candidate_state, candidate_status_id from users where id = ${userId}`
        expect(u).toEqual({ candidate_state: 'active', candidate_status_id: statusBefore })
      }
    }
    finally {
      await updateRecruiting(hr(), { autoArchiveRejected: original.autoArchiveRejected, archiveAfterDays: original.archiveAfterDays } as Parameters<typeof updateRecruiting>[1])
    }
    expect(await admin`select id from notifications where user_id = ${userId} and code = 'candidate_rejected'`).toHaveLength(0)
    expect(await admin`select id from candidate_status_history where candidate_id = ${userId} and reason_code is not null`).toHaveLength(0)
    await dropProfiles()
  })

  it('к. 4: модель вернула балл без цитаты — повтор с усиленной инструкцией, строк оценок нет, needs_human, candidate_scores пуста', async () => {
    await netProfile('noev', 'interview_score')
    const userId = await makeCandidate()
    const quizId = await makeQuiz(2, [userId])
    await publishScenario(quizId)
    const sessionId = await startText(userId, quizId)
    await answerAll(userId, sessionId, 1, 2)
    const seen: boolean[] = []
    setAiHttp(async (_url, init) => {
      const body = JSON.parse(String(init!.body)) as { messages: { role: string, content: string }[] }
      seen.push(/previous reply had criteria without rationale/.test(body.messages[0]!.content))
      const user = JSON.parse(body.messages[1]!.content) as { criteria: { criterionId: string }[] }
      const content = JSON.stringify({ criteria: user.criteria.map(c => ({ criterionId: c.criterionId, value: 4, confidence: 0.9, rationale: 'Добре, впевнено, чітко відповідає на питання.', evidence: [] })) })
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
    })
    expect(await scoreSession(tenantId, sessionId)).toBe('needs_human')
    expect(seen).toEqual([false, true])
    expect(await sessionRow(sessionId)).toMatchObject({ state: 'needs_human', degraded_reason: 'unexplained', candidate_score_id: null })
    expect(await admin`select id from interview_criterion_scores where session_id = ${sessionId}`).toHaveLength(0)
    expect(await admin`select id from candidate_scores where candidate_id = ${userId}`).toHaveLength(0)
    expect(await admin`select id from notifications where user_id = ${adminId} and code = 'interview_needs_human' and ref_id = ${userId}`).toHaveLength(1)
    // Кандидат видит «Відповіді надіслано» и одну строку без техники
    expect(await getSession(actor(userId), sessionId)).toMatchObject({ needsHuman: true, current: null })
    await dropProfiles()
  })

  it('«Завершити» раньше последней реплики: без ответов — no_answers, с ответом — сессия к оценке, остальное пропущено', async () => {
    const userId = await makeCandidate()
    const quizId = await makeQuiz(3, [userId])
    await publishScenario(quizId)
    const sessionId = await startText(userId, quizId)
    expect(await finishSession(actor(userId), sessionId, meta)).toEqual({ ok: false, code: 'no_answers' })
    await answerAll(userId, sessionId, 1, 1)
    const r = await finishSession(actor(userId), sessionId, meta)
    expect(r).toMatchObject({ ok: true, session: { state: 'scoring', current: null, turnsAnswered: 1 } })
    expect((await admin`select transcript_status from interview_turns where session_id = ${sessionId} order by ordinal`).map(x => x.transcript_status)).toEqual(['not_needed', 'skipped', 'skipped'])
    expect(await finishSession(actor(userId), sessionId, meta)).toEqual({ ok: false, code: 'not_live' })
    expect((await sessionRow(sessionId)).purge_after).toBeNull()
  })

  it('мимо сервиса база не принимает балл без обоснования, без цитаты и «стёртую» вставку', async () => {
    const userId = await makeCandidate()
    const quizId = await makeQuiz(1, [userId])
    const sc = await publishScenario(quizId)
    const sessionId = await startText(userId, quizId)
    const crit = sc.criteria[0]!.id
    const base = { tenant_id: tenantId, session_id: sessionId, criterion_id: crit, value: 3, confidence: 0.8 }
    await expect(admin`insert into interview_criterion_scores ${admin({ ...base, rationale: 'Обґрунтування достатньої довжини тут.', evidence: admin.json([]) })}`).rejects.toThrow(/ics_evidence_chk/)
    await expect(admin`insert into interview_criterion_scores ${admin({ ...base, rationale: null, evidence: admin.json([{ quote: 'так' }]) })}`).rejects.toThrow(/ics_rationale_chk/)
    await expect(admin`insert into interview_criterion_scores ${admin({ ...base, rationale: 'Обґрунтування достатньої довжини тут.', evidence: admin.json([{ turnId: 'x' }]) })}`).rejects.toThrow(/ics_evidence_quote_chk/)
    await expect(admin`insert into interview_criterion_scores ${admin({ ...base, rationale: null, evidence: admin.json([]), redacted_at: new Date() })}`).rejects.toThrow(/стёртую оценку нельзя вставить/)
  })
})

// ── Отзыв согласия (к. 9) и обезличивание ───────────────────────────────────────────────

describe('отзыв согласия (30 §7.6, §13 к. 9) и обезличивание (30 §7.9)', () => {
  it('аудио в pending_delete той же транзакцией, расшифровки пусты, попытка не failed, рекрутер и HR уведомлены', async () => {
    const userId = await makeCandidate()
    const quizId = await makeQuiz(3, [userId])
    await publishScenario(quizId)
    await accept(userId, quizId)
    const s = await startSession(actor(userId), quizId, { answerMode: 'voice' }, meta)
    if (!s.ok) throw new Error('start')
    const up = await uploadAnswer(actor(userId), s.sessionId, 1, { mime: 'audio/webm', bytes: 2048 }, meta)
    expect(up.ok, JSON.stringify(up)).toBe(true)
    if (!up.ok) return
    const a = await answerTurn(actor(userId), s.sessionId, 1, { mode: 'voice', mediaId: up.mediaId, durationMs: 4200, firstSoundDelayMs: 1200 }, meta)
    expect(a.ok).toBe(true)
    // Заглушка расшифровывает — у реплики есть текст, у ответа попытки тоже
    expect(await transcribeTurn(tenantId, (await admin`select id from interview_turns where session_id = ${s.sessionId} and ordinal = 1`)[0]!.id as string)).toBe('ok')
    await answerAll(userId, s.sessionId, 2, 2)
    const turnsBefore = await admin`select transcript from interview_turns where session_id = ${s.sessionId} and transcript is not null`
    expect(turnsBefore.length).toBe(2)

    expect(await withdrawConsent(actor(userId), s.sessionId, 'передумав')).toEqual({ ok: true })
    const [media] = await admin`select lifecycle, delete_reason, purge_after <= now() as due from media_assets where id = ${up.mediaId}`
    expect(media).toEqual({ lifecycle: 'pending_delete', delete_reason: 'consent_withdrawn', due: true })
    expect(await admin`select id from interview_turns where session_id = ${s.sessionId} and (transcript is not null or prompt_text is not null)`).toHaveLength(0)
    const row = await sessionRow(s.sessionId)
    expect(row).toMatchObject({ state: 'abandoned', degraded_reason: 'consent_withdrawn' })
    expect(row.redacted_at).not.toBeNull()
    const [attempt] = await admin`select status, annul_reason from attempts where id = ${row.attempt_id}`
    expect(attempt).toEqual({ status: 'annulled', annul_reason: 'interview_consent_withdrawn' })
    expect(await admin`select answer from attempt_answers where attempt_id = ${row.attempt_id} and answer is not null`).toHaveLength(0)
    expect((await admin`select decision, withdrawn_at is not null as w from interview_consents where id = ${row.consent_id}`)[0]).toEqual({ decision: 'withdrawn', w: true })
    expect(await admin`select id from notifications where user_id = ${adminId} and code = 'interview_consent_withdrawn' and ref_id = ${userId}`).toHaveLength(1)
    expect(await admin`select output from ai_calls where ref_kind = 'interview_turn' and subject_user_id = ${userId} and output is not null`).toHaveLength(0)
    // Отзыв окончателен: второй раз — already_withdrawn; оценка не формируется
    expect(await withdrawConsent(actor(userId), s.sessionId, null)).toEqual({ ok: false, code: 'already_withdrawn' })
    expect(await scoreSession(tenantId, s.sessionId)).toBe('skipped')
    expect(await getEntry(actor(userId), quizId, {})).toMatchObject({ ok: true, state: { next: 'withdrawn' } })
  })

  it('отзыв без единого ответа возвращает резерв ИИ-операции', async () => {
    const userId = await makeCandidate()
    const quizId = await makeQuiz(2, [userId])
    await publishScenario(quizId)
    const sessionId = await startText(userId, quizId)
    expect(await withdrawConsent(actor(userId), sessionId, null)).toEqual({ ok: true })
    const [net] = await admin`select coalesce(sum(delta), 0)::int as n, count(*)::int as rows from usage_events where axis = 'ai_interview_ops' and ref_id = ${sessionId}`
    expect(net).toEqual({ n: 0, rows: 2 })
  })

  it('обезличивание по механике consent_sweep стирает записи собеседования, баллы и уверенность остаются', async () => {
    const userId = await makeCandidate()
    const quizId = await makeQuiz(2, [userId])
    await publishScenario(quizId)
    const sessionId = await startText(userId, quizId)
    await answerAll(userId, sessionId, 1, 2)
    expect(await scoreSession(tenantId, sessionId)).toBe('scored')

    expect(await withTenant(tenantId, null, tx => anonymizeCandidate(tx, tenantId, userId, null, 'consent_expired'))).toBe(true)
    const ics = await admin`select value, confidence, rationale, evidence, redacted_at from interview_criterion_scores where session_id = ${sessionId}`
    expect(ics).toHaveLength(2)
    for (const x of ics) {
      expect(x.value).not.toBeNull()
      expect(x.confidence).not.toBeNull()
      expect(x.rationale).toBeNull()
      expect(x.evidence).toEqual([])
      expect(x.redacted_at).not.toBeNull()
    }
    expect(await admin`select id from interview_turns where session_id = ${sessionId} and transcript is not null`).toHaveLength(0)
    expect((await admin`select ip, user_agent from interview_consents where user_id = ${userId}`)[0]).toEqual({ ip: null, user_agent: null })
    expect((await sessionRow(sessionId)).ai_score).not.toBeNull()
    expect(await admin`select id from ai_calls where subject_user_id = ${userId} and (output is not null or input_ref is not null)`).toHaveLength(0)
  })
})

// ── Расшифровка по HTTP, прослушивание, исчерпанный ИИ ──────────────────────────────────

describe('расшифровка по HTTP и прослушивание записи (30 §7.8, §7.10; хвост PR-27)', () => {
  it('multipart-запрос с аудио из S3; уверенность ниже порога — ненадёжная реплика и человек вместо оценки', async () => {
    await netProfile('voice', 'transcribe')
    const userId = await makeCandidate()
    const quizId = await makeQuiz(1, [userId])
    await publishScenario(quizId, { modes: ['voice'] })
    await accept(userId, quizId)
    const s = await startSession(actor(userId), quizId, { answerMode: 'voice' }, meta)
    if (!s.ok) throw new Error('start')
    const up = await uploadAnswer(actor(userId), s.sessionId, 1, { mime: 'audio/webm', bytes: 16 }, meta)
    if (!up.ok) throw new Error(JSON.stringify(up))
    const [m] = await admin`select key from media_assets where id = ${up.mediaId}`
    await ensureBucket()
    await s3().send(new PutObjectCommand({ Bucket: S3_BUCKET(), Key: m!.key as string, Body: Buffer.from('OggS-fake-audio!'), ContentType: 'audio/webm' }))
    await answerTurn(actor(userId), s.sessionId, 1, { mode: 'voice', mediaId: up.mediaId, durationMs: 3000 }, meta)
    expect((await sessionRow(s.sessionId)).state).toBe('transcribing')

    const seen: { url: string, file: boolean, fields: Record<string, string> }[] = []
    setAiHttp(async (url, init) => {
      const form = init!.body as FormData
      seen.push({ url: String(url), file: form.get('file') instanceof Blob, fields: { model: String(form.get('model')), language: String(form.get('language')), response_format: String(form.get('response_format')) } })
      return new Response(JSON.stringify({ text: 'Я працював баристою', language: 'ukrainian', segments: [{ avg_logprob: Math.log(0.3) }] }), { status: 200 })
    })
    const turnId = (await admin`select id from interview_turns where session_id = ${s.sessionId}`)[0]!.id as string
    expect(await transcribeTurn(tenantId, turnId)).toBe('low_confidence')
    expect(seen).toEqual([{ url: 'https://api.example.test/v1/audio/transcriptions', file: true, fields: { model: 'net-model', language: 'uk', response_format: 'verbose_json' } }])
    const [turn] = await admin`select transcript, transcript_status, transcript_lang, transcript_engine from interview_turns where id = ${turnId}`
    expect(turn).toEqual({ transcript: 'Я працював баристою', transcript_status: 'low_confidence', transcript_lang: 'uk', transcript_engine: 'openai_compatible:net-model' })
    const [call] = await admin`select input_ref, status from ai_calls where ref_id = ${turnId} and prompt_key = 'interview.transcribe'`
    expect(call).toEqual({ input_ref: m!.key, status: 'ok' })
    expect(await sessionRow(s.sessionId)).toMatchObject({ state: 'needs_human', degraded_reason: 'low_confidence' })
    expect(await admin`select id from candidate_scores where candidate_id = ${userId}`).toHaveLength(0)

    // Прослушивание: ссылка на 15 минут и строка журнала; удалённое аудио — purged
    const before = await admin`select count(*)::int as n from audit_log where action = 'interview.media.listen' and entity_id = ${turnId}`
    const l = await listenTurn(recruiter, userId, turnId)
    expect(l).toMatchObject({ ok: true })
    const after = await admin`select count(*)::int as n from audit_log where action = 'interview.media.listen' and entity_id = ${turnId}`
    expect(after[0]!.n).toBe(before[0]!.n + 1)
    await admin`update media_assets set lifecycle = 'pending_delete', deleted_at = now(), purge_after = now() where id = ${up.mediaId}`
    expect(await listenTurn(recruiter, userId, turnId)).toMatchObject({ ok: false, code: 'purged' })
    await dropProfiles()
  })

  it('перезапись сверх лимита сценария — retake_limit; прежняя запись уходит в корзину сразу', async () => {
    const userId = await makeCandidate()
    const quizId = await makeQuiz(1, [userId])
    await publishScenario(quizId)
    await accept(userId, quizId)
    const s = await startSession(actor(userId), quizId, { answerMode: 'voice' }, meta)
    if (!s.ok) throw new Error('start')
    const ids: string[] = []
    const upload = async () => {
      const r = await uploadAnswer(actor(userId), s.sessionId, 1, { mime: 'audio/ogg', bytes: 1024 }, meta)
      expect(r.ok).toBe(true)
      if (r.ok) ids.push(r.mediaId)
    }
    await upload()
    // Больше 25 МБ — отказ до начала передачи; перезаписью он не считается
    expect(await uploadAnswer(actor(userId), s.sessionId, 1, { mime: 'audio/ogg', bytes: 30 * 1024 * 1024 }, meta)).toMatchObject({ ok: false, code: 'media', mediaCode: 'too_big' })
    await upload()
    await upload()
    expect(await uploadAnswer(actor(userId), s.sessionId, 1, { mime: 'audio/ogg', bytes: 1024 }, meta)).toEqual({ ok: false, code: 'retake_limit' })
    const media = await admin`select id, lifecycle from media_assets where id in ${admin(ids)} order by created_at`
    expect(media.map(x => x.lifecycle)).toEqual(['pending_delete', 'pending_delete', 'active'])
    expect((await admin`select retakes from interview_turns where session_id = ${s.sessionId}`)[0]!.retakes).toBe(2)
    expect(await uploadAnswer(actor(userId), s.sessionId, 2, { mime: 'audio/ogg', bytes: 1024 }, meta)).toEqual({ ok: false, code: 'turn_closed' })
  })

  it('ИИ недоступен: вход сразу предлагает альтернативу, старт отказывает без списания; сессия не создаётся', async () => {
    const userId = await makeCandidate()
    const quizId = await makeQuiz(1, [userId])
    await publishScenario(quizId, { alternative: 'text_form' })
    const e0 = await getEntry(actor(userId), quizId, {})
    if (!e0.ok) throw new Error('entry')
    await accept(userId, quizId)
    await setLimits({ ai_status: 'expired' })
    try {
      expect(await getEntry(actor(userId), quizId, {})).toMatchObject({ ok: true, state: { ai: { available: false, reason: 'expired' } } })
      const s = await startSession(actor(userId), quizId, { answerMode: 'text' }, meta)
      expect(s).toMatchObject({ ok: false, code: 'ai_unavailable', reason: 'expired', alternative: 'text_form' })
      expect(await admin`select id from interview_sessions where candidate_id = ${userId}`).toHaveLength(0)
      expect(await takeAlternativePath(actor(userId), quizId, { reason: 'ai_unavailable' })).toEqual({ ok: true, next: 'text_form', alternative: 'text_form' })
      expect((await startTextForm(actor(userId), quizId, {})).ok).toBe(true)
    }
    finally {
      await setLimits({ ai_status: 'active' })
    }
  })

  it('чужая сессия и неназначенный тест — не существуют (404)', async () => {
    const owner = await makeCandidate()
    const stranger = await makeCandidate()
    const quizId = await makeQuiz(1, [owner])
    await publishScenario(quizId)
    const sessionId = await startText(owner, quizId)
    expect(await getSession(actor(stranger), sessionId)).toBeNull()
    expect(await heartbeat(actor(stranger), sessionId, {}, meta)).toEqual({ ok: false, code: 'not_found' })
    expect(await withdrawConsent(actor(stranger), sessionId, null)).toEqual({ ok: false, code: 'not_found' })
    expect(await getEntry(actor(stranger), quizId, {})).toEqual({ ok: false, code: 'not_found' })
    expect(await listenTurn(recruiter, stranger, randomUUID())).toEqual({ ok: false, code: 'not_found' })
  })
})
