import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { assignments, courses, enrollmentEvents, enrollments, locations, userPlacements, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { enqueueNotification } from './notifications'

/**
 * due.scan (docs/10 §7.4, §11; docs/15 §3.4): ежедневно — напоминания за N дней,
 * в день срока, просрочка → expired + уведомление руководителю через M дней,
 * scheduled → not_started. Идемпотентно через dedupKey (одно на запись+код+день).
 */

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10)
}

async function managerOf(tx: TenantTx, userId: string): Promise<string | null> {
  const [row] = await tx.select({ managerId: locations.managerId })
    .from(userPlacements)
    .innerJoin(locations, eq(locations.id, userPlacements.locationId))
    .where(and(eq(userPlacements.userId, userId), eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt)))
  return row?.managerId ?? null
}

export async function runDueScan(tenantId: string): Promise<{ activated: number, remindered: number, expired: number }> {
  const stats = { activated: 0, remindered: 0, expired: 0 }
  await withTenant(tenantId, null, async (tx) => {
    const now = new Date()
    const today = dayKey(now)

    // 1. scheduled → not_started (docs/10 §4)
    const activated = await tx.update(enrollments)
      .set({ status: 'not_started', updatedAt: now })
      .where(and(eq(enrollments.status, 'scheduled'), lte(enrollments.startsAt, now)))
      .returning({ id: enrollments.id })
    stats.activated = activated.length

    // 2. Активные записи со сроком
    const active = await tx.select({
      e: enrollments,
      courseTitle: courses.title,
      reminders: assignments.reminders,
      fullName: users.fullName,
    })
      .from(enrollments)
      .innerJoin(courses, eq(courses.id, enrollments.subjectId))
      .innerJoin(users, eq(users.id, enrollments.userId))
      .leftJoin(assignments, eq(assignments.id, enrollments.assignmentId))
      .where(and(
        inArray(enrollments.status, ['not_started', 'in_progress', 'failed', 'expired']),
        sql`${enrollments.dueAt} is not null`,
      ))

    for (const { e, courseTitle, reminders, fullName } of active) {
      const r = (reminders ?? {}) as { enabled?: boolean, beforeDays?: number[], onDueDay?: boolean, afterDays?: number[], notifyManagerAfterDays?: number | null }
      // Календарная разница дат: срок «вчера» = -1 даже если прошло 20 часов
      const dueDay = Date.UTC(e.dueAt!.getUTCFullYear(), e.dueAt!.getUTCMonth(), e.dueAt!.getUTCDate())
      const nowDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
      const daysLeft = Math.round((dueDay - nowDay) / 86_400_000)
      const payload = { course: courseTitle, due: e.dueAt!.toISOString(), enrollmentId: e.id, days: daysLeft, name: fullName }

      if (r.enabled === false) continue

      if (daysLeft > 0 && (r.beforeDays ?? [3, 1]).includes(daysLeft) && e.status !== 'expired') {
        if (await enqueueNotification(tx, { tenantId, userId: e.userId, code: 'enrollment_due_soon', payload, dedupKey: `due_soon:${e.id}:${today}` })) stats.remindered++
      }
      if (daysLeft === 0 && r.onDueDay !== false && e.status !== 'expired') {
        if (await enqueueNotification(tx, { tenantId, userId: e.userId, code: 'enrollment_due_today', payload, dedupKey: `due_today:${e.id}:${today}` })) stats.remindered++
      }
      if (daysLeft < 0) {
        const daysOver = -daysLeft
        if (e.status !== 'expired' && e.status !== 'failed') {
          // Просрочка не блокирует доступ (docs/10 §7.5), но статус — expired
          await tx.update(enrollments).set({ status: 'expired', expiredAt: now, updatedAt: now }).where(eq(enrollments.id, e.id))
          await tx.insert(enrollmentEvents).values({ tenantId, enrollmentId: e.id, event: 'expired', payload: { dueAt: e.dueAt } })
          const { emitWebhook } = await import('./webhooks')
          await emitWebhook(tx, tenantId, 'assignment.overdue', { enrollmentId: e.id, userId: e.userId, courseId: e.subjectId, dueAt: e.dueAt })
          stats.expired++
        }
        if ((r.afterDays ?? [1, 3, 7]).includes(daysOver)) {
          if (await enqueueNotification(tx, { tenantId, userId: e.userId, code: 'enrollment_overdue', payload, dedupKey: `overdue:${e.id}:${today}` })) stats.remindered++
        }
        const managerAfter = r.notifyManagerAfterDays ?? 1
        if (managerAfter !== null && daysOver === managerAfter) {
          const managerId = await managerOf(tx, e.userId)
          if (managerId && managerId !== e.userId) {
            await enqueueNotification(tx, { tenantId, userId: managerId, code: 'enrollment_overdue_manager', payload, dedupKey: `overdue_mgr:${e.id}:${today}` })
          }
        }
      }
    }

    // 3. Переаттестация (docs/10 §7.6): за 30 дней до valid_until — новая запись source=repeat
    const expiring = await tx.select().from(enrollments).where(and(
      eq(enrollments.status, 'completed'),
      sql`${enrollments.validUntil} is not null`,
      lte(enrollments.validUntil, new Date(now.getTime() + 30 * 86_400_000)),
      sql`not exists (select 1 from ${enrollments} r where r.user_id = ${enrollments.userId} and r.subject_id = ${enrollments.subjectId} and r.source = 'repeat' and r.created_at > ${enrollments.completedAt})`,
    ))
    for (const e of expiring) {
      const [course] = await tx.select().from(courses).where(eq(courses.id, e.subjectId))
      if (!course?.publishedVersionId || course.status !== 'published') continue
      const [rep] = await tx.insert(enrollments).values({
        tenantId, userId: e.userId, subjectId: e.subjectId, versionId: course.publishedVersionId,
        assignmentId: e.assignmentId, source: 'repeat', requiredTotal: e.requiredTotal, dueAt: e.validUntil,
      }).onConflictDoNothing().returning({ id: enrollments.id })
      if (rep) {
        await tx.insert(enrollmentEvents).values({ tenantId, enrollmentId: rep.id, event: 'created', payload: { source: 'repeat', from: e.id } })
        await enqueueNotification(tx, { tenantId, userId: e.userId, code: 'enrollment_repeat_due', payload: { course: course.title, due: e.validUntil?.toISOString(), enrollmentId: rep.id }, dedupKey: `repeat:${rep.id}` })
      }
    }
  })
  return stats
}

export async function allActiveTenants(): Promise<string[]> {
  const rows = await db.execute(sql`select id from tenants where status = 'active'`)
  return (rows as unknown as { id: string }[]).map(r => r.id)
}
