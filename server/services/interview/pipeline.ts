import { and, asc, eq, sql } from 'drizzle-orm'
import { attemptAnswers, interviewCriteria, interviewCriterionScores, interviewScenarios, interviewSessions, interviewTurns, mediaAssets, users } from '../../db/schema'
import { withTenant, type TenantTx } from '../../utils/withTenant'
import { recordAudit } from '../audit'
import { callModel, releaseSessionOp } from '../ai/gateway'
import { INTERVIEW_SCORE_PROMPT, INTERVIEW_TRANSCRIBE_PROMPT, type InterviewScoreInput } from '../ai/prompts'
import { writeAiScoreTx } from '../candidates'
import { personById } from '../repo/people'
import { formatDate, resolveLocale } from '../../../shared/domain/dateFormat'
import {
  INTERVIEW_REAP_HOURS, INTERVIEW_SCORE_RETRY_MINUTES, INTERVIEW_TRANSCRIBE_RETRY_MINUTES, sessionConfidence, turnFlags, validateScores, weightedScore,
  type ScoreProblem,
} from '../../../shared/domain/interview'
import type { InterviewDegradedReason } from '../../../shared/enums'
import { enqueueScore, enqueueTranscribe, notifyNeedsHuman } from './session'
import { notifyAll, recruitingRecipients } from './common'

/**
 * Фоновая часть собеседования (`docs/v2/30-ai-interview.md` §7.2, §7.10–§7.12, §11; план `45`
 * PR-28): расшифровка реплик (`interview.transcribe`), оценка сессии по критериям
 * (`interview.score`), сессии без активности (`interview.reap`).
 *
 * **ИИ не принимает решений о людях** (инвариант 18, `30` §7.1). Вывод модели попадает в систему
 * ровно тремя путями, и ни один не решает о человеке: текст расшифровки — в реплику и в ответ
 * попытки (для ручной проверки); объяснённые баллы по критериям — в
 * `interview_criterion_scores`; одно число — в `candidate_scores.kind = 'ai'` через владельца
 * оценок (`candidates.ts#writeAiScoreTx`). Состояние кандидата, колонку канбана, статус попытки и
 * правильность ответа этот файл не трогает (сквозная проверка 16 `scripts/v2-crosschecks.sh`).
 *
 * **Балл без обоснования и цитаты не сохраняется** (`30` §3.5, §7.2, §12 п. 5): ответ модели
 * проверяется (`validateScores`), при провале — один повтор с усиленной инструкцией, затем
 * `needs_human` с причиной `unexplained`. Даже если проверка пропустит плохой балл, его не
 * примет база: CHECK'и `ics_rationale_chk`, `ics_evidence_chk`, `ics_evidence_quote_chk`.
 */

const SYSTEM = { actorId: null as string | null }

type Session = typeof interviewSessions.$inferSelect

const NEEDS_HUMAN_TEXT: Record<InterviewDegradedReason, string> = {
  provider_down: 'провайдер ШІ не відповів',
  limit_exhausted: 'ліміт ШІ-співбесід вичерпано',
  transcribe_failed: 'не вдалося розшифрувати відповіді — аудіо збережено',
  low_confidence: 'впевненість оцінки нижча за поріг сценарію',
  consent_withdrawn: 'кандидат відкликав згоду',
  timeout: 'сплив час спроби',
  unexplained: 'програма не пояснила оцінку цитатами з відповідей',
}

/** Сессия → `needs_human`: оценки ИИ нет, решение — за человеком; кандидат видит «Відповіді надіслано». */
async function toNeedsHuman(tx: TenantTx, tenantId: string, s: Session, reason: InterviewDegradedReason, detail: string | null = null): Promise<void> {
  await tx.update(interviewSessions).set({
    state: 'needs_human', degradedReason: reason, needsHumanReason: detail ?? NEEDS_HUMAN_TEXT[reason], updatedAt: new Date(),
  }).where(eq(interviewSessions.id, s.id))
  await notifyNeedsHuman(tx, tenantId, s, NEEDS_HUMAN_TEXT[reason])
  await recordAudit(tx, { tenantId, actorId: null, action: 'interview.needs_human', entity: 'interview_session', entityId: s.id, after: { reason, detail } })
}

// ── Расшифровка реплики (`30` §7.10, `interview.transcribe`) ────────────────────────────

/**
 * Расшифровка голосового ответа. Уверенность ниже порога сценария — реплика `low_confidence`:
 * текст сохраняется, но из доказательств оценки исключается. Провайдер не ответил — два повтора
 * через 5 и 30 минут, затем `failed` (`30` §7.10). Когда голосовых реплик без итога не осталось —
 * сессия идёт к оценке или к человеку (`advanceSession`).
 */
export async function transcribeTurn(tenantId: string, turnId: string, tryNo = 1): Promise<'ok' | 'low_confidence' | 'retry' | 'failed' | 'skipped'> {
  const loaded = await withTenant(tenantId, null, async (tx) => {
    const [turn] = await tx.select().from(interviewTurns).where(eq(interviewTurns.id, turnId))
    if (!turn) return null
    const [s] = await tx.select().from(interviewSessions).where(eq(interviewSessions.id, turn.sessionId))
    const [scenario] = await tx.select().from(interviewScenarios).where(eq(interviewScenarios.id, s!.scenarioId))
    const [media] = turn.mediaId ? await tx.select().from(mediaAssets).where(eq(mediaAssets.id, turn.mediaId)) : []
    return { turn, session: s!, scenario: scenario!, media: media ?? null }
  })
  if (!loaded) return 'skipped'
  const { turn, session, scenario, media } = loaded
  if (session.redactedAt || turn.answerMode !== 'voice' || turn.transcriptStatus !== 'pending') return 'skipped'
  if (!media || media.lifecycle !== 'active') {
    await markTranscript(tenantId, turn.id, { status: 'failed' })
    await advanceSession(tenantId, session.id)
    return 'failed'
  }

  const lang = scenario.transcribeLang as 'uk' | 'en' | 'ru'
  const r = await callModel({ tenantId, actorId: SYSTEM.actorId }, INTERVIEW_TRANSCRIBE_PROMPT, {
    mediaId: media.id, audioKey: media.key, mime: media.mime, lang, durationMs: turn.durationMs,
  }, { ref: { kind: 'interview_turn', id: turn.id }, subjectUserId: session.candidateId, tryNo })

  if (!r.ok) {
    const delay = INTERVIEW_TRANSCRIBE_RETRY_MINUTES[tryNo - 1]
    if (delay !== undefined) {
      await enqueueTranscribe(tenantId, turn.id, tryNo + 1, new Date(Date.now() + delay * 60_000))
      return 'retry'
    }
    await markTranscript(tenantId, turn.id, { status: 'failed' })
    await advanceSession(tenantId, session.id)
    return 'failed'
  }

  const out = r.output
  const low = out.confidence !== null && out.confidence < Number(scenario.minConfidence)
  const status = low ? 'low_confidence' : 'ok'
  await withTenant(tenantId, null, async (tx) => {
    const [cur] = await tx.select({ transcript: interviewTurns.transcript, version: interviewTurns.transcriptVersion, status: interviewTurns.transcriptStatus })
      .from(interviewTurns).where(eq(interviewTurns.id, turn.id)).for('update')
    if (!cur || cur.status !== 'pending') return
    const [s] = await tx.select().from(interviewSessions).where(eq(interviewSessions.id, session.id)).for('update')
    if (!s || s.redactedAt) return
    await tx.update(interviewTurns).set({
      transcript: out.text,
      transcriptLang: out.language,
      transcriptConfidence: out.confidence === null ? null : String(out.confidence),
      transcriptEngine: `${r.model.driver ?? 'none'}:${r.model.modelName}`,
      transcriptVersion: cur.transcript ? cur.version + 1 : cur.version,
      transcriptStatus: status,
      updatedAt: new Date(),
    }).where(eq(interviewTurns.id, turn.id))
    // Текст голосового ответа — там же, где письменный: ручная проверка читает его без изменений (`30` §3.1)
    if (turn.attemptAnswerId) {
      await tx.update(attemptAnswers).set({ answer: { text: out.text, voice: true, transcript: { status, confidence: out.confidence } }, updatedAt: new Date() })
        .where(eq(attemptAnswers.id, turn.attemptAnswerId))
    }
    let flags = Array.isArray(s.flags) ? [...s.flags as { code: string, ordinal: number | null, at: string }[]] : []
    for (const code of turnFlags({ answer: out.text, prompt: turn.promptText, firstSoundDelayMs: turn.firstSoundDelayMs, lang: out.language }, scenario.transcribeLang)) {
      if (!flags.some(f => f.code === code && f.ordinal === turn.ordinal)) flags = [...flags, { code, ordinal: turn.ordinal, at: new Date().toISOString() }]
    }
    await tx.update(interviewSessions).set({ flags, aiStub: s.aiStub || r.model.driver === 'stub', updatedAt: new Date() })
      .where(eq(interviewSessions.id, s.id))
  })
  await advanceSession(tenantId, session.id)
  return status
}

async function markTranscript(tenantId: string, turnId: string, set: { status: 'failed' }): Promise<void> {
  await withTenant(tenantId, null, tx => tx.update(interviewTurns).set({ transcriptStatus: set.status, updatedAt: new Date() })
    .where(and(eq(interviewTurns.id, turnId), eq(interviewTurns.transcriptStatus, 'pending'))))
}

/**
 * Сессия в `transcribing` идёт дальше, когда у всех голосовых реплик есть итог: хоть одна
 * `failed` или средняя уверенность ниже порога — к человеку (`30` §4), иначе — к оценке.
 */
export async function advanceSession(tenantId: string, sessionId: string): Promise<'scoring' | 'needs_human' | 'waiting'> {
  const next = await withTenant(tenantId, null, async (tx) => {
    const [s] = await tx.select().from(interviewSessions).where(eq(interviewSessions.id, sessionId)).for('update')
    if (!s || s.state !== 'transcribing' || s.redactedAt) return 'waiting' as const
    const turns = await tx.select().from(interviewTurns).where(and(eq(interviewTurns.sessionId, sessionId), eq(interviewTurns.answerMode, 'voice')))
    if (turns.some(t => t.transcriptStatus === 'pending')) return 'waiting' as const
    const [scenario] = await tx.select({ minConfidence: interviewScenarios.minConfidence }).from(interviewScenarios).where(eq(interviewScenarios.id, s.scenarioId))
    if (turns.some(t => t.transcriptStatus === 'failed')) {
      await toNeedsHuman(tx, tenantId, s, 'transcribe_failed')
      return 'needs_human' as const
    }
    const conf = turns.map(t => t.transcriptConfidence).filter((c): c is string => c !== null).map(Number)
    const avg = conf.length ? conf.reduce((a, b) => a + b, 0) / conf.length : null
    if (avg !== null && avg < Number(scenario!.minConfidence)) {
      await toNeedsHuman(tx, tenantId, s, 'low_confidence')
      return 'needs_human' as const
    }
    await tx.update(interviewSessions).set({ state: 'scoring', updatedAt: new Date() }).where(eq(interviewSessions.id, sessionId))
    return 'scoring' as const
  })
  if (next === 'scoring') await enqueueScore(tenantId, sessionId, 1)
  return next
}

// ── Оценка сессии (`30` §7.2, §7.11, `interview.score`) ─────────────────────────────────

export type ScoreOutcome = 'scored' | 'needs_human' | 'retry' | 'skipped'

/**
 * Оценка сессии по критериям сценария — один вызов на сессию (`30` §7.11). Вход — надёжные
 * реплики (письменные и расшифрованные с достаточной уверенностью) и определения критериев.
 *
 * Итог по `30` §4:
 * - у каждого критерия балл, обоснование и дословная цитата — строки `interview_criterion_scores`,
 *   итог — взвешенное среднее к 100, уверенность — минимум по критериям; уверенность не ниже
 *   порога сценария → `scored` и одна строка `candidate_scores.kind = 'ai'`; ниже → `needs_human`
 *   (объяснённые баллы остаются человеку, в карточку число не пишется);
 * - балл без обоснования или цитаты → повтор с усиленной инструкцией, затем `needs_human`
 *   (`unexplained`), ни одной строки оценок и пустая `candidate_scores` (`30` §13 к. 4);
 * - провайдер не ответил → три повтора через 1, 5 и 30 минут, затем `needs_human` (`provider_down`).
 *
 * Вызовы внутри сессии не тарифицируются (операция списана резервом на старте, `30` §7.12).
 */
export async function scoreSession(tenantId: string, sessionId: string, tryNo = 1): Promise<ScoreOutcome> {
  const loaded = await withTenant(tenantId, null, async (tx) => {
    const [s] = await tx.select().from(interviewSessions).where(eq(interviewSessions.id, sessionId))
    if (!s || s.state !== 'scoring' || s.redactedAt) return null
    const [scenario] = await tx.select().from(interviewScenarios).where(eq(interviewScenarios.id, s.scenarioId))
    const criteria = await tx.select().from(interviewCriteria).where(eq(interviewCriteria.scenarioId, s.scenarioId)).orderBy(asc(interviewCriteria.sort))
    const turns = await tx.select().from(interviewTurns).where(eq(interviewTurns.sessionId, sessionId)).orderBy(asc(interviewTurns.ordinal))
    return { session: s, scenario: scenario!, criteria, turns }
  })
  if (!loaded) return 'skipped'
  const { session, scenario, criteria, turns } = loaded

  // Доказательством бывает только надёжный текст: письменный ответ или расшифровка выше порога
  const reliable = turns.filter(t => (t.transcriptStatus === 'ok' || t.transcriptStatus === 'not_needed') && t.transcript?.trim())
  if (!reliable.length) {
    const reason: InterviewDegradedReason = turns.some(t => t.transcriptStatus === 'low_confidence') ? 'low_confidence' : 'transcribe_failed'
    await withTenant(tenantId, null, tx => toNeedsHuman(tx, tenantId, session, reason))
    return 'needs_human'
  }

  const lang = resolveLocale(scenario.transcribeLang) as 'uk' | 'en' | 'ru'
  const input = (strict: boolean): InterviewScoreInput => ({
    lang,
    strict,
    criteria: criteria.map(c => ({ id: c.id, name: c.nameUk, description: c.description, scaleMax: Number(c.scaleMax) })),
    turns: reliable.map(t => ({ turnId: t.id, ordinal: t.ordinal, question: t.promptText ?? '', answer: t.transcript! })),
  })
  const ctx = { tenantId, actorId: SYSTEM.actorId }
  const opts = { ref: { kind: 'interview_session' as const, id: sessionId }, subjectUserId: session.candidateId, tryNo }

  let call = await callModel(ctx, INTERVIEW_SCORE_PROMPT, input(false), opts)
  if (!call.ok) return providerTrouble(tenantId, session, tryNo, call.code)
  const criteriaIn = criteria.map(c => ({ id: c.id, name: c.nameUk, scaleMax: Number(c.scaleMax) }))
  const turnsIn = reliable.map(t => ({ turnId: t.id, ordinal: t.ordinal, answer: t.transcript! }))
  let checked = validateScores(criteriaIn, turnsIn, call.output.criteria)
  if (!checked.ok) {
    // `30` §12 п. 5: один повтор с усиленной инструкцией
    call = await callModel(ctx, INTERVIEW_SCORE_PROMPT, input(true), opts)
    if (!call.ok) return providerTrouble(tenantId, session, tryNo, call.code)
    checked = validateScores(criteriaIn, turnsIn, call.output.criteria)
  }
  if (!checked.ok) {
    const problems = [...new Set(checked.problems.map(p => p.problem))] as ScoreProblem[]
    await withTenant(tenantId, null, tx => toNeedsHuman(tx, tenantId, session, 'unexplained', `${NEEDS_HUMAN_TEXT.unexplained} (${problems.join(', ')})`))
    return 'needs_human'
  }

  const scores = checked.scores
  const byId = new Map(criteria.map(c => [c.id, c]))
  const aiScore = weightedScore(scores.map(x => ({ value: x.value, scaleMax: Number(byId.get(x.criterionId)!.scaleMax), weight: Number(byId.get(x.criterionId)!.weight) })))!
  const aiConfidence = sessionConfidence(scores.map(x => x.confidence))!
  const callId = call.callId
  const stub = session.aiStub || call.model.driver === 'stub'

  try {
    return await withTenant(tenantId, null, async (tx): Promise<ScoreOutcome> => {
      const [s] = await tx.select().from(interviewSessions).where(eq(interviewSessions.id, sessionId)).for('update')
      // Пока модель думала, кандидат отозвал согласие — оценка не формируется (`30` §7.6)
      if (!s || s.state !== 'scoring' || s.redactedAt) return 'skipped'
      for (const x of scores) {
        await tx.insert(interviewCriterionScores).values({
          tenantId,
          sessionId,
          criterionId: x.criterionId,
          value: String(x.value),
          confidence: String(x.confidence),
          rationale: x.rationale,
          evidence: x.evidence,
          aiCallId: callId,
        }).onConflictDoUpdate({
          target: [interviewCriterionScores.tenantId, interviewCriterionScores.sessionId, interviewCriterionScores.criterionId],
          set: { value: String(x.value), confidence: String(x.confidence), rationale: x.rationale, evidence: x.evidence, aiCallId: callId, updatedAt: new Date() },
        })
      }
      const base = { aiScore: String(aiScore), aiConfidence: String(aiConfidence), aiStub: stub, updatedAt: new Date() }
      if (aiConfidence < Number(scenario.minConfidence)) {
        // `30` §12 п. 3: оценка с низкой уверенностью — баллы с обоснованием человеку, числа в карточке нет
        await tx.update(interviewSessions).set(base).where(eq(interviewSessions.id, sessionId))
        await toNeedsHuman(tx, tenantId, { ...s, ...base } as Session, 'low_confidence')
        return 'needs_human'
      }
      const scoreId = await writeAiScoreTx(tx, tenantId, s.candidateId, { value: aiScore, sourceId: sessionId, aiStub: stub })
      await tx.update(interviewSessions).set({ ...base, state: 'scored', candidateScoreId: scoreId }).where(eq(interviewSessions.id, sessionId))
      const [person] = await personById(tx, { fullName: users.fullName, recruiterId: users.recruiterId }, s.candidateId) as unknown as { fullName: string, recruiterId: string | null }[]
      const recipients = await recruitingRecipients(tx, tenantId, person?.recruiterId ?? null)
      await notifyAll(tx, tenantId, recipients, 'interview_completed', { name: person?.fullName ?? '', score: aiScore, stub }, sessionId, s.candidateId)
      await recordAudit(tx, { tenantId, actorId: null, action: 'interview.scored', entity: 'interview_session', entityId: sessionId, after: { aiScore, aiConfidence, aiStub: stub, aiCallId: callId } })
      return 'scored'
    })
  }
  catch (err) {
    // Последний рубеж — ограничения БД (`30` §3.5): необъяснённый балл не лёг, сессия — к человеку
    if ((err as { code?: string })?.code === '23514') {
      await withTenant(tenantId, null, tx => toNeedsHuman(tx, tenantId, session, 'unexplained'))
      return 'needs_human'
    }
    throw err
  }
}

/** Провайдер не ответил: повтор через 1, 5, 30 минут, затем человек (`30` §7.12 «Провайдер недоступен»). */
async function providerTrouble(tenantId: string, s: Session, tryNo: number, code: string): Promise<ScoreOutcome> {
  const delay = INTERVIEW_SCORE_RETRY_MINUTES[tryNo - 1]
  if (delay !== undefined && code === 'provider_failed') {
    await enqueueScore(tenantId, s.id, tryNo + 1, new Date(Date.now() + delay * 60_000))
    return 'retry'
  }
  await withTenant(tenantId, null, tx => toNeedsHuman(tx, tenantId, s, 'provider_down'))
  return 'needs_human'
}

// ── Сессии без активности (`30` §7.12, §11 `interview.reap`) ────────────────────────────

/**
 * Каждые 15 минут: сессия без активности сутки — `abandoned`; попытка не сгорает и продолжается
 * тем же входом, пока она жива (`30` §7.12 «посилання діє до {дата}»). Кандидату — письмо,
 * рекрутеру — уведомление. Брошенная сессия без единого ответа возвращает резерв ИИ.
 */
export async function reapSessions(tenantId: string): Promise<{ abandoned: number }> {
  const rows = await withTenant(tenantId, null, async (tx) => {
    const stale = await tx.execute(sql`
      select s.id, s.candidate_id, s.turns_answered, a.deadline_at
        from interview_sessions s join attempts a on a.id = s.attempt_id
       where s.state in ('in_progress', 'paused')
         and coalesce(s.last_activity_at, s.started_at, s.created_at) < now() - make_interval(hours => ${INTERVIEW_REAP_HOURS})
       for update of s skip locked
       limit 500`) as unknown as { id: string, candidate_id: string, turns_answered: number, deadline_at: Date | string | null }[]
    for (const r of stale) {
      await tx.update(interviewSessions).set({ state: 'abandoned', updatedAt: new Date() }).where(eq(interviewSessions.id, r.id))
      const [person] = await personById(tx, { fullName: users.fullName, recruiterId: users.recruiterId, commLanguage: users.commLanguage }, r.candidate_id) as unknown as { fullName: string, recruiterId: string | null, commLanguage: string | null }[]
      const until = r.deadline_at ? formatDate(r.deadline_at, resolveLocale(person?.commLanguage)) : null
      await notifyAll(tx, tenantId, [r.candidate_id], 'interview_abandoned', { until }, r.id, undefined, 'email')
      const recipients = await recruitingRecipients(tx, tenantId, person?.recruiterId ?? null)
      await notifyAll(tx, tenantId, recipients, 'interview_abandoned_recruiter', { name: person?.fullName ?? '' }, r.id, r.candidate_id)
      await recordAudit(tx, { tenantId, actorId: null, action: 'interview.abandoned', entity: 'interview_session', entityId: r.id, after: { answered: Number(r.turns_answered) } })
    }
    return stale
  })
  for (const r of rows.filter(x => Number(x.turns_answered) === 0)) {
    await releaseSessionOp({ tenantId, actorId: null }, 'ai_interview_ops', { kind: 'interview_session', id: r.id }, 'abandoned_no_answers').catch(err => console.error('[interview.reap] release', err))
  }
  return { abandoned: rows.length }
}
