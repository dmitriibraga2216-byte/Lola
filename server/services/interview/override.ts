import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { interviewCriteria, interviewCriterionScores, interviewSessions } from '../../db/schema'
import { withTenant, type TenantTx } from '../../utils/withTenant'
import { recordAudit } from '../audit'
import { candidateVisible, writeInterviewManualScoreTx, type Viewer } from '../candidates'
import { queueQualityReviewTx } from '../aiQuality'
import { criterionAgreement, humanAdjustedScore, type CriterionAgreement } from '../../../shared/domain/interview'
import type { InterviewOverrideInput } from '../../../shared/schemas/interview'

/**
 * «Не погоджуюсь» — рекрутер оспаривает оценку ИИ по критерию (`docs/v2/30-ai-interview.md` §6.4,
 * §7.3, §12 п. 6, §13 к. 6; план `45` PR-29).
 *
 * **Машинная оценка не переписывается никогда** (§7.3): человеческое значение ложится рядом, в
 * `human_value` той же строки, а в карточку кандидата — **новой** строкой `candidate_scores.kind =
 * 'manual'` авторства человека (итог сессии, пересчитанный с его баллом). Строка `kind = 'ai'`
 * остаётся как была: затирать машинную оценку человеческой нельзя — теряется материал для
 * метрики качества (§7.16). Расхождение `agreement` считается сразу; `major` и отметка «груба
 * помилка моделі» ставят вывод модели в очередь перепроверки качества той же транзакцией.
 *
 * Двое спорят об одном критерии — оптимистическая блокировка по `human_at` (§12 п. 6): форма
 * присылает момент прежнего несогласия, который видела; не совпал — `409 conflict` и актуальное
 * значение, чужое несогласие не затирается молча.
 *
 * Решения о человеке здесь нет (инвариант 18): ни колонка канбана, ни состояние кандидата не
 * меняются, а новая оценка — человеческая, со своим автором.
 */

export interface OverrideView {
  criterionId: string
  sessionId: string
  value: number
  scaleMax: number
  humanValue: number
  humanComment: string
  humanAt: string
  agreement: CriterionAgreement
  /** Новая строка `candidate_scores.kind = 'manual'` — итог сессии с поправкой человека. */
  manualScoreId: string
  manualScore: number
  /** Строка очереди перепроверки качества, если вывод модели туда попал (`major` или отметка). */
  qualityReviewId: string | null
}

export interface OverrideConflict {
  humanValue: number | null
  humanComment: string | null
  humanAt: string | null
  humanBy: string | null
  agreement: string
}

export type OverrideResult
  = | { ok: true, override: OverrideView }
    | { ok: false, code: 'not_found' | 'not_scored' }
    | { ok: false, code: 'out_of_scale', scaleMax: number }
    | { ok: false, code: 'conflict', current: OverrideConflict }

const num = (v: string | null): number | null => (v === null ? null : Number(v))

export async function overrideCriterion(v: Viewer, candidateId: string, criterionId: string, input: InterviewOverrideInput): Promise<OverrideResult> {
  if (!await candidateVisible(v, candidateId)) return { ok: false, code: 'not_found' }
  return withTenant(v.tenantId, v.actorId, async (tx): Promise<OverrideResult> => {
    // Последняя сессия кандидата, где у критерия есть оценка ИИ; строка блокируется до конца решения
    const [row] = await tx.select({ score: interviewCriterionScores, session: interviewSessions })
      .from(interviewCriterionScores)
      .innerJoin(interviewSessions, eq(interviewSessions.id, interviewCriterionScores.sessionId))
      .where(and(eq(interviewSessions.candidateId, candidateId), eq(interviewCriterionScores.criterionId, criterionId)))
      .orderBy(desc(interviewSessions.createdAt))
      .limit(1)
      .for('update', { of: interviewCriterionScores })
    if (!row) {
      const [known] = await tx.select({ id: interviewCriteria.id }).from(interviewCriteria)
        .innerJoin(interviewSessions, eq(interviewSessions.scenarioId, interviewCriteria.scenarioId))
        .where(and(eq(interviewCriteria.id, criterionId), eq(interviewSessions.candidateId, candidateId))).limit(1)
      return known ? { ok: false, code: 'not_scored' } : { ok: false, code: 'not_found' }
    }
    const { score, session } = row
    if (score.value === null || session.redactedAt || !['scored', 'needs_human'].includes(session.state)) return { ok: false, code: 'not_scored' }

    const expected = input.expectedHumanAt ? new Date(input.expectedHumanAt).getTime() : null
    const current = score.humanAt ? score.humanAt.getTime() : null
    if (expected !== current) {
      return {
        ok: false,
        code: 'conflict',
        current: {
          humanValue: num(score.humanValue), humanComment: score.humanComment, humanAt: score.humanAt?.toISOString() ?? null,
          humanBy: score.humanBy, agreement: score.agreement,
        },
      }
    }

    const [criterion] = await tx.select().from(interviewCriteria).where(eq(interviewCriteria.id, criterionId))
    const scaleMax = Number(criterion!.scaleMax)
    if (input.humanValue > scaleMax) return { ok: false, code: 'out_of_scale', scaleMax }

    const ai = Number(score.value)
    const agreement = criterionAgreement(ai, input.humanValue, scaleMax)
    const now = new Date()
    await tx.update(interviewCriterionScores).set({
      humanValue: String(input.humanValue), humanBy: v.actorId, humanAt: now, humanComment: input.humanComment, agreement, updatedAt: now,
    }).where(eq(interviewCriterionScores.id, score.id))

    // Итог сессии с поправкой человека — все критерии сценария, у оспоренных балл человека
    const criteria = await tx.select({ id: interviewCriteria.id, scaleMax: interviewCriteria.scaleMax, weight: interviewCriteria.weight })
      .from(interviewCriteria).where(eq(interviewCriteria.scenarioId, session.scenarioId)).orderBy(asc(interviewCriteria.sort))
    const scores = await tx.select({ criterionId: interviewCriterionScores.criterionId, value: interviewCriterionScores.value, humanValue: interviewCriterionScores.humanValue })
      .from(interviewCriterionScores).where(eq(interviewCriterionScores.sessionId, session.id))
    const byCriterion = new Map(scores.map(s => [s.criterionId, s]))
    const manualScore = humanAdjustedScore(criteria.map(c => ({
      value: num(byCriterion.get(c.id)?.value ?? null),
      humanValue: num(byCriterion.get(c.id)?.humanValue ?? null),
      scaleMax: Number(c.scaleMax),
      weight: Number(c.weight),
    }))) ?? 0
    const manualScoreId = await writeInterviewManualScoreTx(tx, v.tenantId, candidateId, {
      value: manualScore, sessionId: session.id, authorId: v.actorId, comment: input.humanComment,
    })

    const qualityReviewId = agreement === 'major' || input.major
      ? await queueQualityReviewTx(tx, v.tenantId, {
        refKind: 'interview_criterion_score',
        refId: score.id,
        sampledBy: 'override',
        reason: input.major ? 'override_flagged' : 'override_major',
        // «Позначити як грубу помилку моделі» — вердикт рекрутера о модели сразу (§6.4)
        verdict: input.major ? { verdict: 'major_error', auditorId: v.actorId, notes: input.humanComment } : null,
      })
      : null

    await recordAudit(tx, {
      tenantId: v.tenantId,
      actorId: v.actorId,
      action: 'interview.override',
      entity: 'interview_criterion_score',
      entityId: score.id,
      before: { value: ai, humanValue: num(score.humanValue), agreement: score.agreement },
      after: { candidateId, sessionId: session.id, criterionId, humanValue: input.humanValue, agreement, major: input.major, manualScoreId, manualScore, qualityReviewId },
    })
    return {
      ok: true,
      override: {
        criterionId, sessionId: session.id, value: ai, scaleMax, humanValue: input.humanValue, humanComment: input.humanComment,
        humanAt: now.toISOString(), agreement, manualScoreId, manualScore, qualityReviewId,
      },
    }
  })
}

/** Есть ли у кандидата хоть один критерий собеседования, перепроверенный человеком (`30` §7.14 п. 7, §7.15). */
export async function humanCheckedTx(tx: TenantTx, candidateId: string): Promise<boolean> {
  const [r] = await tx.execute(sql`
    select exists (
      select 1 from interview_criterion_scores ics join interview_sessions s on s.id = ics.session_id
       where s.candidate_id = ${candidateId}::uuid and ics.human_at is not null) as checked`) as unknown as { checked: boolean }[]
  return !!r?.checked
}
