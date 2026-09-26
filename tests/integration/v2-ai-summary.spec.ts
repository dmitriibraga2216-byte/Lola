import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

/**
 * PR-29 пакета `docs/v2` (`45-plan.md`): Підсумок кандидата, подсказка проверяющему, качество ИИ,
 * срок голоса (`30-ai-interview.md` §3.5, §3.6, §6.4, §6.5, §7.3, §7.7, §7.13–§7.16, §11).
 *
 * Критерии приёмки `30` §13, закреплённые за PR-29:
 * - **6** — оценка ИИ 4 из 5, рекрутер ставит 2 с причиной: `agreement = 'major'`, создана
 *   `candidate_scores.kind = 'manual'`, строка `kind = 'ai'` не изменена, создана `ai_quality_reviews`;
 * - **10** — сессия завершена 91 день назад, отработала `interview.media_purge`: аудио физически
 *   удалено, расшифровка и баллы на месте, цитаты открываются без аудио (плюс SQL сквозной
 *   проверки 18 `42` §5 — ноль после прогона, и отказ S3 не глушится);
 * - **11** — у ментора с подсказкой в форме нет предзаполненных значений, подсказка без
 *   «правильно»/«невірно», после решения записан `agreement`;
 * - **13** — авто-отправка по «Оцінка рекрутера» ≥ 60 с задержкой 24 ч: 58 — не отправлен; 61 —
 *   отправлен через 24 ч, до срока отменяется;
 * - **14** — отправленный Підсумок содержит «Документ сформовано автоматично», и настройкой
 *   тенанта её не выключить.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'
process.env.SESSION_SECRET ??= 'test-session-secret'

const { createScenario, updateScenario, addCriterion } = await import('../../server/services/interview/scenarios')
const { getEntry, decideConsent, startSession } = await import('../../server/services/interview/candidate')
const { uploadAnswer, answerTurn, withdrawConsent } = await import('../../server/services/interview/session')
const { transcribeTurn, scoreSession } = await import('../../server/services/interview/pipeline')
const { candidateInterview, listenTurn } = await import('../../server/services/interview/recruiter')
const { overrideCriterion } = await import('../../server/services/interview/override')
const { interviewMediaPurge, assignAudioTerms, setAudioObjectDeleter, AudioPurgeError } = await import('../../server/services/interview/mediaPurge')
const { addScore, listScores, viewerOf } = await import('../../server/services/candidates')
const {
  buildSummaryFor, getSummary, patchSummary, sendSummary, revokeSummary, cancelAutoSend, summaryAutoSendScan, summaryExpire, publicSummary,
} = await import('../../server/services/candidateSummaries')
const { buildReviewHint, getReviewHint } = await import('../../server/services/reviewHints')
const { listQualityReviews, setQualityVerdict, sampleQuality, qualityRollup } = await import('../../server/services/aiQuality')
const { startAttempt, saveAnswer, submitAttempt, gradeManual, listReviewAnswers } = await import('../../server/services/attempts')
const { recruitingSettings, updateRecruiting, updateAiSettings } = await import('../../server/services/settings')
const { purgeDue, restoreFile } = await import('../../server/services/storage')
const { allTenantIds } = await import('../../server/services/tenantResolve')
const { createProvider } = await import('../../server/services/ai/providers')
const { setAiHttp } = await import('../../server/services/ai/drivers')
const { invalidateLimits } = await import('../../server/services/tenantLimits')
const { S3_BUCKET, ensureBucket, s3 } = await import('../../server/services/media')
const { recruitingPatchSchema } = await import('../../shared/schemas/settings')
const { candidateSummaryPatchSchema } = await import('../../shared/schemas/candidateSummaries')
const { reviewAnswersQuerySchema } = await import('../../shared/schemas/quizzes')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const MARK = 'PR29'
const PHONE = '+38067993'
const INTRO = 'Вітаю! Мене звати Лола. Я поставлю кілька запитань про ваш досвід роботи з гостями.'
const OUTRO = 'Дякуємо! Відповіді надіслано рекрутеру.'
const DISCLAIMER = 'Документ сформовано автоматично'

let tenantId: string
let adminId: string
let mentorId: string
let learnerId: string
let recruiter: ReturnType<typeof viewerOf>
const cand: string[] = []
const quizzesMade: string[] = []
const banks: string[] = []
let seq = 0

const actor = (userId: string) => ({ tenantId, actorId: userId })
const hr = () => ({ tenantId, actorId: adminId })
const meta = { ip: '10.2.3.4', userAgent: 'vitest-pr29' }

// ── Помощники ───────────────────────────────────────────────────────────────────────────

async function makeCandidate(patch: Record<string, unknown> = {}): Promise<string> {
  seq++
  const [status] = await admin`select id from candidate_statuses where tenant_id = ${tenantId} and code = 'in_progress'`
  const [row] = await admin`
    insert into users ${admin({
      tenant_id: tenantId, kind: 'candidate', candidate_state: 'active', candidate_state_at: new Date(),
      candidate_status_id: status!.id, full_name: `${MARK} Кандидат ${seq}`, phone: `${PHONE}${String(seq).padStart(4, '0')}`,
      email: `pr29-${seq}-${Date.now()}@example.test`,
      status: 'active', source: 'manual', recruiter_id: adminId, comm_language: 'uk',
      consent_given_at: new Date(), consent_expires_at: new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10),
      ...patch,
    })} returning id`
  cand.push(row!.id as string)
  return row!.id as string
}

async function makeQuiz(n: number, assignTo: string[], opts: { kind?: string, criteria?: string[], reference?: string } = {}): Promise<{ quizId: string, questionIds: string[] }> {
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
      values (${tenantId}, ${bank!.id}, 'free', ${admin.json([{ type: 'text', html: `<p>Питання ${i}: як ви зберігаєте продукти?</p>` }])},
              ${admin.json({ criteria: opts.criteria ?? ['досвід'], reference: opts.reference ?? 'еталон' })}, 2)
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

const CRITERIA = [
  { name: 'Комунікація', description: 'Ясно і спокійно пояснює гостю ситуацію та пропонує рішення', weight: 1, scaleMax: 5, isCritical: false },
  { name: 'Досвід', description: 'Має досвід роботи з гостями та говорить про нього конкретно', weight: 1, scaleMax: 5, isCritical: false },
]

async function publishScenario(quizId: string, modes: ('voice' | 'text')[] = ['voice', 'text']) {
  const c = await createScenario(hr(), {
    quizId, name: `${MARK} сценарій`, interviewerName: 'Лола', introText: INTRO, outroText: OUTRO,
    answerModes: modes, minAnswerSec: 5, maxAnswerSec: 180, thinkTimeSec: 15, silenceTimeoutSec: 45,
    retakeLimit: 2, recordVideo: false, transcribeLang: 'uk', minConfidence: 0.6, alternativePath: 'human_interview',
  })
  if (!c.ok) throw new Error(JSON.stringify(c))
  for (const cr of CRITERIA) expect((await addCriterion(hr(), c.scenario.id, cr)).ok).toBe(true)
  const p = await updateScenario(hr(), c.scenario.id, { status: 'published' })
  if (!p.ok) throw new Error(JSON.stringify(p))
}

async function start(userId: string, quizId: string, answerMode: 'voice' | 'text'): Promise<string> {
  const e = await getEntry(actor(userId), quizId, {})
  if (!e.ok) throw new Error(`entry ${e.code}`)
  const d = await decideConsent(actor(userId), quizId, { decision: 'accepted', textVersion: e.state.consent.textVersion, textHash: e.state.consent.textHash }, meta)
  expect(d).toMatchObject({ ok: true })
  const s = await startSession(actor(userId), quizId, { answerMode }, meta)
  if (!s.ok) throw new Error(JSON.stringify(s))
  return s.sessionId
}

async function answerText(userId: string, sessionId: string, ordinals: number[]) {
  for (const i of ordinals) {
    const r = await answerTurn(actor(userId), sessionId, i, { mode: 'text', text: `Я працював баристою два роки, відповідь ${i}, спокійно пояснюю гостю і пропоную рішення.` }, meta)
    expect(r.ok, JSON.stringify(r)).toBe(true)
  }
}

/** Голосовой ответ: запись действительно лежит в S3 — удалять будет что. */
async function answerVoice(userId: string, sessionId: string, ordinal: number): Promise<{ mediaId: string, key: string }> {
  const up = await uploadAnswer(actor(userId), sessionId, ordinal, { mime: 'audio/webm', bytes: 16 }, meta)
  if (!up.ok) throw new Error(JSON.stringify(up))
  const [m] = await admin`select key from media_assets where id = ${up.mediaId}`
  await ensureBucket()
  await s3().send(new PutObjectCommand({ Bucket: S3_BUCKET(), Key: m!.key as string, Body: Buffer.from('OggS-fake-audio!'), ContentType: 'audio/webm' }))
  const a = await answerTurn(actor(userId), sessionId, ordinal, { mode: 'voice', mediaId: up.mediaId, durationMs: 3000 }, meta)
  expect(a.ok, JSON.stringify(a)).toBe(true)
  return { mediaId: up.mediaId, key: m!.key as string }
}

async function objectExists(key: string): Promise<boolean> {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: S3_BUCKET(), Key: key }))
    return true
  }
  catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    if (status === 404 || (err as Error).name === 'NotFound') return false
    throw err
  }
}

async function netProfile(code: string, purpose: 'interview_score') {
  const r = await createProvider(hr(), {
    code: `pr29-${code}`, name: `PR29 ${code}`, purpose, driver: 'openai_compatible', endpointUrl: 'https://api.example.test/v1',
    modelName: 'net-model', params: {}, dataRegion: 'eu', providerRetention: 'none', maxLatencyMs: 5000, isActive: true, priority: 1,
  } as Parameters<typeof createProvider>[1])
  expect(r.ok, JSON.stringify(r)).toBe(true)
}

/** Оценка «модели»: первый критерий — `first`, остальные — 3, цитаты дословно из ответов. */
function scoreReply(first: number) {
  setAiHttp(async (_url, init) => {
    const body = JSON.parse(String(init!.body)) as { messages: { role: string, content: string }[] }
    const user = JSON.parse(body.messages.find(m => m.role === 'user')!.content) as { criteria: { criterionId: string }[], answers: { turnId: string }[] }
    const content = JSON.stringify({
      criteria: user.criteria.map((c, i) => ({
        criterionId: c.criterionId, value: i === 0 ? first : 3, confidence: 0.9,
        rationale: 'Кандидат описує роботу з гостями, наводить приклад спокійного пояснення.',
        evidence: [{ turnId: user.answers[0]!.turnId, quote: 'спокійно пояснюю гостю' }],
      })),
    })
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
}

async function setAiLimits(v: { ai_review_ops?: number | null }) {
  await admin`insert into tenant_limits (tenant_id) values (${tenantId}) on conflict (tenant_id) do nothing`
  if ('ai_review_ops' in v) await admin`update tenant_limits set ai_review_ops = ${v.ai_review_ops ?? null} where tenant_id = ${tenantId}`
  await admin`update tenant_limits set ai_status = 'active', ai_interview_ops = null where tenant_id = ${tenantId}`
  invalidateLimits(tenantId)
}

/** Сквозная проверка 18 (`42` §5) — дословно запрос документа. */
async function voiceOverdue(): Promise<number> {
  const [r] = await admin`select count(*)::int as n from media_assets where origin = 'interview_answer' and purge_after < now() and lifecycle <> 'purged'`
  return r!.n as number
}

let originalRecruiting: Awaited<ReturnType<typeof recruitingSettings>>

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  mentorId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380670000002'`)[0]!.id as string
  learnerId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380670000003'`)[0]!.id as string
  recruiter = viewerOf({ userId: adminId, tenantId, grants: [{ scopes: ['candidate.view', 'candidate.edit', 'interview.view', 'interview.listen', 'interview.override', 'summary.view', 'summary.edit', 'summary.send'], scopeType: 'tenant', scopeId: null }] })
  await admin`delete from ai_providers where tenant_id = ${tenantId} and code like 'pr29-%'`
  await admin`update tenants set candidates_enabled = true where id = ${tenantId}`
  await setAiLimits({ ai_review_ops: null })
  originalRecruiting = await recruitingSettings(hr())
})

afterEach(() => {
  setAiHttp(null)
  setAudioObjectDeleter(null)
})

afterAll(async () => {
  await admin`delete from ai_providers where tenant_id = ${tenantId} and code like 'pr29-%'`
  await updateRecruiting(hr(), { summaryAutoSend: originalRecruiting.summaryAutoSend })
  await updateAiSettings(hr(), { reviewHints: false })
  await setAiLimits({ ai_review_ops: null })
  const everyone = [...cand, learnerId]
  if (cand.length) {
    const ids = admin(cand)
    await admin`delete from candidate_summaries where candidate_id in ${ids}`
    await admin`delete from ai_quality_reviews where ref_id in (select id from interview_criterion_scores where session_id in (select id from interview_sessions where candidate_id in ${ids}))`
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
  await admin`delete from attempt_answers where attempt_id in (select id from attempts where user_id in ${all} and quiz_id in ${admin(quizzesMade.length ? quizzesMade : ['00000000-0000-0000-0000-000000000000'])})`
  await admin`delete from attempt_results where attempt_id in (select id from attempts where user_id in ${all} and quiz_id in ${admin(quizzesMade.length ? quizzesMade : ['00000000-0000-0000-0000-000000000000'])})`
  await admin`delete from task_access_log where user_id in ${all}`
  await admin`delete from user_activity_events where user_id in ${all}`
  if (quizzesMade.length) {
    await admin`delete from attempts where quiz_id in ${admin(quizzesMade)}`
    await admin`delete from assignments where subject_id in ${admin(quizzesMade)}`
    await admin`delete from interview_scenarios where quiz_id in ${admin(quizzesMade)}`
    await admin`delete from quiz_questions where quiz_id in ${admin(quizzesMade)}`
    await admin`delete from quizzes where id in ${admin(quizzesMade)}`
  }
  if (banks.length) {
    await admin`delete from questions where bank_id in ${admin(banks)}`
    await admin`delete from question_banks where id in ${admin(banks)}`
  }
  if (cand.length) await admin`delete from users where id in ${admin(cand)}`
  await admin.end()
})

// ── к. 6: несогласие с оценкой ИИ ───────────────────────────────────────────────────────

describe('несогласие рекрутера с оценкой ИИ (30 §6.4, §7.3, §12 п. 6, §13 к. 6)', () => {
  it('ИИ 4 из 5, рекрутер 2 с причиной: major, новая manual, строка ai не изменена, строка ai_quality_reviews', async () => {
    await netProfile('score', 'interview_score')
    const userId = await makeCandidate()
    const { quizId } = await makeQuiz(2, [userId])
    await publishScenario(quizId)
    const sessionId = await start(userId, quizId, 'text')
    await answerText(userId, sessionId, [1, 2])
    scoreReply(4)
    expect(await scoreSession(tenantId, sessionId)).toBe('scored')
    const [aiBefore] = await admin`select * from candidate_scores where candidate_id = ${userId} and kind = 'ai'`
    const [crit] = await admin`select c.id from interview_criteria c join interview_sessions s on s.scenario_id = c.scenario_id where s.id = ${sessionId} order by c.sort limit 1`
    const criterionId = crit!.id as string
    expect((await admin`select value from interview_criterion_scores where session_id = ${sessionId} and criterion_id = ${criterionId}`)[0]!.value).toBe('4.00')

    const r = await overrideCriterion(recruiter, userId, criterionId, { humanValue: 2, humanComment: 'Кандидат не навів жодного конкретного прикладу', major: false, expectedHumanAt: null })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (!r.ok) return
    expect(r.override).toMatchObject({ agreement: 'major', value: 4, humanValue: 2 })

    const [ics] = await admin`select id, value, human_value, human_by, agreement from interview_criterion_scores where session_id = ${sessionId} and criterion_id = ${criterionId}`
    expect(ics).toMatchObject({ value: '4.00', human_value: '2.00', human_by: adminId, agreement: 'major' })
    // Строка ai не изменена: та же, действующая, то же число
    const [aiAfter] = await admin`select * from candidate_scores where id = ${aiBefore!.id}`
    expect(aiAfter).toMatchObject({ kind: 'ai', value_num: aiBefore!.value_num, is_current: true, author_id: null })
    // Новая manual авторства человека: итог сессии с его баллом (2 и 3 из 5 → 50)
    const manual = await listScores(recruiter, userId, { kind: 'manual' })
    expect(manual).toHaveLength(1)
    expect(manual![0]).toMatchObject({ kind: 'manual', authorId: adminId, sourceType: 'interview', sourceId: sessionId, valueNum: '50.00', isCurrent: true })
    // Очередь перепроверки качества — сразу, не дожидаясь выборки
    const [q] = await admin`select sampled_by, sample_reason, verdict from ai_quality_reviews where ref_kind = 'interview_criterion_score' and ref_id = ${ics!.id}`
    expect(q).toEqual({ sampled_by: 'override', sample_reason: 'override_major', verdict: null })

    // §12 п. 6: второй рекрутер, не видевший первого несогласия, — 409 и актуальное значение
    const stale = await overrideCriterion(recruiter, userId, criterionId, { humanValue: 5, humanComment: 'Не згоден з колегою, відповідь хороша', major: false, expectedHumanAt: null })
    expect(stale).toMatchObject({ ok: false, code: 'conflict', current: { humanValue: 2, agreement: 'major' } })
    // Видевший — проходит; «груба помилка моделі» кладёт вердикт в ту же строку очереди
    const humanAt = (await admin`select human_at from interview_criterion_scores where id = ${ics!.id}`)[0]!.human_at as Date
    const again = await overrideCriterion(recruiter, userId, criterionId, { humanValue: 1, humanComment: 'Перевірив ще раз: прикладів немає', major: true, expectedHumanAt: humanAt.toISOString() })
    expect(again).toMatchObject({ ok: true, override: { agreement: 'major' } })
    expect((await admin`select verdict, auditor_id from ai_quality_reviews where ref_id = ${ics!.id}`)[0]).toEqual({ verdict: 'major_error', auditor_id: adminId })
    expect(await admin`select id from ai_quality_reviews where ref_id = ${ics!.id}`).toHaveLength(1)
    // Шкала критерия — 5: семь не принимается
    const h2 = (await admin`select human_at from interview_criterion_scores where id = ${ics!.id}`)[0]!.human_at as Date
    expect(await overrideCriterion(recruiter, userId, criterionId, { humanValue: 7, humanComment: 'Бал поза шкалою критерію', major: false, expectedHumanAt: h2.toISOString() }))
      .toEqual({ ok: false, code: 'out_of_scale', scaleMax: 5 })
    // Решения о человеке нет: состояние и колонка канбана те же
    expect((await admin`select candidate_state from users where id = ${userId}`)[0]!.candidate_state).toBe('active')
    await admin`delete from ai_providers where tenant_id = ${tenantId} and code = 'pr29-score'`
  })

  it('совпадение в пределах 10 % шкалы — match, строка качества не ставится', async () => {
    const userId = await makeCandidate()
    const { quizId } = await makeQuiz(1, [userId])
    await publishScenario(quizId)
    const sessionId = await start(userId, quizId, 'text')
    await answerText(userId, sessionId, [1])
    expect(await scoreSession(tenantId, sessionId)).toBe('scored')
    const [ics] = await admin`select id, criterion_id, value from interview_criterion_scores where session_id = ${sessionId} order by created_at limit 1`
    const r = await overrideCriterion(recruiter, userId, ics!.criterion_id as string, { humanValue: Number(ics!.value), humanComment: 'Згоден з оцінкою програми повністю', major: false })
    expect(r).toMatchObject({ ok: true, override: { agreement: 'match', qualityReviewId: null } })
    expect(await admin`select id from ai_quality_reviews where ref_id = ${ics!.id}`).toHaveLength(0)
  })
})

// ── к. 10: голос не живёт дольше срока ──────────────────────────────────────────────────

describe('голос не живёт дольше срока (30 §7.7, §11 interview.media_purge, §13 к. 10; 42 §5 проверка 18)', () => {
  it('сессия завершена 91 день назад: аудио физически удалено, расшифровка и баллы на месте, цитаты без аудио', async () => {
    const userId = await makeCandidate()
    const { quizId } = await makeQuiz(2, [userId])
    await publishScenario(quizId)
    const sessionId = await start(userId, quizId, 'voice')
    const voice = await answerVoice(userId, sessionId, 1)
    const turnId = (await admin`select id from interview_turns where session_id = ${sessionId} and ordinal = 1`)[0]!.id as string
    expect(await transcribeTurn(tenantId, turnId)).toBe('ok')
    await answerText(userId, sessionId, [2])
    // Срок — на самой записи с момента завершения (`finished_at + 90 днів`)
    const [term] = await admin`select m.purge_after, s.purge_after as session_purge from media_assets m, interview_sessions s where m.id = ${voice.mediaId} and s.id = ${sessionId}`
    expect(term!.purge_after).toEqual(term!.session_purge)
    expect(await scoreSession(tenantId, sessionId)).toBe('scored')
    expect(await objectExists(voice.key)).toBe(true)

    // До срока задача голос не трогает
    await interviewMediaPurge(tenantId)
    expect((await admin`select lifecycle from media_assets where id = ${voice.mediaId}`)[0]!.lifecycle).toBe('active')
    expect(await objectExists(voice.key)).toBe(true)

    await admin`update interview_sessions set finished_at = now() - interval '91 days', purge_after = now() - interval '1 day' where id = ${sessionId}`
    await admin`update media_assets set purge_after = now() - interval '1 day' where id = ${voice.mediaId}`
    expect(await voiceOverdue()).toBeGreaterThanOrEqual(1)
    const r = await interviewMediaPurge(tenantId)
    expect(r.purged).toBeGreaterThanOrEqual(1)

    expect(await objectExists(voice.key)).toBe(false)
    const [m] = await admin`select lifecycle, deleted_at from media_assets where id = ${voice.mediaId}`
    expect(m!.lifecycle).toBe('purged')
    expect(m!.deleted_at).not.toBeNull()
    expect(await admin`select id from audit_log where action = 'interview.media.purge' and (after->'mediaIds') ? ${voice.mediaId}`).toHaveLength(1)
    // Расшифровка и баллы на месте, цитата открывается без аудио
    expect((await admin`select transcript from interview_turns where id = ${turnId}`)[0]!.transcript).toBeTruthy()
    expect(await admin`select id from interview_criterion_scores where session_id = ${sessionId} and value is not null and rationale is not null`).toHaveLength(2)
    const view = await candidateInterview(recruiter, userId)
    const s = view!.sessions.find(x => x.id === sessionId)!
    expect(s.criteria.every(c => c.evidence.length >= 1)).toBe(true)
    expect(s.turns.find(t => t.id === turnId)).toMatchObject({ audio: 'deleted' })
    expect(s.turns.find(t => t.id === turnId)!.audioDeletedAt).not.toBeNull()
    expect(await listenTurn(recruiter, userId, turnId)).toMatchObject({ ok: false, code: 'purged' })
  })

  it('запись без срока получает срок; выброшенное в корзину корзина не «очищает» и не восстанавливает; SQL проверки 18 — ноль', async () => {
    const userId = await makeCandidate()
    const { quizId } = await makeQuiz(2, [userId])
    await publishScenario(quizId)
    const sessionId = await start(userId, quizId, 'voice')
    // Перезапись: первая запись — в корзину сразу, вторая — «брошена» без ответа
    const first = await uploadAnswer(actor(userId), sessionId, 1, { mime: 'audio/webm', bytes: 16 }, meta)
    if (!first.ok) throw new Error('upload')
    const second = await uploadAnswer(actor(userId), sessionId, 1, { mime: 'audio/webm', bytes: 16 }, meta)
    if (!second.ok) throw new Error('upload2')
    const [discarded] = await admin`select lifecycle, purge_after <= now() as due from media_assets where id = ${first.mediaId}`
    expect(discarded).toEqual({ lifecycle: 'pending_delete', due: true })

    // storage.purge голос не трогает: пометка purged без удаления объекта оставила бы его навсегда
    await purgeDue(tenantId)
    expect((await admin`select lifecycle from media_assets where id = ${first.mediaId}`)[0]!.lifecycle).toBe('pending_delete')
    // И восстановить выброшенный голос из корзины нельзя
    expect(await restoreFile(hr(), first.mediaId)).toEqual({ ok: false, code: 'not_restorable' })

    // Брошенная сессия: у записи срока нет — задача его назначает (+90 дней от последней активности)
    expect((await admin`select purge_after from media_assets where id = ${second.mediaId}`)[0]!.purge_after).toBeNull()
    expect(await assignAudioTerms(tenantId)).toBeGreaterThanOrEqual(1)
    const [termed] = await admin`select purge_after > now() + interval '80 days' as later from media_assets where id = ${second.mediaId}`
    expect(termed!.later).toBe(true)

    // Прогон по всем тенантам, как у задачи: истёкшего голоса с непомеченным объектом — ноль
    for (const t of await allTenantIds()) await interviewMediaPurge(t)
    expect((await admin`select lifecycle from media_assets where id = ${first.mediaId}`)[0]!.lifecycle).toBe('purged')
    expect(await voiceOverdue()).toBe(0)
  })

  it('отказ S3 при удалении не глушится: строка не purged, журнал purge_failed, задача падает; повтор дочищает', async () => {
    const userId = await makeCandidate()
    const { quizId } = await makeQuiz(1, [userId])
    await publishScenario(quizId)
    const sessionId = await start(userId, quizId, 'voice')
    const voice = await answerVoice(userId, sessionId, 1)
    await admin`update media_assets set purge_after = now() - interval '1 hour' where id = ${voice.mediaId}`

    setAudioObjectDeleter(async () => {
      const e = new Error('The Content-MD5 you specified was invalid')
      e.name = 'MissingContentMD5'
      throw e
    })
    await expect(interviewMediaPurge(tenantId)).rejects.toBeInstanceOf(AudioPurgeError)
    expect((await admin`select lifecycle from media_assets where id = ${voice.mediaId}`)[0]!.lifecycle).toBe('active')
    expect(await objectExists(voice.key)).toBe(true)
    const [failed] = await admin`select after from audit_log where action = 'interview.media.purge_failed' order by created_at desc limit 1`
    expect(JSON.stringify(failed!.after)).toContain('MissingContentMD5')
    expect(await voiceOverdue()).toBeGreaterThanOrEqual(1)

    setAudioObjectDeleter(null)
    await interviewMediaPurge(tenantId)
    expect(await objectExists(voice.key)).toBe(false)
    expect(await voiceOverdue()).toBe(0)
  })
})

// ── к. 11: подсказка проверяющему ───────────────────────────────────────────────────────

describe('подсказка проверяющему — не ответ (30 §3.6, §5.5, §7.13, §13 к. 11)', () => {
  const KEY = ['температура зберігання продуктів', 'термін придатності кожної позиції']
  const ANSWER = 'Кожного ранку перевіряю умови зберігання: холодильник має бути в нормі, продукти підписані.'

  async function submitFree(userId: string): Promise<string> {
    const { quizId, questionIds } = await makeQuiz(1, [userId], { kind: 'quiz', criteria: KEY, reference: 'Температура 0…+4, термін придатності на етикетці' })
    const a = await startAttempt(actor(userId), quizId)
    if (!a.ok) throw new Error(JSON.stringify(a))
    const saved = await saveAnswer(actor(userId), a.attemptId, questionIds[0]!, { text: ANSWER })
    expect(saved.ok, JSON.stringify(saved)).toBe(true)
    const sub = await submitAttempt(actor(userId), a.attemptId)
    expect(sub).toMatchObject({ ok: true, status: 'review' })
    const [ans] = await admin`select id from attempt_answers where attempt_id = ${a.attemptId}`
    return ans!.id as string
  }

  it('подсказка — три списка без вердикта; форма ментора пуста; после решения записан agreement', async () => {
    await updateAiSettings(hr(), { reviewHints: true })
    const answerId = await submitFree(learnerId)
    const [queued] = await admin`select id, state, target_kind from ai_review_hints where target_id = ${answerId}`
    expect(queued).toMatchObject({ state: 'queued', target_kind: 'attempt_answer' })
    expect(await buildReviewHint(tenantId, queued!.id as string)).toBe('ready')

    const [row] = await admin`select * from ai_review_hints where id = ${queued!.id}`
    // Полей вердикта в таблице нет вовсе, в строке — только три списка и покрытие
    for (const col of ['is_correct', 'score', 'verdict', 'passed']) expect(Object.keys(row!)).not.toContain(col)
    expect(row!.matched).toEqual([expect.objectContaining({ keyPoint: KEY[0], quote: 'зберігання' })])
    expect(row!.missing).toEqual([{ keyPoint: KEY[1] }])
    expect(row!.coverage).toBe('0.500')
    expect(row!.ai_stub).toBe(true)

    // Форма ментора: решение не предзаполнено — ответ не оценён (`is_correct` пуст, балл — нулевой
    // балл движка для любого непроверенного ручного ответа), подсказки в ответе очереди нет вовсе
    const items = await listReviewAnswers(actor(mentorId), reviewAnswersQuerySchema.parse({ checked: 'unchecked' }))
    const item = items.find(i => i.answerId === answerId)!
    expect(item).toMatchObject({ isCorrect: null, score: 0, reviewedAt: null })
    expect(JSON.stringify(item)).not.toMatch(/coverage|matched|keyPoint/)
    expect((await admin`select is_correct, reviewed_by from attempt_answers where id = ${answerId}`)[0]).toEqual({ is_correct: null, reviewed_by: null })

    // Панель: «Це не оцінка» — ни «правильно», ни «невірно», ни «зарахувати»
    const hint = await getReviewHint(actor(mentorId), 'attempt_answer', answerId, { admin: false })
    expect(hint).toMatchObject({ ok: true, hint: { state: 'ready', coverage: { matched: 1, total: 2 }, aiStub: true, reason: null } })
    expect(JSON.stringify(hint)).not.toMatch(/правильн|невірн|зарахува|isCorrect|"score"|verdict/i)
    expect((await admin`select shown_at from ai_review_hints where id = ${queued!.id}`)[0]!.shown_at).not.toBeNull()
    // Автор ответа своей подсказки не видит
    expect(await getReviewHint(actor(learnerId), 'attempt_answer', answerId, { admin: false })).toEqual({ ok: false, code: 'absent' })

    // Решение ментора — его; покрытие 0,5 при зачёте — minor
    const g = await gradeManual(actor(mentorId), answerId, { isCorrect: true, score: 2 })
    expect(g.ok, JSON.stringify(g)).toBe(true)
    const [after] = await admin`select agreement, reviewer_id, reviewer_decision from ai_review_hints where id = ${queued!.id}`
    expect(after).toEqual({ agreement: 'minor', reviewer_id: mentorId, reviewer_decision: { passed: true, decision: 'accepted' } })
    // Ответ оценил человек и ровно так, как решил он
    expect((await admin`select is_correct, score, reviewed_by from attempt_answers where id = ${answerId}`)[0]).toEqual({ is_correct: true, score: '2.00', reviewed_by: mentorId })
  })

  it('ментор решил, не раскрыв подсказку, — not_shown (контрольная группа, §12 п. 12)', async () => {
    await updateAiSettings(hr(), { reviewHints: true })
    const answerId = await submitFree(learnerId)
    const [h] = await admin`select id from ai_review_hints where target_id = ${answerId}`
    expect(await buildReviewHint(tenantId, h!.id as string)).toBe('ready')
    expect((await gradeManual(actor(mentorId), answerId, { isCorrect: false, comment: 'Не згадано термін придатності продуктів' })).ok).toBe(true)
    expect((await admin`select agreement from ai_review_hints where id = ${h!.id}`)[0]!.agreement).toBe('not_shown')
  })

  it('ось ai_review_ops исчерпана — degraded, работа идёт обычной ручной проверкой; функция выключена — строки нет', async () => {
    await updateAiSettings(hr(), { reviewHints: true })
    await setAiLimits({ ai_review_ops: 0 })
    try {
      const answerId = await submitFree(learnerId)
      const [h] = await admin`select id from ai_review_hints where target_id = ${answerId}`
      expect(await buildReviewHint(tenantId, h!.id as string)).toBe('degraded')
      expect(await getReviewHint(actor(mentorId), 'attempt_answer', answerId, { admin: false })).toEqual({ ok: false, code: 'degraded' })
      expect(await admin`select id from review_queue_items where source_id = ${answerId} and status <> 'done'`).toHaveLength(1)
    }
    finally {
      await setAiLimits({ ai_review_ops: null })
    }
    await updateAiSettings(hr(), { reviewHints: false })
    const off = await submitFree(learnerId)
    expect(await admin`select id from ai_review_hints where target_id = ${off}`).toHaveLength(0)
  })
})

// ── к. 13, к. 14: Підсумок, авто-отправка, неснимаемая строка ──────────────────────────

describe('Підсумок кандидата и авто-отправка (30 §5.4, §6.5, §7.14, §7.15, §13 к. 13, 14)', () => {
  const H = 3_600_000

  async function scoredCandidate(): Promise<string> {
    const userId = await makeCandidate()
    const { quizId } = await makeQuiz(1, [userId])
    await publishScenario(quizId)
    const sessionId = await start(userId, quizId, 'text')
    await answerText(userId, sessionId, [1])
    expect(await scoreSession(tenantId, sessionId)).toBe('scored')
    return userId
  }

  async function recruiterScore(userId: string, value: number) {
    const r = await addScore(recruiter, userId, { kind: 'recruiter', valueNum: value })
    expect(r.ok, JSON.stringify(r)).toBe(true)
  }

  it('к. 13: порог «Оцінка рекрутера» 60, задержка 24 ч — 58 не отправлен, 61 отправлен через 24 ч', async () => {
    await updateRecruiting(hr(), { summaryAutoSend: { enabled: true, scoreKind: 'recruiter', minScore: 60, delayHours: 24, skipRejected: true } })
    const userId = await scoredCandidate()
    const built = await buildSummaryFor(tenantId, adminId, userId)
    expect(built.ok, JSON.stringify(built)).toBe(true)
    if (!built.ok) return
    expect(built.summary.state).toBe('ready')

    const t0 = new Date()
    await recruiterScore(userId, 58)
    await summaryAutoSendScan(tenantId, t0)
    let [s] = await admin`select state, auto_send_due_at from candidate_summaries where id = ${built.summary.id}`
    expect(s).toEqual({ state: 'ready', auto_send_due_at: null })

    await recruiterScore(userId, 61)
    const report = await summaryAutoSendScan(tenantId, t0)
    expect(report.scheduled).toBeGreaterThanOrEqual(1)
    ;[s] = await admin`select state, auto_send_due_at, auto_send_rule from candidate_summaries where id = ${built.summary.id}`
    expect(s!.state).toBe('ready')
    expect(new Date(s!.auto_send_due_at as Date).getTime()).toBe(t0.getTime() + 24 * H)
    expect(s!.auto_send_rule).toMatchObject({ scoreKind: 'recruiter', minScore: 60, trigger: { kind: 'recruiter', value: 61 } })
    const [scheduledNotice] = await admin`select payload from notifications where user_id = ${adminId} and code = 'summary_auto_send_scheduled' and ref_id = ${userId}`
    expect(scheduledNotice).toBeTruthy()
    // «Буде надіслано {{time}}» — дата без часу не давала зрозуміти, до якого моменту можна
    // скасувати (`docs/v2/46-progress.md`, «Что осталось»): рендер має містити саме годину:хвилину
    const { renderTemplate, DEFAULT_TEMPLATES } = await import('../../server/services/notifications')
    const rendered = renderTemplate(DEFAULT_TEMPLATES.summary_auto_send_scheduled!, { name: 'Тест', time: (scheduledNotice!.payload as { time: string }).time })
    expect(rendered).toMatch(/\d{1,2}:\d{2}/)

    // Через 23 часа — ещё нет; через 24 — отправлен письмом, ссылка на 30 дней
    await summaryAutoSendScan(tenantId, new Date(t0.getTime() + 23 * H))
    expect((await admin`select state from candidate_summaries where id = ${built.summary.id}`)[0]!.state).toBe('ready')
    await summaryAutoSendScan(tenantId, new Date(t0.getTime() + 24 * H + 60_000))
    const [sent] = await admin`select state, share_token, sent_channel, sent_by, share_expires_at > now() + interval '29 days' as month from candidate_summaries where id = ${built.summary.id}`
    expect(sent).toMatchObject({ state: 'sent', sent_channel: 'email', sent_by: null, month: true })
    expect(sent!.share_token).toBeTruthy()
    const [mail] = await admin`select channel, payload from notifications where user_id = ${userId} and code = 'interview_result_ready'`
    expect(mail!.channel).toBe('email')
    expect(String((mail!.payload as { url: string }).url)).toContain(`/summary/${sent!.share_token}`)
  })

  it('к. 13: до auto_send_due_at отправку можно отменить — не уходит и заново не ставится; отклонённому — не назначается', async () => {
    await updateRecruiting(hr(), { summaryAutoSend: { enabled: true, scoreKind: 'recruiter', minScore: 60, delayHours: 24, skipRejected: true } })
    const userId = await scoredCandidate()
    const built = await buildSummaryFor(tenantId, adminId, userId)
    if (!built.ok) throw new Error('build')
    await recruiterScore(userId, 75)
    const t0 = new Date()
    await summaryAutoSendScan(tenantId, t0)
    expect((await admin`select auto_send_due_at from candidate_summaries where id = ${built.summary.id}`)[0]!.auto_send_due_at).not.toBeNull()
    expect(await cancelAutoSend(recruiter, built.summary.id)).toEqual({ ok: true })
    await summaryAutoSendScan(tenantId, new Date(t0.getTime() + 25 * H))
    await summaryAutoSendScan(tenantId, new Date(t0.getTime() + 26 * H))
    expect((await admin`select state, auto_send_due_at, auto_send_cancelled_by from candidate_summaries where id = ${built.summary.id}`)[0])
      .toEqual({ state: 'ready', auto_send_due_at: null, auto_send_cancelled_by: adminId })
    expect(await admin`select id from notifications where user_id = ${userId} and code = 'interview_result_ready'`).toHaveLength(0)

    const rejected = await scoredCandidate()
    await admin`update users set candidate_state = 'rejected' where id = ${rejected}`
    const b2 = await buildSummaryFor(tenantId, adminId, rejected)
    if (!b2.ok) throw new Error('build2')
    await recruiterScore(rejected, 90)
    await summaryAutoSendScan(tenantId, new Date())
    expect((await admin`select auto_send_due_at from candidate_summaries where id = ${b2.summary.id}`)[0]!.auto_send_due_at).toBeNull()
  })

  it('к. 14: «Документ сформовано автоматично» — в теле, в письме и по ссылке; не снимается ни секциями, ни правкой, ни настройкой, ни прямой записью', async () => {
    const userId = await scoredCandidate()
    // Настройка тенанта, которой «выключили бы» строку, не принимается вовсе…
    expect(recruitingPatchSchema.safeParse({ summaryDisclaimer: false }).success).toBe(false)
    expect(recruitingPatchSchema.safeParse({ summaryAutoSend: { showDisclaimer: false } }).success).toBe(false)
    // …а записанная мимо API — ничего не меняет
    await admin`update tenants set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{recruiting,hideAutoDisclaimer}', 'true'::jsonb) where id = ${tenantId}`
    try {
      const built = await buildSummaryFor(tenantId, adminId, userId)
      if (!built.ok) throw new Error('build')
      expect(built.summary.body!.disclaimer.text.startsWith(DISCLAIMER)).toBe(true)
      expect(built.summary.disclaimerLine).toContain(DISCLAIMER)
      expect(built.summary.body!.strengthsRisks.caveat).toBeTruthy()

      // Все секции выключены, текст генеративной секции переписан — строка на месте
      expect(candidateSummaryPatchSchema.safeParse({ disclaimer: null }).success).toBe(false)
      const p = await patchSummary(recruiter, built.summary.id, { sections: [], strengths: ['Спокійно пояснює гостям'], risks: [] }, true)
      expect(p).toMatchObject({ ok: true, summary: { generatedBy: 'ai_edited', sections: [] } })
      expect((await admin`select body->'disclaimer'->>'text' as t from candidate_summaries where id = ${built.summary.id}`)[0]!.t).toMatch(new RegExp(`^${DISCLAIMER}`))

      const sent = await sendSummary(recruiter, built.summary.id, 'email')
      expect(sent.ok, JSON.stringify(sent)).toBe(true)
      if (!sent.ok) return
      const [mail] = await admin`select payload from notifications where user_id = ${userId} and code = 'interview_result_ready'`
      expect(mail).toBeTruthy()
      const { DEFAULT_TEMPLATES } = await import('../../server/services/notifications')
      expect(DEFAULT_TEMPLATES.interview_result_ready).toContain(DISCLAIMER)

      const pub = await publicSummary(sent.shareToken, { ip: '10.9.9.9' })
      expect(pub.ok, JSON.stringify(pub)).toBe(true)
      if (!pub.ok) return
      expect(pub.summary.disclaimerLine).toContain(DISCLAIMER)
      expect(pub.summary.document.disclaimer.text).toContain(DISCLAIMER)
      // Секции выключены — их нет; ПД третьих лиц (авторы оценок) наружу не уходят
      expect(Object.keys(pub.summary.document)).toEqual(['disclaimer'])

      // Мимо сервиса строку не снять: CHECK таблицы
      await expect(admin`update candidate_summaries set body = body - 'disclaimer' where id = ${built.summary.id}`).rejects.toMatchObject({ code: '23514' })
      await expect(admin`update candidate_summaries set body = jsonb_set(body, '{disclaimer,text}', '"Звіт"') where id = ${built.summary.id}`).rejects.toMatchObject({ code: '23514' })
      // Отправленный документ не правится
      expect(await patchSummary(recruiter, built.summary.id, { risks: ['Інший текст'] }, true)).toEqual({ ok: false, code: 'sent' })
    }
    finally {
      await admin`update tenants set settings = settings #- '{recruiting,hideAutoDisclaimer}' where id = ${tenantId}`
    }
  })

  it('ссылка: неизвестная — not_found, отозванная — revoked, истёкшая — expired; новая версия закрывает старую', async () => {
    const userId = await scoredCandidate()
    const b1 = await buildSummaryFor(tenantId, adminId, userId)
    if (!b1.ok) throw new Error('build')
    const s1 = await sendSummary(recruiter, b1.summary.id, 'link')
    if (!s1.ok) throw new Error(JSON.stringify(s1))
    expect(await publicSummary('x'.repeat(32), { ip: '10.9.9.8' })).toEqual({ ok: false, code: 'not_found' })
    expect((await publicSummary(s1.shareToken, { ip: '10.9.9.8' })).ok).toBe(true)
    // Новая генерация — прежняя версия по ссылке недоступна
    const b2 = await buildSummaryFor(tenantId, adminId, userId)
    if (!b2.ok) throw new Error('build2')
    expect(b2.summary.version).toBe(b1.summary.version + 1)
    expect(await publicSummary(s1.shareToken, { ip: '10.9.9.8' })).toEqual({ ok: false, code: 'revoked' })
    const s2 = await sendSummary(recruiter, b2.summary.id, 'link')
    if (!s2.ok) throw new Error('send2')
    expect(await sendSummary(recruiter, b1.summary.id, 'link')).toEqual({ ok: false, code: 'not_latest' })
    // Истёк срок ссылки
    await admin`update candidate_summaries set share_expires_at = now() - interval '1 minute' where id = ${b2.summary.id}`
    expect(await summaryExpire(tenantId)).toBeGreaterThanOrEqual(1)
    expect(await publicSummary(s2.shareToken, { ip: '10.9.9.8' })).toEqual({ ok: false, code: 'expired' })
    // Отзыв рекрутером
    const b3 = await buildSummaryFor(tenantId, adminId, userId)
    if (!b3.ok) throw new Error('build3')
    const s3r = await sendSummary(recruiter, b3.summary.id, 'link')
    if (!s3r.ok) throw new Error('send3')
    expect(await revokeSummary(recruiter, b3.summary.id, 'помилково надіслано')).toEqual({ ok: true })
    expect(await publicSummary(s3r.shareToken, { ip: '10.9.9.8' })).toEqual({ ok: false, code: 'revoked' })
    expect((await getSummary(recruiter, b3.summary.id, true))!.state).toBe('revoked')
  })

  it('отзыв согласия после отправки: Підсумок отозван и стёрт, баллы у рекрутера остаются (30 §12 п. 4)', async () => {
    const userId = await makeCandidate()
    const { quizId } = await makeQuiz(1, [userId])
    await publishScenario(quizId)
    const sessionId = await start(userId, quizId, 'text')
    await answerText(userId, sessionId, [1])
    expect(await scoreSession(tenantId, sessionId)).toBe('scored')
    const b = await buildSummaryFor(tenantId, adminId, userId)
    if (!b.ok) throw new Error('build')
    const sent = await sendSummary(recruiter, b.summary.id, 'link')
    if (!sent.ok) throw new Error('send')
    expect(await withdrawConsent(actor(userId), sessionId, 'передумав')).toEqual({ ok: true })
    const [row] = await admin`select state, body, redacted_at, revoke_reason from candidate_summaries where id = ${b.summary.id}`
    expect(row).toMatchObject({ state: 'revoked', body: {}, revoke_reason: 'consent_withdrawn' })
    expect(row!.redacted_at).not.toBeNull()
    expect(await publicSummary(sent.shareToken, { ip: '10.9.9.7' })).toEqual({ ok: false, code: 'revoked' })
    expect(await admin`select id from interview_criterion_scores where session_id = ${sessionId} and value is not null`).toHaveLength(2)
    expect(await sendSummary(recruiter, b.summary.id, 'email')).toEqual({ ok: false, code: 'not_ready' })
  })
})

// ── Качество ИИ: выборка, вердикт, метрика (30 §7.16) ───────────────────────────────────

describe('качество ИИ: выборка, вердикт о модели, метрика расхождения (30 §7.16, §8 ai.quality_degraded)', () => {
  it('ежедневная выборка берёт все major, вердикт пишет аудитор, метрика считает долю major по версии промпта', async () => {
    const userId = await makeCandidate()
    const { quizId } = await makeQuiz(1, [userId])
    await publishScenario(quizId)
    const sessionId = await start(userId, quizId, 'text')
    await answerText(userId, sessionId, [1])
    expect(await scoreSession(tenantId, sessionId)).toBe('scored')
    const scores = await admin`select id, criterion_id, value from interview_criterion_scores where session_id = ${sessionId}`
    // Второй критерий — major вручную (значение модели и человека на разных концах шкалы)
    await admin`update interview_criterion_scores set human_value = case when value::float8 > 2.5 then 0 else 5 end, human_at = now(), human_by = ${adminId}, agreement = 'major' where id = ${scores[1]!.id}`

    await sampleQuality(tenantId)
    const [picked] = await admin`select id, sampled_by, sample_reason from ai_quality_reviews where ref_id = ${scores[1]!.id}`
    expect(picked).toMatchObject({ sampled_by: 'auto', sample_reason: 'major' })
    // Повторный прогон дублей не даёт
    await sampleQuality(tenantId)
    expect(await admin`select id from ai_quality_reviews where ref_id = ${scores[1]!.id}`).toHaveLength(1)

    const list = await listQualityReviews(hr(), { status: 'pending', limit: 100 })
    const item = list.items.find(i => i.id === picked!.id)!
    expect(item.subject).toMatchObject({ agreement: 'major', promptVersion: 'v1' })
    const v = await setQualityVerdict(hr(), picked!.id as string, { verdict: 'minor_error', notes: 'Модель переоцінила приклад' })
    expect(v).toMatchObject({ verdict: 'minor_error', auditorId: adminId })

    const metrics = await qualityRollup(tenantId)
    const m = metrics.find(x => x.kind === 'interview_score' && x.promptKey === 'interview.score')
    expect(m).toBeTruthy()
    expect(m!.major).toBeGreaterThanOrEqual(1)
  })
})
