import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { aiCalls, aiQualityReviews, aiReviewHints, candidateSummaries, interviewCriteria, interviewCriterionScores } from '../db/schema'
import { withTenant, type TenantTx } from '../utils/withTenant'
import { keysetAfter, keysetAt } from '../utils/keyset'
import { KEYSETS, encodeKeyset } from '../../shared/domain/keyset'
import type { AiQualityRefKind, AiQualitySampledBy, AiQualityVerdict } from '../../shared/enums'
import type { AiQualityListQuery, AiQualityVerdictInput } from '../../shared/schemas/ai'
import { recordAudit } from './audit'
import { enqueueNotification, tenantAdminIds } from './notifications'

/**
 * Контроль качества ИИ (`docs/v2/30-ai-interview.md` §3.6, §6.4, §7.16, §8, §11; план `45` PR-29):
 * очередь выборочной перепроверки `ai_quality_reviews` и метрика расхождения с человеком.
 *
 * Как вывод модели попадает в очередь:
 * - **сразу** — рекрутер не согласился с оценкой ИИ по критерию, и расхождение `major` или он
 *   отметил «груба помилка моделі» (`sampled_by = 'override'`, `30` §6.4, §13 к. 6);
 * - **ежедневной выборкой** `ai.quality_sample` (06:00): 5 % оценок критериев и 5 % подсказок, все
 *   `agreement = 'major'` и все с уверенностью ниже 0,5 (`sampled_by = 'auto'`, §7.16). Выборка
 *   детерминирована хешем идентификатора: повторный прогон не добавляет случайных строк сверх
 *   5 %, а уникальный ключ `(tenant_id, ref_kind, ref_id)` — дублей.
 *
 * Вердикт — о **модели**, а не о человеке: «правильно ли модель объяснила балл», а не «хорош ли
 * кандидат». Метрика `ai.metrics_rollup` (06:30): доля `major` за 30 дней по версии промпта выше
 * 15 % — `ai_quality_degraded` администраторам. Смена `prompt_version` обнуляет накопленное: версии
 * между собой не сравниваются (§7.16).
 */

interface Ctx { tenantId: string, actorId: string }

// ── Постановка в очередь ────────────────────────────────────────────────────────────────

export interface QueueQualityInput {
  refKind: AiQualityRefKind
  refId: string
  sampledBy: AiQualitySampledBy
  reason: string
  /** Вердикт, известный сразу: рекрутер отметил «груба помилка моделі» (§6.4). */
  verdict: { verdict: AiQualityVerdict, auditorId: string, notes: string | null } | null
}

/**
 * Одна строка на вывод модели. Повтор не дублирует строку; вердикт, поставленный раньше
 * аудитором, не затирается — вердикт из формы рекрутера ложится только в непроверенную строку.
 */
export async function queueQualityReviewTx(tx: TenantTx, tenantId: string, input: QueueQualityInput): Promise<string> {
  const v = input.verdict
  const [row] = await tx.execute(sql`
    insert into ai_quality_reviews (tenant_id, ref_kind, ref_id, sampled_by, sample_reason, auditor_id, verdict, notes, reviewed_at)
    values (${tenantId}::uuid, ${input.refKind}, ${input.refId}::uuid, ${input.sampledBy}, ${input.reason},
            ${v?.auditorId ?? null}::uuid, ${v?.verdict ?? null}, ${v?.notes ?? null}, ${v ? sql`now()` : sql`null`})
    on conflict (tenant_id, ref_kind, ref_id) do update set
      auditor_id = case when ai_quality_reviews.verdict is null then excluded.auditor_id else ai_quality_reviews.auditor_id end,
      notes = case when ai_quality_reviews.verdict is null then excluded.notes else ai_quality_reviews.notes end,
      reviewed_at = case when ai_quality_reviews.verdict is null then excluded.reviewed_at else ai_quality_reviews.reviewed_at end,
      verdict = coalesce(ai_quality_reviews.verdict, excluded.verdict),
      updated_at = now()
    returning id`) as unknown as { id: string }[]
  return row!.id
}

// ── Очередь администратора (`30` §5.6, §10 `/ai/quality-reviews`) ───────────────────────

export interface QualityItem {
  id: string
  refKind: AiQualityRefKind
  refId: string
  sampledBy: AiQualitySampledBy
  sampleReason: string | null
  verdict: AiQualityVerdict | null
  notes: string | null
  auditorId: string | null
  reviewedAt: string | null
  createdAt: string
  /** Что перепроверяется — вывод модели и то, с чем его сравнивал человек. */
  subject: Record<string, unknown> | null
}

const num = (v: string | null | undefined): number | null => (v === null || v === undefined ? null : Number(v))

/** Сам вывод модели для экрана перепроверки: оценка с обоснованием, подсказка или генеративная секция. */
async function subjectOf(tx: TenantTx, refKind: string, refId: string): Promise<Record<string, unknown> | null> {
  if (refKind === 'interview_criterion_score') {
    const [r] = await tx.select({ s: interviewCriterionScores, name: interviewCriteria.nameUk, scaleMax: interviewCriteria.scaleMax, promptVersion: aiCalls.promptVersion, modelName: aiCalls.modelName })
      .from(interviewCriterionScores)
      .innerJoin(interviewCriteria, eq(interviewCriteria.id, interviewCriterionScores.criterionId))
      .leftJoin(aiCalls, eq(aiCalls.id, interviewCriterionScores.aiCallId))
      .where(eq(interviewCriterionScores.id, refId))
    if (!r) return null
    return {
      criterion: r.name, scaleMax: num(r.scaleMax), value: num(r.s.value), confidence: num(r.s.confidence), rationale: r.s.rationale,
      evidence: r.s.evidence, humanValue: num(r.s.humanValue), humanComment: r.s.humanComment, agreement: r.s.agreement,
      redacted: !!r.s.redactedAt, promptVersion: r.promptVersion, model: r.modelName,
    }
  }
  if (refKind === 'review_hint') {
    const [h] = await tx.select({ h: aiReviewHints, promptVersion: aiCalls.promptVersion, modelName: aiCalls.modelName })
      .from(aiReviewHints).leftJoin(aiCalls, eq(aiCalls.id, aiReviewHints.aiCallId)).where(eq(aiReviewHints.id, refId))
    if (!h) return null
    return {
      keySource: h.h.keySource, matched: h.h.matched, missing: h.h.missing, contradictions: h.h.contradictions, coverage: num(h.h.coverage),
      confidence: num(h.h.confidence), agreement: h.h.agreement, reviewerDecision: h.h.reviewerDecision, aiStub: h.h.aiStub,
      promptVersion: h.promptVersion, model: h.modelName,
    }
  }
  const [s] = await tx.select({ body: candidateSummaries.body, redactedAt: candidateSummaries.redactedAt }).from(candidateSummaries).where(eq(candidateSummaries.id, refId))
  if (!s) return null
  return { strengthsRisks: (s.body as { strengthsRisks?: unknown }).strengthsRisks ?? null, redacted: !!s.redactedAt }
}

function toItem(r: typeof aiQualityReviews.$inferSelect, subject: Record<string, unknown> | null): QualityItem {
  return {
    id: r.id, refKind: r.refKind as AiQualityRefKind, refId: r.refId, sampledBy: r.sampledBy as AiQualitySampledBy, sampleReason: r.sampleReason,
    verdict: r.verdict as AiQualityVerdict | null, notes: r.notes, auditorId: r.auditorId, reviewedAt: r.reviewedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(), subject,
  }
}

export async function listQualityReviews(ctx: Ctx, q: AiQualityListQuery): Promise<{ items: QualityItem[], nextCursor: string | null }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const conds = [
      q.status === 'pending' ? isNull(aiQualityReviews.verdict) : q.status === 'reviewed' ? isNotNull(aiQualityReviews.verdict) : undefined,
      q.refKind ? eq(aiQualityReviews.refKind, q.refKind) : undefined,
      keysetAfter(KEYSETS.aiQualityReviews, q.cursor, [aiQualityReviews.createdAt, aiQualityReviews.id], 'desc'),
    ].filter(Boolean)
    const rows = await tx.select({ r: aiQualityReviews, cursorAt: keysetAt(aiQualityReviews.createdAt) }).from(aiQualityReviews)
      .where(and(...conds))
      .orderBy(desc(aiQualityReviews.createdAt), desc(aiQualityReviews.id))
      .limit(q.limit + 1)
    const page = rows.slice(0, q.limit)
    const items: QualityItem[] = []
    for (const { r } of page) items.push(toItem(r, await subjectOf(tx, r.refKind, r.refId)))
    const last = rows.length > q.limit ? page[page.length - 1] : undefined
    return { items, nextCursor: last ? encodeKeyset(KEYSETS.aiQualityReviews, [last.cursorAt, last.r.id]) : null }
  })
}

export async function getQualityReview(ctx: Ctx, id: string): Promise<QualityItem | null> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.select().from(aiQualityReviews).where(eq(aiQualityReviews.id, id))
    return r ? toItem(r, await subjectOf(tx, r.refKind, r.refId)) : null
  })
}

/** Вердикт аудитора о выводе модели (`30` §10 `POST /ai/quality-reviews`). Повторный — пересмотр, след в журнале. */
export async function setQualityVerdict(ctx: Ctx, id: string, input: AiQualityVerdictInput): Promise<QualityItem | null> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(aiQualityReviews).where(eq(aiQualityReviews.id, id)).for('update')
    if (!before) return null
    const [r] = await tx.update(aiQualityReviews).set({
      verdict: input.verdict, notes: input.notes ?? null, auditorId: ctx.actorId, reviewedAt: new Date(), updatedAt: new Date(),
    }).where(eq(aiQualityReviews.id, id)).returning()
    await recordAudit(tx, {
      tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'ai.quality.verdict', entity: 'ai_quality_review', entityId: id,
      before: { verdict: before.verdict, auditorId: before.auditorId }, after: { verdict: input.verdict, refKind: before.refKind, refId: before.refId },
    })
    return toItem(r!, await subjectOf(tx, r!.refKind, r!.refId))
  })
}

// ── Ежедневная выборка (`30` §7.16, §11 `ai.quality_sample`) ────────────────────────────

/** Доля случайной выборки — 5 % (§7.16); окно — неделя: пропущенный день выборка догоняет. */
export const QUALITY_SAMPLE_PERCENT = 5
export const QUALITY_SAMPLE_WINDOW_DAYS = 7
/** Уверенность ниже этой — в выборку целиком (§7.16). */
export const QUALITY_LOW_CONFIDENCE = 0.5

export async function sampleQuality(tenantId: string): Promise<{ scores: number, hints: number }> {
  return withTenant(tenantId, null, async (tx) => {
    // Детерминированный «случай»: первые 32 бита md5 идентификатора по модулю 100
    const pick = (col: string) => sql.raw(`(('x' || substr(md5(${col}::text), 1, 8))::bit(32)::int & 2147483647) % 100 < ${QUALITY_SAMPLE_PERCENT}`)
    const scores = await tx.execute(sql`
      insert into ai_quality_reviews (tenant_id, ref_kind, ref_id, sampled_by, sample_reason)
      select ${tenantId}::uuid, 'interview_criterion_score', s.id, 'auto',
             case when s.agreement = 'major' then 'major' when s.confidence < ${QUALITY_LOW_CONFIDENCE} then 'low_confidence' else 'random' end
        from interview_criterion_scores s
       where s.created_at > now() - make_interval(days => ${QUALITY_SAMPLE_WINDOW_DAYS})
         and (s.agreement = 'major' or s.confidence < ${QUALITY_LOW_CONFIDENCE} or ${pick('s.id')})
      on conflict (tenant_id, ref_kind, ref_id) do nothing
      returning id`) as unknown as { id: string }[]
    const hints = await tx.execute(sql`
      insert into ai_quality_reviews (tenant_id, ref_kind, ref_id, sampled_by, sample_reason)
      select ${tenantId}::uuid, 'review_hint', h.id, 'auto',
             case when h.agreement = 'major' then 'major' when h.confidence < ${QUALITY_LOW_CONFIDENCE} then 'low_confidence' else 'random' end
        from ai_review_hints h
       where h.state = 'ready' and h.created_at > now() - make_interval(days => ${QUALITY_SAMPLE_WINDOW_DAYS})
         and (h.agreement = 'major' or h.confidence < ${QUALITY_LOW_CONFIDENCE} or ${pick('h.id')})
      on conflict (tenant_id, ref_kind, ref_id) do nothing
      returning id`) as unknown as { id: string }[]
    return { scores: scores.length, hints: hints.length }
  })
}

// ── Метрика расхождения (`30` §7.16, §8 `ai.quality_degraded`, §11 `ai.metrics_rollup`) ─

/** Порог доли `major` за 30 дней (§7.16). */
export const QUALITY_MAJOR_THRESHOLD = 0.15
export const QUALITY_WINDOW_DAYS = 30
/**
 * Меньше решений — доля не считается (сверх документа): при трёх решениях один `major` — 33 %,
 * и администратор получал бы тревогу от шума, а не от модели.
 */
export const QUALITY_MIN_DECISIONS = 10

export interface QualityMetric { kind: 'interview_score' | 'review_hint', promptKey: string, promptVersion: string, decided: number, major: number, minor: number, share: number, degraded: boolean }

export async function qualityRollup(tenantId: string, now: Date = new Date()): Promise<QualityMetric[]> {
  return withTenant(tenantId, null, async (tx) => {
    const rows = await tx.execute(sql`
      select 'interview_score' as kind, c.prompt_key, c.prompt_version,
             count(*)::int as decided,
             count(*) filter (where s.agreement = 'major')::int as major,
             count(*) filter (where s.agreement = 'minor')::int as minor
        from interview_criterion_scores s join ai_calls c on c.id = s.ai_call_id
       where s.agreement in ('match', 'minor', 'major') and s.human_at > now() - make_interval(days => ${QUALITY_WINDOW_DAYS})
       group by c.prompt_key, c.prompt_version
      union all
      select 'review_hint', c.prompt_key, c.prompt_version,
             count(*)::int, count(*) filter (where h.agreement = 'major')::int, count(*) filter (where h.agreement = 'minor')::int
        from ai_review_hints h join ai_calls c on c.id = h.ai_call_id
       where h.agreement in ('match', 'minor', 'major') and h.reviewer_decided_at > now() - make_interval(days => ${QUALITY_WINDOW_DAYS})
       group by c.prompt_key, c.prompt_version`) as unknown as { kind: QualityMetric['kind'], prompt_key: string, prompt_version: string, decided: number, major: number, minor: number }[]
    const out: QualityMetric[] = rows.map((r) => {
      const share = r.decided ? r.major / r.decided : 0
      return { kind: r.kind, promptKey: r.prompt_key, promptVersion: r.prompt_version, decided: r.decided, major: r.major, minor: r.minor, share, degraded: r.decided >= QUALITY_MIN_DECISIONS && share > QUALITY_MAJOR_THRESHOLD }
    })
    const day = now.toISOString().slice(0, 10)
    for (const m of out.filter(x => x.degraded)) {
      for (const userId of await tenantAdminIds(tx, tenantId)) {
        await enqueueNotification(tx, {
          tenantId, userId, code: 'ai_quality_degraded', channel: 'email',
          payload: { x: Math.round(m.share * 100), prompt: `${m.promptKey} ${m.promptVersion}` },
          dedupKey: `ai_quality_degraded:${m.promptKey}:${m.promptVersion}:${day}:${userId}`,
        })
      }
    }
    return out
  })
}

/** Подсказки тенанта по состоянию — для уведомления «3 неудачи подряд» (`30` §8 `ai.review_hint_failed`). */
export async function lastHintStates(tx: TenantTx, n: number): Promise<string[]> {
  const rows = await tx.select({ state: aiReviewHints.state }).from(aiReviewHints)
    .where(sql`${aiReviewHints.state} in ('ready', 'failed')`)
    .orderBy(desc(aiReviewHints.updatedAt), desc(aiReviewHints.id)).limit(n)
  return rows.map(r => r.state)
}
