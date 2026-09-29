import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { aiCalls, aiQualityReviews, candidateScores, interviewCriterionScores, interviewScenarios, interviewSessions } from '../../db/schema'
import { withTenant } from '../../utils/withTenant'
import { recordAudit } from '../audit'
import type { AiFailCode } from '../ai/gateway'
import { aiUnavailable, type AiUnavailableReason } from '../ai/policy'
import { candidateVisible, type Viewer } from '../candidates'
import { effectiveLimits, type LimitCheck } from '../tenantLimits'
import { applyUsageTx, axisState, prepareUsage, settleUsage } from '../usageCounters'
import type { InterviewDegradedReason, InterviewSessionState } from '../../../shared/enums'
import type { InterviewRescoreInput } from '../../../shared/schemas/interview'
import { applyScoresTx, loadForScoring, modelScores, reliableTurns } from './pipeline'

/**
 * Переоценка собеседования по просьбе человека — `POST /candidates/:id/interview/rescore`
 * (`docs/v2/30-ai-interview.md` §10, `41` §2 `interview.override`; решение — `44` Р-AI.2).
 *
 * **ИИ по-прежнему ничего не решает о человеке** (инвариант 18, `30` §7.1): переоценка — тот же
 * путь, что и фоновая оценка (`pipeline.ts#modelScores` → `applyScoresTx`), и пишет ровно то же —
 * объяснённые баллы по критериям и одно число `candidate_scores.kind = 'ai'` **новой** строкой;
 * прежняя остаётся в истории. Ни состояние кандидата, ни колонка канбана не меняются.
 *
 * Правила:
 * - переоценивается последняя сессия кандидата в `scored` или `needs_human` (кроме отзыва
 *   согласия и стёртой); в работе у модели (`scoring`) — `409 session.scoring`;
 * - **человек уже перепроверил хоть один критерий — `409 session.human_checked`**: новый балл
 *   модели молча сдвинул бы то, с чем человек спорил, и `agreement` потерял бы смысл (`30` §7.3);
 * - **всё или ничего.** Вызов синхронный; провайдер не ответил, ось исчерпана или модель не
 *   объяснила баллы — сессия возвращается в прежнее состояние, прежние баллы на месте, ответ —
 *   ошибкой; «переоценка сломала оценку» не бывает;
 * - **тариф** (`30` §7.12 [решение]): переоценка после нашего сбоя (`provider_down`,
 *   `limit_exhausted`, `unexplained`, `transcribe_failed`) не тарифицируется; переоценка уже
 *   состоявшейся оценки (`scored`, `low_confidence`) — новая работа модели по просьбе человека
 *   и тратит одну операцию `ai_interview_ops` (отсюда `409 limit_exceeded` в `30` §10) — в той
 *   же транзакции, что и новые баллы: неудавшаяся переоценка не списывает ничего;
 * - вызов — новая попытка (`try_no` на единицу больше прежних): сохранённый ответ модели шлюз
 *   по ключу идемпотентности не возвращает (`30` §7.18), а журнал показывает обе;
 * - ожидающие перепроверки качества строки прежних баллов снимаются (вывод модели, о котором
 *   они, больше не стоит в карточке); вынесенные вердикты остаются — прежний вывод лежит в
 *   `ai_calls.output`.
 */

/** Сбой нашей стороны: переоценка после него не тарифицируется (`30` §7.12 [решение]). */
const FREE_REASONS: readonly InterviewDegradedReason[] = ['provider_down', 'limit_exhausted', 'unexplained', 'transcribe_failed']
const RESCORABLE: readonly InterviewSessionState[] = ['scored', 'needs_human']

export interface RescoreView {
  sessionId: string
  aiCallId: number
  state: 'scored' | 'needs_human'
  aiScore: number
  aiConfidence: number
  charged: boolean
}

export type RescoreResult
  = | { ok: true, rescore: RescoreView }
    | { ok: false, code: 'not_found' | 'scoring' | 'not_rescorable' | 'human_checked' | 'unexplained' }
    | { ok: false, code: 'ai_unavailable', reason: AiUnavailableReason }
    | { ok: false, code: 'limit_exceeded', check: LimitCheck }
    | { ok: false, code: 'provider_failed', reason: AiFailCode }

/** Билинг переоценки: бесплатно только после нашего сбоя. Экспорт — для юнит-теста правила. */
export function rescoreCharged(state: string, degradedReason: string | null): boolean {
  if (state === 'scored') return true
  return !FREE_REASONS.includes(degradedReason as InterviewDegradedReason)
}

export async function rescoreInterview(v: Viewer, candidateId: string, input: InterviewRescoreInput): Promise<RescoreResult> {
  if (!await candidateVisible(v, candidateId)) return { ok: false, code: 'not_found' }

  // 1. Захват: сессия уходит в `scoring` — второй клик и фоновые задачи её не тронут
  const took = await withTenant(v.tenantId, v.actorId, async (tx) => {
    const [s] = await tx.select().from(interviewSessions)
      .where(eq(interviewSessions.candidateId, candidateId))
      .orderBy(desc(interviewSessions.createdAt)).limit(1).for('update')
    if (!s || s.redactedAt) return { ok: false as const, code: 'not_found' as const }
    if (s.state === 'scoring' || s.state === 'transcribing') return { ok: false as const, code: 'scoring' as const }
    if (!RESCORABLE.includes(s.state as InterviewSessionState) || s.degradedReason === 'consent_withdrawn') return { ok: false as const, code: 'not_rescorable' as const }
    const [checked] = await tx.select({ id: interviewCriterionScores.id }).from(interviewCriterionScores)
      .where(and(eq(interviewCriterionScores.sessionId, s.id), sql`${interviewCriterionScores.humanAt} is not null`)).limit(1)
    if (checked) return { ok: false as const, code: 'human_checked' as const }
    const charged = rescoreCharged(s.state, s.degradedReason)
    // Подписка и ось — до захвата: отказ не должен даже на миг менять сессию
    const reason = aiUnavailable((await effectiveLimits(v.tenantId)).subscription)
    if (reason) return { ok: false as const, code: 'ai_unavailable' as const, reason }
    if (charged) {
      const axis = await axisState(v.tenantId, 'ai_interview_ops')
      if (!axis.ok) return { ok: false as const, code: 'limit_exceeded' as const, check: axis as LimitCheck }
    }
    const [{ tryNo }] = await tx.execute(sql`
      select coalesce(max(try_no), 0)::int + 1 as "tryNo" from ai_calls
       where ref_kind = 'interview_session' and ref_id = ${s.id}::uuid and purpose = 'interview_score'`) as unknown as [{ tryNo: number }]
    await tx.update(interviewSessions).set({ state: 'scoring', updatedAt: new Date() }).where(eq(interviewSessions.id, s.id))
    await recordAudit(tx, {
      tenantId: v.tenantId, actorId: v.actorId, action: 'interview.rescore', entity: 'interview_session', entityId: s.id,
      before: { state: s.state, degradedReason: s.degradedReason, aiScore: s.aiScore === null ? null : Number(s.aiScore) },
      after: { candidateId, reason: input.reason, charged, tryNo },
    })
    return { ok: true as const, session: s, charged, tryNo }
  })
  if (!took.ok) return took
  const prev = took.session

  /** Вернуть сессию в прежнее состояние: переоценка не состоялась, прежние баллы на месте. */
  const restore = async () => withTenant(v.tenantId, v.actorId, tx => tx.update(interviewSessions)
    .set({ state: prev.state, degradedReason: prev.degradedReason, needsHumanReason: prev.needsHumanReason, updatedAt: new Date() })
    .where(and(eq(interviewSessions.id, prev.id), eq(interviewSessions.state, 'scoring'))))

  let r: Awaited<ReturnType<typeof modelScores>>
  try {
    const loaded = await loadForScoring(v.tenantId, prev.id)
    if (!loaded || !reliableTurns(loaded.turns).length) {
      await restore()
      return { ok: false, code: 'not_rescorable' }
    }
    r = await modelScores(v.tenantId, loaded, { tryNo: took.tryNo, actorId: v.actorId })
    if (!r.ok) {
      await restore()
      if (r.kind === 'unexplained') return { ok: false, code: 'unexplained' }
      if (r.kind === 'no_text') return { ok: false, code: 'not_rescorable' }
      if (r.code === 'ai_unavailable') return { ok: false, code: 'ai_unavailable', reason: r.reason ?? 'off' }
      if (r.code === 'limit_exceeded' && r.check) return { ok: false, code: 'limit_exceeded', check: r.check }
      return { ok: false, code: 'provider_failed', reason: r.code }
    }
  }
  catch (err) {
    await restore()
    throw err
  }
  const ok = r
  const prep = took.charged ? await prepareUsage(v.tenantId, 'ai_interview_ops') : null
  let used: number | null = null

  try {
    const res = await withTenant(v.tenantId, v.actorId, async (tx): Promise<RescoreResult> => {
      const [s] = await tx.select().from(interviewSessions).where(eq(interviewSessions.id, prev.id)).for('update')
      // Пока модель думала, кандидат отозвал согласие — оценка не формируется (`30` §7.6)
      if (!s || s.state !== 'scoring' || s.redactedAt) return { ok: false, code: 'not_rescorable' }
      const [scenario] = await tx.select({ minConfidence: interviewScenarios.minConfidence }).from(interviewScenarios).where(eq(interviewScenarios.id, s.scenarioId))
      const pendingReviews = await tx.select({ id: interviewCriterionScores.id }).from(interviewCriterionScores).where(eq(interviewCriterionScores.sessionId, s.id))
      if (pendingReviews.length) {
        await tx.delete(aiQualityReviews).where(and(
          eq(aiQualityReviews.refKind, 'interview_criterion_score'),
          inArray(aiQualityReviews.refId, pendingReviews.map(p => p.id)),
          isNull(aiQualityReviews.verdict),
        ))
      }
      const state = await applyScoresTx(tx, v.tenantId, s, Number(scenario!.minConfidence), ok, { notify: false })
      if (state === 'needs_human' && s.candidateScoreId) {
        // Новая оценка ниже порога: прежнее число модели в карточке больше не действует (история остаётся)
        await tx.update(candidateScores).set({ isCurrent: false, updatedAt: new Date() }).where(eq(candidateScores.id, s.candidateScoreId))
        await tx.update(interviewSessions).set({ candidateScoreId: null }).where(eq(interviewSessions.id, s.id))
      }
      if (prep) {
        // Списание — вместе с применённым результатом: неудачная переоценка не стоит ничего
        used = await applyUsageTx(tx, v.tenantId, 'ai_interview_ops', 1, { refId: s.id, actorUserId: v.actorId, meta: { aiCallId: ok.callId, rescore: true } }, prep)
        await tx.update(aiCalls).set({ billed: true }).where(eq(aiCalls.id, ok.callId))
      }
      return { ok: true, rescore: { sessionId: s.id, aiCallId: ok.callId, state, aiScore: ok.aiScore, aiConfidence: ok.aiConfidence, charged: took.charged } }
    })
    if (prep && used !== null) await settleUsage(v.tenantId, 'ai_interview_ops', used, prep.limit)
    return res
  }
  catch (err) {
    await restore()
    if ((err as { code?: string })?.code === '23514') return { ok: false, code: 'unexplained' }
    throw err
  }
}
