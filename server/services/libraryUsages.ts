import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm'
import {
  courseVersions, courses, lessons, libraryModuleUsages, libraryModuleVersions, libraryModules, modules,
  resourceVersions, resources, trajectories, trajectoryNodes, users,
} from '../db/schema'
import type { TenantTx } from '../utils/withTenant'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'
import type { LibraryActor } from './library'
import { versionSnapshot } from './library'
import type { LibraryAttachInput } from '../../shared/schemas/library'
import type { LibraryContainerType, LibraryHolderType, LibraryPinMode } from '../../shared/enums'
import { isStale } from '../../shared/domain/library'

/**
 * Места использования модулей библиотеки — «де використовується» (`docs/v2/31` §3.4, §5.3,
 * §7.1–§7.3, §7.9, §7.10; PR-25).
 *
 * Два вида держателя ссылки (§3.4):
 * - **урок курса** — ссылка живёт в самом уроке: `lessons.library_version_id` плюс
 *   `resource_version_id` снимка версии (`lessons_library_ref_ck`). Своего материала у такого
 *   урока нет, плеер показывает закреплённый снимок, публикация курса его не перезакрепляет;
 * - **узел траектории** — до PR-26 ссылка живёт только в этом реестре (колонку
 *   `trajectory_nodes.library_version_id` вводит PR-26, `45` §5: две ветки одну таблицу не
 *   трогают). Реестр уже отвечает на вопросы «где используется», «на какой версии», «что
 *   устарело» и не даёт удалить используемый модуль (критерии 1, 3, 4).
 *
 * Строка места не удаляется никогда: `detached_at` конечен (§4), отключённые места нужны
 * отчёту «Використання бібліотеки» и правилу §7.5.
 */

interface Ctx { tenantId: string, actorId: string }

export interface UsageRow {
  id: string
  libraryModuleId: string
  holderType: LibraryHolderType
  holderId: string
  holderTitle: string | null
  containerType: LibraryContainerType
  containerId: string
  containerTitle: string
  versionId: string
  version: number
  /** Последняя опубликованная версия модуля — баннер «Доступна нова версія v3» (критерий 1). */
  latestVersion: number | null
  isStale: boolean
  pinMode: LibraryPinMode
  attachedBy: { id: string, fullName: string }
  attachedAt: Date
  detachedAt: Date | null
}

const usageColumns = {
  id: libraryModuleUsages.id,
  libraryModuleId: libraryModuleUsages.libraryModuleId,
  holderType: libraryModuleUsages.holderType,
  holderId: libraryModuleUsages.holderId,
  holderTitle: libraryModuleUsages.holderTitle,
  containerType: libraryModuleUsages.containerType,
  containerId: libraryModuleUsages.containerId,
  containerTitle: libraryModuleUsages.containerTitle,
  versionId: libraryModuleUsages.versionId,
  version: libraryModuleVersions.version,
  latestVersion: sql<number | null>`(select cv.version from library_module_versions cv where cv.id = ${libraryModules.currentVersionId})`,
  isStale: libraryModuleUsages.isStale,
  pinMode: libraryModuleUsages.pinMode,
  attachedById: libraryModuleUsages.attachedBy,
  attachedAt: libraryModuleUsages.attachedAt,
  detachedAt: libraryModuleUsages.detachedAt,
}

/** Места с номером закреплённой и последней версии и именем вставившего — одним запросом и одной формой. */
async function selectUsages(tx: TenantTx, where: SQL | undefined): Promise<UsageRow[]> {
  const rows = await tx.select(usageColumns).from(libraryModuleUsages)
    .innerJoin(libraryModuleVersions, eq(libraryModuleVersions.id, libraryModuleUsages.versionId))
    .innerJoin(libraryModules, eq(libraryModules.id, libraryModuleUsages.libraryModuleId))
    .where(where)
    .orderBy(asc(libraryModuleUsages.containerTitle), desc(libraryModuleUsages.attachedAt))
  const ids = [...new Set(rows.map(r => r.attachedById))]
  const people = ids.length ? await tx.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, ids)) : []
  const nameOf = new Map(people.map(p => [p.id, p.fullName]))
  return rows.map(r => ({
    id: r.id,
    libraryModuleId: r.libraryModuleId,
    holderType: r.holderType as LibraryHolderType,
    holderId: r.holderId,
    holderTitle: r.holderTitle,
    containerType: r.containerType as LibraryContainerType,
    containerId: r.containerId,
    containerTitle: r.containerTitle,
    versionId: r.versionId,
    version: r.version,
    latestVersion: r.latestVersion === null ? null : Number(r.latestVersion),
    isStale: r.isStale,
    pinMode: r.pinMode as LibraryPinMode,
    attachedBy: { id: r.attachedById, fullName: nameOf.get(r.attachedById) ?? '' },
    attachedAt: r.attachedAt,
    detachedAt: r.detachedAt,
  }))
}

async function usageById(tx: TenantTx, id: string): Promise<UsageRow | null> {
  const [row] = await selectUsages(tx, eq(libraryModuleUsages.id, id))
  return row ?? null
}

/** «Де використовується» (§5.3): активные места и, по запросу, «Відключені раніше». */
export async function listUsages(actor: LibraryActor, moduleId: string, opts: { includeDetached?: boolean } = {}) {
  return withTenant(actor.tenantId, actor.actorId, async (tx) => {
    const [m] = await tx.select({ id: libraryModules.id }).from(libraryModules).where(eq(libraryModules.id, moduleId))
    if (!m) return null
    const all = await selectUsages(tx, and(eq(libraryModuleUsages.libraryModuleId, moduleId), opts.includeDetached ? undefined : isNull(libraryModuleUsages.detachedAt)))
    return { active: all.filter(u => !u.detachedAt), detached: all.filter(u => !!u.detachedAt) }
  })
}

// ── Вставка (§5.4, §7.1, §7.2, §7.15) ────────────────────────────────────────────────────

export type AttachResult
  = | { ok: true, usage: UsageRow }
    | { ok: false, code: 'not_found' | 'holder_not_found' | 'module_archived' | 'module_not_published' | 'already_attached' | 'container_forbidden' | 'container_published' | 'holder_not_content' }

interface Holder { title: string | null, containerTitle: string }

/**
 * Урок-держатель: урок курса в **черновой** версии этого курса. Опубликованная версия курса
 * неизменяема (`docs/11` §7.1) — вставлять в неё нельзя, как и правило графа запрещает
 * перестраивать опубликованную траекторию.
 */
async function courseLessonHolder(tx: TenantTx, lessonId: string, courseId: string) {
  const [row] = await tx.select({ lesson: lessons, versionStatus: courseVersions.status, courseId: courses.id, courseTitle: courses.title, courseDeleted: courses.deletedAt })
    .from(lessons)
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(courseVersions, eq(courseVersions.id, modules.courseVersionId))
    .innerJoin(courses, eq(courses.id, courseVersions.courseId))
    .where(and(eq(lessons.id, lessonId), isNotNull(lessons.moduleId)))
  if (!row || row.courseId !== courseId || row.courseDeleted) return null
  return row
}

async function trajectoryNodeHolder(tx: TenantTx, nodeId: string, trajectoryId: string) {
  const [row] = await tx.select({ node: trajectoryNodes, status: trajectories.status, trajectoryId: trajectories.id, trajectoryTitle: trajectories.title })
    .from(trajectoryNodes)
    .innerJoin(trajectories, eq(trajectories.id, trajectoryNodes.trajectoryId))
    .where(eq(trajectoryNodes.id, nodeId))
  if (!row || row.trajectoryId !== trajectoryId) return null
  return row
}

/**
 * Вставить модуль в место (§10 `POST /library/usages`): закрепляется версия, текущая **на
 * момент вставки** (§7.2), черновик на неё не влияет (§12). Архивный модуль и модуль без
 * опубликованной версии не вставляются: в палитре их нет (§7.6), а вставлять нечего.
 * Право на контейнер — `course.edit` для курса, `program.manage` для траектории; без него —
 * `container_forbidden` (mentor и manager с `library.use` вставлять не могут, §2).
 */
export async function attachUsage(actor: LibraryActor, input: LibraryAttachInput): Promise<AttachResult> {
  return withTenant(actor.tenantId, actor.actorId, async (tx): Promise<AttachResult> => {
    const [m] = await tx.select().from(libraryModules).where(eq(libraryModules.id, input.libraryModuleId)).for('update')
    if (!m) return { ok: false, code: 'not_found' }
    if (m.status === 'archived') return { ok: false, code: 'module_archived' }
    if (!m.currentVersionId) return { ok: false, code: 'module_not_published' }
    const snap = await versionSnapshot(tx, m.currentVersionId)
    if (!snap) throw new Error(`library_module ${m.id}: версия без снимка`)

    let holder: Holder
    if (input.holderType === 'course_lesson') {
      const h = await courseLessonHolder(tx, input.holderId, input.containerId)
      if (!h) return { ok: false, code: 'holder_not_found' }
      if (!actor.courseEdit) return { ok: false, code: 'container_forbidden' }
      if (h.versionStatus !== 'draft') return { ok: false, code: 'container_published' }
      holder = { title: h.lesson.title, containerTitle: h.courseTitle }
    }
    else {
      const h = await trajectoryNodeHolder(tx, input.holderId, input.containerId)
      if (!h) return { ok: false, code: 'holder_not_found' }
      if (!actor.programManage) return { ok: false, code: 'container_forbidden' }
      if (h.status === 'published') return { ok: false, code: 'container_published' }
      // Модуль — это материал: вставляется в узел-задание, а не в логику графа (И/АБО, таймер)
      if (h.node.kind !== 'task') return { ok: false, code: 'holder_not_content' }
      holder = { title: h.node.title, containerTitle: h.trajectoryTitle }
    }

    const [taken] = await tx.select({ id: libraryModuleUsages.id }).from(libraryModuleUsages)
      .where(and(eq(libraryModuleUsages.holderType, input.holderType), eq(libraryModuleUsages.holderId, input.holderId), isNull(libraryModuleUsages.detachedAt)))
    if (taken) return { ok: false, code: 'already_attached' }

    if (input.holderType === 'course_lesson') {
      // Урок становится местом использования: своего материала нет, читает снимок версии.
      // `pass_score_pct` — порог теста в плане курса; у материала его не бывает.
      await tx.update(lessons).set({
        itemType: 'resource',
        itemId: snap.snapshot.resourceId,
        resourceVersionId: snap.snapshot.id,
        libraryVersionId: snap.version.id,
        passScorePct: null,
        updatedAt: new Date(),
      }).where(eq(lessons.id, input.holderId))
    }

    const [usage] = await tx.insert(libraryModuleUsages).values({
      tenantId: actor.tenantId,
      libraryModuleId: m.id,
      versionId: snap.version.id,
      holderType: input.holderType,
      holderId: input.holderId,
      holderTitle: holder.title,
      containerType: input.containerType,
      containerId: input.containerId,
      containerTitle: holder.containerTitle,
      pinMode: input.pinMode,
      isStale: false,
      latestVersionSeen: snap.version.version,
      attachedBy: actor.actorId,
    }).returning({ id: libraryModuleUsages.id })
    await tx.update(libraryModules).set({ usageCount: sql`${libraryModules.usageCount} + 1` }).where(eq(libraryModules.id, m.id))
    await recordAudit(tx, {
      tenantId: actor.tenantId, actorId: actor.actorId, action: 'library_usage.attach', entity: 'library_module', entityId: m.id,
      after: { usageId: usage!.id, holderType: input.holderType, holderId: input.holderId, containerType: input.containerType, containerId: input.containerId, version: snap.version.version, pinMode: input.pinMode },
    })
    return { ok: true, usage: (await usageById(tx, usage!.id))! }
  }).catch((err: unknown) => {
    // Частичный уникальный индекс держателя (§7.15) — последняя линия против гонки двух вставок
    if ((err as { code?: string }).code === '23505') return { ok: false as const, code: 'already_attached' as const }
    throw err
  })
}

// ── Отвязка (§7.10) ──────────────────────────────────────────────────────────────────────

export type DetachResult
  = | { ok: true, lessonId: string | null }
    | { ok: false, code: 'not_found' | 'already_detached' | 'container_forbidden' | 'container_published' }

/**
 * Копия снимка версии в собственный материал урока (внутри транзакции): «Відʼєднати і
 * зробити копією» (§7.10). Урок перестаёт быть местом использования и получает обычный
 * черновой материал, который закрепит публикация курса, как у любого урока плана.
 */
async function copySnapshotIntoLesson(tx: TenantTx, ctx: Ctx, lesson: typeof lessons.$inferSelect): Promise<void> {
  const [snap] = lesson.resourceVersionId
    ? await tx.select().from(resourceVersions).where(eq(resourceVersions.id, lesson.resourceVersionId))
    : []
  const [copy] = await tx.insert(resources).values({
    tenantId: ctx.tenantId,
    title: lesson.title,
    slug: `lesson-copy-${randomUUID().slice(0, 12)}`,
    kind: snap?.kind ?? 'article',
    body: snap?.body ?? [],
    plainText: snap?.plainText ?? '',
    mediaId: snap?.mediaId ?? null,
    externalUrl: snap?.externalUrl ?? null,
    authorIds: [ctx.actorId],
    status: 'draft', // опубликуется снимком вместе с курсом, как материал, созданный из плана
  }).returning({ id: resources.id })
  await tx.update(lessons).set({ itemId: copy!.id, resourceVersionId: null, libraryVersionId: null, updatedAt: new Date() })
    .where(eq(lessons.id, lesson.id))
}

/**
 * Отвязать место (§10 `POST /library/usages/:id/detach`). Урок курса **всегда** получает копию
 * тела закреплённой версии: урок не может остаться без материала, а «убрать урок из курса» —
 * это `DELETE /lessons/:id`, который отвязывает место сам. Узел траектории до PR-26 ссылки в
 * себе не держит — у него отвязка только закрывает строку реестра; копию в узел делает PR-26.
 */
export async function detachUsage(actor: LibraryActor, usageId: string): Promise<DetachResult> {
  return withTenant(actor.tenantId, actor.actorId, async (tx): Promise<DetachResult> => {
    const [u] = await tx.select().from(libraryModuleUsages).where(eq(libraryModuleUsages.id, usageId)).for('update')
    if (!u) return { ok: false, code: 'not_found' }
    if (u.detachedAt) return { ok: false, code: 'already_detached' }
    if (u.holderType === 'course_lesson' ? !actor.courseEdit : !actor.programManage) return { ok: false, code: 'container_forbidden' }

    let lessonId: string | null = null
    if (u.holderType === 'course_lesson') {
      const h = await courseLessonHolder(tx, u.holderId, u.containerId)
      if (h && h.lesson.libraryVersionId) {
        if (h.versionStatus !== 'draft') return { ok: false, code: 'container_published' }
        await copySnapshotIntoLesson(tx, actor, h.lesson)
        lessonId = h.lesson.id
      }
    }
    await closeUsages(tx, [u.id])
    await recordAudit(tx, {
      tenantId: actor.tenantId, actorId: actor.actorId, action: 'library_usage.detach', entity: 'library_module', entityId: u.libraryModuleId,
      after: { usageId: u.id, holderType: u.holderType, holderId: u.holderId, copiedInto: lessonId },
    })
    return { ok: true, lessonId }
  })
}

/** Закрыть места (`detached_at`) и пересчитать `usage_count` их модулей в той же транзакции (§7.9). */
async function closeUsages(tx: TenantTx, usageIds: string[]): Promise<number> {
  if (!usageIds.length) return 0
  const closed = await tx.update(libraryModuleUsages).set({ detachedAt: new Date(), updatedAt: new Date() })
    .where(and(inArray(libraryModuleUsages.id, usageIds), isNull(libraryModuleUsages.detachedAt)))
    .returning({ moduleId: libraryModuleUsages.libraryModuleId })
  const perModule = new Map<string, number>()
  for (const c of closed) perModule.set(c.moduleId, (perModule.get(c.moduleId) ?? 0) + 1)
  for (const [moduleId, n] of perModule) {
    await tx.update(libraryModules).set({ usageCount: sql`greatest(${libraryModules.usageCount} - ${n}, 0)` }).where(eq(libraryModules.id, moduleId))
  }
  return closed.length
}

// ── Крючки для редакторов курса и траектории (внутри их транзакций) ──────────────────────

/**
 * Держатели удалены (урок из плана, узел с полотна) — их места закрываются (§12 «Контейнер
 * удалён вместе с узлом: место получает detached_at, usage_count уменьшается»). Прав не
 * проверяет: зовётся из сервиса, который уже проверил право на контейнер.
 */
export async function detachHolders(tx: TenantTx, ctx: Ctx, holderType: LibraryHolderType, holderIds: string[]): Promise<number> {
  if (!holderIds.length) return 0
  const rows = await tx.select({ id: libraryModuleUsages.id, moduleId: libraryModuleUsages.libraryModuleId, holderId: libraryModuleUsages.holderId })
    .from(libraryModuleUsages)
    .where(and(eq(libraryModuleUsages.holderType, holderType), inArray(libraryModuleUsages.holderId, holderIds), isNull(libraryModuleUsages.detachedAt)))
  const n = await closeUsages(tx, rows.map(r => r.id))
  for (const r of rows) {
    await recordAudit(tx, {
      tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'library_usage.detach', entity: 'library_module', entityId: r.moduleId,
      after: { usageId: r.id, holderType, holderId: r.holderId, reason: 'holder_removed' },
    })
  }
  return n
}

/**
 * Черновая версия курса создаётся копией опубликованной (`courses.ts#ensureDraftVersion`), и
 * у урока-держателя появляется двойник с новым id. Место использования следует за черновиком:
 * именно его правит автор («Оновити», «Відʼєднати»), а урок опубликованной версии сохраняет
 * свою ссылку для тех, кто уже учится (Р-31.2), и удалить версию из-под него нельзя.
 */
export async function repointCourseLessonUsages(tx: TenantTx, pairs: { from: string, to: string }[]): Promise<void> {
  for (const p of pairs) {
    await tx.update(libraryModuleUsages).set({ holderId: p.to, updatedAt: new Date() })
      .where(and(eq(libraryModuleUsages.holderType, 'course_lesson'), eq(libraryModuleUsages.holderId, p.from), isNull(libraryModuleUsages.detachedAt)))
  }
}

/** Описание ссылки урока курса на библиотеку — для редактора курса (баннер «Доступна нова версія»). */
export interface LessonLibraryRef {
  moduleId: string
  moduleTitle: string
  moduleStatus: string
  versionId: string
  version: number
  latestVersion: number | null
  isStale: boolean
}

export async function lessonLibraryRefs(tx: TenantTx, versionIds: string[]): Promise<Map<string, LessonLibraryRef>> {
  if (!versionIds.length) return new Map()
  const rows = await tx.select({
    versionId: libraryModuleVersions.id,
    version: libraryModuleVersions.version,
    moduleId: libraryModules.id,
    moduleTitle: libraryModules.title,
    moduleStatus: libraryModules.status,
    currentVersionId: libraryModules.currentVersionId,
    latestVersion: sql<number | null>`(select cv.version from library_module_versions cv where cv.id = ${libraryModules.currentVersionId})`,
  }).from(libraryModuleVersions)
    .innerJoin(libraryModules, eq(libraryModules.id, libraryModuleVersions.libraryModuleId))
    .where(inArray(libraryModuleVersions.id, versionIds))
  return new Map(rows.map(r => [r.versionId, {
    moduleId: r.moduleId,
    moduleTitle: r.moduleTitle,
    moduleStatus: r.moduleStatus,
    versionId: r.versionId,
    version: r.version,
    latestVersion: r.latestVersion === null ? null : Number(r.latestVersion),
    isStale: isStale(r.versionId, r.currentVersionId),
  }]))
}

// ── Ночная сверка (§7.9, §11 `library.usage_recalc`) ────────────────────────────────────

export interface RecalcStats { detached: number, staleFixed: number, countsFixed: number }

/**
 * Сверка денормализованного с фактом (§11): места, чей держатель исчез мимо крючков
 * (раздел курса удалён целиком, узел удалён не через полотно), закрываются; `is_stale` и
 * `usage_count` пересчитываются. В `audit_log` — только при расхождении, одной записью.
 */
export async function usageRecalc(tenantId: string): Promise<RecalcStats> {
  return withTenant(tenantId, null, async (tx) => {
    const lost = await tx.execute(sql`
      select u.id from library_module_usages u
      where u.detached_at is null and (
        (u.holder_type = 'course_lesson' and not exists (
          select 1 from lessons l where l.id = u.holder_id and l.module_id is not null and l.library_version_id is not null))
        or (u.holder_type = 'trajectory_node' and not exists (select 1 from trajectory_nodes n where n.id = u.holder_id))
      )`) as unknown as { id: string }[]
    const detached = await closeUsages(tx, lost.map(r => r.id))

    const stale = await tx.execute(sql`
      update library_module_usages u set is_stale = (m.current_version_id is not null and u.version_id <> m.current_version_id), updated_at = now()
      from library_modules m
      where m.id = u.library_module_id and u.detached_at is null
        and u.is_stale is distinct from (m.current_version_id is not null and u.version_id <> m.current_version_id)
      returning u.id`) as unknown as { id: string }[]

    const counts = await tx.execute(sql`
      update library_modules m set usage_count = c.n
      from (
        select m2.id, count(u.id)::int as n from library_modules m2
        left join library_module_usages u on u.library_module_id = m2.id and u.detached_at is null
        group by m2.id
      ) c
      where c.id = m.id and m.usage_count <> c.n
      returning m.id`) as unknown as { id: string }[]

    const stats = { detached, staleFixed: stale.length, countsFixed: counts.length }
    if (stats.detached || stats.staleFixed || stats.countsFixed) {
      await recordAudit(tx, { tenantId, actorId: null, action: 'library.usage_recalc', entity: 'library_module', after: stats })
    }
    return stats
  })
}
