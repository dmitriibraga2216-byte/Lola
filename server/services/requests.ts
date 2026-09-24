import { and, desc, eq, sql } from 'drizzle-orm'
import { careerRequests, externalTrainingRequests, positions, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import { developmentSettings } from './developmentExtra'
import { managerIdOf } from './orgManager'

interface Ctx { tenantId: string, actorId: string }

/**
 * Заявки (docs/19 §3.7, §4): внешнее обучение — маршрут руководитель → HR → approved;
 * карьера — руководитель → HR. Ветка rejected на любом шаге. approvals — журнал решений.
 */

const EXT_FLOW = ['new', 'manager_approved', 'hr_approved', 'approved'] as const

/** Руководитель человека — единственный источник истины `resolveManager()` (П-16.4, docs/v2/32 §7.8). */
async function managerOf(tx: TenantTx, userId: string) {
  return managerIdOf(tx, userId)
}

// Мокап ExternalRequests: під імʼям людини — «Посада · Точка» з основного розміщення (docs/16, user_placements).
async function placementOf(tx: TenantTx, userId: string) {
  const r = await tx.execute(sql`select p.name as position, l.name as location from user_placements up join positions p on p.id = up.position_id join locations l on l.id = up.location_id where up.user_id = ${userId}::uuid and up.is_primary and up.ended_at is null limit 1`) as unknown as { position: string | null, location: string | null }[]
  return r[0] ? { position: r[0].position, location: r[0].location } : { position: null, location: null }
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
export async function pendingRequests(ctx: Ctx, opts: { isHr: boolean, isAdmin?: boolean }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const st = opts.isAdmin ? ['new', 'manager_approved', 'hr_approved'] : opts.isHr ? ['new', 'manager_approved'] : ['new']
    const external = await tx.select({ r: externalTrainingRequests, fullName: users.fullName }).from(externalTrainingRequests).innerJoin(users, eq(users.id, externalTrainingRequests.userId))
      .where(sql`${externalTrainingRequests.status} = any(${st})`).orderBy(desc(externalTrainingRequests.createdAt))
    const career = await tx.select({ r: careerRequests, fullName: users.fullName, targetPosition: positions.name }).from(careerRequests).innerJoin(users, eq(users.id, careerRequests.userId)).innerJoin(positions, eq(positions.id, careerRequests.targetPositionId))
      .where(sql`${careerRequests.status} = any(${st})`).orderBy(desc(careerRequests.createdAt))
    return { external: external.map(x => ({ ...x.r, fullName: x.fullName })), career: career.map(x => ({ ...x.r, fullName: x.fullName, targetPosition: x.targetPosition })) }
  })
}

/**
 * Повна таблиця заявок з фільтрами (docs/33 D-033, мокап ExternalRequests): на відміну від
 * `pendingRequests` (тільки «на розгляд»), сюди йдуть усі стани — і завершені теж. Той самий
 * сервіс/дані, інше подання. «ВІДПОВІДАЛЬНИЙ» — хто востаннє прийняв рішення по заявці
 * (`approvals` — останній запис), а поки рішень не було — керівник точки людини (хто вирішує зараз).
 */
export async function requestsTable(ctx: Ctx, filter: { kind?: 'external' | 'career', status?: string, from?: string, to?: string } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const actors = await tx.select({ id: users.id, fullName: users.fullName }).from(users)
    const nameOf = new Map(actors.map(a => [a.id, a.fullName]))
    const byRange = (col: typeof externalTrainingRequests.createdAt | typeof careerRequests.createdAt) => sql`
      (${filter.from ? sql`${col} >= ${filter.from}::date` : sql`true`}) and (${filter.to ? sql`${col} < (${filter.to}::date + interval '1 day')` : sql`true`})
    `
    const withResponsible = async (userId: string, approvals: unknown[]) => {
      const last = approvals.length ? approvals[approvals.length - 1] as { by: string } : null
      return last ? (nameOf.get(last.by) ?? null) : await managerOf(tx, userId).then(id => id ? nameOf.get(id) ?? null : null)
    }
    let external: (typeof externalTrainingRequests.$inferSelect & { fullName: string, responsible: string | null, kind: 'external', position: string | null, location: string | null })[] = []
    if (filter.kind !== 'career') {
      const rows = await tx.select({ r: externalTrainingRequests, fullName: users.fullName }).from(externalTrainingRequests).innerJoin(users, eq(users.id, externalTrainingRequests.userId))
        .where(and(filter.status ? eq(externalTrainingRequests.status, filter.status) : sql`true`, byRange(externalTrainingRequests.createdAt)))
        .orderBy(desc(externalTrainingRequests.createdAt))
      external = await Promise.all(rows.map(async (x) => { const pl = await placementOf(tx, x.r.userId); return { ...x.r, fullName: x.fullName, kind: 'external' as const, responsible: await withResponsible(x.r.userId, x.r.approvals as unknown[]), position: pl.position, location: pl.location } }))
    }
    let career: (typeof careerRequests.$inferSelect & { fullName: string, targetPosition: string, responsible: string | null, kind: 'career', position: string | null, location: string | null })[] = []
    if (filter.kind !== 'external') {
      const rows = await tx.select({ r: careerRequests, fullName: users.fullName, targetPosition: positions.name }).from(careerRequests)
        .innerJoin(users, eq(users.id, careerRequests.userId)).innerJoin(positions, eq(positions.id, careerRequests.targetPositionId))
        .where(and(filter.status ? eq(careerRequests.status, filter.status) : sql`true`, byRange(careerRequests.createdAt)))
        .orderBy(desc(careerRequests.createdAt))
      career = await Promise.all(rows.map(async (x) => { const pl = await placementOf(tx, x.r.userId); return { ...x.r, fullName: x.fullName, targetPosition: x.targetPosition, kind: 'career' as const, responsible: await withResponsible(x.r.userId, x.r.approvals as unknown[]), position: pl.position, location: pl.location } }))
    }
    return { external, career }
  })
}

export type DecideResult = { ok: true, status: string } | { ok: false, code: 'not_found' | 'bad_step' | 'self' | 'admin_required' }

/** Решение по шагу: approve двигает по маршруту, reject — в rejected. Сам себе решить нельзя. */
export async function decideRequest(ctx: Ctx, kind: 'external' | 'career', id: string, decision: 'approve' | 'reject', opts: { comment?: string, isHr: boolean, isAdmin?: boolean }): Promise<DecideResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const table = kind === 'external' ? externalTrainingRequests : careerRequests
    const [r] = await tx.select().from(table).where(eq(table.id, id))
    if (!r) return { ok: false as const, code: 'not_found' as const }
    if (r.userId === ctx.actorId) return { ok: false as const, code: 'self' as const }
    const idx = EXT_FLOW.indexOf(r.status as typeof EXT_FLOW[number])
    if (idx < 0 || idx >= EXT_FLOW.length - 1) return { ok: false as const, code: 'bad_step' as const }
    // HR-шаг только для HR; руководительский — для любого с request.decide
    if (r.status === 'manager_approved' && !opts.isHr) return { ok: false as const, code: 'bad_step' as const }
    // docs/19 §7.7, §13.4: сумма выше порога — после HR нужен администратор (hr_approved → approved)
    const settings = await developmentSettings(tx, ctx.tenantId)
    const overThreshold = kind === 'external' && 'cost' in r && r.cost != null && Number(r.cost) > settings.externalTrainingThreshold
    if (r.status === 'hr_approved' && !opts.isAdmin) return { ok: false as const, code: 'admin_required' as const }

    const now = new Date()
    let next: string
    if (decision === 'reject') next = 'rejected'
    else if (kind === 'career') next = r.status === 'manager_approved' ? 'approved' : EXT_FLOW[idx + 1]!
    else if (r.status === 'manager_approved') next = overThreshold ? 'hr_approved' : 'approved'
    else next = EXT_FLOW[idx + 1]!
    const approvals = [...(r.approvals as unknown[]), { step: r.status, by: ctx.actorId, at: now.toISOString(), decision, comment: opts.comment ?? null }]
    await tx.update(table).set({ status: next, approvals, ...(next === 'approved' || next === 'rejected' ? { decidedAt: now } : {}), updatedAt: now }).where(eq(table.id, id))
    await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: r.userId, code: next === 'rejected' ? 'request_rejected' : next === 'approved' ? 'request_approved' : 'request_step', payload: { title: 'title' in r ? r.title : 'Карʼєрна заявка', comment: opts.comment ?? '' }, dedupKey: `req:${id}:${next}` })
    if (next === 'hr_approved') {
      // Администраторам тенанта — на решение
      const admins = await tx.execute(sql`select ur.user_id from user_roles ur join roles ro on ro.id = ur.role_id where ro.code = 'admin' and ur.scope_type = 'tenant'`) as unknown as { user_id: string }[]
      for (const a of admins) await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: a.user_id, code: 'request_new', payload: { title: `${'title' in r ? r.title : ''} (понад ${settings.externalTrainingThreshold} ${'currency' in r ? r.currency : 'UAH'})`, requestId: id }, dedupKey: `req_admin:${id}:${a.user_id}` })
    }
    // docs/19 §7.9: одобренная карьерная заявка → обучение профиля целевой должности и, если настроено, цикл оценки готовности
    if (kind === 'career' && next === 'approved') {
      const { careerApproved } = await import('./developmentExtra')
      await careerApproved(tx, ctx, r as typeof careerRequests.$inferSelect, settings.careerAssessmentFormId)
    }
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
