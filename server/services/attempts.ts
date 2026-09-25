import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  attemptAnswers, attemptRequests, attemptResults, attempts, enrollments, lessons, locations, mediaAssets,
  pointsLedger, positions, questions, quizQuestions, quizzes, userPlacements, users,
} from '../db/schema'
import type { z } from 'zod'
import type { answerFileSchema, reviewAnswersQuerySchema } from '../../shared/schemas/quizzes'
import { withTenant } from '../utils/withTenant'
import { withoutNews } from '../utils/withoutNews'
import { findAssignmentFor, resolveQuizParams } from './taskParams'
import { balanceOf } from './pointsLedger'
import { business } from '../utils/metrics'
import type { TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import {
  MANUAL_KINDS, computeTotals, gradeAnswer, stripAnswers,
  type GradeResult, type QuizParams, type SnapshotQuestion,
} from '../../shared/domain/grading'
import { rescoreVerdict } from '../../shared/domain/contentIssues'
import type { AnswerInputMode, ScoringMethod } from '../../shared/enums'
import { completeLesson, markLessonCompleted, rollbackLessonCompletion, type RollbackResult } from './learning'
import { recordActivity } from './activity'
import { logTaskAccess } from './journals'
import { enqueueNotification } from './notifications'
import { closeReview, enqueueReview, heldByOtherSql, reviewGuard } from './reviewQueue'
import { closeOpenSegments } from './learningTime'
import { plannedSecondsFor } from './timeNorms'

interface Ctx { tenantId: string, actorId: string }

/** Сутки без активности закрывают попытку (docs/12 §7 п. 8). */
const EXPIRE_AFTER = sql.raw(`interval '24 hours'`)
/** Закрытие, опоздавшее больше чем на столько, — тихое: без уведомлений и вебхуков (docs/12 §7 п. 8). */
const QUIET_AFTER = sql.raw(`interval '24 hours'`)

/** Массив строк как параметр запроса: postgres-js не выводит тип text[] сам. */
function textArray(values: string[]) {
  return sql`array[${sql.join(values.map(v => sql`${v}::text`), sql`, `)}]::text[]`
}

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
        ...(rule.tags?.length ? [sql`${questions.tags} && ${textArray(rule.tags)}`] : []),
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

  // «Кількість питань» из назначения (docs/15 §14.3, docs/12 §14.3): one_per_group — по одному случайному
  // вопросу из каждой группы теста (вопросы без группы входят все), limited — случайные N.
  if (quiz.selectionMode !== 'random' && params.questionsMode === 'one_per_group') {
    const byGroup = new Map<string, typeof picked>()
    const ungrouped: typeof picked = []
    for (const p of picked) {
      if (!p.q.questionGroupId) { ungrouped.push(p); continue }
      const arr = byGroup.get(p.q.questionGroupId) ?? []
      arr.push(p)
      byGroup.set(p.q.questionGroupId, arr)
    }
    const chosen = [...byGroup.values()].map(arr => shuffle(arr)[0]!)
    picked = picked.filter(p => ungrouped.includes(p) || chosen.includes(p))
  }
  else if (quiz.selectionMode !== 'random' && params.questionsMode === 'limited' && params.questionsCount && params.questionsCount < picked.length) {
    const keep = new Set(shuffle(picked).slice(0, params.questionsCount))
    picked = picked.filter(p => keep.has(p))
  }

  if (params.shuffleQuestions) picked = shuffle(picked)

  const snapshot: SnapshotQuestion[] = picked.map(({ q, points, isCritical }) => {
    let options = q.options
    if (params.shuffleOptions && Array.isArray(options)) options = shuffle(options as unknown[])
    if (params.shuffleOptions && options && typeof options === 'object' && 'right' in (options as object)) {
      const o = options as { left: unknown[], right: unknown[] }
      options = { left: o.left, right: shuffle(o.right) }
    }
    if (params.shuffleOptions && options && typeof options === 'object' && 'items' in (options as object) && 'groups' in (options as object)) {
      const o = options as { groups: unknown[], items: unknown[] }
      options = { groups: o.groups, items: shuffle(o.items) }
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
      scoringMethod: q.scoringMethod as ScoringMethod,
      negativeMarking: q.negativeMarking,
      requireExact: answer?.requireExact,
      groupId: q.questionGroupId,
      graderHint: q.graderHint,
      attachFiles: q.attachFiles,
    }
  })
  return { ok: true as const, snapshot }
}

/**
 * Одобренные запросы дополнительных попыток (docs/12 §14.5): каждый даёт +1 попытку сверх
 * лимита назначения. Само назначение не меняется.
 */
export async function approvedExtraAttempts(tx: TenantTx, userId: string, quizId: string, enrollmentId?: string | null): Promise<number> {
  const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(attemptRequests).where(and(
    eq(attemptRequests.userId, userId),
    eq(attemptRequests.quizId, quizId),
    eq(attemptRequests.status, 'approved'),
    ...(enrollmentId ? [eq(attemptRequests.enrollmentId, enrollmentId)] : []),
  ))
  return row?.n ?? 0
}

/** Ограничение попыток с учётом одобренных запросов: 0 — без ограничения. */
export function effectiveAttemptsAllowed(params: QuizParams, extra: number): number {
  return params.attemptsAllowed > 0 ? params.attemptsAllowed + extra : 0
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

    // Правила — из назначения, не из теста (CLAUDE.md п. 11)
    const { params, assignmentId } = await resolveQuizParams(tx, { tenantId: ctx.tenantId, userId: ctx.actorId, quizId, enrollmentId: opts.enrollmentId, lessonId: opts.lessonId })

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

    const allowed = effectiveAttemptsAllowed(params, await approvedExtraAttempts(tx, ctx.actorId, quizId, opts.enrollmentId))
    if (allowed > 0 && prior.length >= allowed) {
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
      assignmentId,
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

    // docs/22 §13.4: старт попытки — обращение к заданию (каждое, не первое)
    await logTaskAccess(tx, { tenantId: ctx.tenantId, userId: ctx.actorId, contentType: 'test', contentId: quizId, title: quiz.title, assignmentId: assignmentId ?? null, enrollmentId: opts.enrollmentId ?? null })
    business.inc({ event: 'attempt_started' })
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

/** Способ ввода ответа (`ANSWER_INPUT_MODES`): вопрос-файл отвечается файлом, остальные — текстом. */
export function answerInputMode(kind: string): AnswerInputMode {
  return kind === 'file' ? 'file' : 'text'
}

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

    // Способ ввода — по типу вопроса из снапшота (docs/v2/30 §3.7, docs/v2/44 В-12): решает
    // сервер, клиент его не присылает. Голос и видео приходят с ИИ-собеседованием (PR-28).
    const inputMode = answerInputMode(q.kind)
    await tx.insert(attemptAnswers).values({
      tenantId: ctx.tenantId,
      attemptId,
      questionId,
      questionVersion: q.version,
      answer,
      answeredAt: new Date(),
      inputMode,
    }).onConflictDoUpdate({
      target: [attemptAnswers.tenantId, attemptAnswers.attemptId, attemptAnswers.questionId],
      set: { answer, answeredAt: new Date(), updatedAt: new Date(), inputMode },
    })
    if (timeSpentSec) {
      await tx.update(attempts).set({ timeSpentSec: attempt.timeSpentSec + Math.min(timeSpentSec, 3600) })
        .where(eq(attempts.id, attemptId))
    }
    return { ok: true as const }
  })
}

/** Автопроверка по снапшоту и финализация (docs/12 §7.4–7.6). */
/**
 * docs/33 D-020: завершена спроба самостійного тесту — рядок у `task_status_log` через єдиний хук
 * (passed → done, failed → failed, результат у %). Тест усередині курсу (`lesson_id`) не є окремим
 * завданням — його завершення фіксує курс (`completeLesson`), інакше компетенції призначення курсу
 * підтверджувалися б після першого ж внутрішнього тесту.
 */
async function logAttemptCompletion(tx: TenantTx, tenantId: string, attempt: typeof attempts.$inferSelect, status: 'passed' | 'failed', totals: { score: number, maxScore: number }, actorId: string | null = null) {
  if (attempt.lessonId) return
  const { onTaskCompleted } = await import('./taskCompletion')
  await onTaskCompleted(tx, tenantId, attempt.userId, {
    contentType: 'test', contentId: attempt.quizId, status: status === 'passed' ? 'done' : 'failed',
    result: totals.maxScore > 0 ? Math.round((totals.score / totals.maxScore) * 10000) / 100 : null,
    assignmentId: attempt.assignmentId, enrollmentId: attempt.enrollmentId, sourceKind: 'attempt', sourceId: attempt.id, actorId,
  })
}

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
  await writeResult(tx, ctx, attempt.id, 'submit', { status, score: totals.score, maxScore: totals.maxScore, passed: totals.passed }, reason === 'expire' ? 'expired' : null)
  // Попытка закончена (отправлена или истекла) — открытый сегмент измерения закрывается
  // `completed` (docs/v2/37 §3.6); чистое время попытки досчитает свёртка `time.rollup`.
  // Сам учёт времени попытку не трогает: ни снапшот, ни дедлайн, ни статус (PR-21).
  await closeOpenSegments(tx, { tenantId: ctx.tenantId, userId: attempt.userId, subjectType: 'quiz', subjectId: attempt.quizId })

  // Единая очередь проверки (docs/v2/44 В-2). Точка одна на оба пути завершения попытки —
  // отправку и истечение по дедлайну: очередь не должна зависеть от того, каким из них
  // работа дошла до наставника. Единица работы — **ответ**, а не попытка целиком
  // (docs/12 §14.4): наставник решает по ответу, и делегируется тоже ответ.
  if (status === 'review') {
    const pending = await tx.select({ id: attemptAnswers.id }).from(attemptAnswers)
      .where(and(eq(attemptAnswers.attemptId, attempt.id), eq(attemptAnswers.autoGraded, false), isNull(attemptAnswers.isCorrect)))
    if (pending.length) {
      const [quiz] = await tx.select({ title: quizzes.title }).from(quizzes).where(eq(quizzes.id, attempt.quizId))
      const [enr] = attempt.enrollmentId
        ? await tx.select({ courseId: enrollments.subjectId }).from(enrollments)
          .where(and(eq(enrollments.id, attempt.enrollmentId), eq(enrollments.subjectType, 'course')))
        : []
      // «Розрахунковий час» теста — снимком на момент сдачи (docs/v2/37 §7.14, PR-22)
      const estimatedSeconds = await plannedSecondsFor(tx, { subjectType: 'quiz', subjectId: attempt.quizId })
      for (const a of pending) {
        await enqueueReview(tx, {
          tenantId: ctx.tenantId,
          taskType: 'quiz_open_answer',
          sourceId: a.id,
          userId: attempt.userId,
          taskTitle: quiz?.title ?? null,
          trackId: enr?.courseId ?? null,
          submittedAt: attempt.submittedAt ?? now,
          attemptNo: attempt.attemptNo,
          estimatedSeconds,
        })
      }
    }
  }

  if (status === 'passed') await onAttemptPassed(tx, ctx, attempt, { activity: reason === 'submit' })
  if (status !== 'review') await logAttemptCompletion(tx, ctx.tenantId, attempt, status, totals)
  // Лента активности (docs/v2/38 §7.9): оценка сданной попытки. Закрытие по сроку — действие
  // системы, а не человека (он попытку не отправлял), и в ленту не идёт ни сдачей, ни оценкой.
  if (status !== 'review' && reason === 'submit') {
    await recordActivity(tx, ctx.tenantId, { userId: attempt.userId, kind: 'attempt_graded', ref: { entity: 'attempts', id: attempt.id } })
  }
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

/**
 * Запись результата (docs/22 §13.7): первый подсчёт, итог проверки, каждое «Перерахувати». Снимок
 * не трогается. `issueId` — карточка жалобы, из которой запущен пересчёт (docs/v2/36 §7.8, П-12.4).
 */
async function writeResult(tx: TenantTx, ctx: Ctx, attemptId: string, reason: 'submit' | 'review' | 'recalculate', r: { status: string, score: number, maxScore: number, passed: boolean | null }, comment: string | null, createdBy: string | null = null, issueId: string | null = null) {
  await tx.insert(attemptResults).values({
    tenantId: ctx.tenantId,
    attemptId,
    reason,
    status: r.status,
    score: String(r.score),
    maxScore: String(r.maxScore),
    passed: r.passed,
    createdBy,
    comment,
    issueId,
  })
}

/**
 * Зачёт теста как урока курса → завершение урока и прогресс (docs/10 §7.3). `activity: false` —
 * зачёт появился не действием человека (пересчёт администратором, закрытие по сроку): урок
 * засчитывается, но в ленту активности (docs/v2/38 §7.9) не идёт.
 */
async function onAttemptPassed(tx: TenantTx, ctx: Ctx, attempt: typeof attempts.$inferSelect, opts: { activity?: boolean } = {}) {
  if (!attempt.enrollmentId || !attempt.lessonId) return
  await markLessonCompleted(tx, ctx.tenantId, { userId: attempt.userId, enrollmentId: attempt.enrollmentId, lessonId: attempt.lessonId, activity: opts.activity })
}

export type SubmitResult
  = | { ok: true, status: string, score: number, passed: boolean | null, pendingManual: number, quizId?: string }
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
    await recordActivity(tx, ctx.tenantId, { userId: ctx.actorId, kind: 'attempt_submitted', ref: { entity: 'attempts', id: attemptId } })
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
    return { ok: true as const, status: t.status, score: t.score, passed: t.passed, pendingManual: t.pendingManual, enrollmentId: attempt.enrollmentId, lessonId: attempt.lessonId, quizId: attempt.quizId }
  })

  // Пересчёт прогресса курса вне транзакции попытки (completeLesson открывает свою)
  if (result.ok && result.status === 'passed' && result.enrollmentId && result.lessonId) {
    await completeLesson(ctx, result.enrollmentId, result.lessonId).catch(() => {})
  }
  // Тест как узел программы/траектории (docs/17 §7.4): движение по графу
  if (result.ok && result.quizId && (result.status === 'passed' || result.status === 'failed')) {
    const quizId = result.quizId, passed = result.status === 'passed', score = result.score
    import('./programs').then(p => p.onItemResult(ctx.tenantId, ctx.actorId, 'quiz', quizId, { passed, score })).catch(err => console.error('program quiz hook', err))
    import('./trajectories').then(t => t.onTaskResult(ctx.tenantId, ctx.actorId, 'quiz', quizId, { passed, score })).catch(err => console.error('trajectory quiz hook', err))
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

    // Протокол помилок (docs/12 Г-12.4): «Показати протокол» · «Приховати правильні відповіді» ·
    // «лише після останньої спроби» — если попытки ещё остались и тест не сдан, разбор не показывается.
    const allowed = effectiveAttemptsAllowed(params, await approvedExtraAttempts(tx, attempt.userId, attempt.quizId, attempt.enrollmentId))
    const attemptsLeft = allowed > 0 ? Math.max(0, allowed - attempt.attemptNo) : null
    const isLast = allowed > 0 && attempt.attemptNo >= allowed
    let protocol: 'shown' | 'hidden' | 'after_last_attempt' = params.showErrorProtocol ? 'shown' : 'hidden'
    if (protocol === 'shown' && params.protocolAfterLastAttempt && attempt.passed !== true && !isLast) protocol = 'after_last_attempt'
    const showCorrect = reveal && !params.hideCorrectInProtocol

    const earned = snapshot.reduce((sum, q) => sum + Number(byQ.get(q.id)?.score ?? 0), 0)
    return {
      locked: false as const,
      bonus: await attemptBonus(tx, attempt),
      status: attempt.status,
      score: params.showScore ? Number(attempt.score) : null,
      passScore: params.passScore,
      passed: attempt.passed,
      attemptNo: attempt.attemptNo,
      attemptsAllowed: allowed,
      attemptsLeft,
      earned: Math.round(earned * 100) / 100,
      maxScore: Number(attempt.maxScore ?? 0),
      timeSpentSec: attempt.timeSpentSec,
      protocol,
      questions: protocol !== 'shown'
        ? []
        : snapshot.map((q) => {
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
              ...(showCorrect ? { answer: q.answer } : {}),
              ...(reveal ? { explanation: q.explanation } : {}),
            }
          }),
    }
  })
}

/**
 * Плашка «+5 бонусів зараховано · Баланс: 23 бонуси» (мокап TestResult; docs/33 D-069): бонусы
 * за это задание, если их начислила именно эта попытка. Тест в уроке курса — не задание (его
 * завершение засчитывает курс), повторная попытка уже вознаграждённого назначения — без плашки:
 * строка книги старше попытки.
 */
async function attemptBonus(tx: TenantTx, attempt: typeof attempts.$inferSelect): Promise<{ earned: number, balance: number } | null> {
  if (!attempt.passed || attempt.lessonId) return null
  const assignmentId = attempt.assignmentId ?? (await findAssignmentFor(tx, 'test', attempt.quizId, attempt.userId))?.id ?? null
  if (!assignmentId) return null
  const [row] = await tx.select({ delta: pointsLedger.delta, createdAt: pointsLedger.createdAt }).from(pointsLedger)
    .where(and(eq(pointsLedger.userId, attempt.userId), eq(pointsLedger.currency, 'bonuses'), eq(pointsLedger.event, 'task_completed'), eq(pointsLedger.refId, assignmentId)))
  if (!row || row.createdAt < attempt.createdAt) return null
  return { earned: row.delta, balance: await balanceOf(tx, attempt.userId, 'bonuses') }
}

/** Вложение к свободному ответу (docs/04 §4.6): файл уже загружен через /media, здесь — ссылка в ответе. */
export type AddFileResult = { ok: true, files: unknown[] } | { ok: false, code: 'not_found' | 'locked' | 'not_allowed' | 'media_not_found' | 'too_many' }

export async function addAnswerFile(ctx: Ctx, attemptId: string, questionId: string, file: z.infer<typeof answerFileSchema>): Promise<AddFileResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [attempt] = await tx.select().from(attempts).where(and(eq(attempts.id, attemptId), eq(attempts.userId, ctx.actorId)))
    if (!attempt) return { ok: false as const, code: 'not_found' as const }
    if (attempt.status !== 'in_progress') return { ok: false as const, code: 'locked' as const }
    const q = (attempt.snapshot as SnapshotQuestion[]).find(s => s.id === questionId)
    if (!q) return { ok: false as const, code: 'not_found' as const }
    if (!(q.kind === 'file' || (q.kind === 'free' && q.attachFiles))) return { ok: false as const, code: 'not_allowed' as const }
    const [media] = await tx.select({ id: mediaAssets.id }).from(mediaAssets).where(eq(mediaAssets.id, file.mediaId))
    if (!media) return { ok: false as const, code: 'media_not_found' as const }

    const [row] = await tx.select().from(attemptAnswers).where(and(eq(attemptAnswers.attemptId, attemptId), eq(attemptAnswers.questionId, questionId)))
    const prev = (row?.answer ?? {}) as { text?: string, files?: unknown[] }
    const files = [...(prev.files ?? []), file]
    if (files.length > 5) return { ok: false as const, code: 'too_many' as const }
    const answer = { ...prev, files }
    await tx.insert(attemptAnswers).values({
      tenantId: ctx.tenantId, attemptId, questionId, questionVersion: q.version, answer, answeredAt: new Date(),
    }).onConflictDoUpdate({
      target: [attemptAnswers.tenantId, attemptAnswers.attemptId, attemptAnswers.questionId],
      set: { answer, answeredAt: new Date(), updatedAt: new Date() },
    })
    return { ok: true as const, files }
  })
}

// ── «Перерахувати» (docs/22 §13.7, docs/04 §4.6; docs/v2/36 §7.8, П-12.4) ─────────────
//
// Логика пересчёта одна, точек входа две (П-12.4): кнопка в отчёте по тесту
// (`recalculateAttempt`/`recalculateQuiz`) и кнопка «Перерахувати результати» в карточке жалобы
// (`server/services/contentIssueTriage.ts`). Обе считают через `planRecalc()` и записывают через
// `recalculateAttempt()`; различаются только параметры:
//   - какие вопросы берут текущий ключ (отчёт по тесту — все; жалоба — вопрос жалобы);
//   - исключается ли вопрос из знаменателя (резолюция `question_void`);
//   - политика применения: отчёт по тесту применяет любой итог и откатывает снятый зачёт (D-013),
//     жалоба — только улучшение (§7.8: «отобрать зачтённое нельзя»).

/** Статусы попыток, которые пересчитываются из обеих точек входа: завершённые и не аннулированные. */
export const RECALCULABLE_ATTEMPT_STATUSES = ['submitted', 'review', 'passed', 'failed', 'expired'] as const

export interface RecalcOptions {
  /**
   * Вопросы, которые берут текущий ключ. Не задано — все (отчёт по тесту: «пересчёт по текущему
   * ключу»). Задано — только эти; у остальных остаётся уже выставленная оценка, чтобы пересчёт
   * по жалобе на один вопрос не переписал чужой (и чтобы аудит с `issue_id` не приписал жалобе
   * изменение, которого она не вызывала).
   */
  rekeyQuestionIds?: readonly string[]
  /** Вопросы, исключённые из знаменателя (`question_void`): Σ баллов без них / Σ весов без них. */
  voidQuestionIds?: readonly string[]
  /** `any` — отчёт по тесту (D-013); `improve_only` — жалоба: худший итог не применяется. */
  policy?: 'any' | 'improve_only'
  /** Карточка жалобы: ссылка в `attempt_results.issue_id`; по ней же повторный пересчёт идемпотентен. */
  issueId?: string | null
}

export interface RecalcPlan {
  before: { status: string, score: number | null, passed: boolean | null }
  after: { status: string, score: number, maxScore: number, passed: boolean | null }
  verdict: 'improved' | 'unchanged' | 'worse'
  /** Ответы на авто-вопросы, которые получили новую оценку, — их строки перепишет применение. */
  answerUpdates: { id: string, isCorrect: boolean | null, score: number, auto: boolean }[]
}

/**
 * Подсчёт без записи — общий для предпросмотра, пересчёта по тесту и пересчёта по жалобе.
 * Что пересчитывается: автопроверяемые ответы — по текущим answer / scoring_method /
 * negative_marking / балл (с переопределением в составе теста) и критичности вопроса. Что не
 * трогается: снимок попытки (формулировки, варианты, порядок), ответы ученика, оценки
 * наставника по ручным вопросам, params назначения.
 */
export async function planRecalc(tx: TenantTx, attempt: typeof attempts.$inferSelect, opts: RecalcOptions = {}): Promise<RecalcPlan> {
  const snapshot = attempt.snapshot as SnapshotQuestion[]
  const params = attempt.params as QuizParams
  const rekeyAll = !opts.rekeyQuestionIds
  const rekey = new Set(opts.rekeyQuestionIds ?? [])
  const voided = new Set(opts.voidQuestionIds ?? [])
  const takesKey = (id: string) => rekeyAll || rekey.has(id)

  const keyIds = snapshot.filter(q => takesKey(q.id)).map(q => q.id)
  const current = keyIds.length
    ? await tx.select({ q: questions, override: quizQuestions })
        .from(questions)
        .leftJoin(quizQuestions, and(eq(quizQuestions.questionId, questions.id), eq(quizQuestions.quizId, attempt.quizId)))
        .where(inArray(questions.id, keyIds))
    : []
  const keyById = new Map(current.map(r => [r.q.id, r]))

  // Ключ для пересчёта: снимок + текущие эталон/метод/балл/критичность; исключённые — вне расчёта
  const keyed: SnapshotQuestion[] = snapshot.filter(q => !voided.has(q.id)).map((q) => {
    const cur = takesKey(q.id) ? keyById.get(q.id) : undefined
    if (!cur) return q
    return {
      ...q,
      answer: cur.q.answer,
      points: cur.override?.pointsOverride != null ? Number(cur.override.pointsOverride) : Number(cur.q.points),
      isCritical: cur.override?.isCriticalOverride ?? cur.q.isCritical,
      scoringMethod: cur.q.scoringMethod as ScoringMethod,
      negativeMarking: cur.q.negativeMarking,
      requireExact: (cur.q.answer as { requireExact?: boolean } | null)?.requireExact,
    }
  })

  const rows = await tx.select().from(attemptAnswers).where(eq(attemptAnswers.attemptId, attempt.id))
  const byQ = new Map(rows.map(r => [r.questionId, r]))
  const graded = new Map<string, GradeResult>()
  const answerUpdates: RecalcPlan['answerUpdates'] = []
  for (const q of keyed) {
    const row = byQ.get(q.id)
    if (MANUAL_KINDS.has(q.kind)) {
      // Ручные оценки не пересчитываются — только балл ограничивается новым весом
      if (row && row.isCorrect !== null) graded.set(q.id, { isCorrect: row.isCorrect, score: Math.min(Number(row.score ?? 0), q.points), auto: false })
      else if (!row) graded.set(q.id, { isCorrect: false, score: 0, auto: true })
      continue
    }
    if (!takesKey(q.id)) {
      // Вопрос не пересчитывается: остаётся оценка, выставленная раньше (в т. ч. прошлым «Перерахувати»)
      graded.set(q.id, row ? { isCorrect: row.isCorrect ?? false, score: Number(row.score ?? 0), auto: row.autoGraded } : { isCorrect: false, score: 0, auto: true })
      continue
    }
    const late = attempt.deadlineAt && row?.answeredAt && row.answeredAt > attempt.deadlineAt
    const g = gradeAnswer(q, late ? null : (row?.answer ?? null))
    if (row) answerUpdates.push({ id: row.id, isCorrect: g.isCorrect, score: g.score, auto: g.auto })
    graded.set(q.id, g)
  }

  const totals = computeTotals(keyed, graded, params.passScore)
  const status = totals.passed === null ? 'review' : totals.passed ? 'passed' : 'failed'
  const before = { status: attempt.status, score: attempt.score != null ? Number(attempt.score) : null, passed: attempt.passed }
  const after = { status, score: totals.score, maxScore: totals.maxScore, passed: totals.passed }
  return { before, after, verdict: rescoreVerdict(before, after), answerUpdates }
}

export type RecalcResult
  = | {
    ok: true
    before: { status: string, score: number | null, passed: boolean | null }
    after: { status: string, score: number, passed: boolean | null }
    changed: boolean
    /** Записан ли результат. У `improve_only` худший и неизменный итог не записываются. */
    applied: boolean
    verdict: 'improved' | 'unchanged' | 'worse'
    /** Попытка уже пересчитана по этой карточке — повторно не трогается (идемпотентность). */
    already?: boolean
    userId: string
    rollback?: RollbackResult | null
  }
  | { ok: false, code: 'not_found' | 'in_progress' }

/**
 * Пересчёт одной попытки (см. блок выше): новая запись attempt_results (reason=recalculate),
 * attempts.score/passed/status обновляются, событие уходит в аудит с before/after.
 * Третий аргумент — причина (комментарий записи результата и аудита), как и прежде.
 */
export async function recalculateAttempt(ctx: Ctx, attemptId: string, comment?: string, opts: RecalcOptions = {}): Promise<RecalcResult> {
  const policy = opts.policy ?? 'any'
  const result = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [attempt] = await tx.select().from(attempts).where(eq(attempts.id, attemptId))
    if (!attempt) return { ok: false as const, code: 'not_found' as const }
    if (attempt.status === 'in_progress' || attempt.status === 'annulled') return { ok: false as const, code: 'in_progress' as const }

    if (opts.issueId) {
      const [done] = await tx.select({ id: attemptResults.id }).from(attemptResults)
        .where(and(eq(attemptResults.attemptId, attemptId), eq(attemptResults.issueId, opts.issueId)))
      if (done) {
        const same = { status: attempt.status, score: attempt.score != null ? Number(attempt.score) : 0, passed: attempt.passed }
        return { ok: true as const, before: same, after: same, changed: false, applied: false, verdict: 'unchanged' as const, already: true, userId: attempt.userId, enrollmentId: null, lessonId: null, quizId: attempt.quizId }
      }
    }

    const plan = await planRecalc(tx, attempt, opts)
    const { before } = plan
    const after = { status: plan.after.status, score: plan.after.score, passed: plan.after.passed }
    const changed = before.status !== after.status || before.score !== after.score
    if (policy === 'improve_only' && plan.verdict !== 'improved') {
      return { ok: true as const, before, after, changed: false, applied: false, verdict: plan.verdict, userId: attempt.userId, enrollmentId: null, lessonId: null, quizId: attempt.quizId }
    }

    const now = new Date()
    for (const u of plan.answerUpdates) {
      await tx.update(attemptAnswers).set({ isCorrect: u.isCorrect, score: String(u.score), autoGraded: u.auto, updatedAt: now }).where(eq(attemptAnswers.id, u.id))
    }
    await tx.update(attempts).set({
      status: after.status,
      score: String(after.score),
      maxScore: String(plan.after.maxScore),
      passed: after.passed,
      ...(after.status !== 'review' ? { gradedAt: now } : {}),
      updatedAt: now,
    }).where(eq(attempts.id, attemptId))
    await writeResult(tx, ctx, attemptId, 'recalculate', { status: after.status, score: after.score, maxScore: plan.after.maxScore, passed: after.passed }, comment ?? null, ctx.actorId, opts.issueId ?? null)
    // D-013: зачёт снят (passed → failed/review) — откат урока, записи и сертификата (docs/28 Spec 12
    // «Перерахувати»). По жалобе сюда не доходит: `improve_only` худший итог не применяет.
    const rollback = before.status === 'passed' && after.status !== 'passed' && attempt.enrollmentId && attempt.lessonId
      ? await rollbackLessonCompletion(tx, ctx, attempt.enrollmentId, attempt.lessonId)
      : null
    await recordAudit(tx, {
      tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'attempt.recalculate', entity: 'attempt', entityId: attemptId, before,
      after: { ...after, comment: comment ?? null, ...(opts.issueId ? { issueId: opts.issueId } : {}), ...(rollback?.lessonReopened ? { rollback } : {}) },
    })
    const newlyPassed = after.status === 'passed' && before.status !== 'passed'
    if (newlyPassed) {
      await onAttemptPassed(tx, ctx, attempt, { activity: false })
      // Самостоятельный тест: «завдання завершено» — та же единая точка, что и при сдаче (D-020)
      await logAttemptCompletion(tx, ctx.tenantId, attempt, 'passed', { score: after.score, maxScore: plan.after.maxScore }, ctx.actorId)
    }
    return { ok: true as const, before, after, changed, applied: true, verdict: plan.verdict, userId: attempt.userId, rollback, enrollmentId: attempt.enrollmentId, lessonId: attempt.lessonId, quizId: attempt.quizId }
  })
  if (!result.ok) return result
  // Зачёт появился — прогресс курса, сертификат и граф программы/траектории, как при сдаче попытки
  if (result.applied && result.after.status === 'passed' && result.before.status !== 'passed') {
    if (result.enrollmentId && result.lessonId) {
      await completeLesson({ tenantId: ctx.tenantId, actorId: result.userId }, result.enrollmentId, result.lessonId).catch(() => {})
    }
    const { quizId, userId } = result
    const score = result.after.score
    import('./programs').then(p => p.onItemResult(ctx.tenantId, userId, 'quiz', quizId, { passed: true, score })).catch(err => console.error('program quiz hook', err))
    import('./trajectories').then(t => t.onTaskResult(ctx.tenantId, userId, 'quiz', quizId, { passed: true, score })).catch(err => console.error('trajectory quiz hook', err))
  }
  return {
    ok: true,
    before: result.before,
    after: result.after,
    changed: result.changed,
    applied: result.applied,
    verdict: result.verdict,
    ...('already' in result ? { already: result.already } : {}),
    userId: result.userId,
    ...('rollback' in result ? { rollback: result.rollback } : {}),
  }
}

/** «Перерахувати» для всех завершённых попыток теста — после правки ключа одного вопроса. */
export async function recalculateQuiz(ctx: Ctx, quizId: string, comment?: string) {
  const ids = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [quiz] = await tx.select({ id: quizzes.id }).from(quizzes).where(and(eq(quizzes.id, quizId), isNull(quizzes.deletedAt)))
    if (!quiz) return null
    return (await tx.select({ id: attempts.id }).from(attempts)
      .where(and(eq(attempts.quizId, quizId), inArray(attempts.status, [...RECALCULABLE_ATTEMPT_STATUSES])))).map(r => r.id)
  })
  if (!ids) return null
  let changed = 0
  for (const id of ids) {
    const r = await recalculateAttempt(ctx, id, comment)
    if (r.ok && r.changed) changed++
  }
  return { total: ids.length, changed }
}

/** История результатов попытки (для отчёта и карточки попытки). */
export async function listAttemptResults(ctx: Ctx, attemptId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [attempt] = await tx.select({ id: attempts.id }).from(attempts).where(eq(attempts.id, attemptId))
    if (!attempt) return null
    return tx.select().from(attemptResults).where(eq(attemptResults.attemptId, attemptId)).orderBy(asc(attemptResults.createdAt))
  })
}

// ── Очередь проверки по ответам (docs/12 §14.4, docs/04 §4.7) ─────────

export type ReviewAnswersFilter = z.infer<typeof reviewAnswersQuerySchema>

/**
 * Поток отдельных ответов на ручные вопросы, а не попыток целиком. Вкладки Неперевірені ·
 * Перевірені · Усі; фильтры — метки вопроса (маршрутизация по темам), «Поза програмами»,
 * «Поза курсами», точка. Наставнику отдаётся grader_hint, ученику — никогда.
 */
export async function listReviewAnswers(ctx: Ctx, filter: ReviewAnswersFilter) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select({
      answerId: attemptAnswers.id,
      attemptId: attempts.id,
      attemptStatus: attempts.status,
      questionId: attemptAnswers.questionId,
      answer: attemptAnswers.answer,
      answeredAt: attemptAnswers.answeredAt,
      isCorrect: attemptAnswers.isCorrect,
      score: attemptAnswers.score,
      reviewedAt: attemptAnswers.reviewedAt,
      reviewedBy: attemptAnswers.reviewedBy,
      reviewComment: attemptAnswers.reviewComment,
      submittedAt: attempts.submittedAt,
      enrollmentId: attempts.enrollmentId,
      lessonId: attempts.lessonId,
      userId: attempts.userId,
      fullName: users.fullName,
      quizId: quizzes.id,
      quizTitle: quizzes.title,
      snapshot: attempts.snapshot,
      positionName: positions.name,
      locationId: locations.id,
      locationName: locations.name,
      questionTags: questions.tags,
    })
      .from(attemptAnswers)
      .innerJoin(attempts, eq(attempts.id, attemptAnswers.attemptId))
      .innerJoin(users, eq(users.id, attempts.userId))
      .innerJoin(quizzes, eq(quizzes.id, attempts.quizId))
      .leftJoin(questions, eq(questions.id, attemptAnswers.questionId))
      .leftJoin(userPlacements, and(eq(userPlacements.userId, attempts.userId), eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt)))
      .leftJoin(positions, eq(positions.id, userPlacements.positionId))
      .leftJoin(locations, eq(locations.id, userPlacements.locationId))
      .where(and(
        eq(attemptAnswers.autoGraded, false),
        sql`${attempts.status} in ('review', 'passed', 'failed', 'expired')`,
        // Непроверенный ответ, назначенный или делегированный другому, ушёл из «Мої»
        // (docs/v2/37 §13 к. 1) — и из узкого списка тоже; состояние — из очереди (В-2).
        ...(filter.checked === 'unchecked' ? [isNull(attemptAnswers.isCorrect), sql`not ${heldByOtherSql(ctx.actorId, 'quiz_open_answer', sql`${attemptAnswers.id}`)}`] : []),
        ...(filter.checked === 'checked' ? [sql`${attemptAnswers.isCorrect} is not null`] : []),
        ...(filter.tags.length ? [sql`${questions.tags} && ${textArray(filter.tags)}`] : []),
        ...(filter.quizId ? [eq(quizzes.id, filter.quizId)] : []),
        ...(filter.locationId ? [eq(locations.id, filter.locationId)] : []),
        // «Поза курсами»: попытка не внутри урока курса; «Поза програмами»: тест не является узлом программы для этого человека
        ...(filter.outsideCourses ? [isNull(attempts.lessonId)] : []),
        ...(filter.outsidePrograms ? [sql`not exists (select 1 from program_nodes pn where pn.item_type = 'quiz' and pn.item_id = ${attempts.quizId})`] : []),
        // Свои попытки в очередь проверяющего не попадают (docs/01 §1.8)
        sql`${attempts.userId} <> ${ctx.actorId}::uuid`,
      ))
      .orderBy(asc(attempts.submittedAt))
      .limit(filter.limit)

    return rows.map((r) => {
      const q = (r.snapshot as SnapshotQuestion[]).find(s => s.id === r.questionId)
      const a = (r.answer ?? {}) as { text?: string, files?: unknown[] }
      return {
        answerId: r.answerId,
        attemptId: r.attemptId,
        attemptStatus: r.attemptStatus,
        userId: r.userId,
        fullName: r.fullName,
        positionName: r.positionName,
        locationId: r.locationId,
        locationName: r.locationName,
        quizId: r.quizId,
        quizTitle: r.quizTitle,
        submittedAt: r.submittedAt,
        answeredAt: r.answeredAt,
        questionTags: q ? (r.questionTags ?? []) : [],
        question: q
          ? {
              kind: q.kind,
              stem: q.stem,
              points: q.points,
              isCritical: q.isCritical,
              criteria: (q.answer as { criteria?: string[] } | null)?.criteria ?? [],
              reference: (q.answer as { reference?: string } | null)?.reference ?? null,
              graderHint: q.graderHint ?? null,
            }
          : null,
        answer: r.answer,
        files: a.files ?? [],
        isCorrect: r.isCorrect,
        score: r.score != null ? Number(r.score) : null,
        reviewedAt: r.reviewedAt,
        reviewComment: r.reviewComment,
        hoursWaiting: r.submittedAt ? Math.floor((Date.now() - r.submittedAt.getTime()) / 3_600_000) : 0,
      }
    })
  })
}

/** Очередь непроверенных — совместимость с /review/queue (docs/14 §5.2). */
export async function reviewQueue(ctx: Ctx) {
  return listReviewAnswers(ctx, { checked: 'unchecked', tags: [], outsidePrograms: false, outsideCourses: false, limit: 200 })
}

export type GradeManualResult
  = | { ok: true, attemptStatus: string }
    | { ok: false, code: 'not_found' | 'self_review' | 'already_graded' | 'already_claimed' | 'assigned_to_other' }

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
    // Назначенный или делегированный другому ответ решает он (docs/v2/37 §7.1): состояние —
    // в очереди, узкий список `/review/answers` его уже не показывает, а прямой вызов не проходит.
    const guard = await reviewGuard(tx, { taskType: 'quiz_open_answer', sourceId: answerId, actorId: ctx.actorId })
    if (!guard.ok) return { ok: false as const, code: guard.code }

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

    // Решение по ответу принято — элемент очереди закрывается (не удаляется, проверка 21).
    await closeReview(tx, { taskType: 'quiz_open_answer', sourceIds: [answerId], reviewerId: ctx.actorId, decision: input.isCorrect ? 'зараховано' : 'не зараховано' })

    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'attempt.grade', entity: 'attempt_answer', entityId: answerId, after: { isCorrect: input.isCorrect, score } })
    // Лента проверяющего (docs/v2/38 §7.9): проверенный ответ — его учебная работа в системе
    await recordActivity(tx, ctx.tenantId, { userId: ctx.actorId, kind: 'review_graded', ref: { entity: 'attempt_answers', id: answerId } })

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
    await writeResult(tx, ctx, row.att.id, 'review', { status, score: totals.score, maxScore: totals.maxScore, passed: totals.passed }, null, ctx.actorId)
    if (status === 'passed') await onAttemptPassed(tx, ctx, row.att)
    await logAttemptCompletion(tx, ctx.tenantId, row.att, status, totals, ctx.actorId)
    // Оценка попытки ложится в ленту ученика днём **сдачи** (Р-34.3): учился он тогда, а день
    // проверки — работа проверяющего, она уже записана ему `review_graded`
    await recordActivity(tx, ctx.tenantId, { userId: row.att.userId, kind: 'attempt_graded', ref: { entity: 'attempts', id: row.att.id }, occurredAt: row.att.submittedAt })
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
    const [before] = await tx.select({ status: attempts.status, enrollmentId: attempts.enrollmentId, lessonId: attempts.lessonId }).from(attempts).where(eq(attempts.id, attemptId))
    const [attempt] = await tx.update(attempts).set({
      status: 'annulled',
      annulledBy: ctx.actorId,
      annulReason: reason,
      updatedAt: new Date(),
    }).where(and(eq(attempts.id, attemptId), sql`${attempts.status} <> 'annulled'`)).returning({ id: attempts.id })
    if (!attempt) return null
    // Аннулированную попытку проверять больше некому и незачем: её ответы уходят из очереди
    // закрытием, а не удалением строк — иначе терялась бы история проверяющего (В-2).
    const pendingAnswers = await tx.select({ id: attemptAnswers.id }).from(attemptAnswers).where(eq(attemptAnswers.attemptId, attemptId))
    await closeReview(tx, { taskType: 'quiz_open_answer', sourceIds: pendingAnswers.map(a => a.id) })
    // D-013: аннулированная зачтённая попытка снимает зачёт урока так же, как пересчёт (docs/12 §7 п. 10, docs/14 §12)
    const rollback = before?.status === 'passed' && before.enrollmentId && before.lessonId
      ? await rollbackLessonCompletion(tx, ctx, before.enrollmentId, before.lessonId)
      : null
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'attempt.annul', entity: 'attempt', entityId: attemptId, before: { status: before?.status }, after: { reason, ...(rollback?.lessonReopened ? { rollback } : {}) } })
    return attempt
  })
}

/**
 * Фоновая задача attempt.expire (docs/12 §7 п. 8): закрыть по дедлайну или после суток без активности
 * и оценить по отвеченному.
 *
 * - Срок закрытия `due_at` — дедлайн или сутки после последней активности, что раньше. Активность —
 *   последний сохранённый ответ: `attempts.updated_at` ответами не обновляется, и без этого сутки
 *   считались бы от старта — попытку без лимита времени закрывало бы посреди работы.
 * - Условие одно, `due_at <= now()`. Прежнее «and(статус, sql с `or` внутри)» разворачивалось в
 *   `(status = 'in_progress' and …) or updated_at < …` и захватывало завершённые попытки любого
 *   статуса: повторная оценка стирала ручную проверку и снимала аннулирование. Пока задача не
 *   работала (до 25.09.2026, docs/v2/46), этого не было видно.
 * - Закрытие, опоздавшее больше чем на сутки (`now() - due_at > 24 ч` — воркер стоял), тихое:
 *   результат, очередь проверки, зачёт и журналы пишутся, а уведомлений и вебхуков это закрытие
 *   не порождает (`withoutNews`) — иначе после простоя люди получают новости недельной давности.
 */
export async function expireStaleAttempts(tenantId: string): Promise<{ closed: number, quiet: number }> {
  return withTenant(tenantId, null, async (tx) => {
    const lastActivity = sql`greatest(${attempts.updatedAt}, (select max(aa.answered_at) from ${attemptAnswers} aa where aa.attempt_id = ${attempts.id}))`
    const dueAt = sql`least(${attempts.deadlineAt}, ${lastActivity} + ${EXPIRE_AFTER})`
    const stale = await tx.select({ attempt: attempts, late: sql<boolean>`now() - ${dueAt} > ${QUIET_AFTER}` })
      .from(attempts)
      .where(and(eq(attempts.status, 'in_progress'), sql`${dueAt} <= now()`))
    let quiet = 0
    for (const { attempt, late } of stale) {
      const close = () => gradeAndFinalize(tx, { tenantId, actorId: attempt.userId }, attempt, 'expire')
      if (late) {
        quiet++
        await withoutNews(close)
      }
      else {
        await close()
      }
    }
    return { closed: stale.length, quiet }
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
    const { params, source: paramsSource } = await resolveQuizParams(tx, { tenantId: ctx.tenantId, userId: ctx.actorId, quizId, enrollmentId })
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
    const allowed = effectiveAttemptsAllowed(params, await approvedExtraAttempts(tx, ctx.actorId, quizId, enrollmentId))
    const [pending] = await tx.select({ id: attemptRequests.id, createdAt: attemptRequests.createdAt }).from(attemptRequests)
      .where(and(eq(attemptRequests.userId, ctx.actorId), eq(attemptRequests.quizId, quizId), eq(attemptRequests.status, 'pending')))
    // «Кількість питань» из назначения меняет размер попытки (docs/15 §14.3)
    let questionCount = quiz.questionCount
    if (quiz.selectionMode === 'random') questionCount = ((quiz.randomRules as { count: number }[] | null) ?? []).reduce((s, r) => s + r.count, 0)
    else if (params.questionsMode === 'one_per_group') {
      const [row] = await tx.select({
        groups: sql<number>`count(distinct ${questions.questionGroupId}) filter (where ${questions.questionGroupId} is not null)::int`,
        ungrouped: sql<number>`count(*) filter (where ${questions.questionGroupId} is null)::int`,
      }).from(quizQuestions).innerJoin(questions, eq(questions.id, quizQuestions.questionId))
        .where(and(eq(quizQuestions.quizId, quizId), eq(questions.status, 'active')))
      questionCount = (row?.groups ?? 0) + (row?.ungrouped ?? 0)
    }
    else if (params.questionsMode === 'limited' && params.questionsCount) questionCount = Math.min(params.questionsCount, quiz.questionCount)
    return {
      id: quiz.id,
      title: quiz.title,
      description: quiz.description,
      questionCount,
      timeLimitSec: params.timeLimitSec,
      passScore: params.passScore,
      attemptsAllowed: allowed,
      attemptsUsed: used,
      attemptsLeft: allowed === 0 ? null : Math.max(0, allowed - used),
      pendingRequestId: pending?.id ?? null,
      paramsSource,
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

/**
 * Тенанты с попытками `in_progress` — источник круга `attempt.expire`.
 *
 * Не `select distinct tenant_id from attempts`: таблица под RLS, и с общего соединения без
 * `app.tenant_id` запрос видит ноль строк — просроченные попытки не закрывались ни у кого
 * (найдено 24.09.2026). Функция `SECURITY DEFINER` (миграция 0079) отдаёт только идентификаторы.
 */
export async function tenantsWithActiveAttempts(): Promise<string[]> {
  const { db } = await import('../db/client')
  const rows = await db.execute(sql`select tenant_id from tenants_with_active_attempts()`)
  return (rows as unknown as { tenant_id: string }[]).map(r => r.tenant_id)
}

