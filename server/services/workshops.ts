import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  lessonProgress, locations, userPlacements, userRoles, roles, users, workshopComments, workshopSubmissions, workshops,
} from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import { sanitizeBody } from './sanitize'
import { enqueueNotification } from './notifications'
import type { ContentBlock } from '../../shared/schemas/content'

interface Ctx { tenantId: string, actorId: string }

export interface Criterion { id: string, text: string, weight: number, isCritical: boolean }

const CLAIM_TTL_MS = 30 * 60_000 // docs/13 §4.2: 30 минут бездействия — карточка возвращается

// ── Управление (методист) ──────────────────────────────────────────────

export async function listWorkshops(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({
      id: workshops.id, title: workshops.title, status: workshops.status, submissionKinds: workshops.submissionKinds,
      slaHours: workshops.slaHours, reviewerRule: workshops.reviewerRule, updatedAt: workshops.updatedAt,
      criteriaCount: sql<number>`jsonb_array_length(${workshops.criteria})`,
      pending: sql<number>`(select count(*)::int from ${workshopSubmissions} s where s.workshop_id = ${workshops.id} and s.status in ('submitted','in_review'))`,
      firstPassPct: sql<number>`(select round(100.0 * count(*) filter (where s.status = 'accepted' and s.rework_count = 0) / nullif(count(*) filter (where s.status in ('accepted','rejected')), 0))::int from ${workshopSubmissions} s where s.workshop_id = ${workshops.id})`,
    }).from(workshops).where(isNull(workshops.deletedAt)).orderBy(desc(workshops.updatedAt))
  })
}

export interface WorkshopInput {
  title: string
  description: ContentBlock[]
  submissionKinds: ('text' | 'photo' | 'file' | 'video')[]
  minTextLength?: number | null
  maxFiles?: number
  maxFileMb?: number
  allowCameraOnly?: boolean
  criteria: { text: string, weight?: number, isCritical?: boolean }[]
  passRule?: { type: 'all_criteria' | 'min_score' | 'manual', minScore?: number }
  reviewerRule?: 'location_mentor' | 'author' | 'specific' | 'any_mentor'
  reviewerIds?: string[]
  allowRework?: boolean
  maxReworks?: number
  slaHours?: number
  status?: 'draft' | 'published' | 'archived'
}

export async function createWorkshop(ctx: Ctx, input: WorkshopInput) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [w] = await tx.insert(workshops).values({
      tenantId: ctx.tenantId,
      title: input.title,
      description: sanitizeBody(input.description),
      submissionKinds: input.submissionKinds,
      minTextLength: input.minTextLength ?? null,
      maxFiles: input.maxFiles ?? 3,
      maxFileMb: input.maxFileMb ?? 50,
      allowCameraOnly: input.allowCameraOnly ?? false,
      criteria: input.criteria.map((c, i) => ({ id: `c${i + 1}`, text: c.text, weight: c.weight ?? 1, isCritical: c.isCritical ?? false })),
      passRule: input.passRule ?? { type: 'all_criteria' },
      reviewerRule: input.reviewerRule ?? 'location_mentor',
      reviewerIds: input.reviewerIds ?? [],
      allowRework: input.allowRework ?? true,
      maxReworks: input.maxReworks ?? 2,
      slaHours: input.slaHours ?? 48,
      status: input.status ?? 'draft',
      authorIds: [ctx.actorId],
    }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'workshop.create', entity: 'workshop', entityId: w!.id, after: { title: input.title } })
    return w!
  })
}

/** Что считается «изменением содержания» практикума для баннера «N завдань змінено» (docs/15 §14.6, D-019). */
const WORKSHOP_CONTENT_KEYS = ['criteria', 'passRule', 'submissionKinds', 'minTextLength', 'allowCameraOnly'] as const

export async function updateWorkshop(ctx: Ctx, id: string, input: Partial<WorkshopInput>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(workshops).where(and(eq(workshops.id, id), isNull(workshops.deletedAt)))
    if (!before) return null
    const [w] = await tx.update(workshops).set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: sanitizeBody(input.description) } : {}),
      ...(input.submissionKinds !== undefined ? { submissionKinds: input.submissionKinds } : {}),
      ...(input.criteria !== undefined ? { criteria: input.criteria.map((c, i) => ({ id: `c${i + 1}`, text: c.text, weight: c.weight ?? 1, isCritical: c.isCritical ?? false })) } : {}),
      ...(input.passRule !== undefined ? { passRule: input.passRule } : {}),
      ...(input.reviewerRule !== undefined ? { reviewerRule: input.reviewerRule } : {}),
      ...(input.reviewerIds !== undefined ? { reviewerIds: input.reviewerIds } : {}),
      ...(input.allowRework !== undefined ? { allowRework: input.allowRework } : {}),
      ...(input.maxReworks !== undefined ? { maxReworks: input.maxReworks } : {}),
      ...(input.slaHours !== undefined ? { slaHours: input.slaHours } : {}),
      ...(input.minTextLength !== undefined ? { minTextLength: input.minTextLength } : {}),
      ...(input.allowCameraOnly !== undefined ? { allowCameraOnly: input.allowCameraOnly } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      updatedAt: new Date(),
    }).where(and(eq(workshops.id, id), isNull(workshops.deletedAt))).returning()
    if (!w) return null
    // D-019: правка критериев/правила зачёта/формата сдачи у опубликованного практикума → баннер у назначений
    if (w.status === 'published' && WORKSHOP_CONTENT_KEYS.some(k => JSON.stringify(before[k]) !== JSON.stringify(w[k]))) {
      const { markContentChanged } = await import('./tasks')
      await markContentChanged(tx, 'workshop', id)
    }
    return w
  })
}

// ── Ученик ─────────────────────────────────────────────────────────────

/** Задание + текущая сдача + история (docs/13 §5.1). */
export async function workshopForLearner(ctx: Ctx, workshopId: string, enrollmentId?: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [w] = await tx.select().from(workshops).where(and(eq(workshops.id, workshopId), isNull(workshops.deletedAt)))
    if (!w) return null
    const history = await tx.select().from(workshopSubmissions)
      .where(and(eq(workshopSubmissions.workshopId, workshopId), eq(workshopSubmissions.userId, ctx.actorId),
        ...(enrollmentId ? [eq(workshopSubmissions.enrollmentId, enrollmentId)] : [])))
      .orderBy(desc(workshopSubmissions.attemptNo))
    const current = history[0] ?? null
    const comments = current
      ? await tx.select({ id: workshopComments.id, authorId: workshopComments.authorId, authorName: users.fullName, body: workshopComments.body, createdAt: workshopComments.createdAt })
          .from(workshopComments).innerJoin(users, eq(users.id, workshopComments.authorId))
          .where(and(eq(workshopComments.submissionId, current.id), eq(workshopComments.isInternal, false), isNull(workshopComments.deletedAt)))
          .orderBy(asc(workshopComments.createdAt))
      : []
    return {
      id: w.id, title: w.title, description: w.description, instructionMedia: w.instructionMedia,
      submissionKinds: w.submissionKinds, minTextLength: w.minTextLength, maxFiles: w.maxFiles, maxFileMb: w.maxFileMb,
      allowCameraOnly: w.allowCameraOnly, criteria: w.criteria, slaHours: w.slaHours, allowRework: w.allowRework, maxReworks: w.maxReworks,
      current, history: history.map(h => ({ id: h.id, attemptNo: h.attemptNo, status: h.status, submittedAt: h.submittedAt, reviewedAt: h.reviewedAt, passed: h.passed, reviewComment: h.reviewComment })),
      comments,
    }
  })
}

export async function saveDraft(ctx: Ctx, workshopId: string, input: { text?: string, files?: unknown[], enrollmentId?: string, lessonId?: string }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [w] = await tx.select().from(workshops).where(eq(workshops.id, workshopId))
    if (!w) return null
    const [existing] = await tx.select().from(workshopSubmissions)
      .where(and(eq(workshopSubmissions.workshopId, workshopId), eq(workshopSubmissions.userId, ctx.actorId), inArray(workshopSubmissions.status, ['draft', 'rework'])))
      .orderBy(desc(workshopSubmissions.attemptNo))
    if (existing) {
      const [s] = await tx.update(workshopSubmissions).set({ body: { text: input.text ?? '' }, files: input.files ?? [], updatedAt: new Date() }).where(eq(workshopSubmissions.id, existing.id)).returning()
      return s!
    }
    const [last] = await tx.select({ n: workshopSubmissions.attemptNo }).from(workshopSubmissions)
      .where(and(eq(workshopSubmissions.workshopId, workshopId), eq(workshopSubmissions.userId, ctx.actorId))).orderBy(desc(workshopSubmissions.attemptNo)).limit(1)
    const [s] = await tx.insert(workshopSubmissions).values({
      tenantId: ctx.tenantId, workshopId, userId: ctx.actorId, enrollmentId: input.enrollmentId ?? null, lessonId: input.lessonId ?? null,
      attemptNo: (last?.n ?? 0) + 1, body: { text: input.text ?? '' }, files: input.files ?? [], criteriaSnapshot: w.criteria, status: 'draft',
    }).returning()
    return s!
  })
}

export type SubmitResult = { ok: true, submissionId: string } | { ok: false, code: 'not_found' | 'requirements_not_met' | 'already_submitted', reasons?: string[] }

/** Отправка на проверку (docs/13 §6.2, §7.1): проверка минимальных условий, назначение проверяющих, SLA. */
export async function submitWorkshop(ctx: Ctx, workshopId: string, input: { text?: string, files?: { mediaId: string, name: string, kind: string, bytes: number }[], enrollmentId?: string, lessonId?: string, device?: string }): Promise<SubmitResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [w] = await tx.select().from(workshops).where(and(eq(workshops.id, workshopId), isNull(workshops.deletedAt)))
    if (!w) return { ok: false as const, code: 'not_found' as const }

    const reasons: string[] = []
    const text = (input.text ?? '').trim()
    const files = input.files ?? []
    if (w.submissionKinds.includes('text') && w.minTextLength && text.length < w.minTextLength) reasons.push(`Мінімум ${w.minTextLength} символів`)
    if (!w.submissionKinds.includes('text') && !files.length) reasons.push('Додайте файл або фото')
    if (w.submissionKinds.includes('text') && !text && !files.length) reasons.push('Додайте текст або файл')
    if (files.length > w.maxFiles) reasons.push(`Можна додати до ${w.maxFiles} файлів`)
    if (files.some(f => f.bytes > w.maxFileMb * 1024 * 1024)) reasons.push(`Файл більший за ${w.maxFileMb} МБ`)
    if (reasons.length) return { ok: false as const, code: 'requirements_not_met' as const, reasons }

    // Уже есть submitted/in_review — вторую отправку отклоняем (docs/13 §12)
    const [active] = await tx.select().from(workshopSubmissions)
      .where(and(eq(workshopSubmissions.workshopId, workshopId), eq(workshopSubmissions.userId, ctx.actorId), inArray(workshopSubmissions.status, ['submitted', 'in_review'])))
    if (active) return { ok: false as const, code: 'already_submitted' as const }

    const draft = await saveDraft(ctx, workshopId, { text, files, enrollmentId: input.enrollmentId, lessonId: input.lessonId })
    const now = new Date()
    const [s] = await tx.update(workshopSubmissions).set({
      status: 'submitted', submittedAt: now, claimedAt: null, reviewerId: null,
      slaDueAt: new Date(now.getTime() + w.slaHours * 3_600_000), device: input.device ?? null, updatedAt: now,
    }).where(eq(workshopSubmissions.id, draft!.id)).returning({ id: workshopSubmissions.id })

    const [me] = await tx.select({ fullName: users.fullName }).from(users).where(eq(users.id, ctx.actorId))
    for (const rid of await reviewersFor(tx, ctx.tenantId, w, ctx.actorId)) {
      await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: rid, code: 'workshop_submitted', payload: { name: me?.fullName, title: w.title, submissionId: s!.id }, dedupKey: `ws_submitted:${s!.id}:${rid}` })
    }
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'workshop.submit', entity: 'workshop_submission', entityId: s!.id })
    return { ok: true as const, submissionId: s!.id }
  })
}

/** Кто проверяет (docs/13 §7.1): по reviewer_rule, сам сдавший исключается. */
async function reviewersFor(tx: TenantTx, tenantId: string, w: typeof workshops.$inferSelect, submitterId: string): Promise<string[]> {
  let ids: string[] = []
  if (w.reviewerRule === 'specific') ids = w.reviewerIds
  else if (w.reviewerRule === 'author') ids = w.authorIds
  else {
    const mentorRows = await tx.select({ userId: userRoles.userId, scopeType: userRoles.scopeType, scopeId: userRoles.scopeId })
      .from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(sql`${roles.scopes} @> array['review.grade']::text[]`)
    if (w.reviewerRule === 'any_mentor') ids = mentorRows.map(r => r.userId)
    else {
      const [pl] = await tx.select({ locationId: userPlacements.locationId }).from(userPlacements)
        .where(and(eq(userPlacements.userId, submitterId), eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt)))
      ids = mentorRows.filter(r => r.scopeType === 'tenant' || (r.scopeType === 'location' && r.scopeId === pl?.locationId)).map(r => r.userId)
    }
  }
  ids = [...new Set(ids)].filter(id => id !== submitterId)
  // Единственный проверяющий — сам сдавший → руководителю точки (docs/14 §7.9)
  if (ids.length === 0) {
    const [pl] = await tx.select({ managerId: locations.managerId }).from(userPlacements).innerJoin(locations, eq(locations.id, userPlacements.locationId))
      .where(and(eq(userPlacements.userId, submitterId), eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt)))
    if (pl?.managerId && pl.managerId !== submitterId) ids = [pl.managerId]
  }
  return ids
}

// ── Проверяющий ────────────────────────────────────────────────────────

/** Очередь (docs/13 §5.2): свои сдачи не видны; захваченные другими — скрыты, кроме протухших. */
export async function reviewQueue(ctx: Ctx, filter: { mine?: boolean, overdue?: boolean } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const stale = new Date(Date.now() - CLAIM_TTL_MS).toISOString()
    const rows = await tx.select({
      id: workshopSubmissions.id, workshopId: workshopSubmissions.workshopId, workshopTitle: workshops.title,
      userId: workshopSubmissions.userId, fullName: users.fullName, attemptNo: workshopSubmissions.attemptNo,
      status: workshopSubmissions.status, submittedAt: workshopSubmissions.submittedAt, slaDueAt: workshopSubmissions.slaDueAt,
      reviewerId: workshopSubmissions.reviewerId, claimedAt: workshopSubmissions.claimedAt, reworkCount: workshopSubmissions.reworkCount,
      locationName: locations.name,
    })
      .from(workshopSubmissions)
      .innerJoin(workshops, eq(workshops.id, workshopSubmissions.workshopId))
      .innerJoin(users, eq(users.id, workshopSubmissions.userId))
      .leftJoin(userPlacements, and(eq(userPlacements.userId, users.id), eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt)))
      .leftJoin(locations, eq(locations.id, userPlacements.locationId))
      .where(and(
        inArray(workshopSubmissions.status, ['submitted', 'in_review']),
        sql`${workshopSubmissions.userId} <> ${ctx.actorId}::uuid`,
        filter.mine
          ? eq(workshopSubmissions.reviewerId, ctx.actorId)
          : sql`(${workshopSubmissions.reviewerId} is null or ${workshopSubmissions.reviewerId} = ${ctx.actorId}::uuid or ${workshopSubmissions.claimedAt} < ${stale}::timestamptz)`,
        ...(filter.overdue ? [sql`${workshopSubmissions.slaDueAt} < now()`] : []),
      ))
      .orderBy(asc(workshopSubmissions.slaDueAt))
      .limit(200)
    return rows.map(r => ({ ...r, hoursLeft: r.slaDueAt ? Math.round((r.slaDueAt.getTime() - Date.now()) / 3_600_000) : null }))
  })
}

export type ClaimResult = { ok: true } | { ok: false, code: 'not_found' | 'already_claimed' | 'self_review' }

/** Захват карточки (docs/13 §7.2): открытие ставит reviewer_id; через 30 минут бездействия освобождается. */
export async function claim(ctx: Ctx, submissionId: string): Promise<ClaimResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [s] = await tx.select().from(workshopSubmissions).where(eq(workshopSubmissions.id, submissionId))
    if (!s || !['submitted', 'in_review'].includes(s.status)) return { ok: false as const, code: 'not_found' as const }
    if (s.userId === ctx.actorId) return { ok: false as const, code: 'self_review' as const }
    const stale = s.claimedAt && s.claimedAt.getTime() < Date.now() - CLAIM_TTL_MS
    if (s.reviewerId && s.reviewerId !== ctx.actorId && !stale) return { ok: false as const, code: 'already_claimed' as const }
    await tx.update(workshopSubmissions).set({ status: 'in_review', reviewerId: ctx.actorId, claimedAt: new Date(), updatedAt: new Date() }).where(eq(workshopSubmissions.id, submissionId))
    return { ok: true as const }
  })
}

export async function release(ctx: Ctx, submissionId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    await tx.update(workshopSubmissions).set({ status: 'submitted', reviewerId: null, claimedAt: null, updatedAt: new Date() })
      .where(and(eq(workshopSubmissions.id, submissionId), eq(workshopSubmissions.reviewerId, ctx.actorId)))
    return true
  })
}

/** Карточка проверки (docs/13 §5.3): работа, критерии из снапшота, история, комментарии. */
export async function submissionForReview(ctx: Ctx, submissionId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [s] = await tx.select().from(workshopSubmissions).where(eq(workshopSubmissions.id, submissionId))
    if (!s) return null
    const [w] = await tx.select().from(workshops).where(eq(workshops.id, s.workshopId))
    const [u] = await tx.select({ fullName: users.fullName }).from(users).where(eq(users.id, s.userId))
    const history = await tx.select({ id: workshopSubmissions.id, attemptNo: workshopSubmissions.attemptNo, status: workshopSubmissions.status, submittedAt: workshopSubmissions.submittedAt, reviewedAt: workshopSubmissions.reviewedAt, reviewComment: workshopSubmissions.reviewComment, criteriaResults: workshopSubmissions.criteriaResults })
      .from(workshopSubmissions).where(and(eq(workshopSubmissions.workshopId, s.workshopId), eq(workshopSubmissions.userId, s.userId), sql`${workshopSubmissions.id} <> ${submissionId}::uuid`))
      .orderBy(desc(workshopSubmissions.attemptNo))
    const comments = await tx.select({ id: workshopComments.id, authorId: workshopComments.authorId, authorName: users.fullName, body: workshopComments.body, isInternal: workshopComments.isInternal, createdAt: workshopComments.createdAt })
      .from(workshopComments).innerJoin(users, eq(users.id, workshopComments.authorId))
      .where(and(eq(workshopComments.submissionId, submissionId), isNull(workshopComments.deletedAt))).orderBy(asc(workshopComments.createdAt))
    return { submission: s, workshop: w ? { id: w.id, title: w.title, description: w.description, passRule: w.passRule, allowRework: w.allowRework, maxReworks: w.maxReworks } : null, learner: { id: s.userId, fullName: u?.fullName }, history, comments }
  })
}

export type GradeResult = { ok: true, status: string } | { ok: false, code: 'not_found' | 'not_claimed' | 'comment_required' | 'rework_exhausted' | 'criteria_not_met' }

/** Решение (docs/13 §6.3, §7.3–7.4): зачёт по правилу, доработка с лимитом, уведомления. */
export async function grade(ctx: Ctx, submissionId: string, input: { decision: 'accepted' | 'rejected' | 'rework', criteriaResults: { criterionId: string, passed: boolean, comment?: string }[], comment?: string, score?: number }): Promise<GradeResult> {
  const result = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [s] = await tx.select().from(workshopSubmissions).where(eq(workshopSubmissions.id, submissionId))
    if (!s || s.status !== 'in_review') return { ok: false as const, code: 'not_found' as const }
    if (s.reviewerId !== ctx.actorId) return { ok: false as const, code: 'not_claimed' as const }
    const [w] = await tx.select().from(workshops).where(eq(workshops.id, s.workshopId))
    if (!w) return { ok: false as const, code: 'not_found' as const }

    const comment = (input.comment ?? '').trim()
    if (input.decision !== 'accepted' && comment.length < 10) return { ok: false as const, code: 'comment_required' as const }
    if (input.decision === 'rework' && (!w.allowRework || s.reworkCount >= w.maxReworks)) return { ok: false as const, code: 'rework_exhausted' as const }

    const criteria = s.criteriaSnapshot as Criterion[]
    const results = new Map(input.criteriaResults.map(r => [r.criterionId, r]))
    const passRule = w.passRule as { type: string, minScore?: number }
    const total = criteria.reduce((a, c) => a + c.weight, 0)
    const earned = criteria.reduce((a, c) => a + (results.get(c.id)?.passed ? c.weight : 0), 0)
    const score = total ? Math.round(earned / total * 10000) / 100 : 0
    const criticalFailed = criteria.some(c => c.isCritical && !results.get(c.id)?.passed)
    const allPassed = criteria.every(c => results.get(c.id)?.passed)

    if (input.decision === 'accepted') {
      const allowed = passRule.type === 'manual'
        || (passRule.type === 'all_criteria' && allPassed && !criticalFailed)
        || (passRule.type === 'min_score' && score >= (passRule.minScore ?? 100) && !criticalFailed)
      if (!allowed) return { ok: false as const, code: 'criteria_not_met' as const }
    }

    const now = new Date()
    await tx.update(workshopSubmissions).set({
      status: input.decision,
      criteriaResults: input.criteriaResults,
      score: String(score),
      passed: input.decision === 'accepted',
      reviewComment: comment || null,
      reviewedAt: now,
      ...(input.decision === 'rework' ? { reworkCount: s.reworkCount + 1, slaDueAt: new Date(now.getTime() + w.slaHours * 3_600_000) } : {}),
      updatedAt: now,
    }).where(eq(workshopSubmissions.id, submissionId))

    if (input.decision === 'accepted' && s.enrollmentId && s.lessonId) {
      await tx.insert(lessonProgress).values({ tenantId: ctx.tenantId, enrollmentId: s.enrollmentId, lessonId: s.lessonId, status: 'completed', completedAt: now })
        .onConflictDoUpdate({ target: [lessonProgress.tenantId, lessonProgress.enrollmentId, lessonProgress.lessonId], set: { status: 'completed', completedAt: now } })
    }

    const code = input.decision === 'accepted' ? 'workshop_accepted' : input.decision === 'rework' ? 'workshop_rework' : 'workshop_rejected'
    await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: s.userId, code, payload: { title: w.title, comment, submissionId }, dedupKey: `ws_${code}:${submissionId}:${s.reworkCount}` })
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'workshop.grade', entity: 'workshop_submission', entityId: submissionId, after: { decision: input.decision, score } })
    return { ok: true as const, status: input.decision, enrollmentId: s.enrollmentId, lessonId: s.lessonId, learnerId: s.userId, workshopId: s.workshopId }
  }).then((r) => {
    // Практикум как узел программы (docs/17 §7.4)
    if (r.ok && (r.status === 'accepted' || r.status === 'rejected')) { import('./programs').then(p => p.onItemResult(ctx.tenantId, r.learnerId, 'workshop', r.workshopId, { passed: r.status === 'accepted' })).catch(err => console.error('program workshop hook', err)); import('./trajectories').then(t => t.onTaskResult(ctx.tenantId, r.learnerId, 'workshop', r.workshopId, { passed: r.status === 'accepted' })).catch(err => console.error('trajectory workshop hook', err)) }
    return r
  })

  if (result.ok && result.status === 'accepted' && result.enrollmentId && result.lessonId) {
    const { completeLesson } = await import('./learning')
    await completeLesson({ tenantId: ctx.tenantId, actorId: result.learnerId }, result.enrollmentId, result.lessonId).catch(() => {})
  }
  return result
}

/** Оценка наставника учеником 1–5 после проверки (docs/22 §4.5, Б.7): одним тапом, один раз. */
export async function rateMentor(ctx: Ctx, submissionId: string, rating: number) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.update(workshopSubmissions).set({ mentorRating: rating, updatedAt: new Date() })
      .where(and(eq(workshopSubmissions.id, submissionId), eq(workshopSubmissions.userId, ctx.actorId), sql`${workshopSubmissions.reviewedAt} is not null`, sql`${workshopSubmissions.mentorRating} is null`)).returning({ id: workshopSubmissions.id })
    return rows.length > 0
  })
}

export async function addComment(ctx: Ctx, submissionId: string, body: string, isInternal = false) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [s] = await tx.select({ userId: workshopSubmissions.userId, workshopId: workshopSubmissions.workshopId }).from(workshopSubmissions).where(eq(workshopSubmissions.id, submissionId))
    if (!s) return null
    const [c] = await tx.insert(workshopComments).values({ tenantId: ctx.tenantId, submissionId, authorId: ctx.actorId, body: body.slice(0, 2000), isInternal }).returning()
    if (!isInternal && s.userId !== ctx.actorId) {
      const [w] = await tx.select({ title: workshops.title }).from(workshops).where(eq(workshops.id, s.workshopId))
      await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: s.userId, code: 'workshop_comment', payload: { title: w?.title, submissionId }, dedupKey: `ws_comment:${c!.id}` })
    }
    return c!
  })
}

/** Фоновые (docs/13 §11): SLA-просрочки руководителю, освобождение протухших захватов, expire доработок. */
export async function workshopSlaScan(tenantId: string): Promise<{ released: number, breached: number, expired: number }> {
  return withTenant(tenantId, null, async (tx) => {
    const stale = new Date(Date.now() - CLAIM_TTL_MS).toISOString()
    const released = await tx.update(workshopSubmissions).set({ status: 'submitted', reviewerId: null, claimedAt: null })
      .where(and(eq(workshopSubmissions.status, 'in_review'), sql`${workshopSubmissions.claimedAt} < ${stale}::timestamptz`)).returning({ id: workshopSubmissions.id })

    let breached = 0
    const overdue = await tx.select({ s: workshopSubmissions, w: workshops }).from(workshopSubmissions).innerJoin(workshops, eq(workshops.id, workshopSubmissions.workshopId))
      .where(and(inArray(workshopSubmissions.status, ['submitted', 'in_review']), sql`${workshopSubmissions.slaDueAt} < now() - (${workshops.slaHours} || ' hours')::interval`))
    for (const { s, w } of overdue) {
      const [pl] = await tx.select({ managerId: locations.managerId }).from(userPlacements).innerJoin(locations, eq(locations.id, userPlacements.locationId))
        .where(and(eq(userPlacements.userId, s.userId), eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt)))
      if (pl?.managerId) {
        const hours = Math.round((Date.now() - (s.submittedAt?.getTime() ?? Date.now())) / 3_600_000)
        if (await enqueueNotification(tx, { tenantId, userId: pl.managerId, code: 'workshop_sla_breach', payload: { title: w.title, hours, submissionId: s.id }, dedupKey: `ws_sla:${s.id}:${new Date().toISOString().slice(0, 10)}` })) breached++
      }
    }

    const expired = await tx.update(workshopSubmissions).set({ status: 'expired', updatedAt: new Date() })
      .where(and(eq(workshopSubmissions.status, 'rework'), sql`${workshopSubmissions.slaDueAt} < now()`)).returning({ id: workshopSubmissions.id })
    return { released: released.length, breached, expired: expired.length }
  })
}
