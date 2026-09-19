import { createHash } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import { surveyResponses, surveys } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'

interface Ctx { tenantId: string, actorId: string }

export interface SurveyQuestion {
  id: string
  type: 'scale' | 'yesno' | 'choice' | 'text'
  text: string
  options?: string[]
  required?: boolean
}

const ANON_THRESHOLD = 5 // docs/03 §3.8: меньше — данные не показываются

export async function listSurveys(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({
      id: surveys.id, title: surveys.title, kind: surveys.kind, status: surveys.status, isAnonymous: surveys.isAnonymous,
      opensAt: surveys.opensAt, closesAt: surveys.closesAt, triggerCourseId: surveys.triggerCourseId, createdAt: surveys.createdAt,
      responses: sql<number>`(select count(*)::int from ${surveyResponses} r where r.survey_id = ${surveys.id})`,
    }).from(surveys).orderBy(desc(surveys.createdAt))
  })
}

export async function createSurvey(ctx: Ctx, input: { title: string, description?: string, kind: string, questions: SurveyQuestion[], isAnonymous: boolean, opensAt?: string | null, closesAt?: string | null, triggerCourseId?: string | null }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [s] = await tx.insert(surveys).values({
      tenantId: ctx.tenantId,
      title: input.title,
      description: input.description ?? null,
      kind: input.kind,
      questions: input.questions,
      isAnonymous: input.isAnonymous,
      opensAt: input.opensAt ? new Date(input.opensAt) : null,
      closesAt: input.closesAt ? new Date(input.closesAt) : null,
      triggerCourseId: input.triggerCourseId ?? null,
      createdBy: ctx.actorId,
    }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'survey.create', entity: 'survey', entityId: s!.id, after: { title: input.title } })
    return s!
  })
}

export async function updateSurvey(ctx: Ctx, id: string, input: Partial<{ title: string, description: string, questions: SurveyQuestion[], isAnonymous: boolean, status: string, opensAt: string | null, closesAt: string | null, triggerCourseId: string | null }>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [s] = await tx.update(surveys).set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.questions !== undefined ? { questions: input.questions } : {}),
      ...(input.isAnonymous !== undefined ? { isAnonymous: input.isAnonymous } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.opensAt !== undefined ? { opensAt: input.opensAt ? new Date(input.opensAt) : null } : {}),
      ...(input.closesAt !== undefined ? { closesAt: input.closesAt ? new Date(input.closesAt) : null } : {}),
      ...(input.triggerCourseId !== undefined ? { triggerCourseId: input.triggerCourseId } : {}),
      updatedAt: new Date(),
    }).where(eq(surveys.id, id)).returning()
    return s ?? null
  })
}

/** Опросы, доступные человеку сейчас: активные в окне, ещё не отвеченные. */
export async function mySurveys(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const hash = respondentHash(ctx.tenantId, ctx.actorId)
    return tx.select({ id: surveys.id, title: surveys.title, description: surveys.description, kind: surveys.kind, isAnonymous: surveys.isAnonymous, closesAt: surveys.closesAt, questions: surveys.questions })
      .from(surveys)
      .where(and(
        eq(surveys.status, 'active'),
        sql`(${surveys.opensAt} is null or ${surveys.opensAt} <= now())`,
        sql`(${surveys.closesAt} is null or ${surveys.closesAt} > now())`,
        sql`not exists (select 1 from ${surveyResponses} r where r.survey_id = ${surveys.id} and r.respondent_hash = ${hash})`,
      ))
      .orderBy(desc(surveys.createdAt))
  })
}

/** Хеш для дедупа анонимных ответов: не хранит user_id, но не даёт ответить дважды. */
function respondentHash(tenantId: string, userId: string) {
  return createHash('sha256').update(`${process.env.SESSION_SECRET ?? ''}:${tenantId}:${userId}`).digest('hex')
}

export type RespondResult = { ok: true } | { ok: false, code: 'not_found' | 'closed' | 'already' | 'incomplete', missing?: string[] }

export async function respond(ctx: Ctx, surveyId: string, answers: Record<string, unknown>, enrollmentId?: string): Promise<RespondResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [s] = await tx.select().from(surveys).where(eq(surveys.id, surveyId))
    if (!s) return { ok: false as const, code: 'not_found' as const }
    if (s.status !== 'active' || (s.closesAt && s.closesAt < new Date())) return { ok: false as const, code: 'closed' as const }

    const qs = s.questions as SurveyQuestion[]
    const missing = qs.filter(q => q.required !== false && (answers[q.id] === undefined || answers[q.id] === '')).map(q => q.id)
    if (missing.length) return { ok: false as const, code: 'incomplete' as const, missing }

    const [r] = await tx.insert(surveyResponses).values({
      tenantId: ctx.tenantId,
      surveyId,
      userId: s.isAnonymous ? null : ctx.actorId,
      respondentHash: respondentHash(ctx.tenantId, ctx.actorId),
      enrollmentId: enrollmentId ?? null,
      answers,
    }).onConflictDoNothing().returning({ id: surveyResponses.id })
    if (!r) return { ok: false as const, code: 'already' as const }
    return { ok: true as const }
  })
}

/** Сводка: распределения, средние; анонимные — порог 5 ответов (docs/03 §3.8). */
export async function surveyReport(ctx: Ctx, surveyId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [s] = await tx.select().from(surveys).where(eq(surveys.id, surveyId))
    if (!s) return null
    const rows = await tx.select({ answers: surveyResponses.answers, userId: surveyResponses.userId, submittedAt: surveyResponses.submittedAt }).from(surveyResponses).where(eq(surveyResponses.surveyId, surveyId))
    const total = rows.length
    if (s.isAnonymous && total < ANON_THRESHOLD) {
      return { id: s.id, title: s.title, total, hidden: true as const, threshold: ANON_THRESHOLD, questions: [] }
    }
    const qs = s.questions as SurveyQuestion[]
    const questions = qs.map((q) => {
      const vals = rows.map(r => (r.answers as Record<string, unknown>)[q.id]).filter(v => v !== undefined && v !== '')
      if (q.type === 'scale') {
        const nums = vals.map(Number).filter(n => !Number.isNaN(n))
        const dist: Record<string, number> = {}
        for (const n of nums) dist[String(n)] = (dist[String(n)] ?? 0) + 1
        return { id: q.id, text: q.text, type: q.type, answered: nums.length, avg: nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length * 100) / 100 : null, distribution: dist }
      }
      if (q.type === 'yesno' || q.type === 'choice') {
        const dist: Record<string, number> = {}
        for (const v of vals) dist[String(v)] = (dist[String(v)] ?? 0) + 1
        return { id: q.id, text: q.text, type: q.type, answered: vals.length, distribution: dist }
      }
      return { id: q.id, text: q.text, type: q.type, answered: vals.length, texts: s.isAnonymous ? vals.map(String) : vals.map(String) }
    })
    return { id: s.id, title: s.title, total, hidden: false as const, questions }
  })
}

/** Автозапуск после курса (docs/03 §3.8): опрос kind=course_feedback с trigger_course_id. */
export async function triggerCourseFeedback(tenantId: string, userId: string, courseId: string, enrollmentId: string) {
  await withTenant(tenantId, userId, async (tx) => {
    const list = await tx.select({ id: surveys.id, title: surveys.title }).from(surveys)
      .where(and(eq(surveys.status, 'active'), eq(surveys.kind, 'course_feedback'), eq(surveys.triggerCourseId, courseId)))
    for (const s of list) {
      await enqueueNotification(tx, { tenantId, userId, code: 'survey_invite', payload: { survey: s.title, surveyId: s.id, enrollmentId }, dedupKey: `survey:${s.id}:${enrollmentId}` })
    }
  })
}
