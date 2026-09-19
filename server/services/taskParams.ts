import { and, desc, eq } from 'drizzle-orm'
import { assignments, enrollments, lessons, tenants } from '../db/schema'
import type { TenantTx } from '../utils/withTenant'
import { resolveAudience } from './audience'
import { DEFAULT_QUIZ_PARAMS } from '../../shared/domain/grading'
import type { QuizParams } from '../../shared/domain/grading'
import type { Audience } from '../../shared/schemas/assignments'
import type { ContentType } from '../../shared/enums'

/**
 * Откуда берутся правила прохождения (CLAUDE.md п. 11, docs/15 §14.3): только из назначения.
 * Контент правил не хранит. Порядок поиска:
 *   1. запись (enrollment) → её назначение → params; порог теста в плане курса
 *      (lessons.pass_score_pct) перекрывает порог назначения только для этого элемента;
 *   2. активное назначение этого контента, в аудиторию которого входит человек (новейшее);
 *   3. значения по умолчанию тенанта (tenants.settings.learning.quizDefaults) поверх системных.
 * Результат копируется в attempts.params при старте и дальше не меняется.
 */
export interface ParamsSource { assignmentId: string | null, source: 'enrollment' | 'assignment' | 'tenant_default' }

export async function tenantQuizDefaults(tx: TenantTx, tenantId: string): Promise<QuizParams> {
  const [t] = await tx.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId))
  const s = (t?.settings ?? {}) as { learning?: { quizDefaults?: Partial<QuizParams> } }
  return { ...DEFAULT_QUIZ_PARAMS, ...(s.learning?.quizDefaults ?? {}) }
}

/** Новейшее активное назначение контента, в аудиторию которого входит человек. */
export async function findAssignmentFor(tx: TenantTx, contentType: ContentType, contentId: string, userId: string) {
  const rows = await tx.select({ id: assignments.id, params: assignments.params, audience: assignments.audience, exclude: assignments.exclude })
    .from(assignments)
    .where(and(eq(assignments.subjectType, contentType), eq(assignments.subjectId, contentId), eq(assignments.status, 'active')))
    .orderBy(desc(assignments.createdAt))
  for (const a of rows) {
    const set = await resolveAudience(tx, a.audience as Audience, a.exclude as Audience)
    if (set.has(userId)) return a
  }
  return null
}

export async function resolveQuizParams(
  tx: TenantTx,
  input: { tenantId: string, userId: string, quizId: string, enrollmentId?: string | null, lessonId?: string | null },
): Promise<{ params: QuizParams } & ParamsSource> {
  const defaults = await tenantQuizDefaults(tx, input.tenantId)

  if (input.enrollmentId) {
    const [e] = await tx.select({ assignmentId: enrollments.assignmentId }).from(enrollments).where(eq(enrollments.id, input.enrollmentId))
    let params: QuizParams = { ...defaults }
    let assignmentId: string | null = null
    if (e?.assignmentId) {
      const [a] = await tx.select({ params: assignments.params }).from(assignments).where(eq(assignments.id, e.assignmentId))
      if (a) { params = { ...params, ...(a.params as Partial<QuizParams>) }; assignmentId = e.assignmentId }
    }
    if (input.lessonId) {
      const [l] = await tx.select({ passScorePct: lessons.passScorePct }).from(lessons).where(eq(lessons.id, input.lessonId))
      if (l?.passScorePct != null) params.passScore = Number(l.passScorePct)
    }
    return { params, assignmentId, source: assignmentId ? 'enrollment' : 'tenant_default' }
  }

  const a = await findAssignmentFor(tx, 'test', input.quizId, input.userId)
  if (a) return { params: { ...defaults, ...(a.params as Partial<QuizParams>) }, assignmentId: a.id, source: 'assignment' }
  return { params: defaults, assignmentId: null, source: 'tenant_default' }
}

/** Комплексный тест: те же правила поиска, без урока. */
export async function resolveComplexParams(tx: TenantTx, input: { tenantId: string, userId: string, complexTestId: string }) {
  const defaults = await tenantQuizDefaults(tx, input.tenantId)
  const a = await findAssignmentFor(tx, 'complex_test', input.complexTestId, input.userId)
  if (a) return { params: { ...defaults, ...(a.params as Partial<QuizParams>) }, assignmentId: a.id, source: 'assignment' as const }
  return { params: defaults, assignmentId: null, source: 'tenant_default' as const }
}
