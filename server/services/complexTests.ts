import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { attempts, complexTestAttempts, complexTests, quizzes, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'
import { startAttempt } from './attempts'
import { resolveComplexParams } from './taskParams'
import type { QuizParams } from '../../shared/domain/grading'

interface Ctx { tenantId: string, actorId: string }

export interface Part { quizId: string, weight: number, isRequired?: boolean, minScore?: number | null }
export interface PartState { quizId: string, attemptId: string | null, score: number | null, status: 'pending' | 'in_progress' | 'passed' | 'failed' | 'review' }

/** Список комплексних тестів (docs/31 `ContentComplexTests`): «Автор» — join на users по created_by (screens-7). */
export async function listComplexTests(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select({
      id: complexTests.id, createdAt: complexTests.createdAt, updatedAt: complexTests.updatedAt, tenantId: complexTests.tenantId,
      title: complexTests.title, parts: complexTests.parts, sequential: complexTests.sequential, showPartsResult: complexTests.showPartsResult,
      isActive: complexTests.isActive, createdBy: complexTests.createdBy, authorName: users.fullName,
    }).from(complexTests).leftJoin(users, eq(users.id, complexTests.createdBy)).orderBy(desc(complexTests.createdAt))
    const quizIds = [...new Set(rows.flatMap(r => (r.parts as Part[]).map(p => p.quizId)))]
    const qs = quizIds.length ? await tx.select({ id: quizzes.id, title: quizzes.title }).from(quizzes).where(inArray(quizzes.id, quizIds)) : []
    const qn = new Map(qs.map(q => [q.id, q.title]))
    return rows.map(r => ({ ...r, parts: (r.parts as Part[]).map(p => ({ ...p, title: qn.get(p.quizId) ?? '?' })) }))
  })
}

/** Карточка комплексного теста — только состав (docs/12 §14.2); порог, лимит, попытки — в назначении. */
export async function upsertComplexTest(ctx: Ctx, input: { id?: string, title: string, parts: Part[], sequential?: boolean, showPartsResult?: boolean, isActive?: boolean }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const values = { title: input.title, parts: input.parts, sequential: input.sequential ?? true, showPartsResult: input.showPartsResult ?? true, isActive: input.isActive ?? true }
    if (input.id) {
      const [before] = await tx.select({ parts: complexTests.parts }).from(complexTests).where(eq(complexTests.id, input.id))
      const [r] = await tx.update(complexTests).set({ ...values, updatedAt: new Date() }).where(eq(complexTests.id, input.id)).returning()
      // D-019: изменился состав частей → баннер «N завдань змінено» у назначений (docs/15 §14.6)
      if (r && before && JSON.stringify(before.parts) !== JSON.stringify(r.parts)) {
        const { markContentChanged } = await import('./tasks')
        await markContentChanged(tx, 'complex_test', input.id)
      }
      return r ?? null
    }
    const [r] = await tx.insert(complexTests).values({ tenantId: ctx.tenantId, createdBy: ctx.actorId, ...values }).returning()
    return r!
  })
}

/** Стартовый экран (docs/18 §5.5): части, лимит, проходной, попытки. */
export async function complexIntro(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [ct] = await tx.select().from(complexTests).where(and(eq(complexTests.id, id), eq(complexTests.isActive, true)))
    if (!ct) return null
    const parts = ct.parts as Part[]
    const qs = await tx.select({ id: quizzes.id, title: quizzes.title }).from(quizzes).where(inArray(quizzes.id, parts.map(p => p.quizId)))
    const mine = await tx.select().from(complexTestAttempts).where(and(eq(complexTestAttempts.complexTestId, id), eq(complexTestAttempts.userId, ctx.actorId))).orderBy(desc(complexTestAttempts.attemptNo))
    const active = mine.find(a => a.status === 'in_progress') ?? null
    const { params, source: paramsSource } = await resolveComplexParams(tx, { tenantId: ctx.tenantId, userId: ctx.actorId, complexTestId: id })
    return {
      id: ct.id, title: ct.title, passScore: params.passScore, timeLimitSec: params.timeLimitSec, sequential: ct.sequential, attemptsAllowed: params.attemptsAllowed, showPartsResult: ct.showPartsResult, paramsSource,
      parts: parts.map((p, i) => ({ index: i + 1, quizId: p.quizId, title: qs.find(q => q.id === p.quizId)?.title ?? '?', weight: p.weight, minScore: p.minScore ?? null })),
      attemptsUsed: mine.filter(a => a.status !== 'in_progress').length, active: active ? { id: active.id, expiresAt: active.expiresAt, partsState: active.partsState } : null,
      last: mine.find(a => a.status !== 'in_progress') ?? null,
    }
  })
}

export type StartComplexResult = { ok: true, attemptId: string, partsState: PartState[], expiresAt: Date | null } | { ok: false, code: 'not_found' | 'attempts_exhausted' | 'in_progress', attemptId?: string }

export async function startComplex(ctx: Ctx, id: string): Promise<StartComplexResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [ct] = await tx.select().from(complexTests).where(and(eq(complexTests.id, id), eq(complexTests.isActive, true)))
    if (!ct) return { ok: false as const, code: 'not_found' as const }
    const prior = await tx.select().from(complexTestAttempts).where(and(eq(complexTestAttempts.complexTestId, id), eq(complexTestAttempts.userId, ctx.actorId)))
    const active = prior.find(a => a.status === 'in_progress')
    if (active) return { ok: false as const, code: 'in_progress' as const, attemptId: active.id }
    const { params, assignmentId } = await resolveComplexParams(tx, { tenantId: ctx.tenantId, userId: ctx.actorId, complexTestId: id })
    if (params.attemptsAllowed > 0 && prior.length >= params.attemptsAllowed) return { ok: false as const, code: 'attempts_exhausted' as const }
    const partsState: PartState[] = (ct.parts as Part[]).map(p => ({ quizId: p.quizId, attemptId: null, score: null, status: 'pending' }))
    const expiresAt = params.timeLimitSec ? new Date(Date.now() + params.timeLimitSec * 1000) : null
    const [a] = await tx.insert(complexTestAttempts).values({ tenantId: ctx.tenantId, complexTestId: id, userId: ctx.actorId, attemptNo: prior.length + 1, partsState, expiresAt, assignmentId, params }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'complex.start', entity: 'complex_test_attempt', entityId: a!.id })
    return { ok: true as const, attemptId: a!.id, partsState, expiresAt }
  })
}

export type StartPartResult = { ok: true, attemptId: string, quizId: string } | { ok: false, code: 'not_found' | 'expired' | 'locked' | 'done' | 'quiz_error', detail?: string }

/** Старт части: при sequential — только следующая по порядку; попытка теста создаётся через attempts.startAttempt. */
export async function startPart(ctx: Ctx, complexAttemptId: string, quizId: string): Promise<StartPartResult> {
  const state = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [a] = await tx.select().from(complexTestAttempts).where(and(eq(complexTestAttempts.id, complexAttemptId), eq(complexTestAttempts.userId, ctx.actorId), eq(complexTestAttempts.status, 'in_progress')))
    if (!a) return { ok: false as const, code: 'not_found' as const }
    if (a.expiresAt && a.expiresAt.getTime() < Date.now()) { await finalize(ctx, a.id, 'expired'); return { ok: false as const, code: 'expired' as const } }
    const [ct] = await tx.select().from(complexTests).where(eq(complexTests.id, a.complexTestId))
    const ps = a.partsState as PartState[]
    const idx = ps.findIndex(p => p.quizId === quizId)
    if (idx < 0) return { ok: false as const, code: 'not_found' as const }
    if (ps[idx]!.status !== 'pending' && ps[idx]!.status !== 'in_progress') return { ok: false as const, code: 'done' as const }
    if (ct!.sequential && ps.slice(0, idx).some(p => p.status === 'pending' || p.status === 'in_progress')) return { ok: false as const, code: 'locked' as const }
    if (ps[idx]!.attemptId) return { ok: true as const, attemptId: ps[idx]!.attemptId!, quizId, existing: true }
    return { ok: true as const, attemptId: null, quizId, existing: false, a }
  })
  if (!state.ok) return state
  if (state.existing) return { ok: true, attemptId: state.attemptId!, quizId }
  const r = await startAttempt(ctx, quizId, { device: 'complex' })
  const attemptId = r.ok ? r.attemptId : r.code === 'in_progress' && r.attemptId ? r.attemptId : null
  if (!attemptId) return { ok: false, code: 'quiz_error', detail: r.ok ? undefined : r.code }
  await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [a] = await tx.select().from(complexTestAttempts).where(eq(complexTestAttempts.id, complexAttemptId))
    const ps = (a!.partsState as PartState[]).map(p => p.quizId === quizId ? { ...p, attemptId, status: 'in_progress' as const } : p)
    await tx.update(complexTestAttempts).set({ partsState: ps, updatedAt: new Date() }).where(eq(complexTestAttempts.id, complexAttemptId))
  })
  return { ok: true, attemptId, quizId }
}

/** Синхронизация состояния частей по попыткам тестов; когда все части закрыты — подсчёт (docs/18 §7.8). */
export async function syncComplex(ctx: Ctx, complexAttemptId: string) {
  let finished: { complexTestId: string, userId: string, passed: boolean, score: number } | null = null
  const res = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [a] = await tx.select().from(complexTestAttempts).where(and(eq(complexTestAttempts.id, complexAttemptId), eq(complexTestAttempts.userId, ctx.actorId)))
    if (!a) return null
    const [ct] = await tx.select().from(complexTests).where(eq(complexTests.id, a.complexTestId))
    const parts = ct!.parts as Part[]
    const passScore = (a.params as Partial<QuizParams>).passScore ?? 80 // копия параметров попытки, не назначения
    let ps = a.partsState as PartState[]
    const ids = ps.map(p => p.attemptId).filter((x): x is string => !!x)
    const rows = ids.length ? await tx.select({ id: attempts.id, status: attempts.status, score: attempts.score }).from(attempts).where(inArray(attempts.id, ids)) : []
    ps = ps.map((p) => {
      const q = rows.find(r => r.id === p.attemptId)
      if (!q) return p
      const part = parts.find(x => x.quizId === p.quizId)!
      if (q.status === 'passed' || q.status === 'failed') {
        const score = Number(q.score ?? 0)
        const minOk = part.minScore == null || score >= part.minScore
        return { ...p, score, status: q.status === 'passed' && minOk ? 'passed' : 'failed' }
      }
      if (q.status === 'review' || q.status === 'submitted') return { ...p, status: 'review', score: q.score != null ? Number(q.score) : null }
      if (q.status === 'expired' || q.status === 'annulled') return { ...p, status: 'failed', score: 0 }
      return { ...p, status: 'in_progress' }
    })
    const expired = a.status === 'in_progress' && a.expiresAt && a.expiresAt.getTime() < Date.now()
    const allDone = ps.every(p => p.status === 'passed' || p.status === 'failed')
    let status = a.status
    let score: number | null = a.score != null ? Number(a.score) : null
    let passed: boolean | null = a.passed
    if (a.status === 'in_progress' && (allDone || expired)) {
      // Σ(балл части × вес) / Σ(вес); незавершённые части при истечении — 0
      let num = 0, den = 0
      let minFail = false
      for (const p of ps) {
        const part = parts.find(x => x.quizId === p.quizId)!
        const s = p.score ?? 0
        num += s * part.weight; den += part.weight
        if (part.minScore != null && s < part.minScore) minFail = true
      }
      score = den ? Math.round((num / den) * 100) / 100 : 0
      passed = !minFail && score >= passScore
      status = expired && !allDone ? 'expired' : passed ? 'passed' : 'failed'
      await tx.update(complexTestAttempts).set({ partsState: ps, status, score: String(score), passed, finishedAt: new Date(), updatedAt: new Date() }).where(eq(complexTestAttempts.id, a.id))
      // docs/33 D-020: комплексний тест завершено — єдиний хук (passed → done, інакше failed)
      const { onTaskCompleted } = await import('./taskCompletion')
      await onTaskCompleted(tx, ctx.tenantId, a.userId, { contentType: 'complex_test', contentId: a.complexTestId, status: passed ? 'done' : 'failed', result: score, assignmentId: a.assignmentId, sourceKind: 'complex_attempt', sourceId: a.id })
      finished = { complexTestId: a.complexTestId, userId: a.userId, passed: !!passed, score }
    }
    else if (JSON.stringify(ps) !== JSON.stringify(a.partsState)) {
      await tx.update(complexTestAttempts).set({ partsState: ps, updatedAt: new Date() }).where(eq(complexTestAttempts.id, a.id))
    }
    return { id: a.id, status, score, passed, partsState: ps, expiresAt: a.expiresAt, showPartsResult: ct!.showPartsResult, passScore, parts: parts.map(p => ({ quizId: p.quizId, weight: p.weight, minScore: p.minScore ?? null })) }
  })
  // Узел траектории «Завдання» с комплексным тестом: тот же хук результата, что у теста, — после
  // фиксации итога (раньше итог писал только журнал, и узел не засчитывался никогда)
  const done = finished as { complexTestId: string, userId: string, passed: boolean, score: number } | null
  if (done) {
    await import('./trajectories').then(t => t.onTaskResult(ctx.tenantId, done.userId, 'complex_test', done.complexTestId, { passed: done.passed, score: done.score }))
      .catch(err => console.error('trajectory complex_test hook', err))
  }
  return res
}

async function finalize(ctx: Ctx, id: string, status: 'expired') {
  await withTenant(ctx.tenantId, ctx.actorId, tx => tx.update(complexTestAttempts).set({ status, finishedAt: new Date(), passed: false, updatedAt: new Date() }).where(eq(complexTestAttempts.id, id)))
}

export async function complexReport(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.execute(sql`
      select ct.title, q.title as part, count(*)::int as attempts,
             round(avg((p->>'score')::numeric), 1) as avg_score,
             sum(case when p->>'status' = 'failed' then 1 else 0 end)::int as failed
      from complex_test_attempts a join complex_tests ct on ct.id = a.complex_test_id
      cross join jsonb_array_elements(a.parts_state) p join quizzes q on q.id = (p->>'quizId')::uuid
      where a.status in ('passed','failed','expired') group by 1, 2 order by failed desc, 1
    `) as unknown as Promise<Record<string, unknown>[]>
  })
}

