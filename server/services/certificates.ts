import { randomBytes } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { certificateCounters, certificates, courses, enrollments, users } from '../db/schema'
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
    | { ok: false, code: 'not_found' | 'not_completed' | 'stage_no_certificate' }

/** Выдача по завершённой записи. Повторный вызов возвращает существующий сертификат. */
export async function issueForEnrollment(ctx: Ctx, enrollmentId: string, attemptId?: string | null): Promise<IssueResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [enr] = await tx.select().from(enrollments).where(eq(enrollments.id, enrollmentId))
    if (!enr) return { ok: false as const, code: 'not_found' as const }
    if (enr.status !== 'done') return { ok: false as const, code: 'not_completed' as const }
    // П-14 (docs/v2/39-patches.md, docs/v2/33 §3.3): по курсам этапа с выключенной
    // возможностью `certificate` сертификат не выдаётся вовсе. Курс без этапа — полный набор
    // возможностей, то есть поведение базового ТЗ не меняется. Решение принимает stageCan()
    // (§7.1) — ветвления по коду этапа здесь нет.
    const { courseStageCan } = await import('./lifecycle')
    if (!await courseStageCan(tx, enr.subjectId, 'certificate')) return { ok: false as const, code: 'stage_no_certificate' as const }

    // Отозванный (D-013: откат зачёта при пересчёте) не считается — повторное завершение выдаёт новый номер (docs/14 §12)
    const existing = await tx.select({ id: certificates.id, number: certificates.number }).from(certificates)
      .where(and(
        eq(certificates.enrollmentId, enrollmentId),
        attemptId ? eq(certificates.attemptId, attemptId) : sql`${certificates.attemptId} is null`,
        sql`${certificates.revokedAt} is null`,
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
        .where(and(eq(certificates.enrollmentId, enrollmentId), sql`${certificates.revokedAt} is null`)).orderBy(desc(certificates.issuedAt))
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

/**
 * Список виданих сертифікатів (мокап Certificates, докс/33 D-065): пошук за ПІБ/номером,
 * фільтр за курсом і станом — під клікабельний рядок таблиці шаблонів і саму витрину відкликання.
 */
export async function listCertificates(ctx: Ctx, filters: { courseId?: string, status?: 'active' | 'revoked', q?: string } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({
      id: certificates.id,
      number: certificates.number,
      userId: certificates.userId,
      fullName: users.fullName,
      score: certificates.score,
      issuedAt: certificates.issuedAt,
      validUntil: certificates.validUntil,
      revokedAt: certificates.revokedAt,
      revokeReason: certificates.revokeReason,
      courseId: certificates.courseId,
      courseTitle: courses.title,
    })
      .from(certificates)
      .leftJoin(courses, eq(courses.id, certificates.courseId))
      .innerJoin(users, eq(users.id, certificates.userId))
      .where(and(
        filters.courseId ? eq(certificates.courseId, filters.courseId) : undefined,
        filters.status === 'active' ? sql`${certificates.revokedAt} is null` : undefined,
        filters.status === 'revoked' ? sql`${certificates.revokedAt} is not null` : undefined,
        filters.q ? sql`(${users.fullName} ilike ${`%${filters.q}%`} or ${certificates.number} ilike ${`%${filters.q}%`})` : undefined,
      ))
      .orderBy(desc(certificates.issuedAt))
      .limit(200)
  })
}

/**
 * Экран «Сертифікати» (мокап Certificates, docs/24 §3.7 «шаблоны сертификатов — точки входа»): строка на курс —
 * выдано, действующих, отозвано, срок действия (из выданных), последняя выдача. Шаблон один (PDF), своих шаблонов ТЗ не задаёт.
 */
export async function certificatesSummary(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.execute(sql`
      select c.course_id, co.title, co.status as course_status,
        count(*)::int as issued,
        count(*) filter (where c.revoked_at is null and (c.valid_until is null or c.valid_until > now()))::int as active,
        count(*) filter (where c.revoked_at is not null)::int as revoked,
        max(c.issued_at) as last_issued_at,
        mode() within group (order by case when c.valid_until is null then null else round(extract(epoch from (c.valid_until - c.issued_at)) / 86400 / 30) end) as validity_months
      from certificates c left join courses co on co.id = c.course_id
      group by c.course_id, co.title, co.status
      order by max(c.issued_at) desc
    `) as unknown as { course_id: string | null, title: string | null, course_status: string | null, issued: number, active: number, revoked: number, last_issued_at: string, validity_months: number | null }[]
    return rows.map(r => ({ courseId: r.course_id, title: r.title, published: r.course_status === 'published', format: 'pdf', issued: r.issued, active: r.active, revoked: r.revoked, lastIssuedAt: new Date(r.last_issued_at).toISOString(), validityMonths: r.validity_months == null ? null : Number(r.validity_months) }))
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
