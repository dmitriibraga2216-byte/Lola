import { randomBytes } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { certificateCounters, certificates, courses, enrollments } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'

interface Ctx { tenantId: string, actorId: string }

/**
 * Сертификаты (docs/14 §3.5, §7.3–7.7): номер LO-<год>-<6 цифр> без пропусков
 * (счётчик в той же транзакции), выдача идемпотентна по (enrollment_id, attempt_id),
 * публичная проверка по токену без входа, отзыв не удаляет.
 */

async function nextNumber(tx: Parameters<Parameters<typeof withTenant>[2]>[0], tenantId: string): Promise<string> {
  const year = new Date().getFullYear()
  const [row] = await tx.insert(certificateCounters).values({ tenantId, year, last: 1 })
    .onConflictDoUpdate({
      target: [certificateCounters.tenantId, certificateCounters.year],
      set: { last: sql`${certificateCounters.last} + 1` },
    })
    .returning({ last: certificateCounters.last })
  return `LO-${year}-${String(row!.last).padStart(6, '0')}`
}

export type IssueResult
  = | { ok: true, certificateId: string, number: string, created: boolean }
    | { ok: false, code: 'not_found' | 'not_completed' }

/** Выдача по завершённой записи. Повторный вызов возвращает существующий сертификат. */
export async function issueForEnrollment(ctx: Ctx, enrollmentId: string, attemptId?: string | null): Promise<IssueResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [enr] = await tx.select().from(enrollments).where(eq(enrollments.id, enrollmentId))
    if (!enr) return { ok: false as const, code: 'not_found' as const }
    if (enr.status !== 'done') return { ok: false as const, code: 'not_completed' as const }

    const existing = await tx.select({ id: certificates.id, number: certificates.number }).from(certificates)
      .where(and(
        eq(certificates.enrollmentId, enrollmentId),
        attemptId ? eq(certificates.attemptId, attemptId) : sql`${certificates.attemptId} is null`,
      ))
    if (existing[0]) return { ok: true as const, certificateId: existing[0].id, number: existing[0].number, created: false }

    const [course] = await tx.select({ validityMonths: courses.validityMonths }).from(courses).where(eq(courses.id, enr.subjectId))
    const number = await nextNumber(tx, ctx.tenantId)
    const issuedAt = new Date()
    const validUntil = course?.validityMonths
      ? new Date(new Date(issuedAt).setMonth(issuedAt.getMonth() + course.validityMonths))
      : null

    const [cert] = await tx.insert(certificates).values({
      tenantId: ctx.tenantId,
      userId: enr.userId,
      courseId: enr.subjectId,
      enrollmentId,
      attemptId: attemptId ?? null,
      number,
      score: enr.score,
      issuedAt,
      validUntil,
      publicToken: randomBytes(32).toString('base64url'),
    }).onConflictDoNothing().returning({ id: certificates.id, number: certificates.number })

    if (!cert) {
      // Гонка: параллельная выдача уже создала — вернуть её
      const [again] = await tx.select({ id: certificates.id, number: certificates.number }).from(certificates)
        .where(eq(certificates.enrollmentId, enrollmentId))
      return { ok: true as const, certificateId: again!.id, number: again!.number, created: false }
    }

    if (validUntil) {
      await tx.update(enrollments).set({ validUntil }).where(eq(enrollments.id, enrollmentId))
    }
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'certificate.issue', entity: 'certificate', entityId: cert.id, after: { number, enrollmentId } })
    const [c] = await tx.select({ title: courses.title }).from(courses).where(eq(courses.id, enr.subjectId))
    await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: enr.userId, code: 'certificate_issued', payload: { number, course: c?.title }, dedupKey: `cert_issued:${cert.id}` })
    const { emitWebhook } = await import('./webhooks')
    await emitWebhook(tx, ctx.tenantId, 'certificate.issued', { certificateId: cert.id, number, userId: enr.userId, courseId: enr.subjectId, validUntil })
    // PDF — фоновой задачей; в тестах/без воркера отрендерится лениво при первом скачивании
    import('./queue').then(q => q.enqueueCertificatePdf(ctx.tenantId, cert.id)).catch(() => {})
    return { ok: true as const, certificateId: cert.id, number: cert.number, created: true }
  })
}

export async function myCertificates(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({
      id: certificates.id,
      number: certificates.number,
      score: certificates.score,
      issuedAt: certificates.issuedAt,
      validUntil: certificates.validUntil,
      revokedAt: certificates.revokedAt,
      publicToken: certificates.publicToken,
      courseTitle: courses.title,
    })
      .from(certificates)
      .leftJoin(courses, eq(courses.id, certificates.courseId))
      .where(eq(certificates.userId, ctx.actorId))
      .orderBy(desc(certificates.issuedAt))
  })
}

export async function listCertificates(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({
      id: certificates.id,
      number: certificates.number,
      userId: certificates.userId,
      score: certificates.score,
      issuedAt: certificates.issuedAt,
      validUntil: certificates.validUntil,
      revokedAt: certificates.revokedAt,
      courseTitle: courses.title,
    })
      .from(certificates)
      .leftJoin(courses, eq(courses.id, certificates.courseId))
      .orderBy(desc(certificates.issuedAt))
      .limit(200)
  })
}

export async function revokeCertificate(ctx: Ctx, id: string, reason: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [cert] = await tx.update(certificates).set({
      revokedAt: new Date(),
      revokedBy: ctx.actorId,
      revokeReason: reason,
      updatedAt: new Date(),
    }).where(and(eq(certificates.id, id), sql`${certificates.revokedAt} is null`)).returning({ id: certificates.id, number: certificates.number })
    if (!cert) return null
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'certificate.revoke', entity: 'certificate', entityId: id, after: { reason } })
    return cert
  })
}

export interface PublicCertificate {
  number: string
  full_name: string
  course_title: string | null
  tenant_name: string
  issued_at: string
  valid_until: string | null
  revoked_at: string | null
  score: string | null
}

/** Публичная страница /c/<token> без входа — через SECURITY DEFINER функцию. */
export async function publicCertificate(token: string): Promise<PublicCertificate | null> {
  const rows = await db.execute(sql`select * from public_certificate(${token})`)
  return (rows as unknown as PublicCertificate[])[0] ?? null
}
