import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import {
  courseCategories, courseVersions, courses, lessons, libraryModuleProposals, modules, resourceVersions, resources, users,
} from '../db/schema'
import type { TenantTx } from '../utils/withTenant'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import type { LibraryActor } from './library'
import { freeSlug, holdsScope, insertModuleTx } from './library'
import type { ContentBlock } from '../../shared/schemas/content'
import type { ResourceKind } from '../../shared/schemas/resources'
import type { LibraryProposalStatus } from '../../shared/enums'
import { authorIdsOf } from '../../shared/domain/library'
import type { z } from 'zod'
import type {
  libraryProposalAcceptSchema, libraryProposalCreateSchema, libraryProposalsQuerySchema,
} from '../../shared/schemas/library'

/**
 * Предложение урока в библиотеку (`docs/v2/31` §3.5, §6.3, §7.11; Р-31.6; PR-25).
 *
 * Библиотека — общий ресурс тенанта, и без модерации за полгода она наполняется десятком
 * почти одинаковых «Інструкція з прибирання» (§7.11). Поэтому носитель `library.use` без
 * `library.publish` кладёт не модуль, а **предложение**; модуль появляется, только когда
 * куратор (`library.publish`) его принимает (критерий приёмки 5). Принятый модуль живёт
 * отдельно от исходного урока: тело копируется, а не делится (§12 «исходный урок потом
 * удалён — library_modules уже создан и живёт отдельно»).
 */

export interface ProposalRow {
  id: string
  sourceLessonId: string
  sourceLessonTitle: string
  sourceContainerType: string
  sourceContainerId: string
  sourceContainerTitle: string | null
  proposedTitle: string
  proposedCategoryId: string | null
  proposedCategoryName: string | null
  comment: string
  status: LibraryProposalStatus
  proposedBy: { id: string, fullName: string }
  decidedBy: { id: string, fullName: string } | null
  decidedAt: Date | null
  decisionComment: string | null
  libraryModuleId: string | null
  createdAt: Date
}

async function toRows(tx: TenantTx, rows: (typeof libraryModuleProposals.$inferSelect)[]): Promise<ProposalRow[]> {
  if (!rows.length) return []
  const peopleIds = [...new Set(rows.flatMap(r => [r.proposedBy, ...(r.decidedBy ? [r.decidedBy] : [])]))]
  const people = await tx.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, peopleIds))
  const nameOf = new Map(people.map(p => [p.id, p.fullName]))
  const lessonRows = await tx.select({ id: lessons.id, title: lessons.title }).from(lessons).where(inArray(lessons.id, rows.map(r => r.sourceLessonId)))
  const lessonTitle = new Map(lessonRows.map(l => [l.id, l.title]))
  const courseIds = [...new Set(rows.filter(r => r.sourceContainerType === 'course').map(r => r.sourceContainerId))]
  const courseRows = courseIds.length ? await tx.select({ id: courses.id, title: courses.title }).from(courses).where(inArray(courses.id, courseIds)) : []
  const courseTitle = new Map(courseRows.map(c => [c.id, c.title]))
  const catIds = [...new Set(rows.map(r => r.proposedCategoryId).filter((v): v is string => !!v))]
  const cats = catIds.length ? await tx.select({ id: courseCategories.id, name: courseCategories.name }).from(courseCategories).where(inArray(courseCategories.id, catIds)) : []
  const catName = new Map(cats.map(c => [c.id, c.name]))
  return rows.map(r => ({
    id: r.id,
    sourceLessonId: r.sourceLessonId,
    sourceLessonTitle: lessonTitle.get(r.sourceLessonId) ?? '',
    sourceContainerType: r.sourceContainerType,
    sourceContainerId: r.sourceContainerId,
    sourceContainerTitle: courseTitle.get(r.sourceContainerId) ?? null,
    proposedTitle: r.proposedTitle,
    proposedCategoryId: r.proposedCategoryId,
    proposedCategoryName: r.proposedCategoryId ? catName.get(r.proposedCategoryId) ?? null : null,
    comment: r.comment,
    status: r.status as LibraryProposalStatus,
    proposedBy: { id: r.proposedBy, fullName: nameOf.get(r.proposedBy) ?? '' },
    decidedBy: r.decidedBy ? { id: r.decidedBy, fullName: nameOf.get(r.decidedBy) ?? '' } : null,
    decidedAt: r.decidedAt,
    decisionComment: r.decisionComment,
    libraryModuleId: r.libraryModuleId,
    createdAt: r.createdAt,
  }))
}

/**
 * Урок-источник: урок **курса** (у библиотечного урока владелец — модуль, его «предлагать» некуда)
 * и именно материал — у теста переиспользование уже решено банками вопросов, у практикума и
 * опроса свои правила проверки (Р-31.7). Урок, который сам ссылается на библиотеку, в неё
 * уже входит.
 */
async function sourceLesson(tx: TenantTx, lessonId: string) {
  const [row] = await tx.select({ lesson: lessons, courseId: courses.id, courseTitle: courses.title })
    .from(lessons)
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(courseVersions, eq(courseVersions.id, modules.courseVersionId))
    .innerJoin(courses, eq(courses.id, courseVersions.courseId))
    .where(and(eq(lessons.id, lessonId), isNotNull(lessons.moduleId)))
  return row ?? null
}

/** Кураторы (носители `library.publish`) — адресаты `library_proposal_created` (§8). */
async function curators(tx: TenantTx, exceptUserId: string): Promise<string[]> {
  const rows = await tx.execute(sql`
    select distinct ur.user_id from user_roles ur join roles r on r.id = ur.role_id
    where r.scopes @> array['library.publish']::text[] and ur.user_id <> ${exceptUserId}::uuid
      and (ur.valid_until is null or ur.valid_until > now())
  `) as unknown as { user_id: string }[]
  return rows.map(r => r.user_id)
}

export type CreateProposalResult
  = | { ok: true, proposal: ProposalRow }
    | { ok: false, code: 'lesson_not_found' | 'not_content' | 'already_in_library' | 'category_not_found' | 'proposal_pending' }

/** «Запропонувати в бібліотеку» (§6.3): создаётся `pending`-предложение, модуль — нет (критерий 5). */
export async function createProposal(actor: LibraryActor, input: z.infer<typeof libraryProposalCreateSchema>): Promise<CreateProposalResult> {
  return withTenant(actor.tenantId, actor.actorId, async (tx): Promise<CreateProposalResult> => {
    const src = await sourceLesson(tx, input.sourceLessonId)
    if (!src) return { ok: false, code: 'lesson_not_found' }
    if (src.lesson.itemType !== 'resource') return { ok: false, code: 'not_content' }
    if (src.lesson.libraryVersionId) return { ok: false, code: 'already_in_library' }
    if (input.proposedCategoryId) {
      const [c] = await tx.select({ id: courseCategories.id }).from(courseCategories).where(eq(courseCategories.id, input.proposedCategoryId))
      if (!c) return { ok: false, code: 'category_not_found' }
    }
    const title = (input.proposedTitle ?? src.lesson.title).trim()
    const [row] = await tx.insert(libraryModuleProposals).values({
      tenantId: actor.tenantId,
      sourceLessonId: src.lesson.id,
      sourceContainerType: 'course',
      sourceContainerId: src.courseId,
      proposedTitle: title.length >= 3 ? title : `${title} — ${src.courseTitle}`.slice(0, 200),
      proposedCategoryId: input.proposedCategoryId ?? null,
      comment: input.comment,
      proposedBy: actor.actorId,
    }).onConflictDoNothing().returning()
    // Частичный уникальный индекс `(tenant_id, source_lesson_id) where pending` (§6.3)
    if (!row) return { ok: false, code: 'proposal_pending' }

    const [me] = await tx.select({ fullName: users.fullName }).from(users).where(eq(users.id, actor.actorId))
    for (const userId of await curators(tx, actor.actorId)) {
      await enqueueNotification(tx, {
        tenantId: actor.tenantId, userId, code: 'library_proposal_created',
        payload: { user: me?.fullName ?? '', title: row.proposedTitle },
        dedupKey: `library_proposal_created:${row.id}:${userId}`,
        refType: 'library_proposal', refId: row.id,
      })
    }
    await recordAudit(tx, {
      tenantId: actor.tenantId, actorId: actor.actorId, action: 'library_proposal.create', entity: 'library_proposal', entityId: row.id,
      after: { sourceLessonId: row.sourceLessonId, courseId: src.courseId, title: row.proposedTitle },
    })
    return { ok: true, proposal: (await toRows(tx, [row]))[0]! }
  })
}

/** Куратор видит все предложения, остальные — только свои (§2 «Предлагать свой урок»). */
export async function listProposals(actor: LibraryActor, q: z.infer<typeof libraryProposalsQuerySchema>): Promise<ProposalRow[]> {
  return withTenant(actor.tenantId, actor.actorId, async (tx) => {
    const rows = await tx.select().from(libraryModuleProposals)
      .where(and(
        q.status ? eq(libraryModuleProposals.status, q.status) : undefined,
        actor.publish ? undefined : eq(libraryModuleProposals.proposedBy, actor.actorId),
      ))
      .orderBy(desc(libraryModuleProposals.createdAt))
      .limit(200)
    return toRows(tx, rows)
  })
}

export type DecideResult
  = | { ok: true, proposal: ProposalRow, libraryModuleId?: string }
    | { ok: false, code: 'not_found' | 'forbidden' | 'already_decided' | 'owner_forbidden' | 'category_not_found' | 'lesson_not_found' }

/** Тело урока-источника для копии: закреплённый снимок, если урок уже публиковался, иначе рабочая редакция. */
async function lessonContent(tx: TenantTx, lesson: typeof lessons.$inferSelect) {
  if (lesson.resourceVersionId) {
    const [v] = await tx.select().from(resourceVersions).where(eq(resourceVersions.id, lesson.resourceVersionId))
    if (v) return { kind: v.kind as ResourceKind, body: v.body as ContentBlock[], mediaId: v.mediaId, externalUrl: v.externalUrl }
  }
  const [r] = await tx.select().from(resources).where(eq(resources.id, lesson.itemId))
  if (!r) return null
  return { kind: r.kind as ResourceKind, body: r.body as ContentBlock[], mediaId: r.mediaId, externalUrl: r.externalUrl }
}

/**
 * Принять (§10 `accept`): появляется модуль-черновик с копией тела урока; владелец —
 * указанный носитель `library.publish` (по умолчанию принявший). Версию выпускает владелец
 * осознанно (Р-31.8) — принятие ещё не публикация.
 */
export async function acceptProposal(actor: LibraryActor, id: string, input: z.infer<typeof libraryProposalAcceptSchema>): Promise<DecideResult> {
  return withTenant(actor.tenantId, actor.actorId, async (tx): Promise<DecideResult> => {
    const [p] = await tx.select().from(libraryModuleProposals).where(eq(libraryModuleProposals.id, id)).for('update')
    if (!p) return { ok: false, code: 'not_found' }
    if (!actor.publish) return { ok: false, code: 'forbidden' }
    if (p.status !== 'pending') return { ok: false, code: 'already_decided' }
    const ownerId = input.ownerId ?? actor.actorId
    if (ownerId !== actor.actorId && !(await holdsScope(tx, ownerId, 'library.publish'))) return { ok: false, code: 'owner_forbidden' }
    const categoryId = input.categoryId !== undefined ? input.categoryId : p.proposedCategoryId
    if (categoryId) {
      const [c] = await tx.select({ id: courseCategories.id }).from(courseCategories).where(eq(courseCategories.id, categoryId))
      if (!c) return { ok: false, code: 'category_not_found' }
    }
    const [lesson] = await tx.select().from(lessons).where(eq(lessons.id, p.sourceLessonId))
    const content = lesson ? await lessonContent(tx, lesson) : null
    if (!content) return { ok: false, code: 'lesson_not_found' }

    const moduleId = await insertModuleTx(tx, actor, {
      title: p.proposedTitle,
      slug: await freeSlug(tx, p.proposedTitle),
      contentKind: content.kind,
      categoryId: categoryId ?? null,
      tags: [],
      summary: null,
      estimatedMinutes: null,
      language: 'uk',
      ownerId,
      authorIds: authorIdsOf(ownerId),
    }, content)
    const now = new Date()
    const [after] = await tx.update(libraryModuleProposals).set({
      status: 'accepted', decidedBy: actor.actorId, decidedAt: now, libraryModuleId: moduleId, updatedAt: now,
    }).where(eq(libraryModuleProposals.id, id)).returning()

    await notifyDecided(tx, actor, after!, 'прийнято')
    await recordAudit(tx, {
      tenantId: actor.tenantId, actorId: actor.actorId, action: 'library_proposal.accept', entity: 'library_proposal', entityId: id,
      before: { status: p.status }, after: { status: 'accepted', libraryModuleId: moduleId, ownerId },
    })
    return { ok: true, proposal: (await toRows(tx, [after!]))[0]!, libraryModuleId: moduleId }
  })
}

/** Отклонить (§10 `reject`): комментарий обязателен — автор предложения должен понять почему. */
export async function rejectProposal(actor: LibraryActor, id: string, decisionComment: string): Promise<DecideResult> {
  return withTenant(actor.tenantId, actor.actorId, async (tx): Promise<DecideResult> => {
    const [p] = await tx.select().from(libraryModuleProposals).where(eq(libraryModuleProposals.id, id)).for('update')
    if (!p) return { ok: false, code: 'not_found' }
    if (!actor.publish) return { ok: false, code: 'forbidden' }
    if (p.status !== 'pending') return { ok: false, code: 'already_decided' }
    const now = new Date()
    const [after] = await tx.update(libraryModuleProposals).set({
      status: 'rejected', decidedBy: actor.actorId, decidedAt: now, decisionComment, updatedAt: now,
    }).where(eq(libraryModuleProposals.id, id)).returning()
    await notifyDecided(tx, actor, after!, 'відхилено')
    await recordAudit(tx, {
      tenantId: actor.tenantId, actorId: actor.actorId, action: 'library_proposal.reject', entity: 'library_proposal', entityId: id,
      before: { status: p.status }, after: { status: 'rejected', decisionComment },
    })
    return { ok: true, proposal: (await toRows(tx, [after!]))[0]! }
  })
}

/** Отозвать своё предложение, пока решения нет. Чужое — «не найдено»: чужие предложения автору не видны. */
export async function withdrawProposal(actor: LibraryActor, id: string): Promise<DecideResult> {
  return withTenant(actor.tenantId, actor.actorId, async (tx): Promise<DecideResult> => {
    const [p] = await tx.select().from(libraryModuleProposals).where(eq(libraryModuleProposals.id, id)).for('update')
    if (!p || (p.proposedBy !== actor.actorId && !actor.publish)) return { ok: false, code: 'not_found' }
    if (p.proposedBy !== actor.actorId) return { ok: false, code: 'forbidden' }
    if (p.status !== 'pending') return { ok: false, code: 'already_decided' }
    const [after] = await tx.update(libraryModuleProposals).set({ status: 'withdrawn', updatedAt: new Date() })
      .where(eq(libraryModuleProposals.id, id)).returning()
    await recordAudit(tx, {
      tenantId: actor.tenantId, actorId: actor.actorId, action: 'library_proposal.withdraw', entity: 'library_proposal', entityId: id,
      before: { status: p.status }, after: { status: 'withdrawn' },
    })
    return { ok: true, proposal: (await toRows(tx, [after!]))[0]! }
  })
}

async function notifyDecided(tx: TenantTx, actor: LibraryActor, p: typeof libraryModuleProposals.$inferSelect, decision: string): Promise<void> {
  if (p.proposedBy === actor.actorId) return
  await enqueueNotification(tx, {
    tenantId: actor.tenantId, userId: p.proposedBy, code: 'library_proposal_decided',
    payload: { title: p.proposedTitle, decision, comment: p.decisionComment ?? '' },
    dedupKey: `library_proposal_decided:${p.id}`,
    refType: 'library_proposal', refId: p.id,
  })
}
