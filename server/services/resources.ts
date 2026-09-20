import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, ilike, inArray, isNull, sql } from 'drizzle-orm'
import type { z } from 'zod'
import {
  accessGroupMembers, accessGroups, assignments, contentAccessGroups, courseVersions, courses, lessons,
  mediaAssets, modules, resourceCategories, resourceVersions, resources, tenants, userPlacements, userRoles, users,
} from '../db/schema'
import type { TenantTx } from '../utils/withTenant'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'
import { blocksToText } from './knowledge'
import { enqueueNotification } from './notifications'
import { sanitizeBody } from './sanitize'
import { logTaskAccess } from './journals'
import { slugify } from './courses'
import type { ContentBlock } from '../../shared/schemas/content'
import {
  resourceKindComplete,
  type accessGroupSchema, type resourceCategorySchema, type resourceCreateSchema,
  type resourceListQuerySchema, type resourcePublishSchema, type resourceUpdateSchema,
} from '../../shared/schemas/resources'

/**
 * Ресурс как тип контента (docs/11 §3.1, §14, Г-11.3; docs/32 Б.7).
 * Строка `resources` — рабочая редакция; публикация делает снимок в `resource_versions`,
 * курс при своей публикации закрепляется за снимком (`lessons.resource_version_id`),
 * назначение — за текущей версией на момент выдачи. Ученик доучивается на той версии, что начал.
 * Правил прохождения у ресурса нет (CLAUDE.md п. 11); правило зачёта по типу — `lessonRules.ts`.
 */

interface Ctx { tenantId: string, actorId: string }
type CreateInput = z.infer<typeof resourceCreateSchema>
type UpdateInput = z.infer<typeof resourceUpdateSchema>

const notDeleted = () => isNull(resources.deletedAt)

// ── Библиотека ──────────────────────────────────────────────────────────────────────

/** Сколько курсов (по любой версии) используют ресурс — «у 3 курсах» (docs/11 §5.1, §7.2). */
async function usageByResource(tx: TenantTx, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map()
  const rows = await tx.select({
    itemId: lessons.itemId,
    n: sql<number>`count(distinct ${courseVersions.courseId})::int`,
  }).from(lessons)
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(courseVersions, eq(courseVersions.id, modules.courseVersionId))
    .where(and(eq(lessons.itemType, 'resource'), inArray(lessons.itemId, ids)))
    .groupBy(lessons.itemId)
  return new Map(rows.map(r => [r.itemId, r.n]))
}

export async function listResources(ctx: Ctx, q: z.infer<typeof resourceListQuerySchema>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const where = and(
      notDeleted(),
      q.status === 'all' ? undefined : eq(resources.status, q.status),
      q.kind ? eq(resources.kind, q.kind) : undefined,
      q.authorId ? sql`${q.authorId}::uuid = any(${resources.authorIds})` : undefined,
      q.tag ? sql`${q.tag} = any(${resources.tags})` : undefined,
      q.categoryId ? sql`${q.categoryId}::uuid = any(${resources.categoryIds})` : undefined,
      q.q ? ilike(resources.title, `%${q.q}%`) : undefined,
    )
    const [{ total }] = await tx.select({ total: sql<number>`count(*)::int` }).from(resources).where(where) as [{ total: number }]
    const rows = await tx.select().from(resources).where(where)
      .orderBy(desc(resources.updatedAt)).limit(q.perPage).offset((q.page - 1) * q.perPage)

    const authorIds = [...new Set(rows.flatMap(r => r.authorIds))]
    const authors = authorIds.length
      ? await tx.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, authorIds))
      : []
    const nameOf = new Map(authors.map(a => [a.id, a.fullName]))
    const usage = await usageByResource(tx, rows.map(r => r.id))
    const counts = await tx.select({ status: resources.status, n: sql<number>`count(*)::int` }).from(resources)
      .where(notDeleted()).groupBy(resources.status)

    return {
      total: total!,
      page: q.page,
      perPage: q.perPage,
      counts: Object.fromEntries(counts.map(c => [c.status, c.n])) as Record<string, number>,
      items: rows.map(r => ({
        id: r.id,
        title: r.title,
        kind: r.kind,
        status: r.status,
        tags: r.tags,
        categoryIds: r.categoryIds,
        authors: r.authorIds.map(id => ({ id, fullName: nameOf.get(id) ?? '' })),
        version: r.version,
        publishedVersionId: r.publishedVersionId,
        updatedAt: r.updatedAt,
        usedInCourses: usage.get(r.id) ?? 0,
      })),
    }
  })
}

export async function getResource(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.select().from(resources).where(and(eq(resources.id, id), notDeleted()))
    if (!r) return null
    const groups = await tx.select({ groupId: contentAccessGroups.groupId }).from(contentAccessGroups)
      .where(and(eq(contentAccessGroups.contentType, 'resource'), eq(contentAccessGroups.contentId, id)))
    const versions = await tx.select({
      id: resourceVersions.id, version: resourceVersions.version, title: resourceVersions.title,
      changelog: resourceVersions.changelog, publishedAt: resourceVersions.publishedAt, publishedBy: resourceVersions.publishedBy,
    }).from(resourceVersions).where(eq(resourceVersions.resourceId, id)).orderBy(desc(resourceVersions.version))
    const usage = await usageByResource(tx, [id])
    return {
      ...r,
      accessGroupIds: groups.map(g => g.groupId),
      versions,
      usedInCourses: usage.get(id) ?? 0,
      hasUnpublishedChanges: !!r.publishedVersionId && !!(await hasDraftChanges(tx, r)),
    }
  })
}

/** Есть ли правки после последней публикации: сравниваем рабочую редакцию со снимком. */
async function hasDraftChanges(tx: TenantTx, r: typeof resources.$inferSelect): Promise<boolean> {
  if (!r.publishedVersionId) return true
  const [v] = await tx.select().from(resourceVersions).where(eq(resourceVersions.id, r.publishedVersionId))
  if (!v) return true
  return v.title !== r.title || v.kind !== r.kind || v.mediaId !== r.mediaId || v.externalUrl !== r.externalUrl
    || JSON.stringify(v.body) !== JSON.stringify(r.body)
}

async function uniqueSlug(tx: TenantTx, base: string): Promise<string> {
  const [taken] = await tx.select({ id: resources.id }).from(resources).where(eq(resources.slug, base))
  return taken ? `${base.slice(0, 70)}-${randomUUID().slice(0, 6)}` : base
}

async function setAccessGroups(tx: TenantTx, tenantId: string, resourceId: string, groupIds: string[]) {
  await tx.delete(contentAccessGroups).where(and(eq(contentAccessGroups.contentType, 'resource'), eq(contentAccessGroups.contentId, resourceId)))
  if (groupIds.length) {
    const known = await tx.select({ id: accessGroups.id }).from(accessGroups).where(inArray(accessGroups.id, groupIds))
    if (known.length) {
      await tx.insert(contentAccessGroups).values(known.map(g => ({ tenantId, contentType: 'resource', contentId: resourceId, groupId: g.id })))
    }
  }
}

export async function createResource(ctx: Ctx, input: CreateInput) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const body = sanitizeBody(input.body as ContentBlock[])
    const [r] = await tx.insert(resources).values({
      tenantId: ctx.tenantId,
      title: input.title,
      slug: await uniqueSlug(tx, input.slug || slugify(input.title)),
      kind: input.kind,
      summary: input.summary ?? null,
      body,
      plainText: blocksToText(body),
      mediaId: input.mediaId ?? null,
      externalUrl: input.externalUrl ?? null,
      categoryIds: input.categoryIds,
      tags: input.tags,
      language: input.language,
      estimatedMinutes: input.estimatedMinutes ?? null,
      coverKey: input.coverKey ?? null,
      cardImageKey: input.cardImageKey ?? null,
      allowPrint: input.allowPrint,
      authorIds: input.authorIds?.length ? input.authorIds : [ctx.actorId],
      status: 'draft',
    }).returning()
    await setAccessGroups(tx, ctx.tenantId, r!.id, input.accessGroupIds ?? [])
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'resource.create', entity: 'resource', entityId: r!.id, after: { title: r!.title, kind: r!.kind } })
    return r!
  })
}

export type UpdateResult
  = | { ok: true, resource: typeof resources.$inferSelect }
    | { ok: false, code: 'not_found' | 'archived' }

/** Правка рабочей редакции. Опубликованная версия не меняется до следующей публикации (Г-11.3). */
export async function updateResource(ctx: Ctx, id: string, input: UpdateInput): Promise<UpdateResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(resources).where(and(eq(resources.id, id), notDeleted()))
    if (!before) return { ok: false as const, code: 'not_found' as const }
    if (before.status === 'archived') return { ok: false as const, code: 'archived' as const }

    const body = input.body !== undefined ? sanitizeBody(input.body as ContentBlock[]) : undefined
    const [after] = await tx.update(resources).set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(body !== undefined ? { body, plainText: blocksToText(body) } : {}),
      ...(input.mediaId !== undefined ? { mediaId: input.mediaId } : {}),
      ...(input.externalUrl !== undefined ? { externalUrl: input.externalUrl } : {}),
      ...(input.categoryIds !== undefined ? { categoryIds: input.categoryIds } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.language !== undefined ? { language: input.language } : {}),
      ...(input.estimatedMinutes !== undefined ? { estimatedMinutes: input.estimatedMinutes } : {}),
      ...(input.coverKey !== undefined ? { coverKey: input.coverKey } : {}),
      ...(input.cardImageKey !== undefined ? { cardImageKey: input.cardImageKey } : {}),
      ...(input.allowPrint !== undefined ? { allowPrint: input.allowPrint } : {}),
      ...(input.authorIds !== undefined && input.authorIds.length ? { authorIds: input.authorIds } : {}),
      updatedAt: new Date(),
    }).where(eq(resources.id, id)).returning()
    if (input.accessGroupIds !== undefined) await setAccessGroups(tx, ctx.tenantId, id, input.accessGroupIds)

    await recordAudit(tx, {
      tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'resource.update', entity: 'resource', entityId: id,
      before: { title: before.title, status: before.status }, after: { title: after!.title, status: after!.status, fields: Object.keys(input) },
    })
    return { ok: true as const, resource: after! }
  })
}

// ── Публикация и версии ─────────────────────────────────────────────────────────────

export interface ResourceCheck { code: string, ok: boolean }

/** Проверки перед публикацией: заполненность по типу, готовность медиа (docs/11 §5.4, §12). */
export async function resourcePublishChecks(tx: TenantTx, r: typeof resources.$inferSelect): Promise<ResourceCheck[]> {
  const mediaIds = [...new Set([
    ...(r.mediaId ? [r.mediaId] : []),
    ...(r.body as ContentBlock[]).flatMap(b => ('mediaId' in b ? [b.mediaId] : [])),
  ])]
  let mediaReady = true
  if (mediaIds.length) {
    const rows = await tx.select({ id: mediaAssets.id, status: mediaAssets.status }).from(mediaAssets)
      .where(and(inArray(mediaAssets.id, mediaIds), isNull(mediaAssets.deletedAt)))
    mediaReady = rows.length === mediaIds.length && rows.every(m => m.status === 'ready')
  }
  return [
    { code: 'kind_complete', ok: resourceKindComplete({ kind: r.kind as CreateInput['kind'], mediaId: r.mediaId, externalUrl: r.externalUrl, body: r.body as unknown[] }) },
    { code: 'media_ready', ok: mediaReady },
    { code: 'has_author', ok: r.authorIds.length > 0 },
  ]
}

export type PublishResourceResult
  = | { ok: true, versionId: string, version: number, notified: number }
    | { ok: false, code: 'not_found' | 'not_publishable', checks?: ResourceCheck[] }

/**
 * Публикация: снимок в `resource_versions`, ресурс → published. Назначения этого ресурса получают
 * `content_changed_at` (баннер «N завдань було змінено», docs/15 §14.6); при `notifyAssigned` — сразу
 * рассылка назначенным через существующий механизм (`tasks.notifyChanged`), решение принимает автор (docs/11 §14.2).
 * Авторам курсов, где ресурс используется, уходит `content_used_changed` (docs/11 §8).
 */
export async function publishResource(ctx: Ctx, id: string, input: z.infer<typeof resourcePublishSchema>): Promise<PublishResourceResult> {
  const result = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.select().from(resources).where(and(eq(resources.id, id), notDeleted()))
    if (!r) return { ok: false as const, code: 'not_found' as const }
    const checks = await resourcePublishChecks(tx, r)
    if (checks.some(c => !c.ok)) return { ok: false as const, code: 'not_publishable' as const, checks }

    const version = r.publishedVersionId ? r.version + 1 : 1
    const [snapshot] = await tx.insert(resourceVersions).values({
      tenantId: ctx.tenantId,
      resourceId: id,
      version,
      title: r.title,
      kind: r.kind,
      body: r.body,
      plainText: r.plainText,
      mediaId: r.mediaId,
      externalUrl: r.externalUrl,
      changelog: input.changelog ?? null,
      publishedBy: ctx.actorId,
    }).returning({ id: resourceVersions.id })

    await tx.update(resources).set({
      status: 'published',
      version,
      publishedVersionId: snapshot!.id,
      updatedAt: new Date(),
    }).where(eq(resources.id, id))

    // Баннер «N завдань було змінено» — копится всегда; рассылка — только по переключателю автора
    const { markContentChanged } = await import('./tasks')
    await markContentChanged(tx, 'resource', id)
    const assignmentIds = input.notifyAssigned
      ? (await tx.select({ id: assignments.id }).from(assignments)
          .where(and(eq(assignments.subjectType, 'resource'), eq(assignments.subjectId, id), inArray(assignments.status, ['active', 'paused']))))
          .map(a => a.id)
      : []

    // docs/11 §8 content_used_changed: авторам курсов, где используется ресурс (кроме самого публикующего)
    if (version > 1) {
      const owners = await tx.select({ courseId: courses.id, title: courses.title, createdBy: courses.createdBy }).from(lessons)
        .innerJoin(modules, eq(modules.id, lessons.moduleId))
        .innerJoin(courseVersions, eq(courseVersions.id, modules.courseVersionId))
        .innerJoin(courses, eq(courses.id, courseVersions.courseId))
        .where(and(eq(lessons.itemType, 'resource'), eq(lessons.itemId, id), isNull(courses.deletedAt)))
        .groupBy(courses.id, courses.title, courses.createdBy)
      for (const o of owners) {
        if (!o.createdBy || o.createdBy === ctx.actorId) continue
        await enqueueNotification(tx, {
          tenantId: ctx.tenantId, userId: o.createdBy, code: 'content_used_changed',
          payload: { title: r.title, course: o.title, version },
          dedupKey: `content_used_changed:${id}:${version}:${o.courseId}:${o.createdBy}`,
          refType: 'course', refId: o.courseId,
        })
      }
    }

    await recordAudit(tx, {
      tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'resource.publish', entity: 'resource', entityId: id,
      after: { version, changelog: input.changelog ?? null, notifyAssigned: input.notifyAssigned },
    })
    return { ok: true as const, versionId: snapshot!.id, version, assignmentIds }
  })
  if (!result.ok) return result
  let notified = 0
  if (result.assignmentIds.length) {
    const { notifyChanged } = await import('./tasks')
    notified = (await notifyChanged(ctx, result.assignmentIds)).notified
  }
  return { ok: true, versionId: result.versionId, version: result.version, notified }
}

export async function listResourceVersions(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.select({ id: resources.id }).from(resources).where(and(eq(resources.id, id), notDeleted()))
    if (!r) return null
    return tx.select().from(resourceVersions).where(eq(resourceVersions.resourceId, id)).orderBy(desc(resourceVersions.version))
  })
}

/** Опубликованный снимок для ученика: по id версии или текущий у ресурса. */
export async function currentVersion(tx: TenantTx, resourceId: string, versionId?: string | null) {
  if (versionId) {
    const [v] = await tx.select().from(resourceVersions).where(eq(resourceVersions.id, versionId))
    if (v) return v
  }
  const [r] = await tx.select().from(resources).where(eq(resources.id, resourceId))
  if (!r?.publishedVersionId) return null
  const [v] = await tx.select().from(resourceVersions).where(eq(resourceVersions.id, r.publishedVersionId))
  return v ?? null
}

/** draft → published → archived; из archived можно вернуть в draft (docs/11 §4). */
export async function setResourceStatus(ctx: Ctx, id: string, status: 'archived' | 'draft') {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(resources).where(and(eq(resources.id, id), notDeleted()))
    if (!before) return null
    if (status === 'draft' && before.status !== 'archived') return before
    const [after] = await tx.update(resources).set({ status, updatedAt: new Date() }).where(eq(resources.id, id)).returning()
    await recordAudit(tx, {
      tenantId: ctx.tenantId, actorId: ctx.actorId, action: status === 'archived' ? 'resource.archive' : 'resource.restore',
      entity: 'resource', entityId: id, before: { status: before.status }, after: { status },
    })
    return after!
  })
}

export type DeleteResult = { ok: true } | { ok: false, code: 'not_found' | 'in_use', usedInCourses?: number }

/** Мягкое удаление; ресурс в курсах не удаляется — сначала убрать из планов (docs/11 §7.8 по аналогии с медиа). */
export async function deleteResource(ctx: Ctx, id: string): Promise<DeleteResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.select().from(resources).where(and(eq(resources.id, id), notDeleted()))
    if (!r) return { ok: false as const, code: 'not_found' as const }
    const used = (await usageByResource(tx, [id])).get(id) ?? 0
    if (used > 0) return { ok: false as const, code: 'in_use' as const, usedInCourses: used }
    await tx.update(resources).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(resources.id, id))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'resource.delete', entity: 'resource', entityId: id, before: { title: r.title } })
    return { ok: true as const }
  })
}

export async function duplicateResource(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.select().from(resources).where(and(eq(resources.id, id), notDeleted()))
    if (!r) return null
    const [copy] = await tx.insert(resources).values({
      tenantId: ctx.tenantId,
      title: `${r.title} (копія)`.slice(0, 200),
      slug: await uniqueSlug(tx, `${r.slug}-copy`),
      kind: r.kind,
      summary: r.summary,
      body: r.body,
      plainText: r.plainText,
      mediaId: r.mediaId,
      externalUrl: r.externalUrl,
      categoryIds: r.categoryIds,
      tags: r.tags,
      language: r.language,
      estimatedMinutes: r.estimatedMinutes,
      coverKey: r.coverKey,
      cardImageKey: r.cardImageKey,
      allowPrint: r.allowPrint,
      authorIds: [ctx.actorId],
      status: 'draft',
    }).returning()
    const groups = await tx.select({ groupId: contentAccessGroups.groupId }).from(contentAccessGroups)
      .where(and(eq(contentAccessGroups.contentType, 'resource'), eq(contentAccessGroups.contentId, id)))
    await setAccessGroups(tx, ctx.tenantId, copy!.id, groups.map(g => g.groupId))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'resource.duplicate', entity: 'resource', entityId: copy!.id, after: { from: id } })
    return copy!
  })
}

// ── Печать ──────────────────────────────────────────────────────────────────────────

/** «Дозволити друк» ресурса, но политика тенанта «Вимкнути друк у ресурсах» (docs/24 «Захист даних») сильнее. */
export async function printAllowed(tx: TenantTx, tenantId: string, allowPrint: boolean): Promise<boolean> {
  if (!allowPrint) return false
  const [t] = await tx.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId))
  const s = (t?.settings ?? {}) as { policies?: { dataProtection?: { disablePrint?: boolean } } }
  return !s.policies?.dataProtection?.disablePrint
}

// ── Категории ресурсов (docs/11 §14, docs/21 §14.1, docs/30: порядок без цифр в названиях) ──

export async function listResourceCategories(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select().from(resourceCategories).orderBy(asc(resourceCategories.sortOrder), asc(resourceCategories.name))
    const counts = await tx.execute(sql`
      select c.id, count(r.id)::int as n from resource_categories c
      left join resources r on c.id = any(r.category_ids) and r.deleted_at is null
      group by c.id
    `) as unknown as { id: string, n: number }[]
    const countOf = new Map(counts.map(c => [c.id, c.n]))
    return rows.map(c => ({ ...c, resourcesCount: countOf.get(c.id) ?? 0 }))
  })
}

export async function createResourceCategory(ctx: Ctx, input: z.infer<typeof resourceCategorySchema>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [{ max }] = await tx.select({ max: sql<number>`coalesce(max(${resourceCategories.sortOrder}), -1)::int` }).from(resourceCategories) as [{ max: number }]
    const [c] = await tx.insert(resourceCategories).values({
      tenantId: ctx.tenantId, name: input.name, parentId: input.parentId ?? null, sortOrder: max! + 1,
    }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'resource_category.create', entity: 'resource_category', entityId: c!.id, after: { name: c!.name } })
    return c!
  })
}

export async function updateResourceCategory(ctx: Ctx, id: string, input: Partial<z.infer<typeof resourceCategorySchema>>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(resourceCategories).where(eq(resourceCategories.id, id))
    if (!before) return null
    const [after] = await tx.update(resourceCategories).set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId === id ? null : input.parentId } : {}),
      updatedAt: new Date(),
    }).where(eq(resourceCategories.id, id)).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'resource_category.update', entity: 'resource_category', entityId: id, before: { name: before.name }, after: { name: after!.name } })
    return after!
  })
}

export async function deleteResourceCategory(ctx: Ctx, id: string): Promise<boolean> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [c] = await tx.delete(resourceCategories).where(eq(resourceCategories.id, id)).returning({ id: resourceCategories.id, name: resourceCategories.name })
    if (!c) return false
    // Убираем категорию из ресурсов, чтобы не осталось «висячих» ссылок
    await tx.update(resources).set({ categoryIds: sql`array_remove(${resources.categoryIds}, ${id}::uuid)` })
      .where(sql`${id}::uuid = any(${resources.categoryIds})`)
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'resource_category.delete', entity: 'resource_category', entityId: id, before: { name: c.name } })
    return true
  })
}

/** Порядок перетаскиванием: позиция в списке = sort_order. */
export async function reorderResourceCategories(ctx: Ctx, ids: string[]) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    for (const [i, id] of ids.entries()) {
      await tx.update(resourceCategories).set({ sortOrder: i, updatedAt: new Date() }).where(eq(resourceCategories.id, id))
    }
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'resource_category.reorder', entity: 'resource_category', after: { ids } })
    return true
  })
}

// ── Группы доступа (docs/02 access_groups, docs/21 §14.1) ─────────────────────────────

export async function listAccessGroups(ctx: Ctx, appliesTo?: 'knowledge' | 'catalog') {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const groups = await tx.select().from(accessGroups)
      .where(appliesTo ? eq(accessGroups.appliesTo, appliesTo) : undefined).orderBy(asc(accessGroups.name))
    const members = groups.length
      ? await tx.select().from(accessGroupMembers).where(inArray(accessGroupMembers.groupId, groups.map(g => g.id)))
      : []
    const usage = groups.length
      ? await tx.select({ groupId: contentAccessGroups.groupId, n: sql<number>`count(*)::int` }).from(contentAccessGroups)
          .where(inArray(contentAccessGroups.groupId, groups.map(g => g.id))).groupBy(contentAccessGroups.groupId)
      : []
    const usageOf = new Map(usage.map(u => [u.groupId, u.n]))
    return groups.map(g => ({
      ...g,
      members: members.filter(m => m.groupId === g.id).map(m => ({ subjectType: m.subjectType, subjectId: m.subjectId })),
      contentCount: usageOf.get(g.id) ?? 0,
    }))
  })
}

async function replaceMembers(tx: TenantTx, tenantId: string, groupId: string, members: { subjectType: string, subjectId: string }[]) {
  await tx.delete(accessGroupMembers).where(eq(accessGroupMembers.groupId, groupId))
  if (members.length) {
    await tx.insert(accessGroupMembers).values(members.map(m => ({ tenantId, groupId, subjectType: m.subjectType, subjectId: m.subjectId }))).onConflictDoNothing()
  }
}

export async function createAccessGroup(ctx: Ctx, input: z.infer<typeof accessGroupSchema>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [g] = await tx.insert(accessGroups).values({
      tenantId: ctx.tenantId, name: input.name, description: input.description ?? null, appliesTo: input.appliesTo,
    }).returning()
    await replaceMembers(tx, ctx.tenantId, g!.id, input.members ?? [])
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'access_group.create', entity: 'access_group', entityId: g!.id, after: { name: g!.name, members: input.members?.length ?? 0 } })
    return g!
  })
}

export async function updateAccessGroup(ctx: Ctx, id: string, input: Partial<z.infer<typeof accessGroupSchema>>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(accessGroups).where(eq(accessGroups.id, id))
    if (!before) return null
    const [after] = await tx.update(accessGroups).set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      updatedAt: new Date(),
    }).where(eq(accessGroups.id, id)).returning()
    if (input.members !== undefined) await replaceMembers(tx, ctx.tenantId, id, input.members)
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'access_group.update', entity: 'access_group', entityId: id, before: { name: before.name }, after: { name: after!.name, members: input.members?.length } })
    return after!
  })
}

export async function deleteAccessGroup(ctx: Ctx, id: string): Promise<boolean> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [g] = await tx.delete(accessGroups).where(eq(accessGroups.id, id)).returning({ name: accessGroups.name })
    if (!g) return false
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'access_group.delete', entity: 'access_group', entityId: id, before: { name: g.name } })
    return true
  })
}

/** Чем человек «является» для групп доступа: свои должности, подразделения, роли и он сам. */
export async function userAccessSubjects(tx: TenantTx, userId: string) {
  const placements = await tx.select({ positionId: userPlacements.positionId, orgUnitId: userPlacements.orgUnitId })
    .from(userPlacements).where(and(eq(userPlacements.userId, userId), isNull(userPlacements.endedAt)))
  const roles = await tx.select({ roleId: userRoles.roleId }).from(userRoles)
    .where(and(eq(userRoles.userId, userId), sql`(${userRoles.validUntil} is null or ${userRoles.validUntil} > now())`))
  return {
    position: placements.map(p => p.positionId),
    org_unit: placements.flatMap(p => (p.orgUnitId ? [p.orgUnitId] : [])),
    role: roles.map(r => r.roleId),
    user: [userId],
  }
}

/**
 * Доступ к ресурсу (docs/21 §14.1, docs/11 §14): без групп — открыт всем в тенанте;
 * с группами — человек должен входить хотя бы в одну (по должности, подразделению, роли или лично).
 * Авторы ресурса видят его всегда.
 */
export async function canAccessResource(tx: TenantTx, userId: string, resourceId: string): Promise<boolean> {
  const [r] = await tx.select({ authorIds: resources.authorIds }).from(resources).where(and(eq(resources.id, resourceId), notDeleted()))
  if (!r) return false
  if (r.authorIds.includes(userId)) return true
  const groups = await tx.select({ groupId: contentAccessGroups.groupId }).from(contentAccessGroups)
    .where(and(eq(contentAccessGroups.contentType, 'resource'), eq(contentAccessGroups.contentId, resourceId)))
  if (!groups.length) return true
  const subjects = await userAccessSubjects(tx, userId)
  const members = await tx.select({ subjectType: accessGroupMembers.subjectType, subjectId: accessGroupMembers.subjectId })
    .from(accessGroupMembers).where(inArray(accessGroupMembers.groupId, groups.map(g => g.groupId)))
  return members.some(m => (subjects[m.subjectType as keyof typeof subjects] ?? []).includes(m.subjectId))
}

/** Просмотр ресурса учеником (вне курса): текущая опубликованная версия, если есть доступ; чужой тенант/нет доступа — null (404). */
export async function viewResource(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.select().from(resources).where(and(eq(resources.id, id), notDeleted(), eq(resources.status, 'published')))
    if (!r) return null
    if (!(await canAccessResource(tx, ctx.actorId, id))) return null
    const v = await currentVersion(tx, id)
    if (!v) return null
    await tx.update(resources).set({ viewsCount: sql`${resources.viewsCount} + 1` }).where(eq(resources.id, id))
    await logTaskAccess(tx, { tenantId: ctx.tenantId, userId: ctx.actorId, contentType: 'resource', contentId: id, title: v.title }) // docs/22 §13.4
    return {
      id: r.id, title: v.title, kind: v.kind, body: v.body as ContentBlock[], mediaId: v.mediaId, externalUrl: v.externalUrl,
      version: v.version, estimatedMinutes: r.estimatedMinutes, canPrint: await printAllowed(tx, ctx.tenantId, r.allowPrint),
    }
  })
}
