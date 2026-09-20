import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { z } from 'zod'
import {
  assignments, courseVersions, courses, lessons, meetups, mediaAssets, modules, resourceVersions, resources, users,
} from '../db/schema'
import type { TenantTx } from '../utils/withTenant'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'
import { sanitizeBody } from './sanitize'
import { blocksToText } from './knowledge'
import type {
  ContentBlock, courseCreateSchema, courseUpdateSchema, lessonCreateSchema, lessonUpdateSchema,
} from '../../shared/schemas/content'
import { resourceKindComplete, type ResourceKind } from '../../shared/schemas/resources'

interface Ctx { tenantId: string, actorId: string }

/** Транслитерация украинского в slug. */
export function slugify(title: string): string {
  const map: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh',
    з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n',
    о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts',
    ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', ы: 'y', э: 'e', ё: 'e', ъ: '',
  }
  const slug = title.toLowerCase()
    .split('')
    .map(ch => map[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug.length >= 3 ? slug : `course-${randomUUID().slice(0, 8)}`
}

/** Список курсов по мокапу ContentCourses: Назва (Код · N розділів, M елементів) · Тривалість · Результат по · Автор · Дата зміни · Опубліковано. */
export async function listCourses(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select({
      course: courses,
      authorName: users.fullName,
    }).from(courses)
      .leftJoin(users, eq(users.id, courses.createdBy))
      .where(isNull(courses.deletedAt))
      .orderBy(desc(courses.updatedAt))
    if (!rows.length) return []
    // Состав считается по последней версии (черновой, если есть)
    const stats = await tx.execute(sql`
      select v.course_id, count(distinct m.id)::int as sections, count(l.id)::int as items
      from course_versions v
      join (select course_id, max(version) as version from course_versions group by course_id) last
        on last.course_id = v.course_id and last.version = v.version
      left join modules m on m.course_version_id = v.id
      left join lessons l on l.module_id = m.id
      where v.course_id in ${sql.raw(`(${rows.map(r => `'${r.course.id}'`).join(',')})`)}
      group by v.course_id
    `) as unknown as { course_id: string, sections: number, items: number }[]
    const statOf = new Map(stats.map(s => [s.course_id, s]))
    return rows.map(({ course, authorName }) => ({
      ...course,
      authorName,
      sections: statOf.get(course.id)?.sections ?? 0,
      items: statOf.get(course.id)?.items ?? 0,
    }))
  })
}

/** Создание курса: сразу черновая версия 1. */
export async function createCourse(ctx: Ctx, input: z.infer<typeof courseCreateSchema>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [course] = await tx.insert(courses).values({
      tenantId: ctx.tenantId,
      title: input.title,
      slug: input.slug || slugify(input.title),
      summary: input.summary ?? null,
      categoryId: input.categoryId ?? null,
      language: input.language,
      estimatedMinutes: input.estimatedMinutes ?? null,
      strictOrder: input.strictOrder,
      isCatalogVisible: input.isCatalogVisible,
      validityMonths: input.validityMonths ?? null,
      competencyId: input.competencyId ?? null,
      competencyLevel: input.competencyLevel ?? null,
      tags: input.tags,
      coverKey: input.coverKey ?? null,
      code: input.code ?? null,
      iconKey: input.iconKey ?? null,
      durationDays: input.durationDays ?? null,
      workload: input.workload ?? null,
      resultMode: input.resultMode ?? 'pct',
      createdBy: ctx.actorId,
    }).returning()

    const [version] = await tx.insert(courseVersions).values({
      tenantId: ctx.tenantId,
      courseId: course!.id,
      version: 1,
      status: 'draft',
    }).returning()

    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'course.create',
      entity: 'course',
      entityId: course!.id,
      after: { title: course!.title },
    })
    return { ...course!, draftVersionId: version!.id }
  })
}

export async function updateCourse(ctx: Ctx, courseId: string, input: z.infer<typeof courseUpdateSchema>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(courses)
      .where(and(eq(courses.id, courseId), isNull(courses.deletedAt)))
    if (!before) return null

    const [after] = await tx.update(courses).set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
      ...(input.estimatedMinutes !== undefined ? { estimatedMinutes: input.estimatedMinutes } : {}),
      ...(input.strictOrder !== undefined ? { strictOrder: input.strictOrder } : {}),
      ...(input.isCatalogVisible !== undefined ? { isCatalogVisible: input.isCatalogVisible } : {}),
      ...(input.validityMonths !== undefined ? { validityMonths: input.validityMonths } : {}),
      ...(input.competencyId !== undefined ? { competencyId: input.competencyId } : {}),
      ...(input.competencyLevel !== undefined ? { competencyLevel: input.competencyLevel } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.coverKey !== undefined ? { coverKey: input.coverKey } : {}),
      ...(input.code !== undefined ? { code: input.code } : {}),
      ...(input.iconKey !== undefined ? { iconKey: input.iconKey } : {}),
      ...(input.durationDays !== undefined ? { durationDays: input.durationDays } : {}),
      ...(input.workload !== undefined ? { workload: input.workload } : {}),
      ...(input.resultMode !== undefined ? { resultMode: input.resultMode } : {}),
      updatedAt: new Date(),
    }).where(eq(courses.id, courseId)).returning()

    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'course.update',
      entity: 'course',
      entityId: courseId,
      before: { title: before.title },
      after: { title: after!.title },
    })
    return after!
  })
}

/** Черновая версия для редактора: последняя draft, либо создаётся копией published. */
export async function ensureDraftVersion(ctx: Ctx, courseId: string): Promise<string | null> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [draft] = await tx.select().from(courseVersions)
      .where(and(eq(courseVersions.courseId, courseId), eq(courseVersions.status, 'draft')))
      .orderBy(desc(courseVersions.version))
      .limit(1)
    if (draft) return draft.id

    const [latest] = await tx.select().from(courseVersions)
      .where(eq(courseVersions.courseId, courseId))
      .orderBy(desc(courseVersions.version))
      .limit(1)
    if (!latest) return null

    // Правка опубликованного курса создаёт черновую версию (docs/11 §7.1)
    const [newDraft] = await tx.insert(courseVersions).values({
      tenantId: ctx.tenantId,
      courseId,
      version: latest.version + 1,
      status: 'draft',
    }).returning()

    const oldModules = await tx.select().from(modules)
      .where(eq(modules.courseVersionId, latest.id))
      .orderBy(asc(modules.sort))
    for (const mod of oldModules) {
      const [newMod] = await tx.insert(modules).values({
        tenantId: ctx.tenantId,
        courseVersionId: newDraft!.id,
        title: mod.title,
        sort: mod.sort,
      }).returning()
      const oldLessons = await tx.select().from(lessons)
        .where(eq(lessons.moduleId, mod.id))
        .orderBy(asc(lessons.sort))
      if (oldLessons.length) {
        await tx.insert(lessons).values(oldLessons.map(l => ({
          tenantId: ctx.tenantId,
          moduleId: newMod!.id,
          title: l.title,
          sort: l.sort,
          itemType: l.itemType,
          itemId: l.itemId,
          isRequired: l.isRequired,
          minSeconds: l.minSeconds,
          videoThresholdPct: l.videoThresholdPct,
          passScorePct: l.passScorePct,
          resourceVersionId: l.resourceVersionId,
        })))
      }
    }
    return newDraft!.id
  })
}

/** Курс для редактора: черновая версия с деревом и телами материалов. */
export async function getCourseEditor(ctx: Ctx, courseId: string) {
  const draftId = await ensureDraftVersion(ctx, courseId)
  if (!draftId) return null

  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [course] = await tx.select().from(courses)
      .where(and(eq(courses.id, courseId), isNull(courses.deletedAt)))
    if (!course) return null

    const [version] = await tx.select().from(courseVersions)
      .where(eq(courseVersions.id, draftId))

    const moduleRows = await tx.select().from(modules)
      .where(eq(modules.courseVersionId, draftId))
      .orderBy(asc(modules.sort))

    const lessonRows = moduleRows.length
      ? await tx.select().from(lessons)
          .where(inArray(lessons.moduleId, moduleRows.map(m => m.id)))
          .orderBy(asc(lessons.sort))
      : []

    const resourceIds = lessonRows.filter(l => l.itemType === 'resource').map(l => l.itemId)
    const resourceRows = resourceIds.length
      ? await tx.select().from(resources).where(inArray(resources.id, resourceIds))
      : []
    const resourceById = new Map(resourceRows.map(r => [r.id, r]))

    return {
      course,
      version,
      modules: moduleRows.map(m => ({
        ...m,
        lessons: lessonRows.filter(l => l.moduleId === m.id).map(l => ({
          ...l,
          body: l.itemType === 'resource' ? (resourceById.get(l.itemId)?.body ?? []) : [],
          resource: l.itemType === 'resource' && resourceById.get(l.itemId)
            ? { kind: resourceById.get(l.itemId)!.kind, status: resourceById.get(l.itemId)!.status, estimatedMinutes: resourceById.get(l.itemId)!.estimatedMinutes, version: resourceById.get(l.itemId)!.version, mediaId: resourceById.get(l.itemId)!.mediaId, externalUrl: resourceById.get(l.itemId)!.externalUrl }
            : null,
        })),
      })),
    }
  })
}

export async function addModule(ctx: Ctx, courseId: string, title: string) {
  const draftId = await ensureDraftVersion(ctx, courseId)
  if (!draftId) return null
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const existing = await tx.select().from(modules).where(eq(modules.courseVersionId, draftId))
    const [mod] = await tx.insert(modules).values({
      tenantId: ctx.tenantId,
      courseVersionId: draftId,
      title,
      sort: existing.length,
    }).returning()
    return mod!
  })
}

export type AddLessonResult
  = | { ok: true, lesson: typeof lessons.$inferSelect }
    | { ok: false, code: 'section_required' | 'resource_not_found' | 'resource_not_published' | 'meetup_not_found' }

/**
 * Элемент плана. Раздел — обязательный уровень (docs/11 §14.1): без раздела элемент не создаётся.
 * Ресурс либо создаётся из тела («Створити і підключити ресурс»), либо подключается из библиотеки
 * по `resourceId` — только опубликованный (docs/11 §5.4: ссылок на архивированные материалы нет).
 */
export async function addLesson(ctx: Ctx, input: z.infer<typeof lessonCreateSchema>): Promise<AddLessonResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [mod] = await tx.select().from(modules).where(eq(modules.id, input.moduleId))
    if (!mod) return { ok: false as const, code: 'section_required' as const }

    let itemId: string
    if (input.itemType === 'quiz') {
      itemId = input.quizId!
    }
    else if (input.itemType === 'workshop') {
      itemId = input.workshopId!
    }
    else if (input.itemType === 'meetup') {
      // Урок-заняття (docs/29 Б.3, docs/18 §14.1): itemId = meetups.id, дата/місце — у сесіях
      // на призначенні, зачёт — по відвідуванню (learning.ts completeLesson).
      const [meetup] = await tx.select({ id: meetups.id, status: meetups.status }).from(meetups)
        .where(and(eq(meetups.id, input.meetupId!), inArray(meetups.kind, ['meetup', 'webinar'])))
      if (!meetup) return { ok: false as const, code: 'meetup_not_found' as const }
      itemId = meetup.id
    }
    else if (input.resourceId) {
      const [existing] = await tx.select({ id: resources.id, status: resources.status, title: resources.title }).from(resources)
        .where(and(eq(resources.id, input.resourceId), isNull(resources.deletedAt)))
      if (!existing) return { ok: false as const, code: 'resource_not_found' as const }
      if (existing.status !== 'published') return { ok: false as const, code: 'resource_not_published' as const }
      itemId = existing.id
    }
    else {
      const cleanBody = sanitizeBody(input.resource!.body as ContentBlock[])
      const [resource] = await tx.insert(resources).values({
        tenantId: ctx.tenantId,
        title: input.title,
        slug: `${slugify(input.title)}-${randomUUID().slice(0, 6)}`,
        kind: 'article',
        body: cleanBody,
        plainText: blocksToText(cleanBody),
        authorIds: [ctx.actorId],
        status: 'draft', // опубликуется (снимок версии) вместе с курсом
      }).returning({ id: resources.id })
      itemId = resource!.id
    }

    const existing = await tx.select().from(lessons).where(eq(lessons.moduleId, input.moduleId))
    const [lesson] = await tx.insert(lessons).values({
      tenantId: ctx.tenantId,
      moduleId: input.moduleId,
      title: input.title,
      sort: existing.length,
      itemType: input.itemType,
      itemId,
      isRequired: input.isRequired,
      minSeconds: input.minSeconds ?? null,
      videoThresholdPct: input.videoThresholdPct,
      passScorePct: input.itemType === 'quiz' && input.passScorePct != null ? String(input.passScorePct) : null,
    }).returning()
    return { ok: true as const, lesson: lesson! }
  })
}

export async function updateLesson(ctx: Ctx, lessonId: string, input: z.infer<typeof lessonUpdateSchema>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [lesson] = await tx.select().from(lessons).where(eq(lessons.id, lessonId))
    if (!lesson) return null

    if (input.body !== undefined && lesson.itemType === 'resource') {
      const cleanBody = sanitizeBody(input.body as ContentBlock[])
      await tx.update(resources).set({
        body: cleanBody,
        plainText: blocksToText(cleanBody),
        version: (await tx.select({ v: resources.version }).from(resources).where(eq(resources.id, lesson.itemId)))[0]!.v + 1,
        updatedAt: new Date(),
      }).where(eq(resources.id, lesson.itemId))
    }

    const [updated] = await tx.update(lessons).set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.isRequired !== undefined ? { isRequired: input.isRequired } : {}),
      ...(input.minSeconds !== undefined ? { minSeconds: input.minSeconds } : {}),
      ...(input.videoThresholdPct !== undefined ? { videoThresholdPct: input.videoThresholdPct } : {}),
      ...(input.passScorePct !== undefined && lesson.itemType === 'quiz' ? { passScorePct: input.passScorePct == null ? null : String(input.passScorePct) } : {}),
      updatedAt: new Date(),
    }).where(eq(lessons.id, lessonId)).returning()

    if (input.title !== undefined && lesson.itemType === 'resource') {
      await tx.update(resources).set({ title: input.title }).where(eq(resources.id, lesson.itemId))
    }
    return updated!
  })
}

export async function deleteLesson(ctx: Ctx, lessonId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [lesson] = await tx.delete(lessons).where(eq(lessons.id, lessonId)).returning()
    return lesson ?? null
  })
}

export async function reorderLessons(ctx: Ctx, items: { id: string, moduleId?: string, sort: number }[]) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    for (const item of items) {
      await tx.update(lessons).set({
        sort: item.sort,
        ...(item.moduleId ? { moduleId: item.moduleId } : {}),
      }).where(eq(lessons.id, item.id))
    }
    return true
  })
}

export interface PublishCheck {
  code: string
  label: string
  ok: boolean
}

/** Проверки публикации (docs/03 §3.6, docs/11 §5.4). */
export async function publishChecks(ctx: Ctx, courseId: string): Promise<PublishCheck[] | null> {
  const editor = await getCourseEditor(ctx, courseId)
  if (!editor) return null

  const allLessons = editor.modules.flatMap(m => m.lessons)
  const quizLessons = allLessons.filter(l => l.itemType === 'quiz')
  const quizzesOk = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    if (quizLessons.length === 0) return true
    const { quizzes } = await import('../db/schema')
    const rows = await tx.select({ id: quizzes.id, count: quizzes.questionCount, mode: quizzes.selectionMode })
      .from(quizzes).where(inArray(quizzes.id, quizLessons.map(l => l.itemId)))
    return rows.length === quizLessons.length && rows.every(r => r.mode === 'random' || r.count > 0)
  })
  const mediaIds = allLessons.flatMap(l =>
    (l.body as ContentBlock[]).flatMap(b =>
      'mediaId' in b ? [b.mediaId] : [],
    ))

  const mediaReady = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    if (mediaIds.length === 0) return true
    const rows = await tx.select({ status: mediaAssets.status }).from(mediaAssets)
      .where(inArray(mediaAssets.id, mediaIds))
    return rows.length === mediaIds.length && rows.every(r => r.status === 'ready')
  })

  const resourceLessons = allLessons.filter(l => l.itemType === 'resource')
  const resourcesOk = resourceLessons.every(l => l.resource && l.resource.status !== 'archived')

  return [
    { code: 'has_sections', label: 'У курсі є хоча б один розділ', ok: editor.modules.length > 0 },
    { code: 'has_lessons', label: 'У курсі є хоча б один урок', ok: allLessons.length > 0 },
    { code: 'resources_available', label: 'Немає посилань на архівовані матеріали', ok: resourcesOk },
    {
      code: 'lessons_have_content',
      label: 'У кожного уроку заповнений матеріал',
      ok: allLessons.every(l => l.itemType !== 'resource' || (!!l.resource && resourceKindComplete({ kind: l.resource.kind as ResourceKind, mediaId: l.resource.mediaId, externalUrl: l.resource.externalUrl, body: l.body as unknown[] }))),
    },
    { code: 'quizzes_have_questions', label: 'У кожного тесту є питання', ok: quizzesOk },
    { code: 'media_ready', label: 'Усі медіафайли оброблені', ok: mediaReady },
  ]
}

export type PublishResult
  = | { ok: true, versionId: string, version: number }
    | { ok: false, code: 'not_found' | 'not_publishable', checks?: PublishCheck[] }

/**
 * Публикация: draft → published, прошлая published → retired, одной транзакцией.
 * Уроки-ресурсы закрепляются за снимком ресурса (Г-11.3): если рабочая редакция ресурса отличается
 * от опубликованной (или снимка ещё нет — ресурс создан в плане), публикация курса делает новый снимок.
 * `notifyAssigned` — «Сповістити про оновлення» (docs/11 §14.2): сразу разослать назначенным,
 * иначе — только баннер «N завдань було змінено» (docs/15 §14.6).
 */
export async function publishCourse(ctx: Ctx, courseId: string, changelog: string, notifyAssigned = false): Promise<PublishResult> {
  const checks = await publishChecks(ctx, courseId)
  if (!checks) return { ok: false, code: 'not_found' }
  if (checks.some(c => !c.ok)) return { ok: false, code: 'not_publishable', checks }

  const result = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [draft] = await tx.select().from(courseVersions)
      .where(and(eq(courseVersions.courseId, courseId), eq(courseVersions.status, 'draft')))
      .orderBy(desc(courseVersions.version))
      .limit(1)
    if (!draft) return { ok: false as const, code: 'not_found' as const }

    await pinResourceVersions(tx, ctx, draft.id, `Публікація курсу, версія ${draft.version}`)

    await tx.update(courseVersions)
      .set({ status: 'retired', updatedAt: new Date() })
      .where(and(eq(courseVersions.courseId, courseId), eq(courseVersions.status, 'published')))

    await tx.update(courseVersions).set({
      status: 'published',
      changelog,
      publishedAt: new Date(),
      publishedBy: ctx.actorId,
      updatedAt: new Date(),
    }).where(eq(courseVersions.id, draft.id))

    await tx.update(courses).set({
      status: 'published',
      publishedVersionId: draft.id,
      updatedAt: new Date(),
    }).where(eq(courses.id, courseId))

    // docs/15 §14.6: правка контента копится в баннер «N завдань було змінено», рассылка — по команде администратора
    const { markContentChanged } = await import('./tasks')
    await markContentChanged(tx, 'course', courseId)
    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'course.publish',
      entity: 'course',
      entityId: courseId,
      after: { version: draft.version, changelog, notifyAssigned },
    })
    const assignmentIds = notifyAssigned
      ? (await tx.select({ id: assignments.id }).from(assignments)
          .where(and(eq(assignments.subjectType, 'course'), eq(assignments.subjectId, courseId), inArray(assignments.status, ['active', 'paused']))))
          .map(a => a.id)
      : []
    return { ok: true as const, versionId: draft.id, version: draft.version, assignmentIds }
  })
  if (result.ok && result.assignmentIds.length) {
    const { notifyChanged } = await import('./tasks')
    await notifyChanged(ctx, result.assignmentIds)
  }
  return result.ok ? { ok: true, versionId: result.versionId, version: result.version } : result
}

/** Снимки ресурсов для уроков версии курса: закрепить существующий или сделать новый, если редакция изменилась. */
async function pinResourceVersions(tx: TenantTx, ctx: Ctx, courseVersionId: string, changelog: string) {
  const rows = await tx.select({ lesson: lessons, resource: resources }).from(lessons)
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(resources, eq(resources.id, lessons.itemId))
    .where(and(eq(modules.courseVersionId, courseVersionId), eq(lessons.itemType, 'resource')))
  for (const { lesson, resource } of rows) {
    let versionId = resource.publishedVersionId
    let changed = !versionId
    if (versionId) {
      const [v] = await tx.select().from(resourceVersions).where(eq(resourceVersions.id, versionId))
      changed = !v || v.title !== resource.title || v.kind !== resource.kind || v.mediaId !== resource.mediaId
        || v.externalUrl !== resource.externalUrl || JSON.stringify(v.body) !== JSON.stringify(resource.body)
    }
    if (changed) {
      const version = resource.publishedVersionId ? resource.version + 1 : 1
      const [snap] = await tx.insert(resourceVersions).values({
        tenantId: ctx.tenantId, resourceId: resource.id, version, title: resource.title, kind: resource.kind,
        body: resource.body, plainText: resource.plainText, mediaId: resource.mediaId, externalUrl: resource.externalUrl,
        changelog, publishedBy: ctx.actorId,
      }).returning({ id: resourceVersions.id })
      await tx.update(resources).set({ status: 'published', version, publishedVersionId: snap!.id, updatedAt: new Date() }).where(eq(resources.id, resource.id))
      versionId = snap!.id
    }
    if (lesson.resourceVersionId !== versionId) {
      await tx.update(lessons).set({ resourceVersionId: versionId }).where(eq(lessons.id, lesson.id))
    }
  }
}
