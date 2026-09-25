import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { interviewCriteria, interviewScenarios, questions, quizQuestions, quizzes } from '../../db/schema'
import { withTenant, type TenantTx } from '../../utils/withTenant'
import { keysetAfter, keysetAt } from '../../utils/keyset'
import { KEYSETS, encodeKeyset } from '../../../shared/domain/keyset'
import type {
  InterviewCriterionInput, InterviewCriterionUpdate, InterviewScenarioCreate, InterviewScenarioListQuery, InterviewScenarioUpdate,
} from '../../../shared/schemas/interview'
import type { InterviewAlternativePath, InterviewAnswerMode, InterviewScenarioStatus } from '../../../shared/enums'
import { recordAudit } from '../audit'

/**
 * Сценарий собеседования и его критерии (`docs/v2/30-ai-interview.md` §3.3, §5.6, §6.1–§6.2,
 * §7.5, §10; план `45` PR-28). Скоуп — `interview.configure` (HR/админ, `30` §2).
 *
 * Правила, которые держит этот файл:
 * - сценарий — только для теста вида `interview` (`44` В-12): `422 scenario.quiz_not_interview`;
 * - опубликовать без альтернативы нельзя: `422 scenario.alternative_required`, статус остаётся
 *   `draft` (`30` §7.5, §13 к. 3) — и тот же запрет держит CHECK таблицы мимо сервиса;
 * - без критериев — `422 criteria.required`; вопросы сценария — только развёрнутые ответы
 *   фиксированным списком (`30` §3.1: голос — способ ответа на вопрос `text_long`);
 * - опубликованный сценарий на месте не правится: правка создаёт версию-черновик с копией
 *   критериев, публикация архивирует прежнюю — идущие сессии держат свою версию (`30` §12 п. 9).
 */

interface Ctx { tenantId: string, actorId: string }

export interface CriterionView {
  id: string
  code: string
  name: string
  description: string
  weight: number
  scaleMax: number
  isCritical: boolean
  sort: number
  source: string
}

export interface ScenarioView {
  id: string
  quizId: string
  quizTitle: string | null
  name: string
  interviewerName: string
  introText: string
  outroText: string
  answerModes: InterviewAnswerMode[]
  minAnswerSec: number
  maxAnswerSec: number
  thinkTimeSec: number
  silenceTimeoutSec: number
  retakeLimit: number
  recordVideo: boolean
  transcribeLang: string
  minConfidence: number
  alternativePath: InterviewAlternativePath | null
  status: InterviewScenarioStatus
  version: number
  publishedAt: string | null
  createdAt: string
  updatedAt: string
  criteria: CriterionView[]
}

export interface ScenarioListRow {
  id: string
  quizId: string
  quizTitle: string | null
  name: string
  status: InterviewScenarioStatus
  version: number
  alternativePath: InterviewAlternativePath | null
  criteriaCount: number
  sessionsCount: number
  /** Доля сессий `needs_human` среди завершённых — сигнал, что сценарий или провайдер плох (`30` §5.6). */
  needsHumanShare: number | null
  updatedAt: string
}

export type ScenarioError
  = | 'not_found' | 'quiz_not_found' | 'quiz_not_interview' | 'alternative_required' | 'criteria_required'
    | 'questions_invalid' | 'archived' | 'published' | 'time_invalid'

type Row = typeof interviewScenarios.$inferSelect

function criterionView(c: typeof interviewCriteria.$inferSelect): CriterionView {
  return {
    id: c.id, code: c.code, name: c.nameUk, description: c.description, weight: Number(c.weight), scaleMax: Number(c.scaleMax),
    isCritical: c.isCritical, sort: c.sort, source: c.source,
  }
}

async function viewOf(tx: TenantTx, row: Row): Promise<ScenarioView> {
  const [quiz] = await tx.select({ title: quizzes.title }).from(quizzes).where(eq(quizzes.id, row.quizId))
  const criteria = await tx.select().from(interviewCriteria)
    .where(eq(interviewCriteria.scenarioId, row.id))
    .orderBy(asc(interviewCriteria.sort), asc(interviewCriteria.createdAt))
  return {
    id: row.id,
    quizId: row.quizId,
    quizTitle: quiz?.title ?? null,
    name: row.name,
    interviewerName: row.interviewerName,
    introText: row.introText,
    outroText: row.outroText,
    answerModes: row.answerModes as InterviewAnswerMode[],
    minAnswerSec: row.minAnswerSec,
    maxAnswerSec: row.maxAnswerSec,
    thinkTimeSec: row.thinkTimeSec,
    silenceTimeoutSec: row.silenceTimeoutSec,
    retakeLimit: row.retakeLimit,
    recordVideo: row.recordVideo,
    transcribeLang: row.transcribeLang,
    minConfidence: Number(row.minConfidence),
    alternativePath: row.alternativePath as InterviewAlternativePath | null,
    status: row.status as InterviewScenarioStatus,
    version: row.version,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    criteria: criteria.map(criterionView),
  }
}

// ── Список (`30` §5.6) ──────────────────────────────────────────────────────────────────

export async function listScenarios(ctx: Ctx, q: InterviewScenarioListQuery): Promise<{ items: ScenarioListRow[], nextCursor: string | null }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const conds = [
      q.status ? eq(interviewScenarios.status, q.status) : undefined,
      q.quizId ? eq(interviewScenarios.quizId, q.quizId) : undefined,
    ]
    const rows = await tx.select({
      id: interviewScenarios.id,
      quizId: interviewScenarios.quizId,
      quizTitle: quizzes.title,
      name: interviewScenarios.name,
      status: interviewScenarios.status,
      version: interviewScenarios.version,
      alternativePath: interviewScenarios.alternativePath,
      updatedAt: interviewScenarios.updatedAt,
      cursorAt: keysetAt(interviewScenarios.updatedAt),
      criteriaCount: sql<number>`(select count(*)::int from interview_criteria c where c.scenario_id = ${interviewScenarios.id})`,
      sessionsCount: sql<number>`(select count(*)::int from interview_sessions s where s.scenario_id = ${interviewScenarios.id})`,
      needsHuman: sql<number>`(select count(*)::int from interview_sessions s where s.scenario_id = ${interviewScenarios.id} and s.state = 'needs_human')`,
      finished: sql<number>`(select count(*)::int from interview_sessions s where s.scenario_id = ${interviewScenarios.id} and s.state in ('scored', 'needs_human'))`,
    }).from(interviewScenarios)
      .leftJoin(quizzes, eq(quizzes.id, interviewScenarios.quizId))
      .where(and(...conds, keysetAfter(KEYSETS.interviewScenarios, q.cursor, [interviewScenarios.updatedAt, interviewScenarios.id], 'desc')))
      .orderBy(desc(interviewScenarios.updatedAt), desc(interviewScenarios.id))
      .limit(q.limit + 1)
    const page = rows.slice(0, q.limit)
    const last = rows.length > q.limit ? page[page.length - 1] : undefined
    return {
      items: page.map(r => ({
        id: r.id, quizId: r.quizId, quizTitle: r.quizTitle, name: r.name, status: r.status as InterviewScenarioStatus,
        version: r.version, alternativePath: r.alternativePath as InterviewAlternativePath | null,
        criteriaCount: Number(r.criteriaCount), sessionsCount: Number(r.sessionsCount),
        needsHumanShare: Number(r.finished) ? Math.round((Number(r.needsHuman) / Number(r.finished)) * 1000) / 1000 : null,
        updatedAt: r.updatedAt.toISOString(),
      })),
      nextCursor: last ? encodeKeyset(KEYSETS.interviewScenarios, [last.cursorAt, last.id]) : null,
    }
  })
}

export async function getScenario(ctx: Ctx, id: string): Promise<ScenarioView | null> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await tx.select().from(interviewScenarios).where(eq(interviewScenarios.id, id))
    return row ? viewOf(tx, row) : null
  })
}

// ── Создание и правка (форма §6.1) ──────────────────────────────────────────────────────

export type ScenarioResult
  = | { ok: true, scenario: ScenarioView, versionCreated?: boolean }
    /** `draftId` — новая версия, созданная правкой опубликованного, если опубликовать её не удалось. */
    | { ok: false, code: ScenarioError, draftId?: string }

async function interviewQuiz(tx: TenantTx, quizId: string): Promise<{ ok: true } | { ok: false, code: 'quiz_not_found' | 'quiz_not_interview' }> {
  const [quiz] = await tx.select({ kind: quizzes.kind }).from(quizzes).where(and(eq(quizzes.id, quizId), sql`${quizzes.deletedAt} is null`))
  if (!quiz) return { ok: false, code: 'quiz_not_found' }
  if (quiz.kind !== 'interview') return { ok: false, code: 'quiz_not_interview' }
  return { ok: true }
}

export async function createScenario(ctx: Ctx, input: InterviewScenarioCreate): Promise<ScenarioResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx): Promise<ScenarioResult> => {
    const quiz = await interviewQuiz(tx, input.quizId)
    if (!quiz.ok) return quiz
    const [{ next }] = await tx.select({ next: sql<number>`coalesce(max(${interviewScenarios.version}), 0)::int + 1` })
      .from(interviewScenarios).where(eq(interviewScenarios.quizId, input.quizId)) as [{ next: number }]
    const [row] = await tx.insert(interviewScenarios).values({
      tenantId: ctx.tenantId,
      quizId: input.quizId,
      name: input.name,
      interviewerName: input.interviewerName,
      introText: input.introText,
      outroText: input.outroText,
      answerModes: input.answerModes,
      minAnswerSec: input.minAnswerSec,
      maxAnswerSec: input.maxAnswerSec,
      thinkTimeSec: input.thinkTimeSec,
      silenceTimeoutSec: input.silenceTimeoutSec,
      retakeLimit: input.retakeLimit,
      recordVideo: false,
      transcribeLang: input.transcribeLang,
      minConfidence: String(input.minConfidence),
      alternativePath: input.alternativePath,
      status: 'draft',
      version: Number(next),
      createdBy: ctx.actorId,
    }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'interview.scenario.create', entity: 'interview_scenario', entityId: row!.id, after: { quizId: input.quizId, version: row!.version, name: input.name } })
    return { ok: true, scenario: await viewOf(tx, row!) }
  })
}

/** Поля формы §6.1 — одна таблица для правки черновика и для новой версии опубликованного. */
function fieldsOf(input: InterviewScenarioUpdate): Partial<typeof interviewScenarios.$inferInsert> {
  const out: Partial<typeof interviewScenarios.$inferInsert> = {}
  if (input.name !== undefined) out.name = input.name
  if (input.interviewerName !== undefined) out.interviewerName = input.interviewerName
  if (input.introText !== undefined) out.introText = input.introText
  if (input.outroText !== undefined) out.outroText = input.outroText
  if (input.answerModes !== undefined) out.answerModes = input.answerModes
  if (input.minAnswerSec !== undefined) out.minAnswerSec = input.minAnswerSec
  if (input.maxAnswerSec !== undefined) out.maxAnswerSec = input.maxAnswerSec
  if (input.thinkTimeSec !== undefined) out.thinkTimeSec = input.thinkTimeSec
  if (input.silenceTimeoutSec !== undefined) out.silenceTimeoutSec = input.silenceTimeoutSec
  if (input.retakeLimit !== undefined) out.retakeLimit = input.retakeLimit
  if (input.transcribeLang !== undefined) out.transcribeLang = input.transcribeLang
  if (input.minConfidence !== undefined) out.minConfidence = String(input.minConfidence)
  if (input.alternativePath !== undefined) out.alternativePath = input.alternativePath
  return out
}

/**
 * Проверки публикации (`30` §7.5, §10, §13 к. 3). Порядок — от того, что объясняет больше:
 * сначала альтернатива (без неё отказ кандидата некуда вести), затем критерии, затем вопросы.
 */
async function publishProblem(tx: TenantTx, row: Row): Promise<ScenarioError | null> {
  if (!row.alternativePath) return 'alternative_required'
  const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(interviewCriteria).where(eq(interviewCriteria.scenarioId, row.id)) as [{ n: number }]
  if (!Number(n)) return 'criteria_required'
  const quiz = await interviewQuiz(tx, row.quizId)
  if (!quiz.ok) return quiz.code
  const [q] = await tx.select({ selectionMode: quizzes.selectionMode }).from(quizzes).where(eq(quizzes.id, row.quizId))
  const kinds = await tx.select({ kind: questions.kind }).from(quizQuestions)
    .innerJoin(questions, eq(questions.id, quizQuestions.questionId))
    .where(and(eq(quizQuestions.quizId, row.quizId), eq(questions.status, 'active')))
  if (q?.selectionMode !== 'fixed' || !kinds.length || kinds.some(k => k.kind !== 'free')) return 'questions_invalid'
  if (row.minAnswerSec >= row.maxAnswerSec) return 'time_invalid'
  return null
}

export async function updateScenario(ctx: Ctx, id: string, input: InterviewScenarioUpdate): Promise<ScenarioResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx): Promise<ScenarioResult> => {
    const [row] = await tx.select().from(interviewScenarios).where(eq(interviewScenarios.id, id)).for('update')
    if (!row) return { ok: false, code: 'not_found' }
    if (row.status === 'archived') return { ok: false, code: 'archived' }
    const fields = fieldsOf(input)
    const changes = Object.keys(fields).length > 0

    // Опубликованный: архивировать — можно; правка — новая версия-черновик с копией критериев
    if (row.status === 'published') {
      if (!changes) {
        if (input.status === 'archived') {
          const [archived] = await tx.update(interviewScenarios).set({ status: 'archived', updatedAt: new Date() }).where(eq(interviewScenarios.id, id)).returning()
          await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'interview.scenario.archive', entity: 'interview_scenario', entityId: id, before: { status: 'published' }, after: { status: 'archived' } })
          return { ok: true, scenario: await viewOf(tx, archived!) }
        }
        return { ok: true, scenario: await viewOf(tx, row) }
      }
      const [{ next }] = await tx.select({ next: sql<number>`coalesce(max(${interviewScenarios.version}), 0)::int + 1` })
        .from(interviewScenarios).where(eq(interviewScenarios.quizId, row.quizId)) as [{ next: number }]
      const { id: _id, createdAt: _c, updatedAt: _u, publishedAt: _p, status: _s, version: _v, createdBy: _b, ...rest } = row
      const [draft] = await tx.insert(interviewScenarios).values({ ...rest, ...fields, status: 'draft', version: Number(next), createdBy: ctx.actorId }).returning()
      const criteria = await tx.select().from(interviewCriteria).where(eq(interviewCriteria.scenarioId, id))
      if (criteria.length) {
        await tx.insert(interviewCriteria).values(criteria.map(({ id: _cid, createdAt: _cc, updatedAt: _cu, scenarioId: _sid, ...c }) => ({ ...c, scenarioId: draft!.id })))
      }
      await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'interview.scenario.version', entity: 'interview_scenario', entityId: draft!.id, before: { fromId: id, version: row.version }, after: { version: draft!.version, fields: Object.keys(fields) } })
      if (input.status === 'published') return publish(tx, ctx, draft!, true)
      return { ok: true, scenario: await viewOf(tx, draft!), versionCreated: true }
    }

    // Черновик: правка на месте, затем — смена статуса
    let current = row
    if (changes) {
      const next = { ...row, ...fields } as Row
      if (next.minAnswerSec >= next.maxAnswerSec) return { ok: false, code: 'time_invalid' }
      const [updated] = await tx.update(interviewScenarios).set({ ...fields, updatedAt: new Date() }).where(eq(interviewScenarios.id, id)).returning()
      current = updated!
      await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'interview.scenario.update', entity: 'interview_scenario', entityId: id, after: { fields: Object.keys(fields) } })
    }
    if (input.status === 'published') return publish(tx, ctx, current, false)
    if (input.status === 'archived') {
      const [archived] = await tx.update(interviewScenarios).set({ status: 'archived', updatedAt: new Date() }).where(eq(interviewScenarios.id, id)).returning()
      await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'interview.scenario.archive', entity: 'interview_scenario', entityId: id, before: { status: 'draft' }, after: { status: 'archived' } })
      return { ok: true, scenario: await viewOf(tx, archived!) }
    }
    return { ok: true, scenario: await viewOf(tx, current) }
  })
}

/**
 * Публикация черновика: прежняя опубликованная версия того же теста уходит в архив — новые
 * сессии пойдут по новой версии, идущие доведут свою (`30` §12 п. 9). Отказ публикации не
 * трогает статус: сценарий остаётся `draft` (`30` §13 к. 3).
 */
async function publish(tx: TenantTx, ctx: Ctx, row: Row, versionCreated: boolean): Promise<ScenarioResult> {
  const problem = await publishProblem(tx, row)
  // Новая версия, которую не удалось опубликовать, остаётся черновиком — правка не теряется
  if (problem) return versionCreated ? { ok: false, code: problem, draftId: row.id } : { ok: false, code: problem }
  await tx.update(interviewScenarios).set({ status: 'archived', updatedAt: new Date() })
    .where(and(eq(interviewScenarios.quizId, row.quizId), eq(interviewScenarios.status, 'published')))
  const [published] = await tx.update(interviewScenarios).set({ status: 'published', publishedAt: new Date(), updatedAt: new Date() })
    .where(eq(interviewScenarios.id, row.id)).returning()
  await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'interview.scenario.publish', entity: 'interview_scenario', entityId: row.id, after: { version: row.version, alternativePath: row.alternativePath } })
  return { ok: true, scenario: await viewOf(tx, published!), ...(versionCreated ? { versionCreated } : {}) }
}

// ── Критерии (форма §6.2) ───────────────────────────────────────────────────────────────

export type CriterionResult = { ok: true, criterion: CriterionView } | { ok: false, code: 'not_found' | 'published' | 'archived' }

async function editableScenario(tx: TenantTx, scenarioId: string): Promise<{ ok: true } | { ok: false, code: 'not_found' | 'published' | 'archived' }> {
  const [row] = await tx.select({ status: interviewScenarios.status }).from(interviewScenarios).where(eq(interviewScenarios.id, scenarioId))
  if (!row) return { ok: false, code: 'not_found' }
  // Критерии опубликованной версии держат идущие сессии и их оценки — правка только в новой версии
  if (row.status === 'published') return { ok: false, code: 'published' }
  if (row.status === 'archived') return { ok: false, code: 'archived' }
  return { ok: true }
}

export async function listCriteria(ctx: Ctx, scenarioId: string): Promise<CriterionView[] | null> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await tx.select({ id: interviewScenarios.id }).from(interviewScenarios).where(eq(interviewScenarios.id, scenarioId))
    if (!row) return null
    const rows = await tx.select().from(interviewCriteria).where(eq(interviewCriteria.scenarioId, scenarioId))
      .orderBy(asc(interviewCriteria.sort), asc(interviewCriteria.createdAt))
    return rows.map(criterionView)
  })
}

export async function addCriterion(ctx: Ctx, scenarioId: string, input: InterviewCriterionInput): Promise<CriterionResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx): Promise<CriterionResult> => {
    const editable = await editableScenario(tx, scenarioId)
    if (!editable.ok) return editable
    const existing = await tx.select({ code: interviewCriteria.code, sort: interviewCriteria.sort }).from(interviewCriteria).where(eq(interviewCriteria.scenarioId, scenarioId))
    // Код — служебный и стабильный (`c1`, `c2`…): по нему критерий узнаётся в новой версии сценария
    let n = existing.length + 1
    const codes = new Set(existing.map(e => e.code))
    while (codes.has(`c${n}`)) n++
    const [row] = await tx.insert(interviewCriteria).values({
      tenantId: ctx.tenantId,
      scenarioId,
      code: `c${n}`,
      nameUk: input.name,
      description: input.description,
      weight: String(input.weight),
      scaleMax: String(input.scaleMax),
      isCritical: input.isCritical,
      sort: input.sort ?? (existing.reduce((m, e) => Math.max(m, e.sort), 0) + 1),
      source: 'manual',
    }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'interview.criterion.create', entity: 'interview_criterion', entityId: row!.id, after: { scenarioId, name: input.name } })
    return { ok: true, criterion: criterionView(row!) }
  })
}

export async function updateCriterion(ctx: Ctx, scenarioId: string, criterionId: string, input: InterviewCriterionUpdate): Promise<CriterionResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx): Promise<CriterionResult> => {
    const editable = await editableScenario(tx, scenarioId)
    if (!editable.ok) return editable
    const set: Partial<typeof interviewCriteria.$inferInsert> = { updatedAt: new Date() }
    if (input.name !== undefined) set.nameUk = input.name
    if (input.description !== undefined) set.description = input.description
    if (input.weight !== undefined) set.weight = String(input.weight)
    if (input.scaleMax !== undefined) set.scaleMax = String(input.scaleMax)
    if (input.isCritical !== undefined) set.isCritical = input.isCritical
    if (input.sort !== undefined) set.sort = input.sort
    const [row] = await tx.update(interviewCriteria).set(set)
      .where(and(eq(interviewCriteria.id, criterionId), eq(interviewCriteria.scenarioId, scenarioId))).returning()
    if (!row) return { ok: false, code: 'not_found' }
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'interview.criterion.update', entity: 'interview_criterion', entityId: criterionId, after: { fields: Object.keys(input) } })
    return { ok: true, criterion: criterionView(row) }
  })
}

export async function deleteCriterion(ctx: Ctx, scenarioId: string, criterionId: string): Promise<{ ok: true } | { ok: false, code: 'not_found' | 'published' | 'archived' }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const editable = await editableScenario(tx, scenarioId)
    if (!editable.ok) return editable
    const [row] = await tx.delete(interviewCriteria)
      .where(and(eq(interviewCriteria.id, criterionId), eq(interviewCriteria.scenarioId, scenarioId))).returning({ id: interviewCriteria.id })
    if (!row) return { ok: false as const, code: 'not_found' as const }
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'interview.criterion.delete', entity: 'interview_criterion', entityId: criterionId, after: { scenarioId } })
    return { ok: true as const }
  })
}
