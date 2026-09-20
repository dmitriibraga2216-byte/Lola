import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { currentRequestContext } from '../utils/requestContext'
import {
  courseVersions, courses, enrollmentEvents, enrollments, lessonProgress, lessons, mediaAssets, modules, resources,
} from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { business } from '../utils/metrics'
import type { TenantTx } from '../utils/withTenant'
import type { ContentBlock, TickInput } from '../../shared/schemas/content'
import type { ResourceKind } from '../../shared/schemas/resources'
import { evaluateLesson, type Evaluation } from './lessonRules'
import { currentVersion, printAllowed } from './resources'
import { TASK_GROUPS, deriveTaskState, notCancelled, taskGroupWhere } from './enrollmentStatus'
import type { TaskGroup } from './enrollmentStatus'

interface Ctx { tenantId: string, actorId: string }

async function logEvent(tx: TenantTx, tenantId: string, enrollmentId: string, event: string, payload: Record<string, unknown> = {}, actorId: string | null = null) {
  await tx.insert(enrollmentEvents).values({ tenantId, enrollmentId, event, payload, actorId, requestContext: currentRequestContext() })
}

/** «Мої завдання»: пять групп эталона (docs/04 §4.4, docs/10 Г-10.3) — new | planned | failed | overdue | done. */
export async function myLearning(ctx: Ctx, group: TaskGroup) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select({
      id: enrollments.id,
      status: enrollments.status,
      progressPct: enrollments.progressPct,
      dueAt: enrollments.dueAt,
      startsAt: enrollments.startsAt,
      expiredAt: enrollments.expiredAt,
      cancelledAt: enrollments.cancelledAt,
      source: enrollments.source,
      completedAt: enrollments.completedAt,
      courseId: courses.id,
      title: courses.title,
      coverKey: courses.coverKey,
      estimatedMinutes: courses.estimatedMinutes,
      requiredTotal: enrollments.requiredTotal,
      requiredDone: enrollments.requiredDone,
      createdAt: enrollments.createdAt,
    })
      .from(enrollments)
      .innerJoin(courses, eq(courses.id, enrollments.subjectId))
      .where(and(eq(enrollments.userId, ctx.actorId), taskGroupWhere(group)))

    const derived = rows.map(r => ({ ...r, ...deriveTaskState(r) }))
    // Сортировка docs/10 §5.1: просроченные → ближайший дедлайн → начатые → новые
    const weight = (r: typeof derived[number]) =>
      r.overdue ? 0 : r.dueAt ? 1 : r.status === 'in_progress' ? 2 : 3
    derived.sort((a, b) => weight(a) - weight(b)
      || (a.dueAt && b.dueAt ? +new Date(a.dueAt) - +new Date(b.dueAt) : 0)
      || +new Date(b.createdAt) - +new Date(a.createdAt))
    return derived
  })
}

/** Активность за неделю (Пн–Нд текущей недели): число событий прохождения по дням — для профиля. */
export async function myWeekActivity(ctx: Ctx): Promise<{ days: { date: string, events: number }[], total: number }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.execute(sql`
      with days as (select generate_series(date_trunc('week', now())::date, date_trunc('week', now())::date + 6, interval '1 day')::date as d)
      select d.d::text as date,
             (select count(*)::int from enrollment_events ev join enrollments e on e.id = ev.enrollment_id
               where e.user_id = ${ctx.actorId}::uuid and ev.created_at::date = d.d)
             + (select count(*)::int from lesson_progress lp join enrollments e on e.id = lp.enrollment_id
               where e.user_id = ${ctx.actorId}::uuid and coalesce(lp.completed_at, lp.updated_at)::date = d.d) as events
      from days d order by d.d`) as unknown as { date: string, events: number }[]
    return { days: rows, total: rows.reduce((s, r) => s + r.events, 0) }
  })
}

/** Счётчики пяти групп для шапки «Мої завдання». */
export async function myTaskCounts(ctx: Ctx): Promise<Record<TaskGroup, number>> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const out = { new: 0, planned: 0, failed: 0, overdue: 0, done: 0 } as Record<TaskGroup, number>
    for (const g of TASK_GROUPS) {
      const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(enrollments).where(and(eq(enrollments.userId, ctx.actorId), taskGroupWhere(g)))
      out[g] = r?.n ?? 0
    }
    return out
  })
}

/** Каталог: опубликованные курсы с is_catalog_visible; уже назначенные помечены. */
export async function catalog(ctx: Ctx, q?: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select().from(courses)
      .where(and(
        eq(courses.status, 'published'),
        eq(courses.isCatalogVisible, true),
        isNull(courses.deletedAt),
        ...(q ? [sql`${courses.title} ilike ${`%${q}%`}`] : []),
      ))
      .orderBy(desc(courses.updatedAt))

    const mine = await tx.select({ subjectId: enrollments.subjectId, id: enrollments.id })
      .from(enrollments)
      .where(and(eq(enrollments.userId, ctx.actorId), notCancelled()))
    const mineByCourse = new Map(mine.map(m => [m.subjectId, m.id]))

    return rows.map(c => ({
      id: c.id,
      title: c.title,
      summary: c.summary,
      coverKey: c.coverKey,
      estimatedMinutes: c.estimatedMinutes,
      tags: c.tags,
      enrollmentId: mineByCourse.get(c.id) ?? null,
    }))
  })
}

/** Число обязательных уроков опубликованной версии. */
export async function countRequired(tx: TenantTx, versionId: string): Promise<number> {
  const [row] = await tx.select({ count: sql<number>`count(*)::int` })
    .from(lessons)
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .where(and(eq(modules.courseVersionId, versionId), eq(lessons.isRequired, true)))
  return row?.count ?? 0
}

export type EnrollResult
  = | { ok: true, enrollmentId: string }
    | { ok: false, code: 'not_found' | 'exists' | 'catalog_hidden' }

/** Самозапись (docs/10 §6.1): enrollment с source=self на опубликованную версию. */
export async function selfEnroll(ctx: Ctx, courseId: string): Promise<EnrollResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [course] = await tx.select().from(courses)
      .where(and(eq(courses.id, courseId), eq(courses.status, 'published'), isNull(courses.deletedAt)))
    if (!course || !course.publishedVersionId) return { ok: false as const, code: 'not_found' as const }
    if (!course.isCatalogVisible) return { ok: false as const, code: 'catalog_hidden' as const }

    const existing = await tx.select({ id: enrollments.id }).from(enrollments)
      .where(and(eq(enrollments.userId, ctx.actorId), eq(enrollments.subjectId, courseId), notCancelled()))
    if (existing.length > 0) return { ok: false as const, code: 'exists' as const }

    const requiredTotal = await countRequired(tx, course.publishedVersionId)
    const [enrollment] = await tx.insert(enrollments).values({
      tenantId: ctx.tenantId,
      userId: ctx.actorId,
      subjectId: courseId,
      versionId: course.publishedVersionId,
      source: 'self',
      requiredTotal,
    }).returning({ id: enrollments.id })

    await logEvent(tx, ctx.tenantId, enrollment!.id, 'created', { source: 'self' }, ctx.actorId)
    return { ok: true as const, enrollmentId: enrollment!.id }
  })
}

/** Дерево курса с прогрессом и доступностью уроков (строгий порядок). */
export async function enrollmentTree(ctx: Ctx, enrollmentId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [enrollment] = await tx.select().from(enrollments)
      .where(and(eq(enrollments.id, enrollmentId), eq(enrollments.userId, ctx.actorId)))
    if (!enrollment) return null

    const [course] = await tx.select().from(courses).where(eq(courses.id, enrollment.subjectId))
    const [version] = await tx.select().from(courseVersions).where(eq(courseVersions.id, enrollment.versionId))

    const moduleRows = await tx.select().from(modules)
      .where(eq(modules.courseVersionId, enrollment.versionId))
      .orderBy(asc(modules.sort))
    const lessonRows = moduleRows.length
      ? await tx.select().from(lessons)
          .where(inArray(lessons.moduleId, moduleRows.map(m => m.id)))
          .orderBy(asc(lessons.sort))
      : []

    const progressRows = await tx.select().from(lessonProgress)
      .where(eq(lessonProgress.enrollmentId, enrollmentId))
    const progressByLesson = new Map(progressRows.map(p => [p.lessonId, p]))

    // Плоский порядок уроков: модули по sort, внутри — уроки по sort
    const ordered = moduleRows.flatMap(m =>
      lessonRows.filter(l => l.moduleId === m.id))

    let blocked = false
    const items = ordered.map((l) => {
      const progress = progressByLesson.get(l.id)
      const completed = progress?.status === 'completed'
      const available = !course!.strictOrder || !blocked
      if (course!.strictOrder && l.isRequired && !completed) blocked = true
      return {
        id: l.id,
        moduleId: l.moduleId,
        title: l.title,
        itemType: l.itemType,
        itemId: l.itemId,
        isRequired: l.isRequired,
        minSeconds: l.minSeconds,
        status: completed ? 'completed' : progress ? 'opened' : available ? 'available' : 'locked',
        secondsSpent: progress?.secondsSpent ?? 0,
      }
    })

    const resume = items.find(i => i.status !== 'completed' && i.status !== 'locked')

    return {
      enrollment,
      course: { id: course!.id, title: course!.title, strictOrder: course!.strictOrder },
      version: { id: version!.id, version: version!.version },
      modules: moduleRows.map(m => ({
        id: m.id,
        title: m.title,
        lessons: items.filter(i => i.moduleId === m.id),
      })),
      resumeLessonId: resume?.id ?? null,
    }
  })
}

/** Урок доступен, если предыдущие обязательные завершены (при строгом порядке). */
async function checkAvailable(tx: TenantTx, enrollment: typeof enrollments.$inferSelect, lessonId: string) {
  const [course] = await tx.select().from(courses).where(eq(courses.id, enrollment.subjectId))
  const moduleRows = await tx.select().from(modules)
    .where(eq(modules.courseVersionId, enrollment.versionId))
    .orderBy(asc(modules.sort))
  const lessonRows = moduleRows.length
    ? await tx.select().from(lessons)
        .where(inArray(lessons.moduleId, moduleRows.map(m => m.id)))
        .orderBy(asc(lessons.sort))
    : []
  const ordered = moduleRows.flatMap(m => lessonRows.filter(l => l.moduleId === m.id))

  const target = ordered.find(l => l.id === lessonId)
  if (!target) return { available: false as const, lesson: null }

  if (course!.strictOrder) {
    const progressRows = await tx.select().from(lessonProgress)
      .where(eq(lessonProgress.enrollmentId, enrollment.id))
    const done = new Set(progressRows.filter(p => p.status === 'completed').map(p => p.lessonId))
    for (const l of ordered) {
      if (l.id === lessonId) break
      if (l.isRequired && !done.has(l.id)) return { available: false as const, lesson: target }
    }
  }
  return { available: true as const, lesson: target }
}

export type OpenLessonResult
  = | { ok: true, lesson: Record<string, unknown>, progress: Record<string, unknown> }
    | { ok: false, code: 'not_found' | 'locked' }

/** Открытие урока: фиксирует opened, стартует запись (docs/10 §4.1). */
export async function openLesson(ctx: Ctx, enrollmentId: string, lessonId: string, device?: string): Promise<OpenLessonResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [enrollment] = await tx.select().from(enrollments)
      .where(and(eq(enrollments.id, enrollmentId), eq(enrollments.userId, ctx.actorId)))
    if (!enrollment) return { ok: false as const, code: 'not_found' as const }

    const { available, lesson } = await checkAvailable(tx, enrollment, lessonId)
    if (!lesson) return { ok: false as const, code: 'not_found' as const }
    if (!available) return { ok: false as const, code: 'locked' as const }

    const now = new Date()
    const [progress] = await tx.insert(lessonProgress).values({
      tenantId: ctx.tenantId,
      enrollmentId,
      lessonId,
      device: device ?? null,
    }).onConflictDoNothing().returning()

    const [current] = progress
      ? [progress]
      : await tx.select().from(lessonProgress)
          .where(and(eq(lessonProgress.enrollmentId, enrollmentId), eq(lessonProgress.lessonId, lessonId)))

    if (enrollment.status === 'not_started') {
      await tx.update(enrollments).set({
        status: 'in_progress',
        startedAt: enrollment.startedAt ?? now,
        lastActivityAt: now,
      }).where(eq(enrollments.id, enrollmentId))
      await logEvent(tx, ctx.tenantId, enrollmentId, 'started', {}, ctx.actorId)
    }
    else {
      await tx.update(enrollments).set({ lastActivityAt: now }).where(eq(enrollments.id, enrollmentId))
    }

    const material = await lessonMaterial(tx, lesson)
    const [mod] = await tx.select({ title: modules.title, sort: modules.sort }).from(modules).where(eq(modules.id, lesson.moduleId))
    const evaluation = material ? evaluateLesson(material.facts, progressFacts(current!)) : null

    return {
      ok: true as const,
      lesson: {
        id: lesson.id,
        title: lesson.title,
        itemType: lesson.itemType,
        itemId: lesson.itemId,
        minSeconds: lesson.minSeconds,
        videoThresholdPct: lesson.videoThresholdPct,
        isRequired: lesson.isRequired,
        body: material?.facts.body ?? [],
        kind: material?.facts.kind ?? null,
        mediaId: material?.mediaId ?? null,
        externalUrl: material?.externalUrl ?? null,
        resourceVersion: material?.version ?? null,
        requiredSeconds: evaluation?.requiredSeconds ?? lesson.minSeconds,
        canPrint: material ? await printAllowed(tx, ctx.tenantId, material.allowPrint) : false,
        section: mod ? { title: mod.title, number: mod.sort + 1 } : null,
      },
      progress: {
        status: current!.status,
        secondsSpent: current!.secondsSpent,
        blocksState: current!.blocksState,
        videoPct: current!.videoPct,
        scrollPct: current!.scrollPct,
        acknowledged: !!current!.acknowledgedAt,
        downloaded: !!current!.downloadedAt,
        ready: evaluation?.ready ?? false,
        reasons: evaluation?.reasons ?? [],
      },
    }
  })
}

/**
 * Материал урока-ресурса: закреплённый снимок (Г-11.3), иначе текущая опубликованная версия,
 * иначе рабочая редакция (курс, опубликованный до появления версий). Возвращает факты для правила зачёта.
 */
async function lessonMaterial(tx: TenantTx, lesson: typeof lessons.$inferSelect) {
  if (lesson.itemType !== 'resource') return null
  const [resource] = await tx.select().from(resources).where(eq(resources.id, lesson.itemId))
  if (!resource) return null
  const v = await currentVersion(tx, lesson.itemId, lesson.resourceVersionId)
  const kind = (v?.kind ?? resource.kind) as ResourceKind
  const mediaId = v ? v.mediaId : resource.mediaId
  let pages: number | null = null
  if (kind === 'file' && mediaId) {
    const [m] = await tx.select({ pages: sql<number | null>`(${mediaAssets.variants}->>'pages')::int` }).from(mediaAssets).where(eq(mediaAssets.id, mediaId))
    pages = m?.pages ?? null
  }
  return {
    version: v?.version ?? null,
    mediaId,
    externalUrl: v ? v.externalUrl : resource.externalUrl,
    allowPrint: resource.allowPrint,
    facts: {
      kind,
      body: (v?.body ?? resource.body ?? []) as ContentBlock[],
      plainText: v?.plainText ?? resource.plainText,
      pages,
      minSeconds: lesson.minSeconds,
      videoThresholdPct: lesson.videoThresholdPct,
    },
  }
}

function progressFacts(p: typeof lessonProgress.$inferSelect) {
  return {
    secondsSpent: p.secondsSpent,
    scrollPct: p.scrollPct,
    videoPct: p.videoPct,
    acknowledged: !!p.acknowledgedAt,
    downloaded: !!p.downloadedAt,
    blocksState: p.blocksState as Record<string, unknown>,
  }
}

export const TICK_MAX_SECONDS = 20
export const TICK_MIN_INTERVAL_MS = 10_000

export interface TickResult extends Evaluation {
  secondsSpent: number
  videoPct: number
  scrollPct: number
}

/**
 * Тик (docs/11 §7.4, docs/04 §4.5): клиент присылает факты — секунды, докуда доскроллил, сколько видео
 * просмотрено; сервер решает. Идемпотентно и защищено от накрутки: за тик засчитывается не больше
 * 20 секунд и не больше реально прошедшего с прошлого тика времени; тики чаще раза в 10 секунд
 * времени не добавляют; проценты только растут (максимум). Ответ — состояние и готовность к зачёту
 * по правилу типа (Г-11.5): клиент показывает подпись, завершает `complete`.
 */
export async function tickLesson(ctx: Ctx, enrollmentId: string, lessonId: string, input: TickInput): Promise<TickResult | null> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [enrollment] = await tx.select().from(enrollments)
      .where(and(eq(enrollments.id, enrollmentId), eq(enrollments.userId, ctx.actorId)))
    if (!enrollment) return null

    const [progress] = await tx.select().from(lessonProgress)
      .where(and(eq(lessonProgress.enrollmentId, enrollmentId), eq(lessonProgress.lessonId, lessonId)))
    if (!progress) return null
    const [lesson] = await tx.select().from(lessons).where(eq(lessons.id, lessonId))
    if (!lesson) return null

    const now = new Date()
    const since = progress.lastTickAt ?? progress.firstOpenedAt
    const elapsedSec = Math.round((now.getTime() - since.getTime()) / 1000)
    const tooSoon = !!progress.lastTickAt && now.getTime() - progress.lastTickAt.getTime() < TICK_MIN_INTERVAL_MS
    const addSeconds = tooSoon || progress.status === 'completed'
      ? 0
      : Math.max(0, Math.min(input.seconds, TICK_MAX_SECONDS, elapsedSec))

    const [updated] = await tx.update(lessonProgress).set({
      secondsSpent: progress.secondsSpent + addSeconds,
      ...(addSeconds > 0 ? { lastTickAt: now } : {}),
      ...(input.blocksState
        ? { blocksState: { ...(progress.blocksState as Record<string, unknown>), ...input.blocksState } }
        : {}),
      ...(input.videoPct !== undefined ? { videoPct: Math.max(progress.videoPct, input.videoPct) } : {}),
      ...(input.scrollPct !== undefined ? { scrollPct: Math.max(progress.scrollPct, input.scrollPct) } : {}),
      ...(input.device ? { device: input.device } : {}),
      updatedAt: now,
    }).where(eq(lessonProgress.id, progress.id)).returning()

    if (addSeconds > 0) {
      await tx.update(enrollments).set({
        lastActivityAt: now,
        timeSpentSec: enrollment.timeSpentSec + addSeconds,
      }).where(eq(enrollments.id, enrollmentId))
    }

    const material = await lessonMaterial(tx, lesson)
    const evaluation: Evaluation = material
      ? evaluateLesson(material.facts, progressFacts(updated!))
      : { ready: false, reasons: [], requiredSeconds: lesson.minSeconds }
    return { secondsSpent: updated!.secondsSpent, videoPct: updated!.videoPct, scrollPct: updated!.scrollPct, ...evaluation }
  })
}

/** «Я ознайомився» для ссылки (docs/04 §4.5 acknowledge, Г-11.5); идемпотентно. */
export async function acknowledgeLesson(ctx: Ctx, enrollmentId: string, lessonId: string): Promise<TickResult | null> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [enrollment] = await tx.select({ id: enrollments.id }).from(enrollments)
      .where(and(eq(enrollments.id, enrollmentId), eq(enrollments.userId, ctx.actorId)))
    if (!enrollment) return null
    const [progress] = await tx.update(lessonProgress).set({ acknowledgedAt: sql`coalesce(${lessonProgress.acknowledgedAt}, now())`, updatedAt: new Date() })
      .where(and(eq(lessonProgress.enrollmentId, enrollmentId), eq(lessonProgress.lessonId, lessonId))).returning()
    if (!progress) return null
    const [lesson] = await tx.select().from(lessons).where(eq(lessons.id, lessonId))
    const material = lesson ? await lessonMaterial(tx, lesson) : null
    const evaluation: Evaluation = material ? evaluateLesson(material.facts, progressFacts(progress)) : { ready: false, reasons: [], requiredSeconds: null }
    return { secondsSpent: progress.secondsSpent, videoPct: progress.videoPct, scrollPct: progress.scrollPct, ...evaluation }
  })
}

/** Документ скачан (Г-11.5: «пролистан до конца либо скачан»); отметка идемпотентна. */
export async function markDownloaded(ctx: Ctx, enrollmentId: string, lessonId: string): Promise<TickResult | null> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [enrollment] = await tx.select({ id: enrollments.id }).from(enrollments)
      .where(and(eq(enrollments.id, enrollmentId), eq(enrollments.userId, ctx.actorId)))
    if (!enrollment) return null
    const [progress] = await tx.update(lessonProgress).set({ downloadedAt: sql`coalesce(${lessonProgress.downloadedAt}, now())`, updatedAt: new Date() })
      .where(and(eq(lessonProgress.enrollmentId, enrollmentId), eq(lessonProgress.lessonId, lessonId))).returning()
    if (!progress) return null
    const [lesson] = await tx.select().from(lessons).where(eq(lessons.id, lessonId))
    const material = lesson ? await lessonMaterial(tx, lesson) : null
    const evaluation: Evaluation = material ? evaluateLesson(material.facts, progressFacts(progress)) : { ready: false, reasons: [], requiredSeconds: null }
    return { secondsSpent: progress.secondsSpent, videoPct: progress.videoPct, scrollPct: progress.scrollPct, ...evaluation }
  })
}

export type CompleteResult
  = | { ok: true, courseCompleted: boolean, progressPct: number }
    | { ok: false, code: 'not_found' | 'conditions_not_met', reasons?: string[] }

/** Завершение урока: сервер проверяет условия (docs/11 §7.3), клиент только просит. */
export async function completeLesson(ctx: Ctx, enrollmentId: string, lessonId: string): Promise<CompleteResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [enrollment] = await tx.select().from(enrollments)
      .where(and(eq(enrollments.id, enrollmentId), eq(enrollments.userId, ctx.actorId)))
    if (!enrollment) return { ok: false as const, code: 'not_found' as const }

    const [lesson] = await tx.select().from(lessons).where(eq(lessons.id, lessonId))
    const [progress] = await tx.select().from(lessonProgress)
      .where(and(eq(lessonProgress.enrollmentId, enrollmentId), eq(lessonProgress.lessonId, lessonId)))
    if (!lesson || !progress) return { ok: false as const, code: 'not_found' as const }

    if (progress.status !== 'completed') {
      const reasons: string[] = []
      if (lesson.itemType === 'quiz') {
        // Урок-тест закрывается зачётом попытки (attempts.ts → onAttemptPassed), не кнопкой
        return { ok: false as const, code: 'conditions_not_met' as const, reasons: ['Складіть тест'] }
      }
      if (lesson.itemType === 'workshop') {
        return { ok: false as const, code: 'conditions_not_met' as const, reasons: ['Здайте практикум'] }
      }
      // Правило зачёта по типу материала (Г-11.5) + min_seconds, чек-листы, видео-блоки (docs/11 §7.3)
      const material = await lessonMaterial(tx, lesson)
      if (material) reasons.push(...evaluateLesson(material.facts, progressFacts(progress)).reasons)
      else if (lesson.minSeconds && progress.secondsSpent < lesson.minSeconds) reasons.push(`Ще ${lesson.minSeconds - progress.secondsSpent} секунд`)

      if (reasons.length > 0) {
        return { ok: false as const, code: 'conditions_not_met' as const, reasons: [...new Set(reasons)] }
      }

      await tx.update(lessonProgress).set({
        status: 'completed',
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(lessonProgress.id, progress.id))
    }

    // Пересчёт прогресса (docs/10 §7.2–7.3)
    const requiredLessonIds = (await tx.select({ id: lessons.id })
      .from(lessons)
      .innerJoin(modules, eq(modules.id, lessons.moduleId))
      .where(and(eq(modules.courseVersionId, enrollment.versionId), eq(lessons.isRequired, true))))
      .map(r => r.id)

    const doneRows = requiredLessonIds.length
      ? await tx.select({ lessonId: lessonProgress.lessonId }).from(lessonProgress)
          .where(and(
            eq(lessonProgress.enrollmentId, enrollmentId),
            eq(lessonProgress.status, 'completed'),
            inArray(lessonProgress.lessonId, requiredLessonIds),
          ))
      : []

    const requiredTotal = requiredLessonIds.length
    const requiredDone = doneRows.length
    const progressPct = requiredTotal === 0 ? 100 : Math.floor(requiredDone / requiredTotal * 100)
    const courseCompleted = requiredTotal > 0 && requiredDone === requiredTotal

    await tx.update(enrollments).set({
      requiredTotal,
      requiredDone,
      progressPct: String(progressPct),
      ...(courseCompleted && enrollment.status !== 'done'
        ? { status: 'done', completedAt: new Date() }
        : {}),
      lastActivityAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(enrollments.id, enrollmentId))
    if (courseCompleted && enrollment.status !== 'done') business.inc({ event: 'course_completed' })

    await logEvent(tx, ctx.tenantId, enrollmentId, courseCompleted ? 'completed' : 'progress', {
      lessonId,
      progressPct,
    }, ctx.actorId)
    if (courseCompleted) {
      const { emitWebhook } = await import('./webhooks')
      await emitWebhook(tx, ctx.tenantId, 'enrollment.completed', { enrollmentId, userId: ctx.actorId, courseId: enrollment.subjectId })
    }

    return { ok: true as const, courseCompleted, progressPct }
  }).then(async (res) => {
    // Сертификат за курс — после фиксации completed, отдельной транзакцией (docs/14 §7.3, идемпотентно)
    if (res.ok && res.courseCompleted) {
      const { issueForEnrollment } = await import('./certificates')
      await issueForEnrollment(ctx, enrollmentId).catch(err => console.error('certificate.issue failed', err))
      const { runRules } = await import('./automation')
      const [e] = await withTenant(ctx.tenantId, ctx.actorId, tx => tx.select({ courseId: enrollments.subjectId }).from(enrollments).where(eq(enrollments.id, enrollmentId)))
      runRules(ctx.tenantId, 'course.completed', ctx.actorId, { courseId: e?.courseId, enrollmentId }).catch(err => console.error('rules course.completed', err))
      if (e) import('./programs').then(p => p.onItemResult(ctx.tenantId, ctx.actorId, 'course', e.courseId, { passed: true, enrollmentId })).catch(err => console.error('program course hook', err))
      if (e) import('./trajectories').then(t => t.onTaskResult(ctx.tenantId, ctx.actorId, 'course', e.courseId, { passed: true })).catch(err => console.error('trajectory course hook', err))
      // docs/19 §7.3: курс с компетенцией и сданным итоговым тестом → оценка уровня source=test
      if (e) import('./developmentExtra').then(d => d.onCourseCompletedCompetency(ctx.tenantId, ctx.actorId, e.courseId, enrollmentId)).catch(err => console.error('competency course hook', err))
      if (e) {
        const { triggerCourseFeedback } = await import('./surveys')
        triggerCourseFeedback(ctx.tenantId, ctx.actorId, e.courseId, enrollmentId).catch(err => console.error('survey trigger', err))
      }
    }
    return res
  })
}
