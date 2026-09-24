import { and, eq, isNull, sql } from 'drizzle-orm'
import { orgConflicts, taskAccessLog, userPlacements } from '../db/schema'
import type { TenantTx } from '../utils/withTenant'
import { withTenant } from '../utils/withTenant'
import { currentRequestContext } from '../utils/requestContext'
import type { ContentType, OrgConflictKind, OrgConflictSeverity } from '../../shared/enums'
import { recordAudit } from './audit'

/**
 * Писатели журналов Spec 22 (docs/22 §13.4, docs/16 §7): обращения к заданиям и конфликты оргструктуры.
 * Оба пишут `request_context` тем же хелпером, что остальные журналы (CLAUDE.md п. 14), и никогда
 * не роняют основной поток — журнал вторичен по отношению к действию.
 */

export interface TaskAccessInput {
  tenantId: string
  userId: string
  contentType: ContentType | 'news' | 'simple_notice' | 'article' // хаб (Spec 21): просмотры новостей, плашек и статей — тем же журналом
  contentId: string
  title?: string | null
  assignmentId?: string | null
  enrollmentId?: string | null
  action?: 'open' | 'download'
}

/** Каждое открытие или скачивание задания — строка (эталон фиксирует обращение, а не первый вход). */
export async function logTaskAccess(tx: TenantTx | null, input: TaskAccessInput): Promise<void> {
  const values = {
    tenantId: input.tenantId,
    userId: input.userId,
    contentType: input.contentType,
    contentId: input.contentId,
    title: input.title ?? null,
    assignmentId: input.assignmentId ?? null,
    enrollmentId: input.enrollmentId ?? null,
    action: input.action ?? 'open',
    requestContext: currentRequestContext(),
  }
  try {
    if (tx) await tx.insert(taskAccessLog).values(values)
    else await withTenant(input.tenantId, input.userId, t => t.insert(taskAccessLog).values(values))
  }
  catch (err) {
    console.error('task_access_log write failed', err)
  }
}

export type { OrgConflictKind, OrgConflictSeverity }

export interface OrgConflictInput {
  tenantId: string
  userId?: string | null
  kind: OrgConflictKind
  /** Важность (docs/v2/32 §3.3, решение В-7). По умолчанию `warning` — как в колонке. */
  severity?: OrgConflictSeverity
  /** Узел дерева, на котором конфликт найден (PR-30); null — конфликт про человека. */
  nodeId?: string | null
  source?: 'manual' | 'import'
  importJobId?: string | null
  details?: Record<string, unknown>
  actorId?: string | null
}

/** Конфликт оргструктуры: эталон не падает, а пишет строку и продолжает (docs/16 §14). */
export async function logOrgConflict(tx: TenantTx, input: OrgConflictInput): Promise<void> {
  try {
    await tx.insert(orgConflicts).values({
      tenantId: input.tenantId,
      userId: input.userId ?? null,
      kind: input.kind,
      severity: input.severity ?? 'warning',
      nodeId: input.nodeId ?? null,
      source: input.source ?? 'manual',
      importJobId: input.importJobId ?? null,
      details: input.details ?? {},
      actorId: input.actorId ?? null,
      requestContext: currentRequestContext(),
    })
  }
  catch (err) {
    console.error('org_conflicts write failed', err)
  }
}

export type ConflictResolution = 'acknowledge' | 'close_placement'

/**
 * Разрешение конфликта (мокап OrgConflicts: «Не вирішено» → «Вирішено»): `acknowledge` — принять как есть;
 * `close_placement` — для «людина у двох підрозділах» закрыть одно из открытых размещений (`ended_at = сегодня`).
 * Решение остаётся в `details.resolution`, факт — в audit_log; строка журнала не удаляется.
 */
export async function resolveOrgConflict(ctx: { tenantId: string, actorId: string }, id: string, input: { action: ConflictResolution, placementId?: string | null, comment?: string | null }): Promise<{ ok: true } | { ok: false, code: 'not_found' | 'already_resolved' | 'placement_required' | 'placement_not_found' }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [c] = await tx.select().from(orgConflicts).where(eq(orgConflicts.id, id))
    if (!c) return { ok: false as const, code: 'not_found' as const }
    if (c.resolvedAt) return { ok: false as const, code: 'already_resolved' as const }
    let closed: string | null = null
    if (input.action === 'close_placement') {
      if (!input.placementId) return { ok: false as const, code: 'placement_required' as const }
      const [p] = await tx.update(userPlacements).set({ endedAt: sql`current_date`, updatedAt: new Date() })
        .where(and(eq(userPlacements.id, input.placementId), c.userId ? eq(userPlacements.userId, c.userId) : sql`true`, isNull(userPlacements.endedAt)))
        .returning({ id: userPlacements.id, isPrimary: userPlacements.isPrimary })
      if (!p) return { ok: false as const, code: 'placement_not_found' as const }
      closed = p.id
      // Если закрыли основное — первое из оставшихся открытых становится основным
      if (p.isPrimary && c.userId) {
        await tx.execute(sql`update user_placements set is_primary = true, updated_at = now() where id = (select id from user_placements where user_id = ${c.userId}::uuid and ended_at is null order by started_at desc limit 1)`)
      }
    }
    const resolution = { action: input.action, placementId: closed, comment: input.comment?.trim() || null, by: ctx.actorId, at: new Date().toISOString() }
    await tx.update(orgConflicts).set({ resolvedAt: new Date(), resolvedBy: ctx.actorId, details: { ...(c.details as Record<string, unknown>), resolution }, updatedAt: new Date() }).where(eq(orgConflicts.id, id))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'org_conflict.resolve', entity: 'org_conflict', entityId: id, before: { kind: c.kind, userId: c.userId }, after: resolution })
    return { ok: true as const }
  })
}

/** Открытые размещения человека — для выбора, какое закрыть при «людина у двох підрозділах». */
export async function openPlacements(ctx: { tenantId: string, actorId: string }, userId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, tx => tx.execute(sql`
    select up.id, up.is_primary, up.started_at, l.name as location, p.name as position, ou.name as unit
    from user_placements up join locations l on l.id = up.location_id join positions p on p.id = up.position_id
    left join org_units ou on ou.id = coalesce(up.org_unit_id, l.org_unit_id)
    where up.user_id = ${userId}::uuid and up.ended_at is null order by up.is_primary desc, up.started_at desc`) as unknown as Promise<Record<string, unknown>[]>)
}
