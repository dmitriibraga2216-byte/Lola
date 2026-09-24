import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { z } from 'zod'
import { attempts, questionBanks, questionGroups, questions, quizQuestions, quizzes } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'
import { sanitizeBody } from './sanitize'
import type { ContentBlock } from '../../shared/schemas/content'
import type { TenantTx } from '../utils/withTenant'
import type {
  bankSchema, questionGroupSchema, questionGroupUpdateSchema, questionSchema, questionUpdateSchema,
  questionsImportSchema, quizSchema, quizUpdateSchema,
} from '../../shared/schemas/quizzes'

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

export async function listQuestions(ctx: Ctx, filter: { bankId?: string, kind?: string, q?: string, tags?: string[], quizId?: string }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select().from(questions)
      .where(and(
        eq(questions.status, 'active'),
        ...(filter.bankId ? [eq(questions.bankId, filter.bankId)] : []),
        ...(filter.kind ? [eq(questions.kind, filter.kind)] : []),
        ...(filter.q ? [sql`${questions.stem}::text ilike ${`%${filter.q}%`}`] : []),
        ...(filter.tags?.length ? [sql`${questions.tags} && array[${sql.join(filter.tags.map(t => sql`${t}::text`), sql`, `)}]::text[]`] : []),
        // Вопросы другого теста — для «Питання з іншого тесту» (docs/12 §14.3)
        ...(filter.quizId ? [sql`${questions.id} in (select question_id from quiz_questions where quiz_id = ${filter.quizId}::uuid)`] : []),
      ))
      .orderBy(desc(questions.updatedAt))
      .limit(200)
  })
}

export async function getQuestion(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [q] = await tx.select().from(questions).where(eq(questions.id, id))
    return q ?? null
  })
}

/** Группа должна быть видна в тенанте; чужая — как будто её нет (CLAUDE.md п. 15). */
async function groupExists(tx: TenantTx, groupId: string): Promise<boolean> {
  const [g] = await tx.select({ id: questionGroups.id }).from(questionGroups).where(eq(questionGroups.id, groupId))
  return !!g
}

/** Группа из тела запроса не найдена — эндпоинт отвечает 404. */
export class QuestionGroupNotFound extends Error {
  readonly code = 'question_group_not_found'
  constructor() { super('Групу питань не знайдено') }
}

export async function createQuestion(ctx: Ctx, input: z.infer<typeof questionSchema>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    if (input.questionGroupId && !(await groupExists(tx, input.questionGroupId))) {
      throw new QuestionGroupNotFound()
    }
    const [q] = await tx.insert(questions).values({
      tenantId: ctx.tenantId,
      bankId: input.bankId,
      questionGroupId: input.questionGroupId ?? null,
      kind: input.kind,
      stem: sanitizeBody(input.stem as ContentBlock[]),
      options: input.options ?? null,
      answer: input.answer ?? null,
      explanation: input.explanation ? sanitizeBody(input.explanation as ContentBlock[]) : null,
      hint: input.hint ?? null,
      graderHint: input.graderHint ?? null,
      attachFiles: input.attachFiles,
      isCritical: input.isCritical,
      difficulty: input.difficulty,
      points: String(input.points),
      scoringMethod: input.scoringMethod,
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

    if (input.questionGroupId && !(await groupExists(tx, input.questionGroupId))) {
      throw new QuestionGroupNotFound()
    }
    // Версия растёт при правке содержания или ключа (docs/12 §7.11, Г-12.2): идущие попытки остаются на снимке
    const changed = (key: 'stem' | 'options' | 'answer' | 'scoringMethod' | 'negativeMarking', prev: unknown) =>
      input[key] !== undefined && JSON.stringify(input[key]) !== JSON.stringify(prev)
    const contentChanged = changed('stem', before.stem) || changed('options', before.options) || changed('answer', before.answer)
      || changed('scoringMethod', before.scoringMethod) || changed('negativeMarking', before.negativeMarking)
      || (input.points !== undefined && Number(input.points) !== Number(before.points))
    const [after] = await tx.update(questions).set({
      ...(input.questionGroupId !== undefined ? { questionGroupId: input.questionGroupId } : {}),
      ...(input.stem !== undefined ? { stem: sanitizeBody(input.stem as ContentBlock[]) } : {}),
      ...(input.options !== undefined ? { options: input.options } : {}),
      ...(input.answer !== undefined ? { answer: input.answer } : {}),
      ...(input.explanation !== undefined ? { explanation: sanitizeBody(input.explanation as ContentBlock[]) } : {}),
      ...(input.hint !== undefined ? { hint: input.hint } : {}),
      ...(input.graderHint !== undefined ? { graderHint: input.graderHint } : {}),
      ...(input.attachFiles !== undefined ? { attachFiles: input.attachFiles } : {}),
      ...(input.isCritical !== undefined ? { isCritical: input.isCritical } : {}),
      ...(input.difficulty !== undefined ? { difficulty: input.difficulty } : {}),
      ...(input.points !== undefined ? { points: String(input.points) } : {}),
      ...(input.scoringMethod !== undefined ? { scoringMethod: input.scoringMethod } : {}),
      ...(input.negativeMarking !== undefined ? { negativeMarking: input.negativeMarking } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(contentChanged ? { version: before.version + 1 } : {}),
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
    // Вопрос живёт без черновика: новая версия сразу идёт в новые попытки, то есть она и есть
    // публикация — исправленные жалобы на вопрос закрываются (docs/v2/36 §7.9, PR-24)
    if (after!.version > before.version) {
      const { onContentPublished } = await import('./contentIssueTriage')
      await onContentPublished(tx, 'question', id)
    }
    return after!
  })
}

// ── Тесты ──────────────────────────────────────────────────────────────

/** Список тестов по мокапу ContentTests: Назва · Питань · Автор · Мітки · Дата зміни · Опубліковано. */
export async function listQuizzes(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({
      id: quizzes.id,
      title: quizzes.title,
      kind: quizzes.kind,
      status: quizzes.status,
      tags: quizzes.tags,
      questionCount: quizzes.questionCount,
      totalPoints: quizzes.totalPoints,
      selectionMode: quizzes.selectionMode,
      updatedAt: quizzes.updatedAt,
      authorName: sql<string | null>`(select u.full_name from users u where u.id = ${quizzes.authorIds}[1])`,
    }).from(quizzes).where(isNull(quizzes.deletedAt)).orderBy(desc(quizzes.updatedAt))
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
      tags: questions.tags,
      questionGroupId: questions.questionGroupId,
      bankId: questions.bankId,
    })
      .from(quizQuestions)
      .innerJoin(questions, eq(questions.id, quizQuestions.questionId))
      .where(eq(quizQuestions.quizId, id))
      .orderBy(asc(quizQuestions.sort))
    const groups = await tx.select().from(questionGroups).where(eq(questionGroups.quizId, id)).orderBy(asc(questionGroups.sortOrder), asc(questionGroups.createdAt))
    return { quiz, items, groups }
  })
}

// ── Группы вопросов (docs/12 §14.3) ───────────────────────────────────

export async function listGroups(ctx: Ctx, quizId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [quiz] = await tx.select({ id: quizzes.id }).from(quizzes).where(and(eq(quizzes.id, quizId), isNull(quizzes.deletedAt)))
    if (!quiz) return null
    return tx.select().from(questionGroups).where(eq(questionGroups.quizId, quizId)).orderBy(asc(questionGroups.sortOrder), asc(questionGroups.createdAt))
  })
}

export async function createGroup(ctx: Ctx, quizId: string, input: z.infer<typeof questionGroupSchema>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [quiz] = await tx.select({ id: quizzes.id }).from(quizzes).where(and(eq(quizzes.id, quizId), isNull(quizzes.deletedAt)))
    if (!quiz) return null
    const [g] = await tx.insert(questionGroups).values({ tenantId: ctx.tenantId, quizId, title: input.title, sortOrder: input.sortOrder }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'question_group.create', entity: 'question_group', entityId: g!.id, after: { quizId, title: input.title } })
    return g!
  })
}

export async function updateGroup(ctx: Ctx, id: string, input: z.infer<typeof questionGroupUpdateSchema>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [g] = await tx.update(questionGroups).set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      updatedAt: new Date(),
    }).where(eq(questionGroups.id, id)).returning()
    if (!g) return null
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'question_group.update', entity: 'question_group', entityId: id, after: input })
    return g
  })
}

/** Удаление группы: вопросы остаются, теряют группу (FK set null); идущие попытки — на снимке. */
export async function deleteGroup(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [g] = await tx.delete(questionGroups).where(eq(questionGroups.id, id)).returning({ id: questionGroups.id, quizId: questionGroups.quizId })
    if (!g) return null
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'question_group.delete', entity: 'question_group', entityId: id, before: { quizId: g.quizId } })
    return g
  })
}

// ── «Питання з іншого тесту» (копия) и «Створені питання» (ссылка на банк) ──

export type ImportResult
  = | { ok: true, added: number, questionIds: string[] }
    | { ok: false, code: 'not_found' | 'group_not_found' | 'questions_not_found' }

/**
 * Г-12.2: из другого теста берётся независимая копия (правка не влияет на оригинал),
 * из банка — ссылка (одна запись questions в нескольких тестах; правка банка поднимает version,
 * идущие попытки остаются на снимке).
 */
export async function importQuestions(ctx: Ctx, quizId: string, input: z.infer<typeof questionsImportSchema>): Promise<ImportResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [quiz] = await tx.select({ id: quizzes.id }).from(quizzes).where(and(eq(quizzes.id, quizId), isNull(quizzes.deletedAt)))
    if (!quiz) return { ok: false as const, code: 'not_found' as const }
    if (input.questionGroupId && !(await groupExists(tx, input.questionGroupId))) return { ok: false as const, code: 'group_not_found' as const }

    let sources: typeof questions.$inferSelect[]
    if (input.mode === 'copy') {
      sources = await tx.select({ q: questions }).from(quizQuestions)
        .innerJoin(questions, eq(questions.id, quizQuestions.questionId))
        .where(and(eq(quizQuestions.quizId, input.fromQuizId), inArray(quizQuestions.questionId, input.questionIds), eq(questions.status, 'active')))
        .then(rows => rows.map(r => r.q))
    }
    else {
      sources = await tx.select().from(questions).where(and(inArray(questions.id, input.questionIds), eq(questions.status, 'active')))
    }
    if (sources.length !== new Set(input.questionIds).size) return { ok: false as const, code: 'questions_not_found' as const }

    const existing = await tx.select({ questionId: quizQuestions.questionId, sort: quizQuestions.sort, pointsOverride: quizQuestions.pointsOverride, isCriticalOverride: quizQuestions.isCriticalOverride })
      .from(quizQuestions).where(eq(quizQuestions.quizId, quizId)).orderBy(asc(quizQuestions.sort))
    const present = new Set(existing.map(e => e.questionId))

    const addedIds: string[] = []
    for (const src of sources) {
      if (input.mode === 'copy') {
        const [copy] = await tx.insert(questions).values({
          tenantId: ctx.tenantId,
          bankId: src.bankId,
          questionGroupId: input.questionGroupId ?? null,
          kind: src.kind,
          stem: src.stem,
          options: src.options,
          answer: src.answer,
          explanation: src.explanation,
          hint: src.hint,
          graderHint: src.graderHint,
          attachFiles: src.attachFiles,
          isCritical: src.isCritical,
          difficulty: src.difficulty,
          points: src.points,
          scoringMethod: src.scoringMethod,
          negativeMarking: src.negativeMarking,
          tags: src.tags,
          timeLimitSec: src.timeLimitSec,
        }).returning({ id: questions.id })
        await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'question.copy', entity: 'question', entityId: copy!.id, before: { sourceId: src.id, fromQuizId: input.fromQuizId }, after: { quizId } })
        addedIds.push(copy!.id)
      }
      else {
        if (present.has(src.id)) continue
        if (input.questionGroupId !== undefined && src.questionGroupId !== input.questionGroupId) {
          await tx.update(questions).set({ questionGroupId: input.questionGroupId, updatedAt: new Date() }).where(eq(questions.id, src.id))
        }
        addedIds.push(src.id)
      }
    }

    const items = [
      ...existing.map(e => ({ questionId: e.questionId, sort: e.sort, pointsOverride: e.pointsOverride != null ? Number(e.pointsOverride) : null, isCriticalOverride: e.isCriticalOverride })),
      ...addedIds.map((id, i) => ({ questionId: id, sort: existing.length + i })),
    ]
    await setQuizQuestionsTx(tx, ctx, quizId, items)
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'quiz.questions_import', entity: 'quiz', entityId: quizId, after: { mode: input.mode, added: addedIds.length } })
    return { ok: true as const, added: addedIds.length, questionIds: addedIds }
  })
}

/** Есть ли снимок попытки с этим вопросом (docs/12 §7.12: удалять нельзя — только архивировать). */
export async function questionInSnapshots(ctx: Ctx, questionId: string): Promise<boolean> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(attempts)
      .where(sql`${attempts.snapshot} @> ${JSON.stringify([{ id: questionId }])}::jsonb`)
    return (row?.n ?? 0) > 0
  })
}

/** Полная замена состава фиксированного теста; пересчёт total_points и question_count. */
export async function setQuizQuestions(ctx: Ctx, quizId: string, items: {
  questionId: string
  sort: number
  pointsOverride?: number | null
  isCriticalOverride?: boolean | null
}[]) {
  return withTenant(ctx.tenantId, ctx.actorId, async tx => setQuizQuestionsTx(tx, ctx, quizId, items))
}

async function setQuizQuestionsTx(tx: TenantTx, ctx: Ctx, quizId: string, items: {
  questionId: string
  sort: number
  pointsOverride?: number | null
  isCriticalOverride?: boolean | null
}[]) {
  {
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
  }
}
