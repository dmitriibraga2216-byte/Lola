import { and, asc, desc, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm'
import { interviewScenarios, interviewSessions, interviewTurns } from '../../db/schema'
import type { TenantTx } from '../../utils/withTenant'
import { isDuplicateAnswer, longSilencePattern, type InterviewFlag } from '../../../shared/domain/interview'

/**
 * Флаги сессии, которые видны только на всей сессии целиком (`docs/v2/30-ai-interview.md` §7.17):
 * `duplicate_answer` — ответ совпадает с ответом **другого** кандидата на тот же вопрос больше чем
 * на 85 %, и `long_silence_pattern` — долгие паузы в нескольких репликах (`44` Р-AI2.1, Р-AI2.2).
 *
 * Считаются один раз — когда тексты всех реплик готовы: при завершении письменной сессии
 * (`session.ts#finishTx`) и при выходе голосовой из `transcribing` (`pipeline.ts#advanceSession`).
 *
 * **Флаг — материал для человека, а не решение** (инвариант 18, `30` §7.17): балл, состояние
 * сессии, попытка и кандидат отсюда не меняются, кандидату флаг не показывается. Флаг ставится
 * только текущей сессии: чужая сессия, с которой совпал ответ, не трогается — она уже прошла свой
 * путь, и правка её фактов задним числом меняла бы материал, по которому человек мог уже решить.
 */

/** Сколько чужих ответов на вопрос сравниваем — последние по времени: копия ходит по свежим. */
export const DUPLICATE_COMPARE_LIMIT = 500

type Flag = { code: string, ordinal: number | null, at: string }

export async function applyPatternFlagsTx(tx: TenantTx, sessionId: string): Promise<InterviewFlag[]> {
  const [s] = await tx.select({ id: interviewSessions.id, candidateId: interviewSessions.candidateId, scenarioId: interviewSessions.scenarioId, flags: interviewSessions.flags, redactedAt: interviewSessions.redactedAt })
    .from(interviewSessions).where(eq(interviewSessions.id, sessionId))
  if (!s || s.redactedAt) return []
  const [scenario] = await tx.select({ silenceTimeoutSec: interviewScenarios.silenceTimeoutSec }).from(interviewScenarios).where(eq(interviewScenarios.id, s.scenarioId))
  const turns = await tx.select({
    ordinal: interviewTurns.ordinal, questionId: interviewTurns.questionId, transcript: interviewTurns.transcript,
    answerMode: interviewTurns.answerMode, silenceMs: interviewTurns.silenceMs, firstSoundDelayMs: interviewTurns.firstSoundDelayMs,
  }).from(interviewTurns).where(eq(interviewTurns.sessionId, s.id)).orderBy(asc(interviewTurns.ordinal))

  let flags = Array.isArray(s.flags) ? [...s.flags as Flag[]] : []
  const add = (code: InterviewFlag, ordinal: number | null) => {
    if (!flags.some(f => f.code === code && (f.ordinal ?? null) === ordinal)) flags = [...flags, { code, ordinal, at: new Date().toISOString() }]
  }

  for (const t of turns) {
    if (!t.questionId || !t.transcript?.trim()) continue
    const others = await tx.select({ transcript: interviewTurns.transcript })
      .from(interviewTurns)
      .innerJoin(interviewSessions, eq(interviewSessions.id, interviewTurns.sessionId))
      .where(and(
        eq(interviewTurns.questionId, t.questionId),
        ne(interviewSessions.candidateId, s.candidateId),
        isNull(interviewSessions.redactedAt),
        isNotNull(interviewTurns.transcript),
        inArray(interviewTurns.answerMode, ['voice', 'text']),
      ))
      .orderBy(desc(interviewTurns.submittedAt))
      .limit(DUPLICATE_COMPARE_LIMIT)
    if (isDuplicateAnswer(t.transcript, others.map(o => o.transcript!))) add('duplicate_answer', t.ordinal)
  }
  if (scenario && longSilencePattern(turns, scenario.silenceTimeoutSec)) add('long_silence_pattern', null)

  if (flags.length !== (Array.isArray(s.flags) ? s.flags.length : 0)) {
    await tx.update(interviewSessions).set({ flags, updatedAt: new Date() }).where(eq(interviewSessions.id, s.id))
  }
  return flags.map(f => f.code as InterviewFlag)
}
