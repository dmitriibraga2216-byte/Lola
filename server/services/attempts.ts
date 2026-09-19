import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import {
  attemptAnswers, attempts, lessonProgress, lessons, questions, quizQuestions, quizzes, users,
} from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import {
  DEFAULT_QUIZ_PARAMS, MANUAL_KINDS, computeTotals, gradeAnswer, stripAnswers,
  type GradeResult, type QuizParams, type SnapshotQuestion,
} from '../../shared/domain/grading'
import { completeLesson } from './learning'
import { enqueueNotification } from './notifications'

interface Ctx { tenantId: string, actorId: string }

const EXPIRE_AFTER_MS = 24 * 60 * 60 * 1000

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/** Собирает состав вопросов по режиму теста и делает снапшот (docs/12 §7.1–7.2). */
async function buildSnapshot(tx: TenantTx, quiz: typeof quizzes.$inferSelect, params: QuizParams) {
  let picked: { q: typeof questions.$inferSelect, points: number, isCritical: boolean }[] = []

  if (quiz.selectionMode === 'random' && Array.isArray(quiz.randomRules)) {
    for (const rule of quiz.randomRules as { bankId: string, tags?: string[], difficultyMin?: number, difficultyMax?: number, count: number }[]) {
      const pool = await tx.select().from(questions).where(and(
        eq(questions.bankId, rule.bankId),
        eq(questions.status, 'active'),
        ...(rule.difficultyMin ? [sql`${questions.difficulty} >= ${rule.difficultyMin}`] : []),
        ...(rule.difficultyMax ? [sql`${questions.difficulty} <= ${rule.difficultyMax}`] : []),
        ...(rule.tags?.length ? [sql`${questions.tags} && ${rule.tags}`] : []),
      ))
      if (pool.length < rule.count) return { ok: false as const, code: 'not_enough_questions' as const }
      picked.push(...shuffle(pool).slice(0, rule.count).map(q => ({ q, points: Number(q.points), isCritical: q.isCritical })))
    }
  }
  else {
    const rows = await tx.select({ qq: quizQuestions, q: questions })
      .from(quizQuestions)
      .innerJoin(questions, eq(questions.id, quizQuestions.questionId))
      .where(and(eq(quizQuestions.quizId, quiz.id), eq(questions.status, 'active')))
      .orderBy(asc(quizQuestions.sort))
    picked = rows.map(r => ({
      q: r.q,
      points: r.qq.pointsOverride != null ? Number(r.qq.pointsOverride) : Number(r.q.points),
      isCritical: r.qq.isCriticalOverride ?? r.q.isCritical,
    }))
  }

  if (picked.length === 0) return { ok: false as const, code: 'not_enough_questions' as const }
  if (params.shuffleQuestions) picked = shuffle(picked)

  const snapshot: SnapshotQuestion[] = picked.map(({ q, points, isCritical }) => {
    let options = q.options
    if (params.shuffleOptions && Array.isArray(options)) options = shuffle(options as unknown[])
    if (params.shuffleOptions && options && typeof options === 'object' && 'right' in (options as object)) {
      const o = options as { left: unknown[], right: unknown[] }
      options = { left: o.left, right: shuffle(o.right) }
    }
    const answer = q.answer as { requireExact?: boolean } | null
    return {
      id: q.id,
      version: q.version,
      kind: q.kind as SnapshotQuestion['kind'],
      stem: q.stem,
      options,
      answer: q.answer,
      explanation: q.explanation,
      points,
      isCritical,
      partialCredit: q.partialCredit,
      negativeMarking: q.negativeMarking,
      requireExact: answer?.requireExact,
    }
  })
  return { ok: true as const, snapshot }
}

export type StartResult
  = | { ok: true, attemptId: string, attemptNo: number, deadlineAt: Date | null }
    | { ok: false, code: 'not_found' | 'attempts_exhausted' | 'cooldown' | 'not_enough_questions' | 'in_progress', attemptId?: string, retryAt?: Date }

/**
 * Старт попытки (docs/12 §7.1): проверка попыток и cooldown, снапшот с эталонами,
 * params с теста (с этапа 4 — из назначения), deadline.
 */
export async function startAttempt(ctx: Ctx, quizId: string, opts: { enrollmentId?: string, lessonId?: string, device?: string, ip?: string } = {}): Promise<StartResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [quiz] = await tx.select().from(quizzes).where(and(eq(quizzes.id, quizId), isNull(quizzes.deletedAt)))
    if (!quiz) return { ok: false as const, code: 'not_found' as const }

    const params: QuizParams = { ...DEFAULT_QUIZ_PARAMS, ...(quiz.params as Partial<QuizParams>) }

    const prior = await tx.select().from(attempts)
      .where(and(
        eq(attempts.quizId, quizId),
        eq(attempts.userId, ctx.actorId),
        ...(opts.enrollmentId ? [eq(attempts.enrollmentId, opts.enrollmentId)] : []),
        sql`${attempts.status} <> 'annulled'`,
      ))
      .orderBy(desc(attempts.attemptNo))

    const active = prior.find(a => a.status === 'in_progress')
    if (active) return { ok: false as const, code: 'in_progress' as const, attemptId: active.id }

    if (params.attemptsAllowed > 0 && prior.length >= params.attemptsAllowed) {
      return { ok: false as const, code: 'attempts_exhausted' as const }
    }
    const last = prior[0]
    if (last?.submittedAt && params.attemptCooldownMin > 0) {
      const retryAt = new Date(last.submittedAt.getTime() + params.attemptCooldownMin * 60_000)
      if (retryAt > new Date()) return { ok: false as const, code: 'cooldown' as const, retryAt }
    }

    const built = await buildSnapshot(tx, quiz, params)
    if (!built.ok) return { ok: false as const, code: built.code }

    const now = new Date()
    const deadlineAt = params.timeLimitSec ? new Date(now.getTime() + params.timeLimitSec * 1000) : null
    const [attempt] = await tx.insert(attempts).values({
      tenantId: ctx.tenantId,
      quizId,
      enrollmentId: opts.enrollmentId ?? null,
      lessonId: opts.lessonId ?? null,
      userId: ctx.actorId,
      attemptNo: (last?.attemptNo ?? 0) + 1,
      snapshot: built.snapshot,
      params,
      maxScore: String(built.snapshot.reduce((s, q) => s + q.points, 0)),
      startedAt: now,
      deadlineAt,
      device: opts.device ?? null,
      ip: opts.ip ?? null,
    }).returning({ id: attempts.id, attemptNo: attempts.attemptNo })

    return { ok: true as const, attemptId: attempt!.id, attemptNo: attempt!.attemptNo, deadlineAt }
  })
}

/** Состояние попытки для ученика — без эталонов (docs/12 §10, тест attempt-leak). */
export async function getAttemptState(ctx: Ctx, attemptId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [attempt] = await tx.select().from(attempts)
      .where(and(eq(attempts.id, attemptId), eq(attempts.userId, ctx.actorId)))
    if (!attempt) return null

    const answers = await tx.select({ questionId: attemptAnswers.questionId, answer: attemptAnswers.answer })
      .from(attemptAnswers).where(eq(attemptAnswers.attemptId, attemptId))
    const params = attempt.params as QuizParams
    const snapshot = attempt.snapshot as SnapshotQuestion[]
    const finished = ['passed', 'failed', 'expired', 'annulled'].includes(attempt.status)

    return {
      id: attempt.id,
      status: attempt.status,
      attemptNo: attempt.attemptNo,
      deadlineAt: attempt.deadlineAt,
      secondsLeft: attempt.deadlineAt ? Math.max(0, Math.floor((attempt.deadlineAt.getTime() - Date.now()) / 1000)) : null,
      params: {
        allowSkip: params.allowSkip,
        allowBack: params.allowBack,
        requireAllAnswered: params.requireAllAnswered,
        showAnswers: params.showAnswers,
        passScore: params.passScore,
      },
      questions: snapshot.map(q => ({
        ...stripAnswers(q),
        answered: answers.some(a => a.questionId === q.id),
        ...(finished ? {} : {}),
      })),
      answers: Object.fromEntries(answers.map(a => [a.questionId, a.answer])),
      ...(finished && params.showScore ? { score: attempt.score, passed: attempt.passed } : {}),
    }
  })
}

export type SaveAnswerResult = { ok: true } | { ok: false, code: 'not_found' | 'locked' | 'deadline' }

/** Сохранение ответа, идемпотентно; после submit — 423 (docs/12 §7.3). */
export async function saveAnswer(ctx: Ctx, attemptId: string, questionId: string, answer: unknown, timeSpentSec?: number): Promise<SaveAnswerResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [attempt] = await tx.select().from(attempts)
      .where(and(eq(attempts.id, attemptId), eq(attempts.userId, ctx.actorId)))
    if (!attempt) return { ok: false as const, code: 'not_found' as const }
    if (attempt.status !== 'in_progress') return { ok: false as const, code: 'locked' as const }
    if (attempt.deadlineAt && attempt.deadlineAt < new Date()) return { ok: false as const, code: 'deadline' as const }

    const snapshot = attempt.snapshot as SnapshotQuestion[]
    const q = snapshot.find(s => s.id === questionId)
    if (!q) return { ok: false as const, code: 'not_found' as const }

    await tx.insert(attemptAnswers).values({
      tenantId: ctx.tenantId,
      attemptId,
      questionId,
      questionVersion: q.version,
      answer,
      answeredAt: new Date(),
    }).onConflictDoUpdate({
      target: [attemptAnswers.tenantId, attemptAnswers.attemptId, attemptAnswers.questionId],
      set: { answer, answeredAt: new Date(), updatedAt: new Date() },
    })
    if (timeSpentSec) {
      await tx.update(attempts).set({ timeSpentSec: attempt.timeSpentSec + Math.min(timeSpentSec, 3600) })
        .where(eq(attempts.id, attemptId))
    }
    return { ok: true as const }
  })
}

/** Автопроверка по снапшоту и финализация (docs/12 §7.4–7.6). */
async function gradeAndFinalize(tx: TenantTx, ctx: Ctx, attempt: typeof attempts.$inferSelect, reason: 'submit' | 'expire') {
  const snapshot = attempt.snapshot as SnapshotQuestion[]
  const params = attempt.params as QuizParams
  const rows = await tx.select().from(attemptAnswers).where(eq(attemptAnswers.attemptId, attempt.id))
  const byQ = new Map(rows.map(r => [r.questionId, r]))

  const graded = new Map<string, GradeResult>()
  for (const q of snapshot) {
    const row = byQ.get(q.id)
    // Ответ после дедлайна не засчитывается (docs/12 §7.7)
    const late = attempt.deadlineAt && row?.answeredAt && row.answeredAt > attempt.deadlineAt
    const g = gradeAnswer(q, late ? null : (row?.answer ?? null))
    if (row) {
      await tx.update(attemptAnswers).set({
        isCorrect: g.isCorrect,
        score: String(g.score),
        autoGraded: g.auto,
      }).where(eq(attemptAnswers.id, row.id))
      graded.set(q.id, g)
    }
    else if (MANUAL_KINDS.has(q.kind)) {
      // Пустой ручной ответ — незачёт без проверки
      graded.set(q.id, { isCorrect: false, score: 0, auto: true })
    }
  }

  const totals = computeTotals(snapshot, graded, params.passScore)
  const status = totals.passed === null ? 'review' : totals.passed ? 'passed' : 'failed'
  const now = new Date()

  await tx.update(attempts).set({
    status: reason === 'expire' && status === 'review' ? 'review' : status,
    score: String(totals.score),
    passed: totals.passed,
    submittedAt: attempt.submittedAt ?? now,
    ...(status !== 'review' ? { gradedAt: now } : {}),
    updatedAt: now,
  }).where(eq(attempts.id, attempt.id))

  if (status === 'passed') await onAttemptPassed(tx, ctx, attempt)
  if (status !== 'review') {
    const { emitWebhook } = await import('./webhooks')
    await emitWebhook(tx, ctx.tenantId, status === 'passed' ? 'attempt.passed' : 'attempt.failed', { attemptId: attempt.id, userId: attempt.userId, quizId: attempt.quizId, score: totals.score })
    const [quiz] = await tx.select({ title: quizzes.title }).from(quizzes).where(eq(quizzes.id, attempt.quizId))
    const left = params.attemptsAllowed > 0 ? Math.max(0, params.attemptsAllowed - attempt.attemptNo) : null
    await enqueueNotification(tx, {
      tenantId: ctx.tenantId, userId: attempt.userId, code: status === 'passed' ? 'attempt_passed' : 'attempt_failed',
      payload: { quiz: quiz?.title, score: totals.score, left }, dedupKey: `attempt_result:${attempt.id}`,
    })
  }
  return { status, ...totals }
}

/** Зачёт теста как урока курса → завершение урока и прогресс (docs/10 §7.3). */
async function onAttemptPassed(tx: TenantTx, ctx: Ctx, attempt: typeof attempts.$inferSelect) {
  if (!attempt.enrollmentId || !attempt.lessonId) return
  await tx.insert(lessonProgress).values({
    tenantId: ctx.tenantId,
    enrollmentId: attempt.enrollmentId,
    lessonId: attempt.lessonId,
    status: 'completed',
    completedAt: new Date(),
  }).onConflictDoUpdate({
    target: [lessonProgress.tenantId, lessonProgress.enrollmentId, lessonProgress.lessonId],
    set: { status: 'completed', completedAt: new Date() },
  })
}

export type SubmitResult
  = | { ok: true, status: string, score: number, passed: boolean | null, pendingManual: number }
    | { ok: false, code: 'not_found' | 'locked' | 'incomplete', missing?: string[] }

export async function submitAttempt(ctx: Ctx, attemptId: string): Promise<SubmitResult> {
  const result = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [attempt] = await tx.select().from(attempts)
      .where(and(eq(attempts.id, attemptId), eq(attempts.userId, ctx.actorId)))
    if (!attempt) return { ok: false as const, code: 'not_found' as const }
    if (attempt.status !== 'in_progress') return { ok: false as const, code: 'locked' as const }

    const params = attempt.params as QuizParams
    if (params.requireAllAnswered) {
      const snapshot = attempt.snapshot as SnapshotQuestion[]
      const answered = new Set((await tx.select({ q: attemptAnswers.questionId }).from(attemptAnswers)
        .where(eq(attemptAnswers.attemptId, attemptId))).map(r => r.q))
      const missing = snapshot.filter(q => !answered.has(q.id)).map(q => q.id)
      if (missing.length) return { ok: false as const, code: 'incomplete' as const, missing }
    }

    const t = await gradeAndFinalize(tx, ctx, attempt, 'submit')
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'attempt.submit', entity: 'attempt', entityId: attemptId, after: { status: t.status, score: t.score } })
    if (t.status === 'review') {
      const [quiz] = await tx.select({ title: quizzes.title }).from(quizzes).where(eq(quizzes.id, attempt.quizId))
      const [me] = await tx.select({ fullName: users.fullName }).from(users).where(eq(users.id, ctx.actorId))
      const mentorIds = await tx.execute(sql`
        select distinct ur.user_id from user_roles ur join roles r on r.id = ur.role_id
        where r.scopes @> array['review.queue']::text[] and ur.user_id <> ${ctx.actorId}::uuid
          and (ur.scope_type = 'tenant' or (ur.scope_type = 'location' and ur.scope_id in
            (select location_id from user_placements where user_id = ${ctx.actorId}::uuid and ended_at is null)))
      `)
      for (const m of mentorIds as unknown as { user_id: string }[]) {
        await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: m.user_id, code: 'review_needed', payload: { name: me?.fullName, quiz: quiz?.title }, dedupKey: `review_needed:${attemptId}:${m.user_id}` })
      }
    }
    return { ok: true as const, status: t.status, score: t.score, passed: t.passed, pendingManual: t.pendingManual, enrollmentId: attempt.enrollmentId, lessonId: attempt.lessonId }
  })

  // Пересчёт прогресса курса вне транзакции попытки (completeLesson открывает свою)
  if (result.ok && result.status === 'passed' && result.enrollmentId && result.lessonId) {
    await completeLesson(ctx, result.enrollmentId, result.lessonId).catch(() => {})
  }
  return result
}

/** Разбор после завершения по правилу show_answers (docs/12 §5.4). */
export async function getAttemptResult(ctx: Ctx, attemptId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [attempt] = await tx.select().from(attempts)
      .where(and(eq(attempts.id, attemptId), eq(attempts.userId, ctx.actorId)))
    if (!attempt) return null
    if (attempt.status === 'in_progress') return { locked: true as const, status: attempt.status }

    const params = attempt.params as QuizParams
    const snapshot = attempt.snapshot as SnapshotQuestion[]
    const rows = await tx.select().from(attemptAnswers).where(eq(attemptAnswers.attemptId, attemptId))
    const byQ = new Map(rows.map(r => [r.questionId, r]))

    const reveal = params.showAnswers === 'after_attempt'
      || (params.showAnswers === 'after_pass' && attempt.passed === true)
      || params.showAnswers === 'after_question'

    return {
      locked: false as const,
      status: attempt.status,
      score: params.showScore ? Number(attempt.score) : null,
      passScore: params.passScore,
      passed: attempt.passed,
      attemptNo: attempt.attemptNo,
      timeSpentSec: attempt.timeSpentSec,
      questions: snapshot.map((q) => {
        const row = byQ.get(q.id)
        return {
          id: q.id,
          kind: q.kind,
          stem: q.stem,
          options: q.options,
          isCritical: q.isCritical,
          points: q.points,
          yourAnswer: row?.answer ?? null,
          isCorrect: row?.isCorrect ?? (MANUAL_KINDS.has(q.kind) ? null : false),
          score: row ? Number(row.score ?? 0) : 0,
          reviewComment: row?.reviewComment ?? null,
          ...(reveal ? { answer: q.answer, explanation: q.explanation } : {}),
        }
      }),
    }
  })
}

// ── Очередь проверки (docs/14 §5.2) ───────────────────────────────────

export async function reviewQueue(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select({
      answerId: attemptAnswers.id,
      attemptId: attempts.id,
      questionId: attemptAnswers.questionId,
      answer: attemptAnswers.answer,
      answeredAt: attemptAnswers.answeredAt,
      submittedAt: attempts.submittedAt,
      userId: attempts.userId,
      fullName: users.fullName,
      quizTitle: quizzes.title,
      snapshot: attempts.snapshot,
    })
      .from(attemptAnswers)
      .innerJoin(attempts, eq(attempts.id, attemptAnswers.attemptId))
      .innerJoin(users, eq(users.id, attempts.userId))
      .innerJoin(quizzes, eq(quizzes.id, attempts.quizId))
      .where(and(
        eq(attempts.status, 'review'),
        isNull(attemptAnswers.isCorrect),
        eq(attemptAnswers.autoGraded, false),
        // Свои попытки в очередь проверяющего не попадают (docs/01 §1.8)
        sql`${attempts.userId} <> ${ctx.actorId}::uuid`,
      ))
      .orderBy(asc(attempts.submittedAt))
      .limit(200)

    return rows.map((r) => {
      const q = (r.snapshot as SnapshotQuestion[]).find(s => s.id === r.questionId)
      return {
        answerId: r.answerId,
        attemptId: r.attemptId,
        userId: r.userId,
        fullName: r.fullName,
        quizTitle: r.quizTitle,
        submittedAt: r.submittedAt,
        question: q ? { kind: q.kind, stem: q.stem, points: q.points, isCritical: q.isCritical, criteria: (q.answer as { criteria?: string[] } | null)?.criteria ?? [], reference: (q.answer as { reference?: string } | null)?.reference ?? null } : null,
        answer: r.answer,
        hoursWaiting: r.submittedAt ? Math.floor((Date.now() - r.submittedAt.getTime()) / 3_600_000) : 0,
      }
    })
  })
}

export type GradeManualResult
  = | { ok: true, attemptStatus: string }
    | { ok: false, code: 'not_found' | 'self_review' | 'already_graded' }

/** Зачёт/незачёт ручного ответа; после проверки всех — пересчёт попытки (docs/03 §3.4). */
export async function gradeManual(ctx: Ctx, answerId: string, input: { isCorrect: boolean, score?: number, comment?: string }): Promise<GradeManualResult> {
  const result = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await tx.select({ a: attemptAnswers, att: attempts })
      .from(attemptAnswers)
      .innerJoin(attempts, eq(attempts.id, attemptAnswers.attemptId))
      .where(eq(attemptAnswers.id, answerId))
    if (!row) return { ok: false as const, code: 'not_found' as const }
    if (row.att.userId === ctx.actorId) return { ok: false as const, code: 'self_review' as const }
    if (row.a.isCorrect !== null) return { ok: false as const, code: 'already_graded' as const }

    const snapshot = row.att.snapshot as SnapshotQuestion[]
    const q = snapshot.find(s => s.id === row.a.questionId)!
    const score = input.isCorrect ? Math.min(input.score ?? q.points, q.points) : 0

    await tx.update(attemptAnswers).set({
      isCorrect: input.isCorrect,
      score: String(score),
      reviewedBy: ctx.actorId,
      reviewedAt: new Date(),
      reviewComment: input.comment ?? null,
      updatedAt: new Date(),
    }).where(eq(attemptAnswers.id, answerId))

    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'attempt.grade', entity: 'attempt_answer', entityId: answerId, after: { isCorrect: input.isCorrect, score } })

    // Все ручные проверены? → пересчёт
    const rows = await tx.select().from(attemptAnswers).where(eq(attemptAnswers.attemptId, row.att.id))
    const graded = new Map<string, GradeResult>()
    for (const s of snapshot) {
      const r = rows.find(x => x.questionId === s.id)
      if (r && r.isCorrect !== null) graded.set(s.id, { isCorrect: r.isCorrect, score: Number(r.score ?? 0), auto: r.autoGraded })
      else if (!r && MANUAL_KINDS.has(s.kind)) graded.set(s.id, { isCorrect: false, score: 0, auto: true })
    }
    const params = row.att.params as QuizParams
    const totals = computeTotals(snapshot, graded, params.passScore)
    if (totals.passed === null) return { ok: true as const, attemptStatus: 'review', enrollmentId: null, lessonId: null }

    const status = totals.passed ? 'passed' : 'failed'
    await tx.update(attempts).set({
      status,
      score: String(totals.score),
      passed: totals.passed,
      gradedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(attempts.id, row.att.id))
    if (status === 'passed') await onAttemptPassed(tx, ctx, row.att)
    const [quiz] = await tx.select({ title: quizzes.title }).from(quizzes).where(eq(quizzes.id, row.att.quizId))
    await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: row.att.userId, code: 'review_done', payload: { quiz: quiz?.title, status: status === 'passed' ? 'зараховано' : 'не зараховано' }, dedupKey: `review_done:${row.att.id}` })

    return { ok: true as const, attemptStatus: status, enrollmentId: row.att.enrollmentId, lessonId: row.att.lessonId }
  })

  if (result.ok && result.attemptStatus === 'passed' && result.enrollmentId && result.lessonId) {
    const learnerCtx = { tenantId: ctx.tenantId, actorId: (await withTenant(ctx.tenantId, ctx.actorId, async tx =>
      (await tx.select({ u: attempts.userId }).from(attempts).innerJoin(attemptAnswers, eq(attemptAnswers.attemptId, attempts.id)).where(eq(attemptAnswers.id, answerId)))[0]!.u))!
    }
    await completeLesson(learnerCtx, result.enrollmentId, result.lessonId).catch(() => {})
  }
  return result
}

/** Аннулирование руководителем (docs/12 §7.10): не считается использованной попыткой. */
export async function annulAttempt(ctx: Ctx, attemptId: string, reason: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [attempt] = await tx.update(attempts).set({
      status: 'annulled',
      annulledBy: ctx.actorId,
      annulReason: reason,
      updatedAt: new Date(),
    }).where(and(eq(attempts.id, attemptId), sql`${attempts.status} <> 'annulled'`)).returning({ id: attempts.id })
    if (!attempt) return null
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'attempt.annul', entity: 'attempt', entityId: attemptId, after: { reason } })
    return attempt
  })
}

/** Фоновая задача attempt.expire (docs/12 §7.8): закрыть по дедлайну или по 24ч бездействия. */
export async function expireStaleAttempts(tenantId: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const now = new Date()
    const stale = await tx.select().from(attempts).where(and(
      eq(attempts.status, 'in_progress'),
      sql`(${attempts.deadlineAt} is not null and ${attempts.deadlineAt} < ${now}) or ${attempts.updatedAt} < ${new Date(now.getTime() - EXPIRE_AFTER_MS)}`,
    ))
    for (const a of stale) {
      await gradeAndFinalize(tx, { tenantId, actorId: a.userId }, a, 'expire')
    }
    return stale.length
  })
}

/** Список попыток человека по тесту (для истории и повторов). */
export async function listMyAttempts(ctx: Ctx, quizId: string, enrollmentId?: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({
      id: attempts.id,
      attemptNo: attempts.attemptNo,
      status: attempts.status,
      score: attempts.score,
      passed: attempts.passed,
      startedAt: attempts.startedAt,
      submittedAt: attempts.submittedAt,
    }).from(attempts)
      .where(and(
        eq(attempts.quizId, quizId),
        eq(attempts.userId, ctx.actorId),
        ...(enrollmentId ? [eq(attempts.enrollmentId, enrollmentId)] : []),
      ))
      .orderBy(desc(attempts.attemptNo))
  })
}

/** Стартовый экран теста (docs/12 §5.4): что за тест, сколько попыток осталось. */
export async function quizIntro(ctx: Ctx, quizId: string, enrollmentId?: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [quiz] = await tx.select().from(quizzes).where(and(eq(quizzes.id, quizId), isNull(quizzes.deletedAt)))
    if (!quiz) return null
    const params: QuizParams = { ...DEFAULT_QUIZ_PARAMS, ...(quiz.params as Partial<QuizParams>) }
    const prior = await tx.select({ id: attempts.id, status: attempts.status, attemptNo: attempts.attemptNo, passed: attempts.passed })
      .from(attempts)
      .where(and(
        eq(attempts.quizId, quizId),
        eq(attempts.userId, ctx.actorId),
        ...(enrollmentId ? [eq(attempts.enrollmentId, enrollmentId)] : []),
        sql`${attempts.status} <> 'annulled'`,
      ))
      .orderBy(desc(attempts.attemptNo))
    const active = prior.find(a => a.status === 'in_progress')
    const used = prior.length
    return {
      id: quiz.id,
      title: quiz.title,
      description: quiz.description,
      questionCount: quiz.selectionMode === 'random'
        ? ((quiz.randomRules as { count: number }[] | null) ?? []).reduce((s, r) => s + r.count, 0)
        : quiz.questionCount,
      timeLimitSec: params.timeLimitSec,
      passScore: params.passScore,
      attemptsAllowed: params.attemptsAllowed,
      attemptsUsed: used,
      attemptsLeft: params.attemptsAllowed === 0 ? null : Math.max(0, params.attemptsAllowed - used),
      activeAttemptId: active?.id ?? null,
      lastPassed: prior.some(a => a.passed === true),
      history: prior,
    }
  })
}

/** Урок-тест: связь lesson.itemId → quiz. Для плеера: понять, что урок — тест. */
export async function lessonQuizId(ctx: Ctx, lessonId: string): Promise<string | null> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [l] = await tx.select({ itemType: lessons.itemType, itemId: lessons.itemId }).from(lessons).where(eq(lessons.id, lessonId))
    return l?.itemType === 'quiz' ? l.itemId : null
  })
}

/** Тенанты с активными попытками — для фоновой задачи. */
export async function tenantsWithActiveAttempts(): Promise<string[]> {
  const { db } = await import('../db/client')
  const rows = await db.execute(sql`select distinct tenant_id from attempts where status = 'in_progress'`)
  return (rows as unknown as { tenant_id: string }[]).map(r => r.tenant_id)
}

