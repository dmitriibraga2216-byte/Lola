import { and, desc, eq, sql } from 'drizzle-orm'
import { careerRequests, externalTrainingRequests, positions, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'

interface Ctx { tenantId: string, actorId: string }

/**
 * Заявки (docs/19 §3.7, §4): внешнее обучение — маршрут руководитель → HR → approved;
 * карьера — руководитель → HR. Ветка rejected на любом шаге. approvals — журнал решений.
 */

const EXT_FLOW = ['new', 'manager_approved', 'hr_approved', 'approved'] as const

async function managerOf(tx: TenantTx, userId: string) {
  const r = await tx.execute(sql`select l.manager_id from user_placements up join locations l on l.id = up.location_id where up.user_id = ${userId}::uuid and up.is_primary and up.ended_at is null limit 1`) as unknown as { manager_id: string | null }[]
  return r[0]?.manager_id ?? null
}

export async function createExternalRequest(ctx: Ctx, input: { title: string, provider?: string, format: 'online' | 'offline', startsAt?: string, cost?: number, currency?: string, justification?: string, expectedResult?: string }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.insert(externalTrainingRequests).values({
      tenantId: ctx.tenantId, userId: ctx.actorId, title: input.title, provider: input.provider ?? null, format: input.format, startsAt: input.startsAt ?? null,
      cost: input.cost != null ? String(input.cost) : null, currency: input.currency ?? 'UAH', justification: input.justification ?? null, expectedResult: input.expectedResult ?? null,
    }).returning()
    const mgr = await managerOf(tx, ctx.actorId)
    if (mgr) await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: mgr, code: 'request_new', payload: { title: input.title, requestId: r!.id }, dedupKey: `req_new:${r!.id}` })
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'request.external.create', entity: 'external_training_request', entityId: r!.id })
    return r!
  })
}

export async function createCareerRequest(ctx: Ctx, input: { targetPositionId: string, targetLocationId?: string, motivation?: string }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.insert(careerRequests).values({ tenantId: ctx.tenantId, userId: ctx.actorId, targetPositionId: input.targetPositionId, targetLocationId: input.targetLocationId ?? null, motivation: input.motivation ?? null }).returning()
    const mgr = await managerOf(tx, ctx.actorId)
    const [pos] = await tx.select({ name: positions.name }).from(positions).where(eq(positions.id, input.targetPositionId))
    if (mgr) await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: mgr, code: 'request_new', payload: { title: `Карʼєра: ${pos?.name}`, requestId: r!.id }, dedupKey: `career_new:${r!.id}` })
    return r!
  })
}

export async function myRequests(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const external = await tx.select().from(externalTrainingRequests).where(eq(externalTrainingRequests.userId, ctx.actorId)).orderBy(desc(externalTrainingRequests.createdAt))
    const career = await tx.select({ id: careerRequests.id, status: careerRequests.status, motivation: careerRequests.motivation, approvals: careerRequests.approvals, createdAt: careerRequests.createdAt, targetPosition: positions.name })
      .from(careerRequests).innerJoin(positions, eq(positions.id, careerRequests.targetPositionId)).where(eq(careerRequests.userId, ctx.actorId)).orderBy(desc(careerRequests.createdAt))
    return { external, career }
  })
}

/** Очередь на решение (docs/19 §5.1 заявки): руководитель видит new, HR — manager_approved. */
export async function pendingRequests(ctx: Ctx, opts: { isHr: boolean }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const st = opts.isHr ? ['new', 'manager_approved'] : ['new']
    const external = await tx.select({ r: externalTrainingRequests, fullName: users.fullName }).from(externalTrainingRequests).innerJoin(users, eq(users.id, externalTrainingRequests.userId))
      .where(sql`${externalTrainingRequests.status} = any(${st})`).orderBy(desc(externalTrainingRequests.createdAt))
    const career = await tx.select({ r: careerRequests, fullName: users.fullName, targetPosition: positions.name }).from(careerRequests).innerJoin(users, eq(users.id, careerRequests.userId)).innerJoin(positions, eq(positions.id, careerRequests.targetPositionId))
      .where(sql`${careerRequests.status} = any(${st})`).orderBy(desc(careerRequests.createdAt))
    return { external: external.map(x => ({ ...x.r, fullName: x.fullName })), career: career.map(x => ({ ...x.r, fullName: x.fullName, targetPosition: x.targetPosition })) }
  })
}

export type DecideResult = { ok: true, status: string } | { ok: false, code: 'not_found' | 'bad_step' | 'self' }

/** Решение по шагу: approve двигает по маршруту, reject — в rejected. Сам себе решить нельзя. */
export async function decideRequest(ctx: Ctx, kind: 'external' | 'career', id: string, decision: 'approve' | 'reject', opts: { comment?: string, isHr: boolean }): Promise<DecideResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const table = kind === 'external' ? externalTrainingRequests : careerRequests
    const [r] = await tx.select().from(table).where(eq(table.id, id))
    if (!r) return { ok: false as const, code: 'not_found' as const }
    if (r.userId === ctx.actorId) return { ok: false as const, code: 'self' as const }
    const idx = EXT_FLOW.indexOf(r.status as typeof EXT_FLOW[number])
    if (idx < 0 || idx >= EXT_FLOW.length - 1) return { ok: false as const, code: 'bad_step' as const }
    // HR-шаг только для HR; руководительский — для любого с request.decide
    if (r.status === 'manager_approved' && !opts.isHr) return { ok: false as const, code: 'bad_step' as const }

    const now = new Date()
    const next = decision === 'reject' ? 'rejected' : (kind === 'career' && r.status === 'manager_approved') || (opts.isHr && r.status === 'manager_approved') ? 'approved' : EXT_FLOW[idx + 1]!
    const approvals = [...(r.approvals as unknown[]), { step: r.status, by: ctx.actorId, at: now.toISOString(), decision, comment: opts.comment ?? null }]
    await tx.update(table).set({ status: next, approvals, ...(next === 'approved' || next === 'rejected' ? { decidedAt: now } : {}), updatedAt: now }).where(eq(table.id, id))
    await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: r.userId, code: next === 'rejected' ? 'request_rejected' : next === 'approved' ? 'request_approved' : 'request_step', payload: { title: 'title' in r ? r.title : 'Карʼєрна заявка', comment: opts.comment ?? '' }, dedupKey: `req:${id}:${next}` })
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: `request.${kind}.${decision}`, entity: kind === 'external' ? 'external_training_request' : 'career_request', entityId: id, before: { status: r.status }, after: { status: next } })
    return { ok: true as const, status: next }
  })
}

export async function completeExternal(ctx: Ctx, id: string, report: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.update(externalTrainingRequests).set({ status: 'completed', report, updatedAt: new Date() })
      .where(and(eq(externalTrainingRequests.id, id), eq(externalTrainingRequests.userId, ctx.actorId), eq(externalTrainingRequests.status, 'approved'))).returning({ id: externalTrainingRequests.id })
    return r ?? null
  })
}
