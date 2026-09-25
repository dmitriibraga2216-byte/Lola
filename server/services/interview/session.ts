import { and, asc, eq, sql } from 'drizzle-orm'
import { attemptAnswers, attempts, interviewConsents, interviewScenarios, interviewSessions, interviewTurns, mediaAssets, users } from '../../db/schema'
import { withTenant, type TenantTx } from '../../utils/withTenant'
import { recordAudit } from '../audit'
import { afterSubmit, annulAttemptTx, submitAttemptTx, type SubmittedAttempt } from '../attempts'
import { completeUpload, createUploadUrl } from '../media'
import { enqueueMediaProcess } from '../queue'
import { enqueueForTenant } from '../tenantQueue'
import { releaseSessionOp } from '../ai/gateway'
import { personById } from '../repo/people'
import { stripAnswers, type SnapshotQuestion } from '../../../shared/domain/grading'
import { audioPurgeAfter, isDisconnectGap } from '../../../shared/domain/interview'
import type { InterviewAnswerMode, InterviewSessionState } from '../../../shared/enums'
import type { InterviewAnswerInput, InterviewHeartbeatInput, InterviewUploadInput } from '../../../shared/schemas/interview'
import { notifyAll, recruitingRecipients, type Ctx } from './common'
import { redactInterviewData } from './redaction'

/**
 * Прохождение собеседования кандидатом (`docs/v2/30-ai-interview.md` §4, §5.2, §7.6, §7.12,
 * §10; план `45` PR-28): реплики, запись и перезапись, обрыв связи и возврат, завершение, отзыв
 * согласия.
 *
 * **Кандидат не теряет прохождение из-за нашей инфраструктуры** (`30` §7.12). Обрыв связи сервер
 * увидеть не может — связи в этот момент нет, — поэтому пауза фиксируется двумя путями: вкладка
 * сама шлёт `pause` при уходе со страницы (`pagehide`), а если не успела — первый запрос после
 * возврата находит молчание дольше порога и засчитывает обрыв задним числом. Возврат продолжает
 * с первой неотвеченной реплики, попытка идёт по своему дедлайну (`30` §4, §13 к. 8).
 *
 * Доступ — по данным: сессия принадлежит кандидату, чужая для него не существует (`404`).
 */

type Session = typeof interviewSessions.$inferSelect
type Turn = typeof interviewTurns.$inferSelect

export interface SessionView {
  id: string
  state: InterviewSessionState
  answerMode: InterviewAnswerMode | null
  turnsTotal: number
  turnsAnswered: number
  /** Секунд до дедлайна попытки (`12` §3.5); `null` — без ограничения. */
  secondsLeft: number | null
  scenario: {
    interviewerName: string
    introText: string
    outroText: string
    answerModes: InterviewAnswerMode[]
    minAnswerSec: number
    maxAnswerSec: number
    thinkTimeSec: number
    silenceTimeoutSec: number
    retakeLimit: number
  }
  current: {
    ordinal: number
    stem: unknown
    promptText: string | null
    retakes: number
    retakesLeft: number
    hasRecording: boolean
  } | null
  /** Оценку сформирует человек — одна строка без техники на финальном экране (`30` §5.2). */
  needsHuman: boolean
  withdrawn: boolean
}

async function lockOwn(tx: TenantTx, ctx: Ctx, sessionId: string): Promise<Session | null> {
  const [row] = await tx.select().from(interviewSessions)
    .where(and(eq(interviewSessions.id, sessionId), eq(interviewSessions.candidateId, ctx.actorId)))
    .for('update')
  return row ?? null
}

async function scenarioOf(tx: TenantTx, s: Session) {
  const [row] = await tx.select().from(interviewScenarios).where(eq(interviewScenarios.id, s.scenarioId))
  return row!
}

async function turnsOf(tx: TenantTx, sessionId: string): Promise<Turn[]> {
  return tx.select().from(interviewTurns).where(eq(interviewTurns.sessionId, sessionId)).orderBy(asc(interviewTurns.ordinal))
}

async function attemptOf(tx: TenantTx, s: Session) {
  const [row] = await tx.select().from(attempts).where(eq(attempts.id, s.attemptId)).for('update')
  return row!
}

/** Текущая реплика — первая без ответа (`30` §7.12: «возврат с той же реплики»). */
function currentTurn(turns: Turn[]): Turn | null {
  return turns.find(t => !t.submittedAt) ?? null
}

async function viewOf(tx: TenantTx, s: Session): Promise<SessionView> {
  const scenario = await scenarioOf(tx, s)
  const turns = await turnsOf(tx, s.id)
  const [attempt] = await tx.select({ snapshot: attempts.snapshot, deadlineAt: attempts.deadlineAt }).from(attempts).where(eq(attempts.id, s.attemptId))
  const snapshot = (attempt?.snapshot ?? []) as SnapshotQuestion[]
  const live = s.state === 'in_progress' || s.state === 'paused' || (s.state === 'abandoned' && !s.degradedReason)
  const cur = live ? currentTurn(turns) : null
  const q = cur ? snapshot.find(x => x.id === cur.questionId) : undefined
  return {
    id: s.id,
    state: s.state as InterviewSessionState,
    answerMode: s.answerMode as InterviewAnswerMode | null,
    turnsTotal: s.turnsTotal,
    turnsAnswered: s.turnsAnswered,
    secondsLeft: attempt?.deadlineAt ? Math.max(0, Math.floor((attempt.deadlineAt.getTime() - Date.now()) / 1000)) : null,
    scenario: {
      interviewerName: scenario.interviewerName,
      introText: scenario.introText,
      outroText: scenario.outroText,
      answerModes: scenario.answerModes as InterviewAnswerMode[],
      minAnswerSec: scenario.minAnswerSec,
      maxAnswerSec: scenario.maxAnswerSec,
      thinkTimeSec: scenario.thinkTimeSec,
      silenceTimeoutSec: scenario.silenceTimeoutSec,
      retakeLimit: scenario.retakeLimit,
    },
    current: cur
      ? {
          ordinal: cur.ordinal,
          // Вопрос — из снимка попытки без эталона и подсказки проверяющему (docs/12 §10)
          stem: q ? stripAnswers(q).stem : null,
          promptText: cur.promptText,
          retakes: cur.retakes,
          retakesLeft: Math.max(0, scenario.retakeLimit - cur.retakes),
          hasRecording: !!cur.mediaId,
        }
      : null,
    needsHuman: s.state === 'needs_human',
    withdrawn: s.degradedReason === 'consent_withdrawn',
  }
}

export async function getSession(ctx: Ctx, sessionId: string): Promise<SessionView | null> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await tx.select().from(interviewSessions)
      .where(and(eq(interviewSessions.id, sessionId), eq(interviewSessions.candidateId, ctx.actorId)))
    return row ? viewOf(tx, row) : null
  })
}

// ── Связь: биение, пауза, возврат (`30` §7.12, §13 к. 8) ───────────────────────────────

export interface RequestMeta { ip: string | null, userAgent: string | null }

interface Flag { code: string, ordinal: number | null, at: string }

function withFlag(flags: unknown, code: string, ordinal: number | null = null): Flag[] {
  const list = Array.isArray(flags) ? flags as Flag[] : []
  if (list.some(f => f.code === code && f.ordinal === ordinal)) return list
  return [...list, { code, ordinal, at: new Date().toISOString() }]
}

/**
 * Любое действие кандидата в сессии — «он здесь». Возврат после паузы или после брошенной
 * вкладки (сутки без активности, но попытка жива) — `resumes + 1`; молчание канала дольше порога
 * без паузы — обрыв, который засчитывается задним числом: `disconnects + 1` и сразу возврат.
 * Здесь же — измеримые факты для человека (`30` §7.17): смена IP и устройства, переключения
 * вкладки. Ни один не влияет на балл и не виден кандидату.
 */
async function touch(tx: TenantTx, s: Session, meta: RequestMeta, input: InterviewHeartbeatInput = {}): Promise<{ session: Session, resumed: boolean }> {
  const now = new Date()
  const set: Partial<typeof interviewSessions.$inferInsert> = { lastActivityAt: now, updatedAt: now }
  let resumed = false
  const reaped = s.state === 'abandoned' && !s.degradedReason
  if (s.state === 'paused' || reaped) {
    set.state = 'in_progress'
    set.resumes = s.resumes + 1
    resumed = true
  }
  else if (s.state === 'in_progress' && isDisconnectGap(s.lastActivityAt, now)) {
    set.disconnects = s.disconnects + 1
    set.resumes = s.resumes + 1
    resumed = true
  }
  let flags = s.flags
  if (meta.ip && s.ip && meta.ip !== s.ip) {
    set.ipChanges = s.ipChanges + 1
    set.ip = meta.ip
    flags = withFlag(flags, 'ip_changed')
  }
  if (meta.userAgent && s.userAgent && meta.userAgent !== s.userAgent) {
    set.userAgent = meta.userAgent
    flags = withFlag(flags, 'device_changed')
  }
  if (input.tabSwitches !== undefined && input.tabSwitches > s.tabSwitches) {
    set.tabSwitches = input.tabSwitches
    if (input.tabSwitches > 5) flags = withFlag(flags, 'tab_switches')
  }
  if (input.silenceEvents !== undefined && input.silenceEvents > s.silenceEvents) set.silenceEvents = input.silenceEvents
  if (flags !== s.flags) set.flags = flags
  const [updated] = await tx.update(interviewSessions).set(set).where(eq(interviewSessions.id, s.id)).returning()
  return { session: updated!, resumed }
}

/** Попытка кончилась по дедлайну (`attempt.expire`) — сессия `expired` по правилам `12` §4 (`30` §4). */
async function expireIfAttemptClosed(tx: TenantTx, s: Session): Promise<Session | null> {
  const attempt = await attemptOf(tx, s)
  const past = attempt.deadlineAt && attempt.deadlineAt < new Date()
  if (attempt.status === 'in_progress' && !past) return null
  const [row] = await tx.update(interviewSessions).set({ state: 'expired', degradedReason: 'timeout', finishedAt: new Date(), updatedAt: new Date() })
    .where(eq(interviewSessions.id, s.id)).returning()
  return row!
}

export type LiveResult<T> = { ok: true } & T | { ok: false, code: 'not_found' | 'not_live' | 'expired' }

export async function heartbeat(ctx: Ctx, sessionId: string, input: InterviewHeartbeatInput, meta: RequestMeta): Promise<LiveResult<{ session: SessionView, resumed: boolean }>> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const s = await lockOwn(tx, ctx, sessionId)
    if (!s) return { ok: false as const, code: 'not_found' as const }
    const resumable = s.state === 'in_progress' || s.state === 'paused' || (s.state === 'abandoned' && !s.degradedReason)
    if (!resumable) return { ok: true as const, session: await viewOf(tx, s), resumed: false }
    const expired = await expireIfAttemptClosed(tx, s)
    if (expired) return { ok: true as const, session: await viewOf(tx, expired), resumed: false }
    const t = await touch(tx, s, meta, input)
    return { ok: true as const, session: await viewOf(tx, t.session), resumed: t.resumed }
  })
}

/**
 * Пауза — вкладку закрыли или ушли со страницы (`navigator.sendBeacon` на `pagehide`): обрыв
 * засчитывается сразу, таймер попытки при этом идёт своим ходом (`30` §4, `12` §3.5).
 */
export async function pause(ctx: Ctx, sessionId: string): Promise<boolean> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const s = await lockOwn(tx, ctx, sessionId)
    if (!s) return false
    if (s.state !== 'in_progress') return true
    await tx.update(interviewSessions).set({ state: 'paused', disconnects: s.disconnects + 1, lastActivityAt: new Date(), updatedAt: new Date() })
      .where(eq(interviewSessions.id, s.id))
    return true
  })
}

/** Сессия, в которой можно отвечать: своя, идёт (или возвращена этим же действием), попытка жива. */
async function liveOwn(tx: TenantTx, ctx: Ctx, sessionId: string, meta: RequestMeta): Promise<{ ok: true, session: Session } | { ok: false, code: 'not_found' | 'not_live' | 'expired' }> {
  const s = await lockOwn(tx, ctx, sessionId)
  if (!s) return { ok: false, code: 'not_found' }
  const resumable = s.state === 'in_progress' || s.state === 'paused' || (s.state === 'abandoned' && !s.degradedReason)
  if (!resumable) return { ok: false, code: 'not_live' }
  if (await expireIfAttemptClosed(tx, s)) return { ok: false, code: 'expired' }
  return { ok: true, session: (await touch(tx, s, meta)).session }
}

/** Запись — в корзину сразу: голос, от которого отказались перезаписью или ответом текстом, не хранится. */
async function discardMedia(tx: TenantTx, mediaId: string, actorId: string, reason: string): Promise<void> {
  await tx.update(mediaAssets).set({
    lifecycle: 'pending_delete', deletedAt: new Date(), deletedBy: actorId, deleteReason: reason, purgeAfter: new Date(), updatedAt: new Date(),
  }).where(and(eq(mediaAssets.id, mediaId), sql`${mediaAssets.lifecycle} in ('active', 'orphaned')`))
}

// ── Запись ответа (`30` §10 `…/upload`, §5.2 «Перезаписати (залишилось N)») ─────────────

export type UploadResult
  = | { ok: true, mediaId: string, uploadUrl: string, retakesLeft: number }
    | { ok: false, code: 'not_found' | 'not_live' | 'expired' | 'turn_closed' | 'voice_not_allowed' | 'retake_limit' }
    | { ok: false, code: 'media', mediaCode: string, message: string }

/**
 * Ссылка на загрузку аудио реплики (`41` §5.8: файл идёт в S3 напрямую, через API — только
 * метаданные). Повторная запись той же реплики — перезапись: сверх `retake_limit` сценария —
 * `409 retake.limit`, прежняя запись уходит в корзину сразу.
 */
export async function uploadAnswer(ctx: Ctx, sessionId: string, ordinal: number, input: InterviewUploadInput, meta: RequestMeta): Promise<UploadResult> {
  const check = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const live = await liveOwn(tx, ctx, sessionId, meta)
    if (!live.ok) return live
    const scenario = await scenarioOf(tx, live.session)
    if (!(scenario.answerModes as string[]).includes('voice')) return { ok: false as const, code: 'voice_not_allowed' as const }
    const turn = currentTurn(await turnsOf(tx, sessionId))
    if (!turn || turn.ordinal !== ordinal) return { ok: false as const, code: 'turn_closed' as const }
    if (turn.mediaId && turn.retakes + 1 > scenario.retakeLimit) return { ok: false as const, code: 'retake_limit' as const }
    return { ok: true as const, turnId: turn.id, retakeLimit: scenario.retakeLimit }
  })
  if (!check.ok) return check

  const ext = input.mime.split('/')[1]?.split(';')[0] ?? 'bin'
  const url = await createUploadUrl(ctx, {
    filename: `interview-answer-${ordinal}.${ext}`, mime: input.mime, bytes: input.bytes,
    origin: 'interview_answer', sourceEntity: 'interview_turns', sourceId: check.turnId,
  })
  if (!url.ok) return { ok: false, code: 'media', mediaCode: url.code, message: url.message }

  return withTenant(ctx.tenantId, ctx.actorId, async (tx): Promise<UploadResult> => {
    const [turn] = await tx.select().from(interviewTurns).where(eq(interviewTurns.id, check.turnId)).for('update')
    if (!turn || turn.submittedAt) {
      await discardMedia(tx, url.mediaId, ctx.actorId, 'turn_closed')
      return { ok: false, code: 'turn_closed' }
    }
    const retake = !!turn.mediaId
    if (retake && turn.retakes + 1 > check.retakeLimit) {
      await discardMedia(tx, url.mediaId, ctx.actorId, 'retake_limit')
      return { ok: false, code: 'retake_limit' }
    }
    if (turn.mediaId) await discardMedia(tx, turn.mediaId, ctx.actorId, 'retake')
    const retakes = turn.retakes + (retake ? 1 : 0)
    await tx.update(interviewTurns).set({ mediaId: url.mediaId, retakes, startedAt: turn.startedAt ?? new Date(), updatedAt: new Date() })
      .where(eq(interviewTurns.id, turn.id))
    return { ok: true, mediaId: url.mediaId, uploadUrl: url.uploadUrl, retakesLeft: Math.max(0, check.retakeLimit - retakes) }
  })
}

// ── Ответ на реплику (`30` §10 `…/answer`) ─────────────────────────────────────────────

export type AnswerResult
  = | { ok: true, session: SessionView }
    | { ok: false, code: 'not_found' | 'not_live' | 'expired' | 'turn_closed' | 'voice_not_allowed' | 'text_not_allowed' | 'answer_empty' }

/**
 * Ответ реплики — строка `attempt_answers` с `input_mode` (`30` §3.1): голос — способ ответа на
 * вопрос `text_long`, а не отдельный тип. Текст голосового ответа приходит расшифровкой
 * (`interview.transcribe`) — ручная проверка читает его там же, где читает письменный ответ.
 * Ответ на последнюю реплику завершает сессию (`30` §4 `in_progress → submitted`).
 */
export async function answerTurn(ctx: Ctx, sessionId: string, ordinal: number, input: InterviewAnswerInput, meta: RequestMeta): Promise<AnswerResult> {
  const after: { transcribe?: string, media?: string, finished?: FinishTail } = {}
  const result = await withTenant(ctx.tenantId, ctx.actorId, async (tx): Promise<AnswerResult> => {
    const live = await liveOwn(tx, ctx, sessionId, meta)
    if (!live.ok) return live
    const s = live.session
    const scenario = await scenarioOf(tx, s)
    const modes = scenario.answerModes as string[]
    const turn = currentTurn(await turnsOf(tx, sessionId))
    if (!turn || turn.ordinal !== ordinal) return { ok: false, code: 'turn_closed' }
    const now = new Date()

    if (input.mode === 'voice') {
      if (!modes.includes('voice')) return { ok: false, code: 'voice_not_allowed' }
      if (!turn.mediaId || turn.mediaId !== input.mediaId) return { ok: false, code: 'answer_empty' }
      await tx.update(interviewTurns).set({
        answerMode: 'voice', durationMs: input.durationMs, firstSoundDelayMs: input.firstSoundDelayMs ?? null,
        silenceMs: input.silenceMs ?? null, submittedAt: now, transcriptStatus: 'pending', updatedAt: now,
      }).where(eq(interviewTurns.id, turn.id))
      await linkAnswer(tx, ctx, s, turn, { text: null, voice: true }, 'voice')
      after.transcribe = turn.id
      after.media = turn.mediaId
    }
    else if (input.mode === 'text') {
      if (!modes.includes('text')) return { ok: false, code: 'text_not_allowed' }
      const text = input.text.trim()
      if (!text) return { ok: false, code: 'answer_empty' }
      if (turn.mediaId) await discardMedia(tx, turn.mediaId, ctx.actorId, 'answered_by_text')
      await tx.update(interviewTurns).set({
        answerMode: 'text', mediaId: null, transcript: text, transcriptStatus: 'not_needed', submittedAt: now, updatedAt: now,
      }).where(eq(interviewTurns.id, turn.id))
      await linkAnswer(tx, ctx, s, turn, { text }, 'text')
    }
    else {
      // Молчание после трёх подсказок — реплика закрыта без ответа, переход дальше (`30` §7.12)
      if (turn.mediaId) await discardMedia(tx, turn.mediaId, ctx.actorId, 'silence')
      await tx.update(interviewTurns).set({
        answerMode: 'none', mediaId: null, silenceMs: input.silenceMs ?? null, submittedAt: now, transcriptStatus: 'skipped', updatedAt: now,
      }).where(eq(interviewTurns.id, turn.id))
    }

    const answered = s.turnsAnswered + (input.mode === 'none' ? 0 : 1)
    const [updated] = await tx.update(interviewSessions).set({
      turnsAnswered: answered,
      silenceEvents: s.silenceEvents + (input.mode === 'none' ? 1 : 0),
      lastActivityAt: now,
      updatedAt: now,
    }).where(eq(interviewSessions.id, s.id)).returning()

    const rest = currentTurn(await turnsOf(tx, sessionId))
    if (!rest) {
      const tail = await finishTx(tx, ctx, updated!)
      after.finished = tail
      const [final] = await tx.select().from(interviewSessions).where(eq(interviewSessions.id, s.id))
      return { ok: true, session: await viewOf(tx, final!) }
    }
    return { ok: true, session: await viewOf(tx, updated!) }
  })

  if (result.ok) {
    if (after.media) {
      await completeUpload(ctx, after.media, { ownOnly: true }).catch(err => console.error('[interview.upload.complete]', err))
      await enqueueMediaProcess(ctx.tenantId, after.media).catch(err => console.error('[interview.media.process]', err))
    }
    if (after.transcribe) await enqueueTranscribe(ctx.tenantId, after.transcribe, 1)
    if (after.finished) await afterFinish(ctx, after.finished)
  }
  return result
}

/** Ответ реплики в попытке: строка `attempt_answers` с `input_mode` и ссылка на неё из реплики. */
async function linkAnswer(tx: TenantTx, ctx: Ctx, s: Session, turn: Turn, answer: Record<string, unknown>, inputMode: 'voice' | 'text'): Promise<void> {
  const [row] = await tx.insert(attemptAnswers).values({
    tenantId: ctx.tenantId,
    attemptId: s.attemptId,
    questionId: turn.questionId!,
    questionVersion: turn.questionVersion ?? 1,
    answer,
    answeredAt: new Date(),
    inputMode,
  }).onConflictDoUpdate({
    target: [attemptAnswers.tenantId, attemptAnswers.attemptId, attemptAnswers.questionId],
    set: { answer, answeredAt: new Date(), updatedAt: new Date(), inputMode },
  }).returning({ id: attemptAnswers.id })
  await tx.update(interviewTurns).set({ attemptAnswerId: row!.id }).where(eq(interviewTurns.id, turn.id))
}

// ── Завершение (`30` §4 `in_progress → submitted`) ─────────────────────────────────────

interface FinishTail { sessionId: string, state: InterviewSessionState, submitted: SubmittedAttempt | null, released: boolean }

/**
 * Завершение сессии кандидатом: попытка отправляется **обычным путём теста** (`30` §3.1) — ответы
 * встают в очередь ручной проверки, статус попытки ставит движок теста, а не модель (`30` §7.1).
 * Дальше — расшифровка голосовых реплик, затем оценка ИИ. Аудио получает срок стирания:
 * 90 дней от конца, но не дольше согласия на обработку ПД (`30` §7.7).
 *
 * Все реплики промолчаны — оценивать нечего: сессия `failed`, попытка аннулируется (не сгорает),
 * резерв ИИ снимается, рекрутеру — `interview_needs_human` (`30` §12 п. 1: без микрофона и
 * текста кандидат не должен терять попытку).
 */
async function finishTx(tx: TenantTx, ctx: Ctx, s: Session): Promise<FinishTail> {
  const now = new Date()
  await tx.update(interviewTurns).set({ transcriptStatus: 'skipped', updatedAt: now })
    .where(and(eq(interviewTurns.sessionId, s.id), sql`${interviewTurns.submittedAt} is null`))
  const attempt = await attemptOf(tx, s)

  if (s.turnsAnswered === 0) {
    if (attempt.status === 'in_progress') await annulAttemptTx(tx, ctx, attempt.id, 'interview_no_answers')
    await tx.update(interviewSessions).set({ state: 'failed', needsHumanReason: 'no_answers', finishedAt: now, lastActivityAt: now, updatedAt: now })
      .where(eq(interviewSessions.id, s.id))
    await notifyNeedsHuman(tx, ctx.tenantId, s, 'кандидат не дав жодної відповіді')
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'interview.finish', entity: 'interview_session', entityId: s.id, after: { state: 'failed', reason: 'no_answers' } })
    return { sessionId: s.id, state: 'failed', submitted: null, released: true }
  }

  const submitted = attempt.status === 'in_progress' ? await submitAttemptTx(tx, ctx, attempt) : null
  const turns = await turnsOf(tx, s.id)
  const pending = turns.some(t => t.answerMode === 'voice' && t.transcriptStatus === 'pending')
  const voice = turns.some(t => t.answerMode === 'voice')
  const [person] = await personById(tx, { consentExpiresAt: users.consentExpiresAt }, s.candidateId) as unknown as { consentExpiresAt: string | null }[]
  const state: InterviewSessionState = pending ? 'transcribing' : 'scoring'
  await tx.update(interviewSessions).set({
    state,
    finishedAt: now,
    lastActivityAt: now,
    purgeAfter: voice ? audioPurgeAfter(now, person?.consentExpiresAt ?? null) : null,
    updatedAt: now,
  }).where(eq(interviewSessions.id, s.id))
  await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'interview.finish', entity: 'interview_session', entityId: s.id, after: { state, answered: s.turnsAnswered, attemptStatus: submitted?.status ?? attempt.status } })
  return { sessionId: s.id, state, submitted, released: false }
}

async function afterFinish(ctx: Ctx, tail: FinishTail): Promise<void> {
  if (tail.submitted) await afterSubmit(ctx, tail.submitted)
  if (tail.released) {
    await releaseSessionOp({ tenantId: ctx.tenantId, actorId: ctx.actorId }, 'ai_interview_ops', { kind: 'interview_session', id: tail.sessionId }, 'no_answers').catch(err => console.error('[interview.release]', err))
  }
  if (tail.state === 'scoring') await enqueueScore(ctx.tenantId, tail.sessionId, 1)
}

export type FinishResult = { ok: true, session: SessionView } | { ok: false, code: 'not_found' | 'not_live' | 'expired' | 'no_answers' }

export async function finishSession(ctx: Ctx, sessionId: string, meta: RequestMeta): Promise<FinishResult> {
  let tail: FinishTail | null = null
  const result = await withTenant(ctx.tenantId, ctx.actorId, async (tx): Promise<FinishResult> => {
    const live = await liveOwn(tx, ctx, sessionId, meta)
    if (!live.ok) return live
    if (live.session.turnsAnswered < 1) return { ok: false, code: 'no_answers' }
    tail = await finishTx(tx, ctx, live.session)
    const [final] = await tx.select().from(interviewSessions).where(eq(interviewSessions.id, sessionId))
    return { ok: true, session: await viewOf(tx, final!) }
  })
  if (result.ok && tail) await afterFinish(ctx, tail)
  return result
}

// ── Отзыв согласия (`30` §7.6, §13 к. 9) ───────────────────────────────────────────────

/**
 * «Припинити співбесіду» на любом шаге и отзыв после завершения (по ссылке из письма) — одно и
 * то же: согласие `withdrawn`, сессия `abandoned`, **в той же транзакции** аудио реплик — в
 * корзину с немедленной очисткой, расшифровки, обоснования и цитаты стёрты, попытка аннулирована
 * (не проваленная и не израсходованная), оценка не формируется, рекрутеру и HR — уведомление.
 * Сессия без единого ответа возвращает резерв ИИ: тенант не платит за то, чего ИИ не делал.
 */
export async function withdrawConsent(ctx: Ctx, sessionId: string, reason: string | null): Promise<{ ok: true } | { ok: false, code: 'not_found' | 'already_withdrawn' }> {
  let release = false
  const result = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const s = await lockOwn(tx, ctx, sessionId)
    if (!s) return { ok: false as const, code: 'not_found' as const }
    if (s.degradedReason === 'consent_withdrawn') return { ok: false as const, code: 'already_withdrawn' as const }
    const now = new Date()
    if (s.consentId) {
      await tx.update(interviewConsents).set({ decision: 'withdrawn', withdrawnAt: now, updatedAt: now })
        .where(and(eq(interviewConsents.id, s.consentId), sql`${interviewConsents.decision} <> 'withdrawn'`))
    }
    await tx.update(interviewSessions).set({
      state: 'abandoned', degradedReason: 'consent_withdrawn', needsHumanReason: null,
      finishedAt: s.finishedAt ?? now, lastActivityAt: now, updatedAt: now,
    }).where(eq(interviewSessions.id, s.id))
    const redacted = await redactInterviewData(tx, ctx.tenantId, ctx.actorId, { reason: 'consent_withdrawn', actorId: ctx.actorId, sessionIds: [s.id] })
    const attempt = await attemptOf(tx, s)
    if (attempt.status !== 'annulled') await annulAttemptTx(tx, ctx, attempt.id, 'interview_consent_withdrawn')

    const [person] = await personById(tx, { fullName: users.fullName, recruiterId: users.recruiterId }, s.candidateId) as unknown as { fullName: string, recruiterId: string | null }[]
    const recipients = await recruitingRecipients(tx, ctx.tenantId, person?.recruiterId ?? null, true)
    await notifyAll(tx, ctx.tenantId, recipients, 'interview_consent_withdrawn', { name: person?.fullName ?? '' }, s.id, s.candidateId)
    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'interview.consent_withdrawn',
      entity: 'interview_session',
      entityId: s.id,
      before: { state: s.state },
      after: { state: 'abandoned', reason: reason ?? null, audio: redacted.audio, attemptId: attempt.id },
    })
    release = s.turnsAnswered === 0
    return { ok: true as const }
  })
  if (result.ok && release) {
    await releaseSessionOp({ tenantId: ctx.tenantId, actorId: ctx.actorId }, 'ai_interview_ops', { kind: 'interview_session', id: sessionId }, 'consent_withdrawn').catch(err => console.error('[interview.release]', err))
  }
  return result
}

// ── Очереди и уведомления ──────────────────────────────────────────────────────────────

export async function enqueueTranscribe(tenantId: string, turnId: string, tryNo: number, startAfter?: Date): Promise<void> {
  await enqueueForTenant('interview.transcribe', tenantId, { turnId, tryNo }, { singletonKey: `interview.transcribe:${turnId}:${tryNo}`, ...(startAfter ? { startAfter } : {}) })
    .catch(err => console.error('[interview.transcribe] enqueue', err))
}

export async function enqueueScore(tenantId: string, sessionId: string, tryNo: number, startAfter?: Date): Promise<void> {
  await enqueueForTenant('interview.score', tenantId, { sessionId, tryNo }, { singletonKey: `interview.score:${sessionId}:${tryNo}`, ...(startAfter ? { startAfter } : {}) })
    .catch(err => console.error('[interview.score] enqueue', err))
}

/** «Оцінку не сформовано: {причина}. Відповіді збережено» (`30` §8 `interview.needs_human`). */
export async function notifyNeedsHuman(tx: TenantTx, tenantId: string, s: Session, reason: string): Promise<void> {
  const [person] = await personById(tx, { fullName: users.fullName, recruiterId: users.recruiterId }, s.candidateId) as unknown as { fullName: string, recruiterId: string | null }[]
  const recipients = await recruitingRecipients(tx, tenantId, person?.recruiterId ?? null)
  await notifyAll(tx, tenantId, recipients, 'interview_needs_human', { name: person?.fullName ?? '', reason }, s.id, s.candidateId)
}
