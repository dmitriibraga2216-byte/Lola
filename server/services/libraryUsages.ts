import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm'
import {
  courseVersions, courses, enrollments, lessons, libraryModuleUsages, libraryModuleVersions, libraryModules, modules,
  resourceVersions, resources, trajectories, trajectoryEnrollments, trajectoryNodeStates, trajectoryNodes, users,
} from '../db/schema'
import type { TenantTx } from '../utils/withTenant'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import type { LibraryActor, VersionCompare } from './library'
import { bodyStatsSql, compareVersionsTx, versionSnapshot } from './library'
import type { LibraryAttachInput, LibraryUpdateVersionInput } from '../../shared/schemas/library'
import type { LibraryContainerType, LibraryHolderType, LibraryModuleStatus, LibraryPinMode } from '../../shared/enums'
import {
  hotfixDecision, isStale, typeIconOf, updateVerdict, type LibraryTypeIcon,
} from '../../shared/domain/library'

/**
 * Места использования модулей библиотеки — «де використовується» (`docs/v2/31` §3.4, §5.3,
 * §5.5, §7.1–§7.4, §7.9, §7.10; PR-25 и PR-26).
 *
 * Два вида держателя ссылки (§3.4), и у обоих ссылка живёт в самом держателе:
 * - **урок курса** — `lessons.library_version_id` плюс `resource_version_id` снимка версии
 *   (`lessons_library_ref_ck`). Своего материала у такого урока нет, плеер показывает
 *   закреплённый снимок, публикация курса его не перезакрепляет;
 * - **узел траектории** — `trajectory_nodes.library_version_id` (PR-26, миграция 0088,
 *   `trajectory_nodes_library_ref_ck`): узел-задание, чей контент — материал-тело модуля.
 *   Назначение, которое узел выдаёт человеку, закрепляется за снимком **этой** версии
 *   (`trajectories.ts#createNodeAssignment`), а не за последней.
 *
 * Реестр `library_module_usages` отвечает на вопросы «где используется», «на какой версии»,
 * «что устарело» и держит модуль от удаления (критерии 1, 3, 4). Строка места не удаляется
 * никогда: `detached_at` конечен (§4), отключённые места нужны отчёту и правилу §7.5.
 *
 * Версию места меняют ровно три пути, все здесь: явное «Оновити до останньої версії» (§7.3,
 * одиночно и массово), «Критичне виправлення» с `pin_mode = 'hotfix_auto'` (§7.4, фоновая
 * `library.hotfix_propagate`) и отвязка (§7.10). Публикация версии места не трогает (Р-31.2).
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

// ── Держатели ────────────────────────────────────────────────────────────────────────────

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

type UsageRecord = typeof libraryModuleUsages.$inferSelect

/**
 * Держит ли держатель ссылку сейчас и можно ли переключить её версию (§7.3). Узел траектории
 * переключается и в опубликованной траектории: состав графа не меняется, а те, кому узел уже
 * выдал назначение, остаются на своём снимке (назначение закреплено за ним). Урок курса —
 * только в черновой версии курса: опубликованная версия неизменяема, на неё ссылаются
 * прохождения и сертификаты (`docs/11` §7.1, `31` §12).
 */
async function holderState(tx: TenantTx, u: UsageRecord): Promise<{ exists: boolean, mutable: boolean }> {
  if (u.holderType === 'course_lesson') {
    const h = await courseLessonHolder(tx, u.holderId, u.containerId)
    return { exists: !!h?.lesson.libraryVersionId, mutable: h?.versionStatus === 'draft' }
  }
  const [n] = await tx.select({ libraryVersionId: trajectoryNodes.libraryVersionId }).from(trajectoryNodes).where(eq(trajectoryNodes.id, u.holderId))
  return { exists: !!n?.libraryVersionId, mutable: true }
}

/** Прохождения `in_progress` по контейнеру (§7.4): люди траектории или записи на курс. */
export async function inProgressIn(tx: TenantTx, containerType: string, containerId: string): Promise<number> {
  if (containerType === 'trajectory') {
    const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(trajectoryEnrollments)
      .where(and(eq(trajectoryEnrollments.trajectoryId, containerId), eq(trajectoryEnrollments.status, 'in_progress'), isNull(trajectoryEnrollments.cancelledAt)))
    return r?.n ?? 0
  }
  const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(enrollments)
    .where(and(eq(enrollments.subjectId, containerId), eq(enrollments.status, 'in_progress'), isNull(enrollments.cancelledAt)))
  return r?.n ?? 0
}

/** Автор контейнера — адресат уведомлений §8 (как `containerAuthors` в `library.ts`). */
async function containerAuthorOf(tx: TenantTx, containerType: string, containerId: string): Promise<string | null> {
  if (containerType === 'trajectory') {
    const [t] = await tx.select({ id: sql<string | null>`coalesce(${trajectories.createdBy}, ${trajectories.updatedBy})` }).from(trajectories).where(eq(trajectories.id, containerId))
    return t?.id ?? null
  }
  const [c] = await tx.select({ id: courses.createdBy }).from(courses).where(eq(courses.id, containerId))
  return c?.id ?? null
}

// ── Вставка (§5.4, §7.1, §7.2, §7.15) ────────────────────────────────────────────────────

export type AttachFailCode = 'not_found' | 'holder_not_found' | 'module_archived' | 'module_not_published' | 'already_attached' | 'container_forbidden' | 'container_published' | 'holder_not_content'

export type AttachResult
  = | { ok: true, usage: UsageRow }
    | { ok: false, code: AttachFailCode }

/**
 * Вставка внутри транзакции вызывающего — ею пользуются и `POST /library/usages`, и полотно
 * траектории (`trajectories.ts#putGraph`, модуль из палитры §5.4 сохраняется вместе с графом).
 * Закрепляется версия, текущая **на момент вставки** (§7.2), черновик на неё не влияет (§12).
 */
export async function attachTx(tx: TenantTx, actor: LibraryActor, input: LibraryAttachInput): Promise<AttachResult> {
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
    // «Вузол» на экране §5.3: своя подпись узла, а без неё — то, что узел показывает на полотне
    holder = { title: h.node.title ?? snap.version.title, containerTitle: h.trajectoryTitle }
  }

  const [taken] = await tx.select({ id: libraryModuleUsages.id }).from(libraryModuleUsages)
    .where(and(eq(libraryModuleUsages.holderType, input.holderType), eq(libraryModuleUsages.holderId, input.holderId), isNull(libraryModuleUsages.detachedAt)))
  if (taken) return { ok: false, code: 'already_attached' }

  const now = new Date()
  if (input.holderType === 'course_lesson') {
    // Урок становится местом использования: своего материала нет, читает снимок версии.
    // `pass_score_pct` — порог теста в плане курса; у материала его не бывает.
    await tx.update(lessons).set({
      itemType: 'resource',
      itemId: snap.snapshot.resourceId,
      resourceVersionId: snap.snapshot.id,
      libraryVersionId: snap.version.id,
      passScorePct: null,
      updatedAt: now,
    }).where(eq(lessons.id, input.holderId))
  }
  else {
    // Узел-ссылка (П-17): контент — материал-тело модуля, человек получит снимок этой версии
    await tx.update(trajectoryNodes).set({
      contentType: 'resource',
      contentId: snap.snapshot.resourceId,
      libraryVersionId: snap.version.id,
      updatedAt: now,
    }).where(eq(trajectoryNodes.id, input.holderId))
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
}

/**
 * Вставить модуль в место (§10 `POST /library/usages`). Архивный модуль и модуль без
 * опубликованной версии не вставляются: в палитре их нет (§7.6), а вставлять нечего.
 * Право на контейнер — `course.edit` для курса, `program.manage` для траектории; без него —
 * `container_forbidden` (mentor и manager с `library.use` вставлять не могут, §2).
 */
export async function attachUsage(actor: LibraryActor, input: LibraryAttachInput): Promise<AttachResult> {
  return withTenant(actor.tenantId, actor.actorId, tx => attachTx(tx, actor, input)).catch((err: unknown) => {
    // Частичный уникальный индекс держателя (§7.15) — последняя линия против гонки двух вставок
    if ((err as { code?: string }).code === '23505') return { ok: false as const, code: 'already_attached' as const }
    throw err
  })
}

// ── Узел траектории на полотне: что показывает ссылка (§5.4) ─────────────────────────────

/** Ссылка узла на модуль — для полотна: подпись «Бібліотека · v2», баннер «Доступна нова версія», карточка ссылки. */
export interface NodeLibraryRef {
  /** Строка реестра — ею работают «Оновити» и «Відʼєднати» (§10). */
  usageId: string | null
  moduleId: string
  moduleTitle: string
  moduleStatus: LibraryModuleStatus
  versionId: string
  /** Закреплённая версия — её и показывает узел (условие выхода PR-26). */
  version: number
  versionTitle: string
  latestVersion: number | null
  isStale: boolean
  pinMode: LibraryPinMode
  contentKind: string
  typeIcon: LibraryTypeIcon
  estimatedMinutes: number | null
}

/**
 * Ссылки узлов на библиотеку по id узлов. Всё, что показывает узел, берётся из **закреплённой**
 * версии (название, тип, длительность, иконка по телу снимка), а последняя — только номером для
 * баннера: узел трека показывает свою версию, а не последнюю.
 */
export async function nodeLibraryRefs(tx: TenantTx, nodeIds: string[]): Promise<Map<string, NodeLibraryRef>> {
  if (!nodeIds.length) return new Map()
  const rows = await tx.execute(sql`
    select n.id as node_id, v.id as version_id, v.version, v.title as version_title, v.content_kind, v.estimated_minutes,
           m.id as module_id, m.title as module_title, m.status as module_status, m.current_version_id,
           (select cv.version from library_module_versions cv where cv.id = m.current_version_id) as latest_version,
           u.id as usage_id, u.pin_mode, s.blocks, s.checklists, s.has_table
    from trajectory_nodes n
    join library_module_versions v on v.id = n.library_version_id
    join library_modules m on m.id = v.library_module_id
    join lessons l on l.id = v.lesson_id
    join resource_versions rv on rv.id = l.resource_version_id
    cross join lateral (${bodyStatsSql(sql`rv.body`)}) s
    left join library_module_usages u on u.holder_type = 'trajectory_node' and u.holder_id = n.id and u.detached_at is null
    where n.id in (${sql.join(nodeIds.map(id => sql`${id}::uuid`), sql`, `)})
  `) as unknown as {
    node_id: string, version_id: string, version: number, version_title: string, content_kind: string, estimated_minutes: number | null
    module_id: string, module_title: string, module_status: string, current_version_id: string | null, latest_version: number | null
    usage_id: string | null, pin_mode: string | null, blocks: number, checklists: number, has_table: boolean
  }[]
  return new Map(rows.map(r => [r.node_id, {
    usageId: r.usage_id,
    moduleId: r.module_id,
    moduleTitle: r.module_title,
    moduleStatus: r.module_status as LibraryModuleStatus,
    versionId: r.version_id,
    version: Number(r.version),
    versionTitle: r.version_title,
    latestVersion: r.latest_version === null ? null : Number(r.latest_version),
    isStale: isStale(r.version_id, r.current_version_id),
    pinMode: (r.pin_mode ?? 'hotfix_auto') as LibraryPinMode,
    contentKind: r.content_kind,
    typeIcon: typeIconOf(r.content_kind, { blocks: Number(r.blocks), checklists: Number(r.checklists), hasTable: !!r.has_table }),
    estimatedMinutes: r.estimated_minutes,
  }]))
}

/** Снимок, который узел выдаёт человеку: назначение закрепляется за ним (`trajectories.ts#createNodeAssignment`). */
export async function pinnedNodeSnapshot(tx: TenantTx, libraryVersionId: string): Promise<{ id: string, title: string } | null> {
  const snap = await versionSnapshot(tx, libraryVersionId)
  return snap ? { id: snap.snapshot.id, title: snap.snapshot.title } : null
}

// ── Отвязка (§7.10) ──────────────────────────────────────────────────────────────────────

export type DetachResult
  = | { ok: true, lessonId: string | null, resourceId: string | null }
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
 * Копия снимка версии в узел траектории (§7.10): узел получает обычный **опубликованный**
 * материал с телом закреплённой версии. Опубликованный — потому что у траектории нет своей
 * публикации контента, как у курса: узел назначает то, что уже можно выдать (`findContent`),
 * иначе проверка полотна показала бы «контент не опубліковано». Копия — самостоятельный
 * материал автора: правка модуля до неё больше не доходит, обратно — только новой вставкой.
 */
async function copySnapshotIntoNode(tx: TenantTx, ctx: Ctx, node: typeof trajectoryNodes.$inferSelect): Promise<string | null> {
  const snap = node.libraryVersionId ? await versionSnapshot(tx, node.libraryVersionId) : null
  if (!snap) return null
  const now = new Date()
  const [copy] = await tx.insert(resources).values({
    tenantId: ctx.tenantId,
    title: node.title ?? snap.snapshot.title,
    slug: `node-copy-${randomUUID().slice(0, 12)}`,
    kind: snap.snapshot.kind,
    body: snap.snapshot.body,
    plainText: snap.snapshot.plainText,
    mediaId: snap.snapshot.mediaId,
    externalUrl: snap.snapshot.externalUrl,
    estimatedMinutes: snap.version.estimatedMinutes,
    authorIds: [ctx.actorId],
    status: 'published',
    version: 1,
  }).returning({ id: resources.id })
  const [rv] = await tx.insert(resourceVersions).values({
    tenantId: ctx.tenantId,
    resourceId: copy!.id,
    version: 1,
    title: node.title ?? snap.snapshot.title,
    kind: snap.snapshot.kind,
    body: snap.snapshot.body,
    plainText: snap.snapshot.plainText,
    mediaId: snap.snapshot.mediaId,
    externalUrl: snap.snapshot.externalUrl,
    changelog: `Копія модуля бібліотеки «${snap.version.title}» v${snap.version.version}`,
    publishedBy: ctx.actorId,
  }).returning({ id: resourceVersions.id })
  await tx.update(resources).set({ publishedVersionId: rv!.id, updatedAt: now }).where(eq(resources.id, copy!.id))
  await tx.update(trajectoryNodes).set({ contentType: 'resource', contentId: copy!.id, libraryVersionId: null, updatedAt: now })
    .where(eq(trajectoryNodes.id, node.id))
  return copy!.id
}

/**
 * Отвязать место (§10 `POST /library/usages/:id/detach`). Урок курса **всегда** получает копию
 * тела закреплённой версии: урок не может остаться без материала, а «убрать урок из курса» —
 * это `DELETE /lessons/:id`, который отвязывает место сам. Узел траектории с `makeCopy`
 * (по умолчанию) получает опубликованную копию, без него — пустое задание, в которое автор
 * выберет другой контент. Опубликованный трек и опубликованную версию курса не меняют.
 */
export async function detachUsage(actor: LibraryActor, usageId: string, opts: { makeCopy?: boolean } = {}): Promise<DetachResult> {
  const makeCopy = opts.makeCopy ?? true
  return withTenant(actor.tenantId, actor.actorId, async (tx): Promise<DetachResult> => {
    const [u] = await tx.select().from(libraryModuleUsages).where(eq(libraryModuleUsages.id, usageId)).for('update')
    if (!u) return { ok: false, code: 'not_found' }
    if (u.detachedAt) return { ok: false, code: 'already_detached' }
    if (u.holderType === 'course_lesson' ? !actor.courseEdit : !actor.programManage) return { ok: false, code: 'container_forbidden' }

    let lessonId: string | null = null
    let resourceId: string | null = null
    if (u.holderType === 'course_lesson') {
      const h = await courseLessonHolder(tx, u.holderId, u.containerId)
      if (h && h.lesson.libraryVersionId) {
        if (h.versionStatus !== 'draft') return { ok: false, code: 'container_published' }
        await copySnapshotIntoLesson(tx, actor, h.lesson)
        lessonId = h.lesson.id
      }
    }
    else {
      const h = await trajectoryNodeHolder(tx, u.holderId, u.containerId)
      if (h && h.node.libraryVersionId) {
        if (h.status === 'published') return { ok: false, code: 'container_published' }
        if (makeCopy) resourceId = await copySnapshotIntoNode(tx, actor, h.node)
        else {
          await tx.update(trajectoryNodes).set({ contentType: null, contentId: null, libraryVersionId: null, updatedAt: new Date() })
            .where(eq(trajectoryNodes.id, h.node.id))
        }
      }
    }
    await closeUsages(tx, [u.id])
    await recordAudit(tx, {
      tenantId: actor.tenantId, actorId: actor.actorId, action: 'library_usage.detach', entity: 'library_module', entityId: u.libraryModuleId,
      after: { usageId: u.id, holderType: u.holderType, holderId: u.holderId, copiedInto: lessonId ?? resourceId, makeCopy },
    })
    return { ok: true, lessonId, resourceId }
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

// ── Обновление до новой версии (§5.5, §7.3, критерий 2) ─────────────────────────────────

type VersionRecord = typeof libraryModuleVersions.$inferSelect

/** Целевая версия: указанная номером или последняя опубликованная. */
async function targetVersion(tx: TenantTx, moduleId: string, toVersion?: number): Promise<VersionRecord | null> {
  if (toVersion !== undefined) {
    const [v] = await tx.select().from(libraryModuleVersions)
      .where(and(eq(libraryModuleVersions.libraryModuleId, moduleId), eq(libraryModuleVersions.version, toVersion)))
    return v ?? null
  }
  const [m] = await tx.select({ current: libraryModules.currentVersionId }).from(libraryModules).where(eq(libraryModules.id, moduleId))
  if (!m?.current) return null
  const [v] = await tx.select().from(libraryModuleVersions).where(eq(libraryModuleVersions.id, m.current))
  return v ?? null
}

/**
 * Переключить держателя и строку реестра на версию `target` (внутри транзакции). Держатель
 * получает снимок новой версии: урок — `resource_version_id`, узел — `library_version_id`
 * (назначение, выданное раньше, остаётся на прежнем снимке — те, кто уже начал, доучиваются
 * на своей версии). `is_stale` снимается, только если цель и есть последняя версия.
 */
async function applyVersionTx(tx: TenantTx, u: UsageRecord, target: VersionRecord): Promise<void> {
  const snap = await versionSnapshot(tx, target.id)
  if (!snap) throw new Error(`library_module_version ${target.id}: нет снимка`)
  const [m] = await tx.select({ currentVersionId: libraryModules.currentVersionId }).from(libraryModules).where(eq(libraryModules.id, u.libraryModuleId))
  const [current] = m?.currentVersionId
    ? await tx.select({ version: libraryModuleVersions.version }).from(libraryModuleVersions).where(eq(libraryModuleVersions.id, m.currentVersionId))
    : []
  const now = new Date()
  if (u.holderType === 'course_lesson') {
    await tx.update(lessons).set({ itemId: snap.snapshot.resourceId, resourceVersionId: snap.snapshot.id, libraryVersionId: target.id, updatedAt: now })
      .where(eq(lessons.id, u.holderId))
  }
  else {
    await tx.update(trajectoryNodes).set({ contentType: 'resource', contentId: snap.snapshot.resourceId, libraryVersionId: target.id, updatedAt: now })
      .where(eq(trajectoryNodes.id, u.holderId))
  }
  await tx.update(libraryModuleUsages).set({
    versionId: target.id,
    isStale: isStale(target.id, m?.currentVersionId ?? null),
    latestVersionSeen: current?.version ?? target.version,
    updatedAt: now,
  }).where(eq(libraryModuleUsages.id, u.id))
}

export type UpdateVersionFailCode
  = 'not_found' | 'already_detached' | 'container_forbidden' | 'container_published' | 'holder_not_found'
    | 'version_not_found' | 'already_latest' | 'version_downgrade' | 'version_retired'

export type UpdateVersionResult
  = | { ok: true, usage: UsageRow, updatedFrom: number, updatedTo: number }
    | { ok: false, code: UpdateVersionFailCode }

/**
 * «Оновити до останньої версії» одного места (§5.5, §7.3, §10 `update-version`). Только явное
 * действие носителя права на контейнер: `course.edit` для курса, `program.manage` для трека.
 * Меняет `version_id` места и снимает `is_stale`; уже начатые прохождения остаются на прежней
 * версии (критерий 2: после подтверждения узел отдаёт тело новой версии).
 */
export async function updateUsageVersion(actor: LibraryActor, usageId: string, input: LibraryUpdateVersionInput = {}): Promise<UpdateVersionResult> {
  return withTenant(actor.tenantId, actor.actorId, async (tx): Promise<UpdateVersionResult> => {
    const [u] = await tx.select().from(libraryModuleUsages).where(eq(libraryModuleUsages.id, usageId)).for('update')
    if (!u) return { ok: false, code: 'not_found' }
    if (u.detachedAt) return { ok: false, code: 'already_detached' }
    if (u.holderType === 'course_lesson' ? !actor.courseEdit : !actor.programManage) return { ok: false, code: 'container_forbidden' }
    const target = await targetVersion(tx, u.libraryModuleId, input.toVersion)
    if (!target) return { ok: false, code: 'version_not_found' }
    const [pinned] = await tx.select().from(libraryModuleVersions).where(eq(libraryModuleVersions.id, u.versionId))
    const verdict = updateVerdict(pinned!.version, target)
    if (!verdict.ok) return { ok: false, code: verdict.code }
    const holder = await holderState(tx, u)
    if (!holder.exists) return { ok: false, code: 'holder_not_found' }
    if (!holder.mutable) return { ok: false, code: 'container_published' }

    await applyVersionTx(tx, u, target)
    await recordAudit(tx, {
      tenantId: actor.tenantId, actorId: actor.actorId, action: 'library_usage.update_version', entity: 'library_module', entityId: u.libraryModuleId,
      before: { usageId: u.id, version: pinned!.version }, after: { usageId: u.id, version: target.version, holderType: u.holderType, holderId: u.holderId },
    })
    return { ok: true, usage: (await usageById(tx, u.id))!, updatedFrom: pinned!.version, updatedTo: target.version }
  })
}

export interface UpdatePreview {
  usage: UsageRow
  /** Changelog пропущенных версий, поблочный diff и тела «було / стало» (§5.5). */
  compare: VersionCompare
  /**
   * «Оновлення не змінить проходження N людей, які вже почали. Вони залишаться на v2» (§5.5):
   * у курса — записи `in_progress` (они на своей версии курса), у трека — прохождения
   * `in_progress`, где узел уже выдал человеку задание на закреплённом снимке. Кто до узла ещё не
   * дошёл, получит новую версию — его в этом числе нет, иначе строка обещала бы неправду.
   */
  alreadyStarted: number
}

/** Сколько людей уже начали это место на закреплённой версии и на ней останутся (§5.5). */
async function startedOnPinned(tx: TenantTx, u: UsageRecord): Promise<number> {
  if (u.containerType !== 'trajectory') return inProgressIn(tx, u.containerType, u.containerId)
  const [r] = await tx.select({ n: sql<number>`count(distinct ${trajectoryEnrollments.id})::int` }).from(trajectoryEnrollments)
    .innerJoin(trajectoryNodeStates, eq(trajectoryNodeStates.enrollmentId, trajectoryEnrollments.id))
    .where(and(
      eq(trajectoryEnrollments.trajectoryId, u.containerId), eq(trajectoryEnrollments.status, 'in_progress'), isNull(trajectoryEnrollments.cancelledAt),
      eq(trajectoryNodeStates.nodeId, u.holderId), sql`${trajectoryNodeStates.status} <> 'locked'`,
    ))
  return r?.n ?? 0
}

export type UpdatePreviewResult
  = | { ok: true, preview: UpdatePreview }
    | { ok: false, code: 'not_found' | 'already_detached' | 'version_not_found' | 'already_latest' | 'version_downgrade' | 'version_retired' }

/**
 * Всё, что показывает диалог «Оновити «…» з v2 до v4» (§5.5): changelog каждой пропущенной
 * версии, поблочный diff закреплённой и целевой, число людей, которые уже проходят и
 * останутся на своей версии. Сервер считает, диалог показывает.
 */
export async function updatePreview(actor: LibraryActor, usageId: string, toVersion?: number): Promise<UpdatePreviewResult> {
  return withTenant(actor.tenantId, actor.actorId, async (tx): Promise<UpdatePreviewResult> => {
    const [u] = await tx.select().from(libraryModuleUsages).where(eq(libraryModuleUsages.id, usageId))
    if (!u) return { ok: false, code: 'not_found' }
    if (u.detachedAt) return { ok: false, code: 'already_detached' }
    const target = await targetVersion(tx, u.libraryModuleId, toVersion)
    if (!target) return { ok: false, code: 'version_not_found' }
    const [pinned] = await tx.select().from(libraryModuleVersions).where(eq(libraryModuleVersions.id, u.versionId))
    const verdict = updateVerdict(pinned!.version, target)
    if (!verdict.ok) return { ok: false, code: verdict.code }
    const compare = await compareVersionsTx(tx, u.libraryModuleId, pinned!.version, target.version)
    if (!compare) return { ok: false, code: 'version_not_found' }
    return {
      ok: true,
      preview: { usage: (await usageById(tx, u.id))!, compare, alreadyStarted: await startedOnPinned(tx, u) },
    }
  })
}

export interface UpdateAllSkip { usageId: string, containerTitle: string, holderTitle: string | null, reason: 'container_published' | 'holder_not_found' }

export type UpdateAllResult
  = | { ok: true, updated: number, skipped: UpdateAllSkip[], toVersion: number }
    | { ok: false, code: 'not_found' | 'forbidden' | 'version_not_found' | 'version_retired' }

/**
 * «Оновити все до v4» (§5.3, §10 `update-all-usages`) — только `library.manage` (§2). Места,
 * которые уже на целевой версии или новее, не трогаются и пропусками не считаются; пропуск —
 * это место, которое обновить нельзя: урок в опубликованной версии курса (править можно только
 * черновик) или держатель, исчезнувший мимо крючков. Прохождения не проверяются: «Ті, хто вже
 * проходить, залишаться на своїй версії» — действие явное, как и одиночное обновление.
 */
export async function updateAllUsages(actor: LibraryActor, moduleId: string, input: LibraryUpdateVersionInput = {}): Promise<UpdateAllResult> {
  return withTenant(actor.tenantId, actor.actorId, async (tx): Promise<UpdateAllResult> => {
    const [m] = await tx.select({ id: libraryModules.id }).from(libraryModules).where(eq(libraryModules.id, moduleId)).for('update')
    if (!m) return { ok: false, code: 'not_found' }
    if (!actor.manage) return { ok: false, code: 'forbidden' }
    const target = await targetVersion(tx, moduleId, input.toVersion)
    if (!target) return { ok: false, code: 'version_not_found' }
    if (target.status === 'retired') return { ok: false, code: 'version_retired' }

    const places = await tx.select({ usage: libraryModuleUsages, version: libraryModuleVersions.version }).from(libraryModuleUsages)
      .innerJoin(libraryModuleVersions, eq(libraryModuleVersions.id, libraryModuleUsages.versionId))
      .where(and(eq(libraryModuleUsages.libraryModuleId, moduleId), isNull(libraryModuleUsages.detachedAt)))
      .orderBy(asc(libraryModuleUsages.containerTitle))
      .for('update', { of: libraryModuleUsages })
    let updated = 0
    const skipped: UpdateAllSkip[] = []
    for (const p of places) {
      if (p.version >= target.version) continue
      const holder = await holderState(tx, p.usage)
      if (!holder.exists || !holder.mutable) {
        skipped.push({ usageId: p.usage.id, containerTitle: p.usage.containerTitle, holderTitle: p.usage.holderTitle, reason: holder.exists ? 'container_published' : 'holder_not_found' })
        continue
      }
      await applyVersionTx(tx, p.usage, target)
      updated++
    }
    await recordAudit(tx, {
      tenantId: actor.tenantId, actorId: actor.actorId, action: 'library_module.update_all_usages', entity: 'library_module', entityId: moduleId,
      after: { toVersion: target.version, updated, skipped: skipped.map(s => ({ usageId: s.usageId, reason: s.reason })) },
    })
    return { ok: true, updated, skipped, toVersion: target.version }
  })
}

// ── Критичне виправлення (§7.4, §11 `library.hotfix_propagate`, критерий 6) ─────────────

export interface HotfixStats { applied: number, blocked: number, skipped: number, notified: number }

/**
 * Разнести «Критичне виправлення» по местам (фоновая задача по событию публикации версии с
 * `is_hotfix`). Решение по каждому месту — `hotfixDecision` (`shared/domain/library.ts`):
 * `hotfix_auto` и ни одного прохождения `in_progress` по контейнеру — место переключается на
 * хотфикс сразу; есть люди в процессе — место остаётся устаревшим, а автор контейнера получает
 * `library_hotfix_blocked` («Оновіть вручну»). Уведомления — по одному на контейнер и адресата
 * (§12: не по письму на каждое место). Повторный прогон ничего не дублирует: применённые места
 * уже на хотфиксе, уведомления дедуплицируются ключом.
 */
export async function propagateHotfix(tenantId: string, moduleId: string, versionId: string): Promise<HotfixStats> {
  return withTenant(tenantId, null, async (tx): Promise<HotfixStats> => {
    const stats: HotfixStats = { applied: 0, blocked: 0, skipped: 0, notified: 0 }
    const [v] = await tx.select().from(libraryModuleVersions)
      .where(and(eq(libraryModuleVersions.id, versionId), eq(libraryModuleVersions.libraryModuleId, moduleId)))
    if (!v || !v.isHotfix) return stats
    const [m] = await tx.select({ title: libraryModules.title }).from(libraryModules).where(eq(libraryModules.id, moduleId))
    if (!m) return stats

    const places = await tx.select({ usage: libraryModuleUsages, version: libraryModuleVersions.version }).from(libraryModuleUsages)
      .innerJoin(libraryModuleVersions, eq(libraryModuleVersions.id, libraryModuleUsages.versionId))
      .where(and(eq(libraryModuleUsages.libraryModuleId, moduleId), isNull(libraryModuleUsages.detachedAt)))
      .for('update', { of: libraryModuleUsages })

    const inProgressCache = new Map<string, number>()
    const outcome = new Map<string, { containerType: string, containerId: string, containerTitle: string, kind: 'applied' | 'in_progress' | 'published' }>()
    for (const p of places) {
      const key = `${p.usage.containerType}:${p.usage.containerId}`
      if (!inProgressCache.has(key)) inProgressCache.set(key, await inProgressIn(tx, p.usage.containerType, p.usage.containerId))
      const holder = await holderState(tx, p.usage)
      if (!holder.exists) { stats.skipped++; continue }
      const decision = hotfixDecision({ pinMode: p.usage.pinMode, pinnedVersion: p.version, hotfixVersion: v.version, inProgress: inProgressCache.get(key)!, holderMutable: holder.mutable })
      if (decision === 'skip_fixed' || decision === 'skip_newer') { stats.skipped++; continue }
      const base = { containerType: p.usage.containerType, containerId: p.usage.containerId, containerTitle: p.usage.containerTitle }
      if (decision === 'apply') {
        await applyVersionTx(tx, p.usage, v)
        stats.applied++
        await recordAudit(tx, {
          tenantId, actorId: null, action: 'library_usage.hotfix_apply', entity: 'library_module', entityId: moduleId,
          before: { usageId: p.usage.id, version: p.version }, after: { usageId: p.usage.id, version: v.version },
        })
        // Блокировка по контейнеру важнее: если хоть одно место контейнера осталось, автор должен об этом узнать
        if (!outcome.has(key)) outcome.set(key, { ...base, kind: 'applied' })
      }
      else {
        stats.blocked++
        // Место остаётся устаревшим — на случай, если флаг сбит, ставим его явно (§7.4)
        if (!p.usage.isStale) await tx.update(libraryModuleUsages).set({ isStale: true, updatedAt: new Date() }).where(eq(libraryModuleUsages.id, p.usage.id))
        outcome.set(key, { ...base, kind: decision === 'blocked_in_progress' ? 'in_progress' : 'published' })
      }
    }

    for (const o of outcome.values()) {
      const authorId = await containerAuthorOf(tx, o.containerType, o.containerId)
      if (!authorId) continue
      const code = o.kind === 'applied' ? 'library_hotfix_applied' : 'library_hotfix_blocked'
      const sent = await enqueueNotification(tx, {
        tenantId, userId: authorId, code, channel: 'inapp',
        payload: { title: m.title, container: o.containerTitle, version: v.version, inProgress: o.kind === 'in_progress', published: o.kind === 'published' },
        dedupKey: `${code}:${v.id}:${o.containerId}:${authorId}`,
        refType: 'library_module', refId: moduleId,
      })
      if (sent) stats.notified++
    }
    if (stats.applied || stats.blocked) {
      await recordAudit(tx, { tenantId, actorId: null, action: 'library.hotfix_propagate', entity: 'library_module', entityId: moduleId, after: { versionId, version: v.version, ...stats } })
    }
    return stats
  })
}

// ── Еженедельный дайджест устаревших ссылок (§8 `library_stale_digest`, §11) ────────────

/** Понедельник недели `at` (UTC, `YYYY-MM-DD`) — ключ дедупликации: один дайджест в неделю. */
export function weekKey(at: Date): string {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}

/**
 * «У ваших треках {n} посилань на застарілі версії модулів» (§8): авторам контейнеров, где
 * есть активные места с `is_stale`. Одно уведомление на автора в неделю, число — сумма по всем
 * его трекам и курсам. Возвращает число адресатов, которым дайджест поставлен в очередь.
 */
export async function staleDigest(tenantId: string, at: Date = new Date()): Promise<{ authors: number, links: number }> {
  return withTenant(tenantId, null, async (tx) => {
    const rows = await tx.select({
      containerType: libraryModuleUsages.containerType,
      containerId: libraryModuleUsages.containerId,
      n: sql<number>`count(*)::int`,
    }).from(libraryModuleUsages)
      .where(and(isNull(libraryModuleUsages.detachedAt), eq(libraryModuleUsages.isStale, true)))
      .groupBy(libraryModuleUsages.containerType, libraryModuleUsages.containerId)
    const perAuthor = new Map<string, number>()
    for (const r of rows) {
      const authorId = await containerAuthorOf(tx, r.containerType, r.containerId)
      if (authorId) perAuthor.set(authorId, (perAuthor.get(authorId) ?? 0) + r.n)
    }
    let authors = 0
    const week = weekKey(at)
    for (const [userId, n] of perAuthor) {
      const sent = await enqueueNotification(tx, {
        tenantId, userId, code: 'library_stale_digest', channel: 'inapp', payload: { n },
        dedupKey: `library_stale_digest:${week}:${userId}`,
      })
      if (sent) authors++
    }
    return { authors, links: [...perAuthor.values()].reduce((s, n) => s + n, 0) }
  })
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

/**
 * Дублирование траектории (`trajectories.ts#duplicateTrajectory`): узел-копия уже несёт ту же
 * `library_version_id`, и у него должно появиться своё место в реестре — иначе копия держала бы
 * версию мимо «Де використовується», мимо запрета удаления (§7.5) и мимо обновлений. Режим
 * закрепления переносится с исходного места; вставившим считается тот, кто дублирует.
 */
export async function copyTrajectoryNodeUsages(tx: TenantTx, ctx: Ctx, pairs: { from: string, to: string, versionId: string, title: string | null }[], container: { id: string, title: string }): Promise<number> {
  let n = 0
  for (const p of pairs) {
    const [src] = await tx.select({ pinMode: libraryModuleUsages.pinMode }).from(libraryModuleUsages)
      .where(and(eq(libraryModuleUsages.holderType, 'trajectory_node'), eq(libraryModuleUsages.holderId, p.from), isNull(libraryModuleUsages.detachedAt)))
    const [v] = await tx.select({ moduleId: libraryModuleVersions.libraryModuleId, version: libraryModuleVersions.version, title: libraryModuleVersions.title, currentVersionId: libraryModules.currentVersionId })
      .from(libraryModuleVersions).innerJoin(libraryModules, eq(libraryModules.id, libraryModuleVersions.libraryModuleId))
      .where(eq(libraryModuleVersions.id, p.versionId))
    if (!v) continue
    const [current] = v.currentVersionId ? await tx.select({ version: libraryModuleVersions.version }).from(libraryModuleVersions).where(eq(libraryModuleVersions.id, v.currentVersionId)) : []
    await tx.insert(libraryModuleUsages).values({
      tenantId: ctx.tenantId,
      libraryModuleId: v.moduleId,
      versionId: p.versionId,
      holderType: 'trajectory_node',
      holderId: p.to,
      holderTitle: p.title ?? v.title,
      containerType: 'trajectory',
      containerId: container.id,
      containerTitle: container.title,
      pinMode: src?.pinMode ?? 'hotfix_auto',
      isStale: isStale(p.versionId, v.currentVersionId),
      latestVersionSeen: current?.version ?? v.version,
      attachedBy: ctx.actorId,
    })
    await tx.update(libraryModules).set({ usageCount: sql`${libraryModules.usageCount} + 1` }).where(eq(libraryModules.id, v.moduleId))
    n++
  }
  return n
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
 * Сверка денормализованного с фактом (§11): места, чей держатель исчез или перестал держать
 * ссылку мимо крючков (раздел курса удалён целиком, узел удалён не через полотно), закрываются;
 * `is_stale` и `usage_count` пересчитываются. В `audit_log` — только при расхождении, одной записью.
 */
export async function usageRecalc(tenantId: string): Promise<RecalcStats> {
  return withTenant(tenantId, null, async (tx) => {
    const lost = await tx.execute(sql`
      select u.id from library_module_usages u
      where u.detached_at is null and (
        (u.holder_type = 'course_lesson' and not exists (
          select 1 from lessons l where l.id = u.holder_id and l.module_id is not null and l.library_version_id is not null))
        or (u.holder_type = 'trajectory_node' and not exists (
          select 1 from trajectory_nodes n where n.id = u.holder_id and n.library_version_id is not null))
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
