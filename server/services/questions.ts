import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { z } from 'zod'
import { questionBanks, questions, quizQuestions, quizzes } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'
import { sanitizeBody } from './sanitize'
import type { ContentBlock } from '../../shared/schemas/content'
import type { bankSchema, questionSchema, questionUpdateSchema, quizSchema, quizUpdateSchema } from '../../shared/schemas/quizzes'

interface Ctx { tenantId: string, actorId: string }

// ── Банки ──────────────────────────────────────────────────────────────

export async function listBanks(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select({
      id: questionBanks.id,
      name: questionBanks.name,
      description: questionBanks.description,
      count: sql<number>`(select count(*)::int from ${questions} q where q.bank_id = ${questionBanks.id} and q.status = 'active')`,
    }).from(questionBanks).orderBy(asc(questionBanks.name))
    return rows
  })
}

export async function createBank(ctx: Ctx, input: z.infer<typeof bankSchema>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [bank] = await tx.insert(questionBanks).values({ tenantId: ctx.tenantId, ...input }).returning()
    return bank!
  })
}

// ── Вопросы ────────────────────────────────────────────────────────────

export async function listQuestions(ctx: Ctx, filter: { bankId?: string, kind?: string, q?: string }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select().from(questions)
      .where(and(
        eq(questions.status, 'active'),
        ...(filter.bankId ? [eq(questions.bankId, filter.bankId)] : []),
        ...(filter.kind ? [eq(questions.kind, filter.kind)] : []),
        ...(filter.q ? [sql`${questions.stem}::text ilike ${`%${filter.q}%`}`] : []),
      ))
      .orderBy(desc(questions.updatedAt))
      .limit(200)
  })
}

export async function createQuestion(ctx: Ctx, input: z.infer<typeof questionSchema>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [q] = await tx.insert(questions).values({
      tenantId: ctx.tenantId,
      bankId: input.bankId,
      kind: input.kind,
      stem: sanitizeBody(input.stem as ContentBlock[]),
      options: input.options ?? null,
      answer: input.answer ?? null,
      explanation: input.explanation ? sanitizeBody(input.explanation as ContentBlock[]) : null,
      hint: input.hint ?? null,
      isCritical: input.isCritical,
      difficulty: input.difficulty,
      points: String(input.points),
      partialCredit: input.partialCredit,
      negativeMarking: input.negativeMarking,
      tags: input.tags,
      timeLimitSec: input.timeLimitSec ?? null,
    }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'question.create', entity: 'question', entityId: q!.id })
    return q!
  })
}

/** Правка эталона поднимает version (docs/12 §7.11); активные попытки не трогаются — они на снапшоте. */
export async function updateQuestion(ctx: Ctx, id: string, input: z.infer<typeof questionUpdateSchema>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(questions).where(eq(questions.id, id))
    if (!before) return null

    const answerChanged = input.answer !== undefined && JSON.stringify(input.answer) !== JSON.stringify(before.answer)
    const [after] = await tx.update(questions).set({
      ...(input.stem !== undefined ? { stem: sanitizeBody(input.stem as ContentBlock[]) } : {}),
      ...(input.options !== undefined ? { options: input.options } : {}),
      ...(input.answer !== undefined ? { answer: input.answer } : {}),
      ...(input.explanation !== undefined ? { explanation: sanitizeBody(input.explanation as ContentBlock[]) } : {}),
      ...(input.hint !== undefined ? { hint: input.hint } : {}),
      ...(input.isCritical !== undefined ? { isCritical: input.isCritical } : {}),
      ...(input.difficulty !== undefined ? { difficulty: input.difficulty } : {}),
      ...(input.points !== undefined ? { points: String(input.points) } : {}),
      ...(input.partialCredit !== undefined ? { partialCredit: input.partialCredit } : {}),
      ...(input.negativeMarking !== undefined ? { negativeMarking: input.negativeMarking } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(answerChanged ? { version: before.version + 1 } : {}),
      updatedAt: new Date(),
    }).where(eq(questions.id, id)).returning()

    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'question.update',
      entity: 'question',
      entityId: id,
      before: { version: before.version },
      after: { version: after!.version },
    })
    return after!
  })
}

// ── Тесты ──────────────────────────────────────────────────────────────

export async function listQuizzes(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select().from(quizzes).where(isNull(quizzes.deletedAt)).orderBy(desc(quizzes.updatedAt))
  })
}

export async function createQuiz(ctx: Ctx, input: z.infer<typeof quizSchema>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [quiz] = await tx.insert(quizzes).values({
      tenantId: ctx.tenantId,
      title: input.title,
      description: input.description ? sanitizeBody(input.description as ContentBlock[]) : null,
      kind: input.kind,
      tags: input.tags,
      authorIds: [ctx.actorId],
      selectionMode: input.selectionMode,
      randomRules: input.randomRules ?? null,
      requiresOfflineConfirm: input.requiresOfflineConfirm,
    }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'quiz.create', entity: 'quiz', entityId: quiz!.id })
    return quiz!
  })
}

export async function updateQuiz(ctx: Ctx, id: string, input: z.infer<typeof quizUpdateSchema>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(quizzes).where(and(eq(quizzes.id, id), isNull(quizzes.deletedAt)))
    if (!before) return null
    const [after] = await tx.update(quizzes).set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: sanitizeBody(input.description as ContentBlock[]) } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.selectionMode !== undefined ? { selectionMode: input.selectionMode } : {}),
      ...(input.randomRules !== undefined ? { randomRules: input.randomRules } : {}),
      ...(input.requiresOfflineConfirm !== undefined ? { requiresOfflineConfirm: input.requiresOfflineConfirm } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      updatedAt: new Date(),
    }).where(eq(quizzes.id, id)).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'quiz.update', entity: 'quiz', entityId: id })
    return after!
  })
}

export async function getQuizEditor(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [quiz] = await tx.select().from(quizzes).where(and(eq(quizzes.id, id), isNull(quizzes.deletedAt)))
    if (!quiz) return null
    const items = await tx.select({
      id: quizQuestions.id,
      questionId: quizQuestions.questionId,
      sort: quizQuestions.sort,
      pointsOverride: quizQuestions.pointsOverride,
      isCriticalOverride: quizQuestions.isCriticalOverride,
      kind: questions.kind,
      stem: questions.stem,
      points: questions.points,
      isCritical: questions.isCritical,
      difficulty: questions.difficulty,
      status: questions.status,
    })
      .from(quizQuestions)
      .innerJoin(questions, eq(questions.id, quizQuestions.questionId))
      .where(eq(quizQuestions.quizId, id))
      .orderBy(asc(quizQuestions.sort))
    return { quiz, items }
  })
}

/** Полная замена состава фиксированного теста; пересчёт total_points и question_count. */
export async function setQuizQuestions(ctx: Ctx, quizId: string, items: {
  questionId: string
  sort: number
  pointsOverride?: number | null
  isCriticalOverride?: boolean | null
}[]) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [quiz] = await tx.select().from(quizzes).where(eq(quizzes.id, quizId))
    if (!quiz) return null

    await tx.delete(quizQuestions).where(eq(quizQuestions.quizId, quizId))
    if (items.length) {
      await tx.insert(quizQuestions).values(items.map(i => ({
        tenantId: ctx.tenantId,
        quizId,
        questionId: i.questionId,
        sort: i.sort,
        pointsOverride: i.pointsOverride != null ? String(i.pointsOverride) : null,
        isCriticalOverride: i.isCriticalOverride ?? null,
      })))
    }

    const qrows = items.length
      ? await tx.select({ id: questions.id, points: questions.points }).from(questions)
          .where(inArray(questions.id, items.map(i => i.questionId)))
      : []
    const pointsById = new Map(qrows.map(r => [r.id, Number(r.points)]))
    const total = items.reduce((sum, i) => sum + (i.pointsOverride ?? pointsById.get(i.questionId) ?? 0), 0)

    const [updated] = await tx.update(quizzes).set({
      totalPoints: String(Math.round(total * 100) / 100),
      questionCount: items.length,
      updatedAt: new Date(),
    }).where(eq(quizzes.id, quizId)).returning()
    const { markContentChanged } = await import('./tasks') // docs/15 §14.6: состав теста изменён → баннер в списке назначений
    await markContentChanged(tx, 'test', quizId)
    return updated!
  })
}
