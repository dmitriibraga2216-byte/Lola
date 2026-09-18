import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { z } from 'zod'
import {
  assignments, courses, enrollmentEvents, enrollments, lessons, modules, quizzes, users,
} from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import { resolveAudience } from './audience'
import { enqueueNotification } from './notifications'
import type { Audience, assignmentCreateSchema, assignmentUpdateSchema } from '../../shared/schemas/assignments'

interface Ctx { tenantId: string, actorId: string }

const DEFAULT_REMINDERS = {
  enabled: true, beforeDays: [3, 1], onDueDay: true, afterDays: [1, 3, 7],
  channels: ['telegram'], notifyManagerAfterDays: 1, notifyOnAssign: true,
}

const EXPAND_BATCH = 5000 // docs/15 §7.10: защита от лавины

export async function listAssignments(ctx: Ctx, filter: { status?: string, kind?: string } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select({
      id: assignments.id,
      title: assignments.title,
      kind: assignments.kind,
      subjectType: assignments.subjectType,
      subjectId: assignments.subjectId,
      status: assignments.status,
      startsAt: assignments.startsAt,
      dueMode: assignments.dueMode,
      dueAt: assignments.dueAt,
      dueDays: assignments.dueDays,
      isMandatory: assignments.isMandatory,
      tags: assignments.tags,
      stats: assignments.stats,
      createdAt: assignments.createdAt,
      createdBy: assignments.createdBy,
      authorName: users.fullName,
    })
      .from(assignments)
      .leftJoin(users, eq(users.id, assignments.createdBy))
      .where(and(
        ...(filter.status ? [eq(assignments.status, filter.status)] : [sql`${assignments.status} <> 'archived'`]),
        ...(filter.kind ? [eq(assignments.kind, filter.kind)] : []),
      ))
      .orderBy(desc(assignments.createdAt))
      .limit(200)
    return rows
  })
}

/** Живой счётчик «Під умову підпадає N людей» (docs/15 §5.2). */
export async function previewAudience(ctx: Ctx, audience: Audience, exclude?: Audience | null) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const ids = [...await resolveAudience(tx, audience, exclude)]
    const sample = ids.length
      ? await tx.select({ id: users.id, fullName: users.fullName }).from(users)
          .where(inArray(users.id, ids.slice(0, 20)))
      : []
    return { count: ids.length, sample }
  })
}

async function subjectTitle(tx: TenantTx, subjectType: string, subjectId: string): Promise<string | null> {
  if (subjectType === 'quiz') {
    const [q] = await tx.select({ title: quizzes.title }).from(quizzes).where(eq(quizzes.id, subjectId))
    return q?.title ?? null
  }
  const [c] = await tx.select({ title: courses.title, status: courses.status }).from(courses)
    .where(and(eq(courses.id, subjectId), isNull(courses.deletedAt)))
  return c?.status === 'published' ? c.title : null
}

export type CreateResult
  = | { ok: true, assignmentId: string, expanded: number }
    | { ok: false, code: 'subject_not_found' | 'empty_audience' }

export async function createAssignment(ctx: Ctx, input: z.infer<typeof assignmentCreateSchema>): Promise<CreateResult> {
  const created = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const title = await subjectTitle(tx, input.subjectType, input.subjectId)
    if (!title) return { ok: false as const, code: 'subject_not_found' as const }

    const count = (await resolveAudience(tx, input.audience, input.exclude)).size
    if (count === 0 && input.status === 'active') return { ok: false as const, code: 'empty_audience' as const }

    let versionId: string | null = null
    if (input.lockVersion && input.subjectType === 'course') {
      const [c] = await tx.select({ v: courses.publishedVersionId }).from(courses).where(eq(courses.id, input.subjectId))
      versionId = c?.v ?? null
    }

    const [row] = await tx.insert(assignments).values({
      tenantId: ctx.tenantId,
      title: input.title ?? title,
      kind: 'manual',
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      subjectVersionId: versionId,
      audience: input.audience,
      exclude: input.exclude ?? { rules: [], match: 'any' },
      startsAt: input.startsAt ? new Date(input.startsAt) : null,
      dueMode: input.dueMode,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      dueDays: input.dueMode === 'relative' ? input.dueDays : null,
      isMandatory: input.isMandatory,
      recurrence: input.recurrence ?? null,
      params: input.params ?? {},
      reminders: { ...DEFAULT_REMINDERS, ...(input.reminders ?? {}) },
      autoSync: input.autoSync,
      tags: input.tags,
      status: input.status,
      createdBy: ctx.actorId,
    }).returning({ id: assignments.id })

    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'assignment.create', entity: 'assignment', entityId: row!.id, after: { title, count } })
    return { ok: true as const, assignmentId: row!.id }
  })
  if (!created.ok) return created

  const expanded = created.ok && input.status === 'active' ? await expandAssignment(ctx.tenantId, created.assignmentId) : 0
  return { ok: true, assignmentId: created.assignmentId, expanded }
}

/**
 * Раскрытие аудитории в записи (docs/15 §7.1–7.2): идемпотентно — существующие
 * записи не дублируются; ушедших из-под условия не снимает.
 */
export async function expandAssignment(tenantId: string, assignmentId: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const [a] = await tx.select().from(assignments).where(eq(assignments.id, assignmentId))
    if (!a || a.status !== 'active') return 0
    if (a.subjectType !== 'course') return 0 // назначения тестов — через курс-обёртку, R2

    const [course] = await tx.select().from(courses).where(and(eq(courses.id, a.subjectId), isNull(courses.deletedAt)))
    if (!course?.publishedVersionId || course.status !== 'published') return 0
    const versionId = a.subjectVersionId ?? course.publishedVersionId

    const wanted = await resolveAudience(tx, a.audience as Audience, a.exclude as Audience)
    const existing = await tx.select({ userId: enrollments.userId }).from(enrollments)
      .where(eq(enrollments.assignmentId, assignmentId))
    const have = new Set(existing.map(e => e.userId))

    // Профиль (docs/15 §7.11): уже пройденные с действующим результатом не назначаются заново
    const alreadyValid = a.kind === 'profile'
      ? new Set((await tx.select({ userId: enrollments.userId }).from(enrollments).where(and(
          eq(enrollments.subjectId, a.subjectId),
          eq(enrollments.status, 'completed'),
          sql`(${enrollments.validUntil} is null or ${enrollments.validUntil} > now())`,
        ))).map(e => e.userId))
      : new Set<string>()

    const toCreate = [...wanted].filter(id => !have.has(id) && !alreadyValid.has(id)).slice(0, EXPAND_BATCH)
    if (toCreate.length === 0) {
      await tx.update(assignments).set({ lastSyncAt: new Date() }).where(eq(assignments.id, assignmentId))
      return 0
    }

    const [cnt] = await tx.select({ requiredTotal: sql<number>`count(*)::int` })
      .from(lessons).innerJoin(modules, eq(modules.id, lessons.moduleId))
      .where(and(eq(modules.courseVersionId, versionId), eq(lessons.isRequired, true)))
    const requiredTotal = cnt?.requiredTotal ?? 0

    const now = new Date()
    const startsAt = a.startsAt && a.startsAt > now ? a.startsAt : null
    const dueAt = a.dueMode === 'absolute'
      ? a.dueAt
      : a.dueMode === 'relative' && a.dueDays
        ? new Date((startsAt ?? now).getTime() + a.dueDays * 86_400_000)
        : null

    const inserted = await tx.insert(enrollments).values(toCreate.map(userId => ({
      tenantId,
      userId,
      subjectId: a.subjectId,
      versionId,
      assignmentId,
      source: 'assigned',
      status: startsAt ? 'scheduled' : 'not_started',
      requiredTotal,
      startsAt,
      dueAt,
    }))).onConflictDoNothing().returning({ id: enrollments.id, userId: enrollments.userId })

    if (inserted.length) {
      await tx.insert(enrollmentEvents).values(inserted.map(e => ({
        tenantId, enrollmentId: e.id, event: 'created', payload: { source: 'assigned', assignmentId }, actorId: a.createdBy,
      })))
      const reminders = a.reminders as { notifyOnAssign?: boolean }
      if (reminders.notifyOnAssign !== false) {
        for (const e of inserted) {
          await enqueueNotification(tx, {
            tenantId,
            userId: e.userId,
            code: 'assignment_created',
            payload: { course: course.title, due: dueAt?.toISOString() ?? null, enrollmentId: e.id },
            dedupKey: `assignment_created:${e.id}`,
          })
        }
      }
    }

    await tx.update(assignments).set({ lastSyncAt: now, updatedAt: now }).where(eq(assignments.id, assignmentId))
    await recalcStats(tx, assignmentId)
    return inserted.length
  })
}

/** Автосинхронизация (docs/15 §7.2): раз в час и по событиям — подхватить новых. */
export async function syncAssignments(tenantId: string): Promise<number> {
  const ids = await withTenant(tenantId, null, async (tx) => {
    return (await tx.select({ id: assignments.id }).from(assignments)
      .where(and(eq(assignments.status, 'active'), eq(assignments.autoSync, true)))).map(r => r.id)
  })
  let total = 0
  for (const id of ids) total += await expandAssignment(tenantId, id)
  return total
}

async function recalcStats(tx: TenantTx, assignmentId: string) {
  const [s] = await tx.select({
    assigned: sql<number>`count(*)::int`,
    started: sql<number>`count(*) filter (where ${enrollments.status} in ('in_progress','completed','failed'))::int`,
    completed: sql<number>`count(*) filter (where ${enrollments.status} = 'completed')::int`,
    overdue: sql<number>`count(*) filter (where ${enrollments.status} = 'expired')::int`,
  }).from(enrollments).where(eq(enrollments.assignmentId, assignmentId))
  await tx.update(assignments).set({ stats: s }).where(eq(assignments.id, assignmentId))
}

export async function getAssignment(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [a] = await tx.select().from(assignments).where(eq(assignments.id, id))
    if (!a) return null
    const people = await tx.select({
      enrollmentId: enrollments.id,
      userId: enrollments.userId,
      fullName: users.fullName,
      status: enrollments.status,
      progressPct: enrollments.progressPct,
      dueAt: enrollments.dueAt,
      completedAt: enrollments.completedAt,
      lastActivityAt: enrollments.lastActivityAt,
    })
      .from(enrollments)
      .innerJoin(users, eq(users.id, enrollments.userId))
      .where(eq(enrollments.assignmentId, id))
      .orderBy(users.fullName)
    return { ...a, people }
  })
}

export async function updateAssignment(ctx: Ctx, id: string, input: z.infer<typeof assignmentUpdateSchema>) {
  const updated = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(assignments).where(eq(assignments.id, id))
    if (!before) return null
    const [after] = await tx.update(assignments).set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.reminders !== undefined ? { reminders: { ...(before.reminders as object), ...input.reminders } } : {}),
      ...(input.params !== undefined ? { params: { ...(before.params as object), ...input.params } } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.autoSync !== undefined ? { autoSync: input.autoSync } : {}),
      updatedAt: new Date(),
    }).where(eq(assignments.id, id)).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'assignment.update', entity: 'assignment', entityId: id, before: { status: before.status }, after: { status: after!.status } })
    return { before, after: after! }
  })
  if (!updated) return null
  // draft/paused → active: раскрыть
  if (updated.before.status !== 'active' && updated.after.status === 'active') {
    await expandAssignment(ctx.tenantId, id)
  }
  return updated.after
}

/** Отмена (docs/15 §6.2, docs/03 §3.5): not_started удаляются, начатые — доучиваются или expired. */
export async function cancelAssignment(ctx: Ctx, id: string, input: { reason: string, keepStarted: boolean }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [a] = await tx.select().from(assignments).where(eq(assignments.id, id))
    if (!a) return null

    const removed = await tx.delete(enrollments)
      .where(and(eq(enrollments.assignmentId, id), inArray(enrollments.status, ['scheduled', 'not_started'])))
      .returning({ id: enrollments.id })

    let cancelled = 0
    if (!input.keepStarted) {
      const rows = await tx.update(enrollments).set({
        status: 'cancelled',
        cancelledBy: ctx.actorId,
        cancelReason: input.reason,
        updatedAt: new Date(),
      }).where(and(eq(enrollments.assignmentId, id), inArray(enrollments.status, ['in_progress', 'failed', 'expired'])))
        .returning({ id: enrollments.id })
      cancelled = rows.length
      if (rows.length) {
        await tx.insert(enrollmentEvents).values(rows.map(r => ({
          tenantId: ctx.tenantId, enrollmentId: r.id, event: 'cancelled', payload: { reason: input.reason }, actorId: ctx.actorId,
        })))
      }
    }

    await tx.update(assignments).set({ status: 'archived', autoSync: false, updatedAt: new Date() }).where(eq(assignments.id, id))
    await recalcStats(tx, id)
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'assignment.cancel', entity: 'assignment', entityId: id, after: { reason: input.reason, removed: removed.length, cancelled } })
    return { removed: removed.length, cancelled }
  })
}

/** Продление срока конкретному человеку (docs/10 §6.2). */
export async function extendEnrollment(ctx: Ctx, enrollmentId: string, input: { dueAt: string, reason: string, notify: boolean }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [e] = await tx.select().from(enrollments).where(eq(enrollments.id, enrollmentId))
    if (!e) return null
    const dueAt = new Date(input.dueAt)
    const [after] = await tx.update(enrollments).set({
      dueAt,
      status: e.status === 'expired' ? 'in_progress' : e.status,
      expiredAt: null,
      updatedAt: new Date(),
    }).where(eq(enrollments.id, enrollmentId)).returning()
    await tx.insert(enrollmentEvents).values({
      tenantId: ctx.tenantId, enrollmentId, event: 'extended', payload: { from: e.dueAt, to: dueAt, reason: input.reason }, actorId: ctx.actorId,
    })
    if (input.notify) {
      const [course] = await tx.select({ title: courses.title }).from(courses).where(eq(courses.id, e.subjectId))
      await enqueueNotification(tx, {
        tenantId: ctx.tenantId, userId: e.userId, code: 'enrollment_extended',
        payload: { course: course?.title, due: dueAt.toISOString() }, dedupKey: `extended:${enrollmentId}:${dueAt.getTime()}`,
      })
    }
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'enrollment.extend', entity: 'enrollment', entityId: enrollmentId, before: { dueAt: e.dueAt }, after: { dueAt, reason: input.reason } })
    return after!
  })
}

/** Записи по людям для руководителя (docs/10 §5.5). */
export async function manageEnrollments(ctx: Ctx, filter: { status?: string, courseId?: string, onlyMandatory?: boolean }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({
      id: enrollments.id,
      userId: enrollments.userId,
      fullName: users.fullName,
      courseId: enrollments.subjectId,
      courseTitle: courses.title,
      source: enrollments.source,
      status: enrollments.status,
      progressPct: enrollments.progressPct,
      dueAt: enrollments.dueAt,
      completedAt: enrollments.completedAt,
      lastActivityAt: enrollments.lastActivityAt,
      assignmentId: enrollments.assignmentId,
    })
      .from(enrollments)
      .innerJoin(users, eq(users.id, enrollments.userId))
      .innerJoin(courses, eq(courses.id, enrollments.subjectId))
      .where(and(
        ...(filter.status ? [eq(enrollments.status, filter.status)] : []),
        ...(filter.courseId ? [eq(enrollments.subjectId, filter.courseId)] : []),
        ...(filter.onlyMandatory ? [sql`exists (select 1 from ${assignments} a where a.id = ${enrollments.assignmentId} and a.is_mandatory)`] : []),
      ))
      .orderBy(desc(enrollments.createdAt))
      .limit(500)
  })
}

