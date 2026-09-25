import { and, eq, sql } from 'drizzle-orm'
import { aiReviewHints } from '../db/schema'
import { withTenant, type TenantTx } from '../utils/withTenant'
import type { SnapshotQuestion } from '../../shared/domain/grading'
import {
  HINT_FAILED_STREAK, hintAgreement, keyPointsOf, validateHint,
  type HintContradiction, type HintMatched, type HintMissing, type KeyPoint,
} from '../../shared/domain/reviewHint'
import { resolveLocale } from '../../shared/domain/dateFormat'
import type { AiReviewHintAgreement, AiReviewHintState, AiReviewHintTarget, ReviewTaskType } from '../../shared/enums'
import { recordAudit } from './audit'
import { readSettings } from './settings'
import { enqueueNotification, tenantAdminIds } from './notifications'
import { reviewGuard } from './reviewQueue'
import { enqueueForTenant } from './tenantQueue'
import { callModel } from './ai/gateway'
import { REVIEW_HINT_PROMPT, type ReviewHintInput } from './ai/prompts'
import { lastHintStates } from './aiQuality'

/**
 * Подсказка проверяющему (`docs/v2/30-ai-interview.md` §3.6, §4, §5.5, §7.13, §8, §12 п. 12,
 * §13 к. 11; план `45` PR-29).
 *
 * **Подсказка — не ответ** (инвариант 18). Она сверяет развёрнутый ответ человека с контрольным
 * ключом (критерии вопроса или практикума, эталонный ответ) и отдаёт ровно три списка: «Збіглося з
 * ключем» с цитатами, «Не згадано», «Суперечить ключу» с цитатой и нейтральным пояснением. Балла,
 * «зараховано», вердикта в ней нет ни колонкой (`ai_review_hints` без них), ни словом (ответ модели
 * со словами вердикта отклоняется, `validateHint`), ни значением в форме ментора: форма проверки
 * не читает подсказку вовсе, её критерии и балл пусты, пока их не заполнит человек (`30` §13 к. 11).
 *
 * Жизненный цикл: постановка работы в очередь (`reviewQueue.ts#enqueueReview`, транзакция самого
 * события) заводит строку `queued`, если функция включена тенантом (`settings.ai.reviewHints`);
 * задача `ai.review_hint` вызывает модель через шлюз (ось `ai_review_ops`, операция на вызов;
 * исчерпана или ИИ не действует — `degraded`, работа идёт обычной ручной проверкой, `35` §7.1);
 * ментор раскрывает панель — `shown_at`; решение ментора — `reviewer_decision` и `agreement` по
 * покрытию ключа (`30` §7.13); решил, не раскрыв, — `not_shown`, контрольная группа (§12 п. 12).
 *
 * Не заводится подсказка к ответам собеседования (`quizzes.kind = 'interview'`) — ни к голосовой
 * сессии, ни к письменной форме: у первой своя оценка ИИ с цитатами, а письменную форму кандидат
 * выбрал, отказавшись от обработки ИИ (`30` §7.5), и вторая машинная обработка его ответов этот
 * выбор обходила бы.
 */

interface Ctx { tenantId: string, actorId: string }

const TASK_TARGET: Partial<Record<ReviewTaskType, AiReviewHintTarget>> = {
  quiz_open_answer: 'attempt_answer',
  workshop: 'workshop_submission',
}

/** Задержка события: строка очереди видна задаче только после фиксации транзакции сдачи. */
const HINT_JOB_DELAY_MS = 3_000
/** Модель думает дольше — сборку забирает следующий (задача или открытая панель). */
const HINT_LEASE_MS = 2 * 60_000
const MODULE_TEXT_MAX = 4_000

const stripHtml = (s: string): string => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

/** Текст блоков контента (вопрос, описание практикума) без разметки. */
function blocksText(blocks: unknown): string {
  const list = Array.isArray(blocks) ? blocks as { html?: string, text?: string, title?: string }[] : []
  return stripHtml(list.map(b => b.html ?? b.text ?? b.title ?? '').filter(t => typeof t === 'string').join(' ')).slice(0, MODULE_TEXT_MAX)
}

interface Target {
  userId: string
  answer: string
  task: string
  keyPoints: KeyPoint[]
  reference: string | null
  moduleText: string | null
  source: Record<string, unknown>
  /** Ответ собеседования — подсказки не бывает (см. шапку файла). */
  interview: boolean
}

async function loadTarget(tx: TenantTx, kind: AiReviewHintTarget, targetId: string): Promise<Target | null> {
  if (kind === 'attempt_answer') {
    const [r] = await tx.execute(sql`
      select aa.answer, aa.question_id::text as question_id, a.snapshot, a.user_id::text as user_id, a.lesson_id::text as lesson_id, q.kind as quiz_kind
        from attempt_answers aa join attempts a on a.id = aa.attempt_id join quizzes q on q.id = a.quiz_id
       where aa.id = ${targetId}::uuid`) as unknown as { answer: { text?: string } | null, question_id: string, snapshot: SnapshotQuestion[], user_id: string, lesson_id: string | null, quiz_kind: string }[]
    if (!r) return null
    const q = (r.snapshot ?? []).find(s => s.id === r.question_id)
    const key = (q?.answer ?? null) as { criteria?: string[], reference?: string } | null
    // «Текст модуля» (`30` §7.13) в PR-29 не передаётся: урок теста — ссылка на тест, а текст
    // соседних материалов — выборка по версии курса; ключ сверки — критерии и эталон вопроса
    const moduleText: string | null = null
    return {
      userId: r.user_id,
      answer: (r.answer?.text ?? '').trim(),
      task: blocksText(q?.stem),
      keyPoints: keyPointsOf({ criteria: key?.criteria ?? [], reference: key?.reference ?? null }),
      reference: key?.reference ? stripHtml(key.reference) : null,
      moduleText,
      source: { questionId: r.question_id, questionVersion: q?.version ?? null, lessonId: r.lesson_id },
      interview: r.quiz_kind === 'interview',
    }
  }
  const [s] = await tx.execute(sql`
    select s.body, s.criteria_snapshot, s.user_id::text as user_id, s.workshop_id::text as workshop_id, w.description
      from workshop_submissions s join workshops w on w.id = s.workshop_id
     where s.id = ${targetId}::uuid`) as unknown as { body: { text?: string } | null, criteria_snapshot: { id?: string, text?: string }[] | null, user_id: string, workshop_id: string, description: unknown }[]
  if (!s) return null
  const criteria = (s.criteria_snapshot ?? []).map(c => c.text ?? '').filter(Boolean)
  return {
    userId: s.user_id,
    answer: (s.body?.text ?? '').trim(),
    task: blocksText(s.description),
    keyPoints: keyPointsOf({ criteria, reference: null }),
    reference: null,
    moduleText: null,
    source: { workshopId: s.workshop_id, criteriaIds: (s.criteria_snapshot ?? []).map(c => c.id).filter(Boolean) },
    interview: false,
  }
}

// ── Постановка (`30` §7.13: триггер — новая работа на проверке) ───────────────────────────

/**
 * Зовётся из `enqueueReview()` — единственной точки постановки работы в очередь — в транзакции
 * самого события. Строка заводится `queued` (или сразу `skipped`, если сверять не с чем); модель
 * зовёт задача `ai.review_hint` уже после фиксации. Пересдача той же работы — та же строка
 * заново: прежние списки и решение ментора снимаются.
 */
export async function requestReviewHintTx(tx: TenantTx, input: { tenantId: string, taskType: ReviewTaskType, sourceId: string, userId: string }): Promise<string | null> {
  const kind = TASK_TARGET[input.taskType]
  if (!kind) return null
  if (!(await readSettings(tx, input.tenantId)).ai.reviewHints) return null
  const target = await loadTarget(tx, kind, input.sourceId)
  if (!target || target.interview) return null
  const skip = !target.keyPoints.length ? 'no_key' : !target.answer ? 'empty_answer' : null
  const keySource = { ...target.source, keyPoints: target.keyPoints }
  const [row] = await tx.insert(aiReviewHints).values({
    tenantId: input.tenantId,
    targetKind: kind,
    targetId: input.sourceId,
    userId: target.userId,
    keySource,
    state: skip ? 'skipped' : 'queued',
    reason: skip,
  }).onConflictDoUpdate({
    target: [aiReviewHints.tenantId, aiReviewHints.targetKind, aiReviewHints.targetId],
    set: {
      keySource, state: skip ? 'skipped' : 'queued', reason: skip, matched: [], missing: [], contradictions: [], coverage: null, confidence: null,
      aiCallId: null, aiStub: false, shownAt: null, reviewerId: null, reviewerDecision: null, reviewerDecidedAt: null, agreement: 'pending', updatedAt: new Date(),
    },
  }).returning({ id: aiReviewHints.id })
  if (!skip) {
    await enqueueForTenant('ai.review_hint', input.tenantId, { hintId: row!.id }, { singletonKey: `ai.review_hint:${row!.id}:${Date.now()}`, startAfter: new Date(Date.now() + HINT_JOB_DELAY_MS) })
      .catch(err => console.error('[ai.review_hint] enqueue', err))
  }
  return row!.id
}

// ── Сборка (`ai.review_hint`) ───────────────────────────────────────────────────────────

export type BuildHintOutcome = AiReviewHintState | 'busy' | 'missing'

/**
 * Сверка через шлюз. Строка забирается арендой (`reason = 'building'` на две минуты): задача и
 * открытая ментором панель не зовут модель дважды. Ответ модели проверяется (`validateHint`): без
 * дословных цитат или со словами вердикта — один повтор с усиленной инструкцией (он не
 * тарифицируется: тенант не платит за брак модели дважды, `30` §7.12), затем `failed`.
 */
export async function buildReviewHint(tenantId: string, hintId: string): Promise<BuildHintOutcome> {
  const claimed = await withTenant(tenantId, null, async (tx) => {
    const [h] = await tx.execute(sql`
      update ai_review_hints set reason = 'building', updated_at = now()
       where id = ${hintId}::uuid and state = 'queued'
         and (reason is distinct from 'building' or updated_at < now() - make_interval(secs => ${HINT_LEASE_MS / 1000}))
      returning id, target_kind, target_id::text as target_id, user_id::text as user_id`) as unknown as { id: string, target_kind: AiReviewHintTarget, target_id: string, user_id: string }[]
    if (!h) {
      const [exists] = await tx.select({ state: aiReviewHints.state }).from(aiReviewHints).where(eq(aiReviewHints.id, hintId))
      return exists ? { busy: true as const } : null
    }
    const target = await loadTarget(tx, h.target_kind, h.target_id)
    const [s] = await tx.execute(sql`select coalesce(locale, 'uk') as locale from tenants where id = ${tenantId}::uuid`) as unknown as { locale: string }[]
    return { hint: h, target, lang: resolveLocale(s?.locale) }
  })
  if (!claimed) return 'missing'
  if ('busy' in claimed) return 'busy'
  const { hint, target, lang } = claimed

  const finish = async (state: AiReviewHintState, set: Partial<typeof aiReviewHints.$inferInsert> = {}): Promise<AiReviewHintState> => {
    await withTenant(tenantId, null, async (tx) => {
      await tx.update(aiReviewHints).set({ state, reason: null, ...set, updatedAt: new Date() }).where(eq(aiReviewHints.id, hint.id))
      if (state === 'failed') await notifyFailedStreak(tx, tenantId)
    })
    return state
  }

  if (!target || !target.answer || !target.keyPoints.length) return finish('skipped', { reason: !target ? 'target_missing' : !target.answer ? 'empty_answer' : 'no_key' })

  const input = (strict: boolean): ReviewHintInput => ({
    lang, strict, task: target.task, keyPoints: target.keyPoints, reference: target.reference, moduleText: target.moduleText, answer: target.answer,
  })
  const ctx = { tenantId, actorId: null }
  const ref = { kind: 'review_hint' as const, id: hint.id }
  let call = await callModel(ctx, REVIEW_HINT_PROMPT, input(false), { ref, subjectUserId: target.userId })
  if (!call.ok) {
    // Ось исчерпана или ИИ не действует — ручная проверка без подсказки (`35` §7.1, `30` §7.12)
    const degraded = call.status === 'degraded' || call.status === 'refused'
    return finish(degraded ? 'degraded' : 'failed', { reason: call.code })
  }
  let checked = validateHint(target.keyPoints, target.answer, call.output.items, call.output.confidence)
  if (!checked.ok) {
    call = await callModel(ctx, REVIEW_HINT_PROMPT, input(true), { ref, subjectUserId: target.userId, tryNo: 2, charge: false })
    if (!call.ok) return finish(call.status === 'degraded' || call.status === 'refused' ? 'degraded' : 'failed', { reason: call.code })
    checked = validateHint(target.keyPoints, target.answer, call.output.items, call.output.confidence)
  }
  if (!checked.ok) {
    const problems = [...new Set(checked.problems.map(p => p.problem))].join(',')
    return finish('failed', { reason: `bad_output:${problems}`.slice(0, 200), aiCallId: call.callId })
  }
  const l = checked.lists
  return finish('ready', {
    matched: l.matched, missing: l.missing, contradictions: l.contradictions,
    coverage: String(l.coverage), confidence: l.confidence === null ? null : String(l.confidence),
    aiCallId: call.callId, aiStub: call.model.driver === 'stub',
  })
}

/** «ШІ-підказка не формується» — три неудачи подряд, админам раз в сутки (`30` §8 `ai.review_hint_failed`). */
async function notifyFailedStreak(tx: TenantTx, tenantId: string): Promise<void> {
  const last = await lastHintStates(tx, HINT_FAILED_STREAK)
  if (last.length < HINT_FAILED_STREAK || last.some(s => s !== 'failed')) return
  const day = new Date().toISOString().slice(0, 10)
  for (const userId of await tenantAdminIds(tx, tenantId)) {
    await enqueueNotification(tx, { tenantId, userId, code: 'ai_review_hint_failed', channel: 'inapp', payload: { n: HINT_FAILED_STREAK }, dedupKey: `ai_review_hint_failed:${day}:${userId}` })
  }
}

// ── Панель ментора (`30` §5.5, §10 `GET /review-hints/:targetKind/:targetId`) ────────────

export interface HintView {
  state: AiReviewHintState
  matched: HintMatched[]
  missing: HintMissing[]
  contradictions: HintContradiction[]
  /** «Покриття ключа: 4 з 6» — число пунктов, а не балл. */
  coverage: { matched: number, total: number } | null
  /** Подсказку дала заглушка, а не модель (Р-28.4). */
  aiStub: boolean
  /** Почему подсказки нет — только администратору (§5.5). */
  reason: string | null
}

export type HintResult
  = | { ok: true, hint: HintView }
    | { ok: false, code: 'absent' | 'degraded' | 'forbidden' }

const TASK_OF: Record<AiReviewHintTarget, ReviewTaskType> = { attempt_answer: 'quiz_open_answer', workshop_submission: 'workshop' }

/**
 * Подсказка для проверяющего. Своя работа — `absent` (своё не проверяют, `37` §7.7); работа в
 * чужих руках — `forbidden`. Первое раскрытие ставит `shown_at`: с этого момента решение
 * ментора сверяется с подсказкой, до него — `not_shown`. Строка, застрявшая в `queued` (задача
 * потерялась), собирается здесь же.
 */
export async function getReviewHint(ctx: Ctx, kind: AiReviewHintTarget, targetId: string, opts: { admin: boolean }): Promise<HintResult> {
  const state = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [h] = await tx.select().from(aiReviewHints).where(and(eq(aiReviewHints.targetKind, kind), eq(aiReviewHints.targetId, targetId)))
    if (!h || h.userId === ctx.actorId) return null
    const guard = await reviewGuard(tx, { taskType: TASK_OF[kind], sourceId: targetId, actorId: ctx.actorId })
    return guard.ok ? h : 'forbidden' as const
  })
  if (state === null) return { ok: false, code: 'absent' }
  if (state === 'forbidden') return { ok: false, code: 'forbidden' }
  if (state.state === 'queued') await buildReviewHint(ctx.tenantId, state.id)

  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [h] = await tx.select().from(aiReviewHints).where(eq(aiReviewHints.id, state.id))
    if (!h) return { ok: false as const, code: 'absent' as const }
    if (h.state === 'degraded') return { ok: false as const, code: 'degraded' as const }
    if (h.state === 'ready' && !h.shownAt) {
      await tx.update(aiReviewHints).set({ shownAt: new Date(), updatedAt: new Date() }).where(eq(aiReviewHints.id, h.id))
    }
    const total = ((h.keySource as { keyPoints?: unknown[] })?.keyPoints ?? []).length
    const matched = h.matched as HintMatched[]
    return {
      ok: true as const,
      hint: {
        state: h.state as AiReviewHintState,
        matched: h.state === 'ready' ? matched : [],
        missing: h.state === 'ready' ? h.missing as HintMissing[] : [],
        contradictions: h.state === 'ready' ? h.contradictions as HintContradiction[] : [],
        coverage: h.state === 'ready' ? { matched: matched.length, total } : null,
        aiStub: h.aiStub,
        reason: opts.admin ? h.reason : null,
      },
    }
  })
}

// ── Решение ментора (`30` §7.13) ─────────────────────────────────────────────────────────

/**
 * Зовут `attempts.ts#gradeManual` и `workshops.ts#grade` в транзакции решения. Подсказка только
 * сверяется с решением — она его не меняет и в нём не участвует. «На доопрацювання» — не зачёт.
 */
export async function recordHintDecisionTx(tx: TenantTx, input: { tenantId: string, kind: AiReviewHintTarget, targetId: string, reviewerId: string, passed: boolean, decision: string }): Promise<AiReviewHintAgreement | null> {
  const [h] = await tx.select().from(aiReviewHints)
    .where(and(eq(aiReviewHints.targetKind, input.kind), eq(aiReviewHints.targetId, input.targetId))).for('update')
  if (!h || h.state !== 'ready') return null
  const agreement = hintAgreement(h.coverage === null ? null : Number(h.coverage), input.passed, !!h.shownAt)
  await tx.update(aiReviewHints).set({
    reviewerId: input.reviewerId,
    reviewerDecision: { passed: input.passed, decision: input.decision },
    reviewerDecidedAt: new Date(),
    agreement,
    updatedAt: new Date(),
  }).where(eq(aiReviewHints.id, h.id))
  await recordAudit(tx, { tenantId: input.tenantId, actorId: input.reviewerId, action: 'ai.review_hint.agreement', entity: 'ai_review_hint', entityId: h.id, after: { agreement, passed: input.passed, shown: !!h.shownAt } })
  return agreement
}

// ── Обезличивание (`30` §7.9) ────────────────────────────────────────────────────────────

/** Цитаты из ответов человека в подсказках — его слова: при обезличивании стираются, счётчики остаются. */
export async function redactHintsTx(tx: TenantTx, userId: string): Promise<number> {
  const rows = await tx.execute(sql`
    update ai_review_hints set matched = '[]'::jsonb, contradictions = '[]'::jsonb, updated_at = now()
     where user_id = ${userId}::uuid and (matched <> '[]'::jsonb or contradictions <> '[]'::jsonb)
    returning id`) as unknown as { id: string }[]
  return rows.length
}
