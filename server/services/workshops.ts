import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  enrollments, locations, reviewQueueItems, userPlacements, userRoles, roles, users, workshopComments, workshopSubmissions, workshops,
} from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import { sanitizeBody } from './sanitize'
import { enqueueNotification } from './notifications'
import { claimReview, closeReview, enqueueReview, heldByOtherSql, releaseReview, reviewConflict, staleClaims } from './reviewQueue'
import { CLAIM_TTL_MS } from './reviewRules'
import { closeOpenSegments } from './learningTime'
import { recordActivity } from './activity'
import { plannedSecondsFor } from './timeNorms'
import type { ContentBlock, WorkshopFile } from '../../shared/schemas/content'
import { managerIdOf, managerIdsOf } from './orgManager'

interface Ctx { tenantId: string, actorId: string }

export interface Criterion { id: string, text: string, weight: number, isCritical: boolean }

/** Решение по практикуму словами — для `review_delegation_resolved` делегировавшему (docs/v2/37 §8). */
const WORKSHOP_DECISION_UK: Record<'accepted' | 'rejected' | 'rework', string> = { accepted: 'зараховано', rejected: 'не зараховано', rework: 'на доопрацювання' }

// ── Файлы сдачи и отложенная загрузка (docs/v2/34 §7.5, §13 к. 1) ────────────────────────

/** Файл-обещание: запись на устройстве сотрудника ждёт места в хранилище и ещё не дослана. */
export function isPendingFile(f: unknown): boolean {
  const e = f as { pendingId?: string, mediaId?: string, lost?: boolean }
  return !!e?.pendingId && !e.mediaId && !e.lost
}

/** SQL-признак «в сдаче есть недосланный файл» — для очереди ментора (метка «Очікує вивантаження»). */
const PENDING_FILES_SQL = sql`jsonb_path_exists(${workshopSubmissions.files}, 'lax $[*] ? (exists(@.pendingId) && !(@.lost == true))')`

/**
 * Состояние файлов сдачи в хранилище: удалённый файл остаётся в сдаче строкой, а экран
 * показывает «Файл видалено {дата}» вместо превью (docs/v2/34 §4, §7.2 п. 4, §13 к. 3) —
 * удаление файла никогда не меняет запись прохождения.
 */
async function withFileState(tx: TenantTx, files: unknown): Promise<(Record<string, unknown> & { deletedAt?: string | null, lifecycle?: string })[]> {
  const list = Array.isArray(files) ? files as Record<string, unknown>[] : []
  const ids = list.map(f => f.mediaId).filter((v): v is string => typeof v === 'string')
  if (!ids.length) return list
  const rows = await tx.execute(sql`
    select id::text as id, lifecycle, deleted_at from media_assets
     where id::text in (${sql.join(ids.map(id => sql`${id}`), sql`, `)})
  `) as unknown as { id: string, lifecycle: string, deleted_at: Date | string | null }[]
  const byId = new Map(rows.map(r => [r.id, r]))
  return list.map((f) => {
    const m = typeof f.mediaId === 'string' ? byId.get(f.mediaId) : undefined
    return m ? { ...f, lifecycle: m.lifecycle, deletedAt: m.deleted_at ? new Date(m.deleted_at).toISOString() : null } : f
  })
}

// ── Управление (методист) ──────────────────────────────────────────────

export async function listWorkshops(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({
      id: workshops.id, title: workshops.title, status: workshops.status, submissionKinds: workshops.submissionKinds,
      slaHours: workshops.slaHours, reviewerRule: workshops.reviewerRule, updatedAt: workshops.updatedAt,
      criteriaCount: sql<number>`jsonb_array_length(${workshops.criteria})`,
      pending: sql<number>`(select count(*)::int from ${workshopSubmissions} s where s.workshop_id = ${workshops.id} and s.status in ('submitted','in_review'))`,
      firstPassPct: sql<number>`(select round(100.0 * count(*) filter (where s.status = 'accepted' and s.rework_count = 0) / nullif(count(*) filter (where s.status in ('accepted','rejected')), 0))::int from ${workshopSubmissions} s where s.workshop_id = ${workshops.id})`,
      // Колонка «Автор» (docs/31 `ContentWorkshops`, screens-7): практикум зберігає лише authorIds,
      // імена — join на users. «Мітки» лишаються 🟡 — у workshops немає стовпця tags і жодного
      // scope у TAG_SCOPES (shared/enums.ts) під практикуми, вигадувати новий scope мовчки не можна.
      authorNames: sql<string[]>`(select coalesce(array_agg(u.full_name order by u.full_name), '{}') from ${users} u where u.id = any(${workshops.authorIds}))`,
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
    const currentRow = history[0] ?? null
    // Срок проверки (`workshop.reviewBy`) ученику нужен, пока сдача ждёт наставника — источник
    // теперь только review_queue_items (В-2, PR-20 сняла зеркало workshop_submissions.sla_due_at).
    const current = currentRow && ['submitted', 'in_review'].includes(currentRow.status)
      ? { ...currentRow, slaDueAt: (await tx.select({ slaDueAt: reviewQueueItems.slaDueAt }).from(reviewQueueItems)
          .where(and(eq(reviewQueueItems.taskType, 'workshop'), eq(reviewQueueItems.sourceId, currentRow.id))))[0]?.slaDueAt ?? null }
      : currentRow ? { ...currentRow, slaDueAt: null } : null
    const comments = current
      ? await tx.select({ id: workshopComments.id, authorId: workshopComments.authorId, authorName: users.fullName, body: workshopComments.body, createdAt: workshopComments.createdAt })
          .from(workshopComments).innerJoin(users, eq(users.id, workshopComments.authorId))
          .where(and(eq(workshopComments.submissionId, current.id), eq(workshopComments.isInternal, false), isNull(workshopComments.deletedAt)))
          .orderBy(asc(workshopComments.createdAt))
      : []
    const currentWithFiles = current ? { ...current, files: await withFileState(tx, current.files), pendingUpload: (current.files as unknown[] ?? []).some(isPendingFile) } : null
    return {
      id: w.id, title: w.title, description: w.description, instructionMedia: w.instructionMedia,
      submissionKinds: w.submissionKinds, minTextLength: w.minTextLength, maxFiles: w.maxFiles, maxFileMb: w.maxFileMb,
      allowCameraOnly: w.allowCameraOnly, criteria: w.criteria, slaHours: w.slaHours, allowRework: w.allowRework, maxReworks: w.maxReworks,
      current: currentWithFiles, history: history.map(h => ({ id: h.id, attemptNo: h.attemptNo, status: h.status, submittedAt: h.submittedAt, reviewedAt: h.reviewedAt, passed: h.passed, reviewComment: h.reviewComment })),
      comments,
    }
  })
}

export async function saveDraft(ctx: Ctx, workshopId: string, input: { text?: string, files?: WorkshopFile[] | unknown[], enrollmentId?: string, lessonId?: string }) {
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

export type SubmitResult = { ok: true, submissionId: string, pendingUpload: boolean } | { ok: false, code: 'not_found' | 'requirements_not_met' | 'already_submitted', reasons?: string[] }

/**
 * Позвать проверяющих: работа готова к проверке (docs/13 §7.1). Если правило распределения уже
 * назначило проверяющего (он получил `review_assigned`), звать всех наставников точки нечестно:
 * взять назначенную другому работу нельзя (docs/v2/37 §7.1).
 */
async function notifyReviewers(tx: TenantTx, tenantId: string, w: typeof workshops.$inferSelect, submitterId: string, submissionId: string): Promise<void> {
  const [queued] = await tx.select({ assigned: reviewQueueItems.assignedReviewerId }).from(reviewQueueItems)
    .where(and(eq(reviewQueueItems.taskType, 'workshop'), eq(reviewQueueItems.sourceId, submissionId)))
  if (queued?.assigned) return
  const [me] = await tx.select({ fullName: users.fullName }).from(users).where(eq(users.id, submitterId))
  for (const rid of await reviewersFor(tx, tenantId, w, submitterId)) {
    await enqueueNotification(tx, { tenantId, userId: rid, code: 'workshop_submitted', payload: { name: me?.fullName, title: w.title, submissionId }, dedupKey: `ws_submitted:${submissionId}:${rid}` })
  }
}

/**
 * Сдача, в которой есть файл-обещание `pendingId`, — найти её и переписать запись файла.
 * Возвращает название практикума для уведомления (или `null`, если сдачи нет — например,
 * сотрудник удалил файл из черновика и так и не сдал).
 */
async function rewritePendingFile(
  tx: TenantTx,
  tenantId: string,
  userId: string,
  pendingId: string,
  patch: (entry: Record<string, unknown>) => Record<string, unknown>,
): Promise<string | null> {
  const [row] = await tx.select({ s: workshopSubmissions, w: workshops })
    .from(workshopSubmissions)
    .innerJoin(workshops, eq(workshops.id, workshopSubmissions.workshopId))
    .where(and(
      eq(workshopSubmissions.userId, userId),
      sql`jsonb_path_exists(${workshopSubmissions.files}, 'lax $[*] ? (@.pendingId == $id)', jsonb_build_object('id', ${pendingId}::text))`,
    ))
    .orderBy(desc(workshopSubmissions.attemptNo))
    .limit(1)
  if (!row) return null
  const files = (Array.isArray(row.s.files) ? row.s.files : []) as Record<string, unknown>[]
  const next = files.map(f => (f.pendingId === pendingId ? patch(f) : f))
  await tx.update(workshopSubmissions).set({ files: next, updatedAt: new Date() }).where(eq(workshopSubmissions.id, row.s.id))

  // Последний недосланный файл пришёл (или потерян) — работа уходит к ментору (§7.5 п. 3).
  // Срок проверки считается от этого момента: пока файла не было, взять работу было нельзя,
  // и SLA ментора не должен был тикать. Строка очереди открывается заново (та же строка) —
  // enqueueReview() сам ставит review_queue_items.sla_due_at = этот момент + slaHours;
  // отдельной записи в workshop_submissions не нужно, зеркало снято PR-20 (В-2).
  if (['submitted', 'in_review'].includes(row.s.status) && !next.some(isPendingFile)) {
    const now = new Date()
    const [enr] = row.s.enrollmentId
      ? await tx.select({ courseId: enrollments.subjectId }).from(enrollments).where(and(eq(enrollments.id, row.s.enrollmentId), eq(enrollments.subjectType, 'course')))
      : []
    await enqueueReview(tx, {
      tenantId, taskType: 'workshop', sourceId: row.s.id, userId, taskTitle: row.w.title,
      trackId: enr?.courseId ?? null, submittedAt: now, attemptNo: row.s.attemptNo, slaHours: row.w.slaHours,
    })
    await notifyReviewers(tx, tenantId, row.w, userId, row.s.id)
  }
  return row.w.title
}

/** Отложенная запись дослана (docs/v2/34 §7.5 п. 3): обещание заменяется настоящим файлом. */
export async function attachPendingFile(tx: TenantTx, tenantId: string, userId: string, pendingId: string, mediaId: string): Promise<string | null> {
  return rewritePendingFile(tx, tenantId, userId, pendingId, (f) => {
    const { pendingId: _drop, lost: _lost, ...rest } = f
    return { ...rest, mediaId }
  })
}

/** Срок ожидания истёк (§7.5 п. 3): сдача остаётся зачтённой, файл помечен «Файл втрачено». */
export async function markPendingFileLost(tx: TenantTx, tenantId: string, userId: string, pendingId: string): Promise<string | null> {
  return rewritePendingFile(tx, tenantId, userId, pendingId, f => ({ ...f, lost: true }))
}

/** Отправка на проверку (docs/13 §6.2, §7.1): проверка минимальных условий, назначение проверяющих, SLA. */
export async function submitWorkshop(ctx: Ctx, workshopId: string, input: { text?: string, files?: WorkshopFile[], enrollmentId?: string, lessonId?: string, device?: string }): Promise<SubmitResult> {
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
      status: 'submitted', submittedAt: now, device: input.device ?? null, updatedAt: now,
    }).where(eq(workshopSubmissions.id, draft!.id)).returning({ id: workshopSubmissions.id })

    // Единая очередь проверки (docs/v2/44 В-2): строка ставится в той же транзакции, что и
    // сама сдача, — иначе работа существует, а очереди о ней не знает. `subject_kind`
    // снимается здесь же, внутри enqueueReview(), и больше не пересчитывается.
    const [enr] = input.enrollmentId
      ? await tx.select({ courseId: enrollments.subjectId }).from(enrollments)
        .where(and(eq(enrollments.id, input.enrollmentId), eq(enrollments.subjectType, 'course')))
      : []
    await enqueueReview(tx, {
      tenantId: ctx.tenantId,
      taskType: 'workshop',
      sourceId: s!.id,
      userId: ctx.actorId,
      taskTitle: w.title,
      trackId: enr?.courseId ?? null,
      submittedAt: now,
      attemptNo: draft!.attemptNo,
      slaHours: w.slaHours,
      // «Розрахунковий час» практикума — снимком на момент сдачи (docs/v2/37 §7.14, PR-22)
      estimatedSeconds: await plannedSecondsFor(tx, { subjectType: 'workshop', subjectId: workshopId }),
    })

    // Сдача с недосланной записью (квота тенанта исчерпана, docs/v2/34 §7.5 п. 2): срок засчитан
    // временем записи — `submitted_at` уже стоит, — но звать проверяющих некого: взять работу
    // нельзя, пока файл не дослан. Позовёт их `attachPendingFile()` в момент досылки.
    const pendingUpload = files.some(isPendingFile)
    if (!pendingUpload) await notifyReviewers(tx, ctx.tenantId, w, ctx.actorId, s!.id)
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'workshop.submit', entity: 'workshop_submission', entityId: s!.id, ...(pendingUpload ? { after: { pendingUpload: true } } : {}) })
    // Сдача отправлена — открытый сегмент измерения закрывается `completed` (docs/v2/37 §3.6);
    // время сдачи в строку и в очередь проверки досчитает свёртка `time.rollup`
    await closeOpenSegments(tx, { tenantId: ctx.tenantId, userId: ctx.actorId, subjectType: 'workshop', subjectId: workshopId })
    await recordActivity(tx, ctx.tenantId, { userId: ctx.actorId, kind: 'workshop_submitted', ref: { entity: 'workshop_submissions', id: s!.id } })
    return { ok: true as const, submissionId: s!.id, pendingUpload }
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
  // Единственный проверяющий — сам сдавший → руководителю (docs/14 §7.9).
  // Руководитель берётся `resolveManager()` (П-16.4), а не из `locations.manager_id`.
  if (ids.length === 0) {
    const mgr = await managerIdOf(tx, submitterId)
    if (mgr && mgr !== submitterId) ids = [mgr]
  }
  return ids
}

// ── Проверяющий ────────────────────────────────────────────────────────

/**
 * Очередь (docs/13 §5.2): свои сдачи не видны; захваченные другими — скрыты, кроме протухших.
 * Захват и срок проверки читаются из review_queue_items — единственного источника истины
 * (В-2, PR-20 сняла зеркало `workshop_submissions.reviewer_id` / `claimed_at` / `sla_due_at`).
 * Инвариант очереди (её писатель — только `enqueueReview()`, никогда не удаляет строку)
 * гарантирует ровно одну строку `review_queue_items` на каждую сдачу в статусе submitted/in_review.
 */
export async function reviewQueue(ctx: Ctx, filter: { mine?: boolean, overdue?: boolean } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const stale = new Date(Date.now() - CLAIM_TTL_MS).toISOString()
    const rows = await tx.select({
      id: workshopSubmissions.id, workshopId: workshopSubmissions.workshopId, workshopTitle: workshops.title,
      userId: workshopSubmissions.userId, fullName: users.fullName, attemptNo: workshopSubmissions.attemptNo,
      status: workshopSubmissions.status, submittedAt: workshopSubmissions.submittedAt, slaDueAt: reviewQueueItems.slaDueAt,
      reviewerId: reviewQueueItems.claimedBy, claimedAt: reviewQueueItems.claimedAt, reworkCount: workshopSubmissions.reworkCount,
      locationName: locations.name,
      // «Очікує вивантаження» (docs/v2/34 §7.5 п. 2): работа видна, взять её нельзя
      pendingUpload: sql<boolean>`${PENDING_FILES_SQL}`,
    })
      .from(workshopSubmissions)
      .innerJoin(workshops, eq(workshops.id, workshopSubmissions.workshopId))
      .innerJoin(users, eq(users.id, workshopSubmissions.userId))
      .innerJoin(reviewQueueItems, and(eq(reviewQueueItems.taskType, 'workshop'), eq(reviewQueueItems.sourceId, workshopSubmissions.id)))
      .leftJoin(userPlacements, and(eq(userPlacements.userId, users.id), eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt)))
      .leftJoin(locations, eq(locations.id, userPlacements.locationId))
      .where(and(
        inArray(workshopSubmissions.status, ['submitted', 'in_review']),
        sql`${workshopSubmissions.userId} <> ${ctx.actorId}::uuid`,
        filter.mine
          ? eq(reviewQueueItems.claimedBy, ctx.actorId)
          : sql`(${reviewQueueItems.claimedBy} is null or ${reviewQueueItems.claimedBy} = ${ctx.actorId}::uuid or ${reviewQueueItems.claimedAt} < ${stale}::timestamptz)`,
        // Назначенная или делегированная другому работа ушла из «Мої» (docs/v2/37 §13 к. 1) —
        // узкий фильтр не должен возвращать её обратно: состояние берётся из очереди (В-2).
        sql`not ${heldByOtherSql(ctx.actorId, 'workshop', sql`${workshopSubmissions.id}`)}`,
        ...(filter.overdue ? [sql`${reviewQueueItems.slaDueAt} < now()`] : []),
      ))
      .orderBy(asc(reviewQueueItems.slaDueAt))
      .limit(200)
    return rows.map(r => ({ ...r, hoursLeft: r.slaDueAt ? Math.round((r.slaDueAt.getTime() - Date.now()) / 3_600_000) : null }))
  })
}

export type ClaimResult = { ok: true } | { ok: false, code: 'not_found' | 'already_claimed' | 'self_review' | 'assigned_to_other' | 'pending_upload' }

/**
 * Захват карточки (docs/13 §7.2): открытие берёт работу в руки; через 30 минут бездействия
 * она освобождается. Кто может брать и занята ли карточка, решает очередь (`reviewGuard`,
 * PR-19): назначенную или делегированную другому работу открыть нельзя (docs/v2/37 §7.1).
 */
export async function claim(ctx: Ctx, submissionId: string): Promise<ClaimResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [s] = await tx.select().from(workshopSubmissions).where(eq(workshopSubmissions.id, submissionId))
    if (!s || !['submitted', 'in_review'].includes(s.status)) return { ok: false as const, code: 'not_found' as const }
    if (s.userId === ctx.actorId) return { ok: false as const, code: 'self_review' as const }
    // Файл ещё на устройстве сотрудника (docs/v2/34 §7.5 п. 2): проверять пока нечего
    if ((s.files as unknown[] ?? []).some(isPendingFile)) return { ok: false as const, code: 'pending_upload' as const }
    const guard = await claimReview(tx, { taskType: 'workshop', sourceId: submissionId, reviewerId: ctx.actorId })
    if (!guard.ok) return { ok: false as const, code: guard.code }
    // Захват живёт только в review_queue_items.claimed_by / claimed_at (В-2, PR-20 сняла зеркало).
    await tx.update(workshopSubmissions).set({ status: 'in_review', updatedAt: new Date() }).where(eq(workshopSubmissions.id, submissionId))
    return { ok: true as const }
  })
}

/** «Пропустити»: снимается только свой захват; назначение и делегирование остаются (docs/v2/37 §4). */
export async function release(ctx: Ctx, submissionId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [q] = await tx.select({ claimedBy: reviewQueueItems.claimedBy }).from(reviewQueueItems)
      .where(and(eq(reviewQueueItems.taskType, 'workshop'), eq(reviewQueueItems.sourceId, submissionId)))
    if (q && q.claimedBy !== ctx.actorId) return false
    await tx.update(workshopSubmissions).set({ status: 'submitted', updatedAt: new Date() })
      .where(and(eq(workshopSubmissions.id, submissionId), eq(workshopSubmissions.status, 'in_review')))
    await releaseReview(tx, { taskType: 'workshop', sourceIds: [submissionId] })
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
    // Конфликт интересов (docs/v2/37 §7.7–7.8): своя работа — решение запрещено; автор
    // материала — решение разрешено, но карточка предупреждает, а факт идёт в audit_log.
    const conflict = await reviewConflict(tx, { actorId: ctx.actorId, subjectUserId: s.userId, authorIds: w?.authorIds })
    return { submission: { ...s, files: await withFileState(tx, s.files) }, workshop: w ? { id: w.id, title: w.title, description: w.description, passRule: w.passRule, allowRework: w.allowRework, maxReworks: w.maxReworks } : null, learner: { id: s.userId, fullName: u?.fullName }, history, comments, conflict }
  })
}

export type GradeResult = { ok: true, status: string } | { ok: false, code: 'not_found' | 'not_claimed' | 'comment_required' | 'rework_exhausted' | 'criteria_not_met' }

/** Решение (docs/13 §6.3, §7.3–7.4): зачёт по правилу, доработка с лимитом, уведомления. */
export async function grade(ctx: Ctx, submissionId: string, input: { decision: 'accepted' | 'rejected' | 'rework', criteriaResults: { criterionId: string, passed: boolean, comment?: string }[], comment?: string, score?: number }): Promise<GradeResult> {
  const result = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [s] = await tx.select().from(workshopSubmissions).where(eq(workshopSubmissions.id, submissionId))
    if (!s || s.status !== 'in_review') return { ok: false as const, code: 'not_found' as const }
    // Решает тот, у кого карточка в руках — по очереди, единственному источнику истины (В-2,
    // PR-20 сняла зеркало): нет строки очереди — работа никем не захвачена.
    const [q] = await tx.select({ claimedBy: reviewQueueItems.claimedBy }).from(reviewQueueItems)
      .where(and(eq(reviewQueueItems.taskType, 'workshop'), eq(reviewQueueItems.sourceId, submissionId)))
    if (q?.claimedBy !== ctx.actorId) return { ok: false as const, code: 'not_claimed' as const }
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
      // Момент решения: и «когда наставник ответил», и опора для дедлайна доработки ниже
      // (workshopSlaScan) — без отдельной колонки под срок пересдачи (зеркало снято PR-20).
      reviewedAt: now,
      ...(input.decision === 'rework' ? { reworkCount: s.reworkCount + 1 } : {}),
      updatedAt: now,
    }).where(eq(workshopSubmissions.id, submissionId))

    if (input.decision === 'accepted' && s.enrollmentId && s.lessonId) {
      const { markLessonCompleted } = await import('./learning')
      await markLessonCompleted(tx, ctx.tenantId, { userId: s.userId, enrollmentId: s.enrollmentId, lessonId: s.lessonId, at: now })
    }

    // По файлам принято решение человеком — они становятся доказательством прохождения
    // (docs/v2/34 §7.1 п. 2): удалить их можно только с причиной и словом «ВИДАЛИТИ».
    // Доработка решением по существу не является — файлы ещё заменятся.
    if (input.decision === 'accepted' || input.decision === 'rejected') {
      const ids = ((s.files as { mediaId?: string }[] | null) ?? []).map(f => f.mediaId).filter((v): v is string => typeof v === 'string')
      if (ids.length) {
        await tx.execute(sql`update media_assets set is_evidence = true, updated_at = now() where id::text in (${sql.join(ids.map(id => sql`${id}`), sql`, `)}) and not is_evidence`)
      }
    }

    // Решение принято — элемент очереди закрывается, но остаётся строкой (проверка 21:
    // ни truncate, ни delete). Доработка тоже закрывает: работа вернулась к ученику, и
    // повторная сдача откроет ту же строку заново через enqueueReview().
    await closeReview(tx, { taskType: 'workshop', sourceIds: [submissionId], reviewerId: ctx.actorId, decision: WORKSHOP_DECISION_UK[input.decision], at: now })
    // Подсказка ИИ (docs/v2/30 §7.13, PR-29) решение не меняет — только сверяется с ним; доработка — не зачёт
    const { recordHintDecisionTx } = await import('./reviewHints')
    await recordHintDecisionTx(tx, { tenantId: ctx.tenantId, kind: 'workshop_submission', targetId: submissionId, reviewerId: ctx.actorId, passed: input.decision === 'accepted', decision: input.decision })

    const code = input.decision === 'accepted' ? 'workshop_accepted' : input.decision === 'rework' ? 'workshop_rework' : 'workshop_rejected'
    await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: s.userId, code, payload: { title: w.title, comment, submissionId }, dedupKey: `ws_${code}:${submissionId}:${s.reworkCount}` })
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'workshop.grade', entity: 'workshop_submission', entityId: submissionId, after: { decision: input.decision, score } })
    // Лента проверяющего (docs/v2/38 §7.9): решение по работе, включая доработку, — его учебная работа
    await recordActivity(tx, ctx.tenantId, { userId: ctx.actorId, kind: 'review_graded', ref: { entity: 'workshop_submissions', id: submissionId } })
    // Критерий приёмки docs/v2/37 §13 п. 6: автор материала вправе проверять работу по нему,
    // но факт фиксируется отдельной записью — по ней строится отчёт «проверки авторами» (§9.2).
    if (w.authorIds.includes(ctx.actorId)) {
      await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'review.author_conflict', entity: 'workshop_submission', entityId: submissionId, after: { workshopId: w.id, decision: input.decision } })
    }
    // docs/33 D-020: рішення наставника по самостійному практикуму — єдиний хук (accepted → done, rejected → failed; rework — ще не завершено).
    // Практикум усередині курсу (`lesson_id`) фіксує курс.
    if (!s.lessonId && (input.decision === 'accepted' || input.decision === 'rejected')) {
      const { onTaskCompleted } = await import('./taskCompletion')
      await onTaskCompleted(tx, ctx.tenantId, s.userId, { contentType: 'workshop', contentId: s.workshopId, status: input.decision === 'accepted' ? 'done' : 'failed', result: score ?? null, enrollmentId: s.enrollmentId, sourceKind: 'workshop_submission', sourceId: submissionId, actorId: ctx.actorId })
    }
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
    // Протухшие захваты и срок проверки — по очереди, единственному источнику истины (В-2,
    // PR-20 сняла зеркало workshop_submissions.reviewer_id / claimed_at / sla_due_at).
    const staleIds = await staleClaims(tx, 'workshop')
    const released = staleIds.length
      ? await tx.update(workshopSubmissions).set({ status: 'submitted' })
        .where(and(eq(workshopSubmissions.status, 'in_review'), inArray(workshopSubmissions.id, staleIds))).returning({ id: workshopSubmissions.id })
      : []
    await releaseReview(tx, { taskType: 'workshop', sourceIds: staleIds })

    let breached = 0
    const overdue = await tx.select({ s: workshopSubmissions, w: workshops }).from(workshopSubmissions)
      .innerJoin(workshops, eq(workshops.id, workshopSubmissions.workshopId))
      .innerJoin(reviewQueueItems, and(eq(reviewQueueItems.taskType, 'workshop'), eq(reviewQueueItems.sourceId, workshopSubmissions.id)))
      .where(and(inArray(workshopSubmissions.status, ['submitted', 'in_review']), sql`${reviewQueueItems.slaDueAt} < now() - (${workshops.slaHours} || ' hours')::interval`))
    const slaManagers = await managerIdsOf(tx, overdue.map(o => o.s.userId)) // П-16.4
    for (const { s, w } of overdue) {
      const mgr = slaManagers.get(s.userId)
      if (mgr) {
        const hours = Math.round((Date.now() - (s.submittedAt?.getTime() ?? Date.now())) / 3_600_000)
        if (await enqueueNotification(tx, { tenantId, userId: mgr, code: 'workshop_sla_breach', payload: { title: w.title, hours, submissionId: s.id }, dedupKey: `ws_sla:${s.id}:${new Date().toISOString().slice(0, 10)}` })) breached++
      }
    }

    // Просрочка доработки: до PR-20 срок жил в зеркальном sla_due_at, пересчитанным при решении
    // «на доопрацювання» (grade()); теперь тот же момент — reviewedAt (когда принято решение) +
    // slaHours практикума, без отдельной колонки под срок пересдачи.
    const expiredRework = await tx.select({ id: workshopSubmissions.id }).from(workshopSubmissions)
      .innerJoin(workshops, eq(workshops.id, workshopSubmissions.workshopId))
      .where(and(eq(workshopSubmissions.status, 'rework'), sql`${workshopSubmissions.reviewedAt} + (${workshops.slaHours} || ' hours')::interval < now()`))
    const expired = expiredRework.length
      ? await tx.update(workshopSubmissions).set({ status: 'expired', updatedAt: new Date() })
        .where(inArray(workshopSubmissions.id, expiredRework.map(r => r.id))).returning({ id: workshopSubmissions.id })
      : []
    // Истёкшая доработка уже никем не проверяется — элемент очереди закрывается, а не удаляется.
    await closeReview(tx, { taskType: 'workshop', sourceIds: expired.map(r => r.id) })
    return { released: released.length, breached, expired: expired.length }
  })
}
