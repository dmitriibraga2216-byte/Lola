import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { z } from 'zod'
import { attemptRequests, attempts, locations, positions, quizzes, userPlacements, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { currentRequestContext } from '../utils/requestContext'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import { resolveQuizParams } from './taskParams'
import { approvedExtraAttempts, effectiveAttemptsAllowed } from './attempts'
import type { attemptRequestDecideSchema, attemptRequestSchema, attemptRequestsQuerySchema } from '../../shared/schemas/quizzes'

interface Ctx { tenantId: string, actorId: string }

/**
 * Запросы дополнительных попыток (docs/12 §6.3, §14.5). Попытки из назначения кончились —
 * человек просит ещё одну прямо с экрана «Спроби вичерпано»; наставник или руководитель
 * решает. Одобрение даёт +1 попытку сверх лимита назначения (attempts.approvedExtraAttempts),
 * само назначение и его параметры не меняются.
 */

export type CreateRequestResult
  = | { ok: true, id: string }
    | { ok: false, code: 'not_found' | 'not_exhausted' | 'already_pending' }

export async function createAttemptRequest(ctx: Ctx, quizId: string, input: z.infer<typeof attemptRequestSchema>): Promise<CreateRequestResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [quiz] = await tx.select({ id: quizzes.id, title: quizzes.title }).from(quizzes).where(and(eq(quizzes.id, quizId), isNull(quizzes.deletedAt)))
    if (!quiz) return { ok: false as const, code: 'not_found' as const }

    const { params, assignmentId } = await resolveQuizParams(tx, { tenantId: ctx.tenantId, userId: ctx.actorId, quizId, enrollmentId: input.enrollmentId })
    const [usedRow] = await tx.select({ n: sql<number>`count(*)::int` }).from(attempts).where(and(
      eq(attempts.quizId, quizId),
      eq(attempts.userId, ctx.actorId),
      ...(input.enrollmentId ? [eq(attempts.enrollmentId, input.enrollmentId)] : []),
      sql`${attempts.status} <> 'annulled'`,
    ))
    const used = usedRow?.n ?? 0
    const allowed = effectiveAttemptsAllowed(params, await approvedExtraAttempts(tx, ctx.actorId, quizId, input.enrollmentId))
    // Запрос имеет смысл только когда попытки действительно кончились (docs/12 §14.5)
    if (allowed === 0 || used < allowed) return { ok: false as const, code: 'not_exhausted' as const }

    const [pending] = await tx.select({ id: attemptRequests.id }).from(attemptRequests)
      .where(and(eq(attemptRequests.userId, ctx.actorId), eq(attemptRequests.quizId, quizId), eq(attemptRequests.status, 'pending')))
    if (pending) return { ok: false as const, code: 'already_pending' as const }

    const [req] = await tx.insert(attemptRequests).values({
      tenantId: ctx.tenantId,
      quizId,
      userId: ctx.actorId,
      enrollmentId: input.enrollmentId ?? null,
      assignmentId,
      reason: input.reason,
      attemptsUsed: used,
      attemptsAllowed: allowed,
      requestContext: currentRequestContext(),
    }).returning({ id: attemptRequests.id })

    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'attempt_request.create', entity: 'attempt_request', entityId: req!.id, after: { quizId, used, allowed } })

    // Наставникам точки и тем, кто решает (docs/12 §8: attempt_request_created)
    const [me] = await tx.select({ fullName: users.fullName }).from(users).where(eq(users.id, ctx.actorId))
    const deciders = await tx.execute(sql`
      select distinct ur.user_id from user_roles ur join roles r on r.id = ur.role_id
      where r.scopes @> array['review.grade']::text[] and ur.user_id <> ${ctx.actorId}::uuid
        and (ur.scope_type = 'tenant' or (ur.scope_type = 'location' and ur.scope_id in
          (select location_id from user_placements where user_id = ${ctx.actorId}::uuid and ended_at is null)))
    `)
    for (const d of deciders as unknown as { user_id: string }[]) {
      await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: d.user_id, code: 'attempt_request_created', payload: { name: me?.fullName, quiz: quiz.title }, dedupKey: `attempt_request_created:${req!.id}:${d.user_id}` })
    }
    return { ok: true as const, id: req!.id }
  })
}

/** Очередь запросов (docs/12 §14.5): Тест · ПІБ · Посада · Точка · Використано · Дата · Статус. */
export async function listAttemptRequests(ctx: Ctx, filter: z.infer<typeof attemptRequestsQuerySchema>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({
      id: attemptRequests.id,
      quizId: attemptRequests.quizId,
      quizTitle: quizzes.title,
      userId: attemptRequests.userId,
      fullName: users.fullName,
      positionName: positions.name,
      locationName: locations.name,
      reason: attemptRequests.reason,
      attemptsUsed: attemptRequests.attemptsUsed,
      attemptsAllowed: attemptRequests.attemptsAllowed,
      status: attemptRequests.status,
      createdAt: attemptRequests.createdAt,
      decidedAt: attemptRequests.decidedAt,
      decisionComment: attemptRequests.decisionComment,
    })
      .from(attemptRequests)
      .innerJoin(quizzes, eq(quizzes.id, attemptRequests.quizId))
      .innerJoin(users, eq(users.id, attemptRequests.userId))
      .leftJoin(userPlacements, and(eq(userPlacements.userId, attemptRequests.userId), eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt)))
      .leftJoin(positions, eq(positions.id, userPlacements.positionId))
      .leftJoin(locations, eq(locations.id, userPlacements.locationId))
      .where(and(
        ...(filter.status !== 'all' ? [eq(attemptRequests.status, filter.status)] : []),
        ...(filter.quizId ? [eq(attemptRequests.quizId, filter.quizId)] : []),
      ))
      .orderBy(desc(attemptRequests.createdAt))
      .limit(500)
  })
}

/** Мои запросы по тесту — для экрана исчерпанных попыток. */
export async function myAttemptRequests(ctx: Ctx, quizId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({ id: attemptRequests.id, status: attemptRequests.status, createdAt: attemptRequests.createdAt, decisionComment: attemptRequests.decisionComment })
      .from(attemptRequests)
      .where(and(eq(attemptRequests.userId, ctx.actorId), eq(attemptRequests.quizId, quizId)))
      .orderBy(desc(attemptRequests.createdAt))
  })
}

export type DecideResult
  = | { ok: true, status: 'approved' | 'rejected' }
    | { ok: false, code: 'not_found' | 'already_decided' | 'self_decision' }

/** «Дати спробу» / «Відмовити» с комментарием; ученику уходит attempt_request_decided. */
export async function decideAttemptRequest(ctx: Ctx, id: string, input: z.infer<typeof attemptRequestDecideSchema>): Promise<DecideResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [req] = await tx.select().from(attemptRequests).where(eq(attemptRequests.id, id))
    if (!req) return { ok: false as const, code: 'not_found' as const }
    if (req.userId === ctx.actorId) return { ok: false as const, code: 'self_decision' as const }
    if (req.status !== 'pending') return { ok: false as const, code: 'already_decided' as const }

    const status = input.approved ? 'approved' : 'rejected'
    await tx.update(attemptRequests).set({
      status,
      decidedBy: ctx.actorId,
      decidedAt: new Date(),
      decisionComment: input.comment ?? null,
      updatedAt: new Date(),
    }).where(eq(attemptRequests.id, id))

    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'attempt_request.decide', entity: 'attempt_request', entityId: id, before: { status: 'pending' }, after: { status, comment: input.comment ?? null, userId: req.userId } })
    const [quiz] = await tx.select({ title: quizzes.title }).from(quizzes).where(eq(quizzes.id, req.quizId))
    await enqueueNotification(tx, {
      tenantId: ctx.tenantId,
      userId: req.userId,
      code: 'attempt_request_decided',
      payload: { quiz: quiz?.title, status: input.approved ? 'надано' : 'відмовлено', comment: input.comment ?? '' },
      dedupKey: `attempt_request_decided:${id}`,
    })
    return { ok: true as const, status }
  })
}
