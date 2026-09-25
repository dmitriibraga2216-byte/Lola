import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { attemptAnswers, attempts, interviewConsents, interviewSessions, interviewTurns } from '../../db/schema'
import { withTenant, type TenantTx } from '../../utils/withTenant'
import { currentRequestContext } from '../../utils/requestContext'
import { recordAudit } from '../audit'
import { approvedExtraAttempts, effectiveAttemptsAllowed, saveAnswer, startAttemptTx, submitAttempt, type StartResult } from '../attempts'
import { resolveQuizParams } from '../taskParams'
import { interviewAlternativeTx } from '../candidateJobs'
import { releaseSessionOp, reserveSessionOp } from '../ai/gateway'
import type { AiUnavailableReason } from '../ai/policy'
import type { LimitCheck } from '../tenantLimits'
import { stripAnswers, type SnapshotQuestion } from '../../../shared/domain/grading'
import { INTERVIEW_DONE_STATES } from '../../../shared/domain/interview'
import type { InterviewAlternativePath, InterviewAnswerMode, InterviewSessionState } from '../../../shared/enums'
import type { InterviewAlternativeInput, InterviewConsentInput, InterviewEntryQuery, InterviewStartInput } from '../../../shared/schemas/interview'
import {
  ALTERNATIVE_LABEL_UK, aiState, consentText, latestDecision, notifyAll, promptTextOf, recruitingRecipients, resolveEntry, scenarioIdsOf,
  type AiState, type ConsentText, type Ctx, type Entry, type EntryError, type Scenario,
} from './common'

/**
 * Вход кандидата в собеседование: экран согласия, отказ и альтернатива, старт сессии, письменная
 * форма (`docs/v2/30-ai-interview.md` §4, §5.1, §6.3, §7.4, §7.5, §7.12, §12 п. 1; план `45` PR-28).
 *
 * **Согласие — до попытки** (`30` §7.4, §13 к. 1): попытки теста вида `interview` без решения по
 * согласию не бывает — ни здесь, ни обычным путём теста (`attempts.ts#startAttemptTx`). Проверка
 * на сервере: прямой `POST …/start` без согласия — `409 interview_consent.required`.
 *
 * **Отказ не закрывает отбор** (`30` §7.5, §13 к. 2): сессия не создаётся, назначение остаётся
 * активным, рекрутеру — `interview_declined`, в истории кандидата — нейтральная строка, в оценки
 * ничего не пишется. Та же альтернатива предлагается, когда ИИ недоступен (подписка, исчерпанная
 * ось — `30` §7.12, §7.20) и когда без микрофона отвечать нечем (`30` §12 п. 1).
 */

// ── Состояние входа ─────────────────────────────────────────────────────────────────────

/**
 * Что показать кандидату на входе:
 * - `consent` — экран согласия (`30` §5.1); `start` — согласие дано, проверка микрофона и старт;
 * - `resume` — идёт сессия, продолжение с той же реплики (`30` §7.12);
 * - `alternative` — выбрано живое собеседование, ждать рекрутера; `text_form` — письменная форма;
 * - `unavailable` — ИИ сейчас недоступен, предложить альтернативу сценария;
 * - `withdrawn` — согласие отозвано; `done` — ответы отправлены, попыток больше нет.
 */
export type EntryNext = 'consent' | 'start' | 'resume' | 'alternative' | 'text_form' | 'unavailable' | 'withdrawn' | 'done'

export interface EntryState {
  quizId: string
  quizTitle: string
  scenario: {
    id: string
    version: number
    interviewerName: string
    introText: string
    outroText: string
    answerModes: InterviewAnswerMode[]
    alternativePath: InterviewAlternativePath
    minAnswerSec: number
    maxAnswerSec: number
    thinkTimeSec: number
    silenceTimeoutSec: number
    retakeLimit: number
  }
  consent: ConsentText
  next: EntryNext
  ai: AiState
  decision: { decision: string, alternative: string | null, decidedAt: string } | null
  sessionId: string | null
  lastSession: { id: string, state: InterviewSessionState, finishedAt: string | null, needsHuman: boolean } | null
  textForm: { attemptId: string, status: string } | null
}

/** Сессия, к которой кандидат возвращается: идёт, на паузе или брошена без отзыва согласия. */
async function liveSession(tx: TenantTx, userId: string, scenarioIds: string[]) {
  if (!scenarioIds.length) return null
  const [row] = await tx.select({ id: interviewSessions.id, state: interviewSessions.state, attemptId: interviewSessions.attemptId })
    .from(interviewSessions)
    .innerJoin(attempts, eq(attempts.id, interviewSessions.attemptId))
    .where(and(
      eq(interviewSessions.candidateId, userId),
      inArray(interviewSessions.scenarioId, scenarioIds),
      eq(attempts.status, 'in_progress'),
      sql`(${interviewSessions.state} in ('in_progress', 'paused') or (${interviewSessions.state} = 'abandoned' and ${interviewSessions.degradedReason} is null))`,
    ))
    .orderBy(desc(interviewSessions.createdAt))
    .limit(1)
  return row ?? null
}

/** Попытка письменной формы — попытка теста собеседования без ИИ-сессии (`30` §7.5 `text_form`). */
async function textFormAttempt(tx: TenantTx, userId: string, quizId: string) {
  const [row] = await tx.select({ id: attempts.id, status: attempts.status })
    .from(attempts)
    .where(and(
      eq(attempts.quizId, quizId),
      eq(attempts.userId, userId),
      sql`${attempts.status} <> 'annulled'`,
      sql`not exists (select 1 from interview_sessions s where s.attempt_id = ${attempts.id})`,
    ))
    .orderBy(desc(attempts.attemptNo))
    .limit(1)
  return row ?? null
}

async function consumed(tx: TenantTx, consentId: string): Promise<boolean> {
  const [row] = await tx.select({ id: interviewSessions.id }).from(interviewSessions).where(eq(interviewSessions.consentId, consentId)).limit(1)
  return !!row
}

async function attemptsLeft(tx: TenantTx, ctx: Ctx, quizId: string, enrollmentId?: string | null): Promise<number | null> {
  const { params } = await resolveQuizParams(tx, { tenantId: ctx.tenantId, userId: ctx.actorId, quizId, enrollmentId })
  const allowed = effectiveAttemptsAllowed(params, await approvedExtraAttempts(tx, ctx.actorId, quizId, enrollmentId))
  if (allowed === 0) return null
  const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(attempts)
    .where(and(eq(attempts.quizId, quizId), eq(attempts.userId, ctx.actorId), sql`${attempts.status} <> 'annulled'`)) as [{ n: number }]
  return Math.max(0, allowed - Number(n))
}

function scenarioView(s: Scenario): EntryState['scenario'] {
  return {
    id: s.id,
    version: s.version,
    interviewerName: s.interviewerName,
    introText: s.introText,
    outroText: s.outroText,
    answerModes: s.answerModes as InterviewAnswerMode[],
    alternativePath: s.alternativePath as InterviewAlternativePath,
    minAnswerSec: s.minAnswerSec,
    maxAnswerSec: s.maxAnswerSec,
    thinkTimeSec: s.thinkTimeSec,
    silenceTimeoutSec: s.silenceTimeoutSec,
    retakeLimit: s.retakeLimit,
  }
}

export async function getEntry(ctx: Ctx, quizId: string, q: InterviewEntryQuery): Promise<{ ok: true, state: EntryState } | { ok: false, code: EntryError }> {
  const ai = await aiState(ctx.tenantId)
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const r = await resolveEntry(tx, ctx, quizId, q.enrollmentId)
    if (!r.ok) return r
    const { quiz, scenario } = r.entry
    const ids = await scenarioIdsOf(tx, quizId)
    const live = await liveSession(tx, ctx.actorId, ids)
    const decision = await latestDecision(tx, ctx.actorId, quizId)
    const text = await textFormAttempt(tx, ctx.actorId, quizId)
    const [last] = await tx.select({ id: interviewSessions.id, state: interviewSessions.state, finishedAt: interviewSessions.finishedAt })
      .from(interviewSessions)
      .where(and(eq(interviewSessions.candidateId, ctx.actorId), inArray(interviewSessions.scenarioId, ids)))
      .orderBy(desc(interviewSessions.createdAt)).limit(1)

    let next: EntryNext
    if (live) next = 'resume'
    else if (text) next = 'text_form'
    else if (decision?.decision === 'declined') next = decision.alternativeChosen === 'text_form' ? 'text_form' : 'alternative'
    else if (decision?.decision === 'withdrawn') next = 'withdrawn'
    else if (decision?.decision === 'accepted' && decision.scenarioId === scenario.id && !await consumed(tx, decision.id)) next = 'start'
    else if (last && INTERVIEW_DONE_STATES.includes(last.state as InterviewSessionState) && await attemptsLeft(tx, ctx, quizId, q.enrollmentId) === 0) next = 'done'
    else if (!ai.available) next = 'unavailable'
    else next = 'consent'

    return {
      ok: true as const,
      state: {
        quizId: quiz.id,
        quizTitle: quiz.title,
        scenario: scenarioView(scenario),
        consent: await consentText(tx, ctx.actorId, scenario),
        next,
        ai,
        decision: decision ? { decision: decision.decision, alternative: decision.alternativeChosen, decidedAt: decision.decidedAt.toISOString() } : null,
        sessionId: live?.id ?? null,
        lastSession: last ? { id: last.id, state: last.state as InterviewSessionState, finishedAt: last.finishedAt?.toISOString() ?? null, needsHuman: last.state === 'needs_human' } : null,
        textForm: text ? { attemptId: text.id, status: text.status } : null,
      },
    }
  })
}

// ── Решение по согласию (`30` §5.1, §6.3, §7.4, §7.5) ──────────────────────────────────

export interface RequestMeta { ip: string | null, userAgent: string | null }

export type ConsentResult
  = | { ok: true, next: 'start' | 'alternative' | 'text_form', alternative?: InterviewAlternativePath }
    | { ok: false, code: EntryError | 'already_decided' | 'invalid' }

export async function decideConsent(ctx: Ctx, quizId: string, input: InterviewConsentInput, meta: RequestMeta): Promise<ConsentResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx): Promise<ConsentResult> => {
    const r = await resolveEntry(tx, ctx, quizId, input.enrollmentId)
    if (!r.ok) return r
    const { scenario } = r.entry
    const ids = await scenarioIdsOf(tx, quizId)
    if (await liveSession(tx, ctx.actorId, ids)) return { ok: false, code: 'already_decided' }
    // Решение уже есть: отказ и отзыв окончательны для теста; согласие по действующей версии
    // ждёт старта. Согласие, израсходованное прошлой сессией или данное прежней версии
    // сценария (другой текст), нового решения не запрещает
    const decision = await latestDecision(tx, ctx.actorId, quizId)
    if (decision && (decision.decision !== 'accepted' || (decision.scenarioId === scenario.id && !await consumed(tx, decision.id)))) {
      return { ok: false, code: 'already_decided' }
    }

    // Человек видел ровно этот текст: другая редакция — «оновіть сторінку», согласие не пишется
    const text = await consentText(tx, ctx.actorId, scenario)
    if (input.textVersion !== text.textVersion || input.textHash !== text.textHash) return { ok: false, code: 'invalid' }
    const alternative = scenario.alternativePath as InterviewAlternativePath
    if (input.decision === 'declined' && input.alternative && input.alternative !== alternative) return { ok: false, code: 'invalid' }

    const voice = (scenario.answerModes as string[]).includes('voice')
    const [row] = await tx.insert(interviewConsents).values({
      tenantId: ctx.tenantId,
      userId: ctx.actorId,
      scenarioId: scenario.id,
      decision: input.decision,
      scopes: input.decision === 'accepted' ? { audio: voice, video: false, transcript: true, share_with_hiring_manager: true } : {},
      textVersion: text.textVersion,
      textHash: text.textHash,
      lang: text.lang,
      alternativeChosen: input.decision === 'declined' ? alternative : null,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestContext: currentRequestContext(),
    }).returning({ id: interviewConsents.id })
    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: input.decision === 'accepted' ? 'interview.consent.accepted' : 'interview.consent.declined',
      entity: 'interview_consent',
      entityId: row!.id,
      after: { quizId, scenarioId: scenario.id, textVersion: text.textVersion, textHash: text.textHash, ...(input.decision === 'declined' ? { alternative } : {}) },
    })
    if (input.decision === 'accepted') return { ok: true, next: 'start' }

    await takeAlternative(tx, ctx, r.entry, { reason: 'declined', alternative, preferredTime: input.preferredTime ?? null })
    return { ok: true, next: alternative === 'text_form' ? 'text_form' : 'alternative', alternative }
  })
}

const REASON_UK: Record<'ai_unavailable' | 'no_microphone', string> = {
  ai_unavailable: 'ШІ-співбесіда зараз недоступна',
  no_microphone: 'у кандидата не працює мікрофон, а сценарій не допускає письмових відповідей',
}

/**
 * Альтернативный путь (`30` §7.5): живое собеседование — карточка в «На перевірці» и
 * `interview_declined` рекрутеру с пометкой «потрібна жива співбесіда»; письменная форма — те
 * же вопросы обычным тестом с ручной проверкой. Ни в каком случае отказ не пишется в оценки.
 */
async function takeAlternative(tx: TenantTx, ctx: Ctx, entry: Entry, opts: { reason: 'declined' | 'ai_unavailable' | 'no_microphone', alternative: InterviewAlternativePath, preferredTime: string | null }): Promise<void> {
  const live = opts.alternative === 'human_interview'
  const who = await interviewAlternativeTx(tx, ctx.tenantId, ctx.actorId, {
    liveInterview: live,
    reasonText: opts.preferredTime ? `Зручний час для дзвінка: ${opts.preferredTime}` : null,
    actorId: ctx.actorId,
  })
  const recipients = await recruitingRecipients(tx, ctx.tenantId, who?.recruiterId ?? null)
  await notifyAll(tx, ctx.tenantId, recipients, 'interview_declined', {
    name: who?.fullName ?? '',
    alternative: ALTERNATIVE_LABEL_UK[opts.alternative],
    reason: opts.reason === 'declined' ? null : REASON_UK[opts.reason],
    preferredTime: opts.preferredTime,
    live,
  }, `${ctx.actorId}:${entry.scenario.id}:${opts.reason}`, ctx.actorId)
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorId: ctx.actorId,
    action: 'interview.alternative',
    entity: 'user',
    entityId: ctx.actorId,
    after: { quizId: entry.quiz.id, scenarioId: entry.scenario.id, alternative: opts.alternative, reason: opts.reason },
  })
}

export type AlternativeResult
  = | { ok: true, next: 'alternative' | 'text_form', alternative: InterviewAlternativePath }
    | { ok: false, code: EntryError | 'ai_available' | 'text_allowed' | 'already_decided' }

/** Альтернатива без отказа: ИИ недоступен или нет микрофона при сценарии без текста (`30` §7.12, §12 п. 1). */
export async function takeAlternativePath(ctx: Ctx, quizId: string, input: InterviewAlternativeInput): Promise<AlternativeResult> {
  const ai = await aiState(ctx.tenantId)
  return withTenant(ctx.tenantId, ctx.actorId, async (tx): Promise<AlternativeResult> => {
    const r = await resolveEntry(tx, ctx, quizId, input.enrollmentId)
    if (!r.ok) return r
    const { scenario } = r.entry
    if (await liveSession(tx, ctx.actorId, await scenarioIdsOf(tx, quizId))) return { ok: false, code: 'already_decided' }
    if (input.reason === 'ai_unavailable' && ai.available) return { ok: false, code: 'ai_available' }
    if (input.reason === 'no_microphone' && (scenario.answerModes as string[]).includes('text')) return { ok: false, code: 'text_allowed' }
    const alternative = scenario.alternativePath as InterviewAlternativePath
    await takeAlternative(tx, ctx, r.entry, { reason: input.reason, alternative, preferredTime: input.preferredTime ?? null })
    return { ok: true, next: alternative === 'text_form' ? 'text_form' : 'alternative', alternative }
  })
}

// ── Старт сессии (`30` §4 `consent_pending → in_progress`, §7.12) ──────────────────────

export type StartSessionResult
  = | { ok: true, sessionId: string, resumed: boolean }
    | { ok: false, code: EntryError | 'consent_required' | 'answer_mode_invalid' | 'attempt_in_progress' | Exclude<Extract<StartResult, { ok: false }>['code'], 'in_progress' | 'interview_required'> }
    | { ok: false, code: 'ai_unavailable', reason: AiUnavailableReason, alternative: InterviewAlternativePath }
    | { ok: false, code: 'limit_exceeded', check: LimitCheck, alternative: InterviewAlternativePath }

/**
 * Старт: согласие по действующей версии сценария, резерв одной операции `ai_interview_ops` на
 * сессию (`30` §7.12 [решение]), затем — в одной транзакции — попытка по снимку, сессия и её
 * реплики. Исчерпанная ось или истёкший ИИ — сессия не стартует, кандидату предлагается
 * альтернатива сценария, счётчик не меняется (`30` §13 к. 7; админу уходит `limit_exceeded`).
 * Не удалось создать попытку — резерв снимается: тенант не платит за наш отказ.
 */
export async function startSession(ctx: Ctx, quizId: string, input: InterviewStartInput, meta: RequestMeta): Promise<StartSessionResult> {
  const pre = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const r = await resolveEntry(tx, ctx, quizId, input.enrollmentId)
    if (!r.ok) return r
    const live = await liveSession(tx, ctx.actorId, await scenarioIdsOf(tx, quizId))
    if (live) return { ok: true as const, resume: live.id, entry: r.entry }
    const decision = await latestDecision(tx, ctx.actorId, quizId)
    if (!decision || decision.decision !== 'accepted' || decision.scenarioId !== r.entry.scenario.id || await consumed(tx, decision.id)) {
      return { ok: false as const, code: 'consent_required' as const }
    }
    if (!(r.entry.scenario.answerModes as string[]).includes(input.answerMode)) return { ok: false as const, code: 'answer_mode_invalid' as const }
    return { ok: true as const, resume: null, entry: r.entry, consentId: decision.id }
  })
  if (!pre.ok) return pre
  if (pre.resume) return { ok: true, sessionId: pre.resume, resumed: true }
  const { entry } = pre
  const alternative = entry.scenario.alternativePath as InterviewAlternativePath

  const sessionId = randomUUID()
  const reserved = await reserveSessionOp({ tenantId: ctx.tenantId, actorId: ctx.actorId }, 'ai_interview_ops', { kind: 'interview_session', id: sessionId })
  if (!reserved.ok) {
    return reserved.code === 'limit_exceeded'
      ? { ok: false, code: 'limit_exceeded', check: reserved.check, alternative }
      : { ok: false, code: 'ai_unavailable', reason: reserved.reason, alternative }
  }

  let result: StartSessionResult
  try {
    result = await withTenant(ctx.tenantId, ctx.actorId, async (tx): Promise<StartSessionResult> => {
      // Повторная проверка под блокировкой: двойной клик «Почати» не создаёт двух сессий
      const [consent] = await tx.select({ id: interviewConsents.id }).from(interviewConsents)
        .where(and(eq(interviewConsents.id, pre.consentId!), eq(interviewConsents.decision, 'accepted'))).for('update')
      if (!consent || await consumed(tx, consent.id)) return { ok: false, code: 'consent_required' }
      const started = await startAttemptTx(tx, ctx, quizId, { enrollmentId: input.enrollmentId, lessonId: input.lessonId, device: input.device, ip: meta.ip ?? undefined, interview: true })
      if (!started.ok) {
        if (started.code === 'in_progress') return { ok: false, code: 'attempt_in_progress' }
        if (started.code === 'interview_required') return { ok: false, code: 'consent_required' }
        return { ok: false, code: started.code }
      }
      const [attempt] = await tx.select({ snapshot: attempts.snapshot }).from(attempts).where(eq(attempts.id, started.attemptId))
      const snapshot = (attempt?.snapshot ?? []) as SnapshotQuestion[]
      const now = new Date()
      await tx.insert(interviewSessions).values({
        id: sessionId,
        tenantId: ctx.tenantId,
        attemptId: started.attemptId,
        scenarioId: entry.scenario.id,
        candidateId: ctx.actorId,
        consentId: consent.id,
        state: 'in_progress',
        answerMode: input.answerMode,
        turnsTotal: snapshot.length,
        device: input.device ?? null,
        ip: meta.ip,
        userAgent: meta.userAgent,
        startedAt: now,
        lastActivityAt: now,
      })
      if (snapshot.length) {
        await tx.insert(interviewTurns).values(snapshot.map((q, i) => ({
          tenantId: ctx.tenantId,
          sessionId,
          ordinal: i + 1,
          role: 'candidate',
          questionId: q.id,
          questionVersion: q.version,
          promptText: promptTextOf(q.stem),
        })))
      }
      await recordAudit(tx, {
        tenantId: ctx.tenantId,
        actorId: ctx.actorId,
        action: 'interview.start',
        entity: 'interview_session',
        entityId: sessionId,
        after: { quizId, scenarioId: entry.scenario.id, attemptId: started.attemptId, answerMode: input.answerMode, reserved: reserved.reserved },
      })
      return { ok: true, sessionId, resumed: false }
    })
  }
  catch (err) {
    await releaseSessionOp({ tenantId: ctx.tenantId, actorId: ctx.actorId }, 'ai_interview_ops', { kind: 'interview_session', id: sessionId }, 'start_failed').catch(() => null)
    throw err
  }
  if (!result.ok) {
    await releaseSessionOp({ tenantId: ctx.tenantId, actorId: ctx.actorId }, 'ai_interview_ops', { kind: 'interview_session', id: sessionId }, 'start_failed')
  }
  return result
}

// ── Письменная форма — альтернатива `text_form` (`30` §6.3, §7.5) ──────────────────────

export interface TextFormState {
  attemptId: string
  status: string
  quizTitle: string
  questions: { id: string, ordinal: number, stem: unknown, answer: string }[]
}

export type TextFormResult = { ok: true, attemptId: string } | { ok: false, code: EntryError | 'text_form_unavailable' | 'consent_required' | 'attempt_in_progress' | 'attempts_exhausted' | 'cooldown' | 'not_enough_questions' }

/**
 * Письменная форма: «ті самі питання текстом, без запису» (`30` §6.3) — обычная попытка теста без
 * ИИ-сессии, ручная проверка в очереди `13` §5.2. Открывается, если это альтернатива сценария и
 * к ней пришли законно: кандидат отказался от ИИ, ИИ сейчас недоступен или сценарий не допускает
 * текста при сломанном микрофоне (§12 п. 1). Идущая попытка формы продолжается.
 */
export async function startTextForm(ctx: Ctx, quizId: string, q: InterviewEntryQuery): Promise<TextFormResult> {
  const ai = await aiState(ctx.tenantId)
  return withTenant(ctx.tenantId, ctx.actorId, async (tx): Promise<TextFormResult> => {
    const r = await resolveEntry(tx, ctx, quizId, q.enrollmentId)
    if (!r.ok) return r
    const { scenario } = r.entry
    if (scenario.alternativePath !== 'text_form') return { ok: false, code: 'text_form_unavailable' }
    if (await liveSession(tx, ctx.actorId, await scenarioIdsOf(tx, quizId))) return { ok: false, code: 'attempt_in_progress' }
    const existing = await textFormAttempt(tx, ctx.actorId, quizId)
    if (existing?.status === 'in_progress') return { ok: true, attemptId: existing.id }
    const decision = await latestDecision(tx, ctx.actorId, quizId)
    const lawful = decision?.decision === 'declined' || !ai.available || !(scenario.answerModes as string[]).includes('text')
    if (!lawful) return { ok: false, code: 'consent_required' }
    const started = await startAttemptTx(tx, ctx, quizId, { enrollmentId: q.enrollmentId, lessonId: q.lessonId, interview: true })
    if (!started.ok) {
      if (started.code === 'in_progress') return { ok: false, code: 'attempt_in_progress' }
      if (started.code === 'not_found' || started.code === 'interview_required') return { ok: false, code: 'not_found' }
      return { ok: false, code: started.code }
    }
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'interview.text_form.start', entity: 'attempt', entityId: started.attemptId, after: { quizId, scenarioId: scenario.id } })
    return { ok: true, attemptId: started.attemptId }
  })
}

/** Попытка письменной формы этого человека: тест собеседования, без ИИ-сессии. Иначе — `null` (404). */
async function ownTextForm(tx: TenantTx, ctx: Ctx, attemptId: string) {
  const [row] = await tx.execute(sql`
    select a.id, a.status, a.snapshot, q.title
      from attempts a join quizzes q on q.id = a.quiz_id
     where a.id = ${attemptId}::uuid and a.user_id = ${ctx.actorId}::uuid and q.kind = 'interview'
       and not exists (select 1 from interview_sessions s where s.attempt_id = a.id)`) as unknown as { id: string, status: string, snapshot: SnapshotQuestion[], title: string }[]
  return row ?? null
}

export async function getTextForm(ctx: Ctx, attemptId: string): Promise<TextFormState | null> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const a = await ownTextForm(tx, ctx, attemptId)
    if (!a) return null
    const answers = await tx.select({ questionId: attemptAnswers.questionId, answer: attemptAnswers.answer }).from(attemptAnswers).where(eq(attemptAnswers.attemptId, attemptId))
    const byQ = new Map(answers.map(x => [x.questionId, x.answer as { text?: string } | null]))
    return {
      attemptId: a.id,
      status: a.status,
      quizTitle: a.title,
      questions: a.snapshot.map((s, i) => ({ id: s.id, ordinal: i + 1, stem: stripAnswers(s).stem, answer: byQ.get(s.id)?.text ?? '' })),
    }
  })
}

export async function answerTextForm(ctx: Ctx, attemptId: string, questionId: string, text: string) {
  const own = await withTenant(ctx.tenantId, ctx.actorId, tx => ownTextForm(tx, ctx, attemptId))
  if (!own) return { ok: false as const, code: 'not_found' as const }
  return saveAnswer(ctx, attemptId, questionId, { text })
}

export async function submitTextForm(ctx: Ctx, attemptId: string) {
  const own = await withTenant(ctx.tenantId, ctx.actorId, tx => ownTextForm(tx, ctx, attemptId))
  if (!own) return { ok: false as const, code: 'not_found' as const }
  const r = await submitAttempt(ctx, attemptId)
  return r
}
