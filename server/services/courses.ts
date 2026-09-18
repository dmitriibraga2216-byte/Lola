import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { z } from 'zod'
import {
  courseVersions, courses, lessons, mediaAssets, modules, resources,
} from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'
import { sanitizeBody } from './sanitize'
import type {
  ContentBlock, courseCreateSchema, courseUpdateSchema, lessonCreateSchema, lessonUpdateSchema,
} from '../../shared/schemas/content'

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

export async function listCourses(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select().from(courses)
      .where(isNull(courses.deletedAt))
      .orderBy(desc(courses.updatedAt))
    return rows
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
      tags: input.tags,
      coverKey: input.coverKey ?? null,
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
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.coverKey !== undefined ? { coverKey: input.coverKey } : {}),
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

export async function addLesson(ctx: Ctx, input: z.infer<typeof lessonCreateSchema>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [mod] = await tx.select().from(modules).where(eq(modules.id, input.moduleId))
    if (!mod) return null

    const [resource] = await tx.insert(resources).values({
      tenantId: ctx.tenantId,
      title: input.title,
      slug: `${slugify(input.title)}-${randomUUID().slice(0, 6)}`,
      kind: 'article',
      body: sanitizeBody(input.resource.body as ContentBlock[]),
      authorIds: [ctx.actorId],
      status: 'published',
    }).returning({ id: resources.id })

    const existing = await tx.select().from(lessons).where(eq(lessons.moduleId, input.moduleId))
    const [lesson] = await tx.insert(lessons).values({
      tenantId: ctx.tenantId,
      moduleId: input.moduleId,
      title: input.title,
      sort: existing.length,
      itemType: 'resource',
      itemId: resource!.id,
      isRequired: input.isRequired,
      minSeconds: input.minSeconds ?? null,
      videoThresholdPct: input.videoThresholdPct,
    }).returning()
    return lesson!
  })
}

export async function updateLesson(ctx: Ctx, lessonId: string, input: z.infer<typeof lessonUpdateSchema>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [lesson] = await tx.select().from(lessons).where(eq(lessons.id, lessonId))
    if (!lesson) return null

    if (input.body !== undefined && lesson.itemType === 'resource') {
      await tx.update(resources).set({
        body: sanitizeBody(input.body as ContentBlock[]),
        version: (await tx.select({ v: resources.version }).from(resources).where(eq(resources.id, lesson.itemId)))[0]!.v + 1,
        updatedAt: new Date(),
      }).where(eq(resources.id, lesson.itemId))
    }

    const [updated] = await tx.update(lessons).set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.isRequired !== undefined ? { isRequired: input.isRequired } : {}),
      ...(input.minSeconds !== undefined ? { minSeconds: input.minSeconds } : {}),
      ...(input.videoThresholdPct !== undefined ? { videoThresholdPct: input.videoThresholdPct } : {}),
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

  return [
    { code: 'has_lessons', label: 'У курсі є хоча б один урок', ok: allLessons.length > 0 },
    {
      code: 'lessons_have_content',
      label: 'У кожного уроку заповнений матеріал',
      ok: allLessons.every(l => (l.body as ContentBlock[]).length > 0),
    },
    { code: 'media_ready', label: 'Усі медіафайли оброблені', ok: mediaReady },
  ]
}

export type PublishResult
  = | { ok: true, versionId: string, version: number }
    | { ok: false, code: 'not_found' | 'not_publishable', checks?: PublishCheck[] }

/** Публикация: draft → published, прошлая published → retired, одной транзакцией. */
export async function publishCourse(ctx: Ctx, courseId: string, changelog: string): Promise<PublishResult> {
  const checks = await publishChecks(ctx, courseId)
  if (!checks) return { ok: false, code: 'not_found' }
  if (checks.some(c => !c.ok)) return { ok: false, code: 'not_publishable', checks }

  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [draft] = await tx.select().from(courseVersions)
      .where(and(eq(courseVersions.courseId, courseId), eq(courseVersions.status, 'draft')))
      .orderBy(desc(courseVersions.version))
      .limit(1)
    if (!draft) return { ok: false as const, code: 'not_found' as const }

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

    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'course.publish',
      entity: 'course',
      entityId: courseId,
      after: { version: draft.version, changelog },
    })
    return { ok: true as const, versionId: draft.id, version: draft.version }
  })
}
