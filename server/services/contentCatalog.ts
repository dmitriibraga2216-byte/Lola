import { and, eq, ilike, inArray, isNull, sql } from 'drizzle-orm'
import {
  assessmentForms, checklists, complexTests, courses, meetups, programs, quizzes, resources, surveys, workshops,
} from '../db/schema'
import type { TenantTx } from '../utils/withTenant'
import { withTenant } from '../utils/withTenant'
import { can, type Access } from './access'
import type { ContentType } from '../../shared/enums'

/**
 * Витрина-агрегатор над одиннадцатью типами контента (docs/33 D-063, докс/28 §28.4:
 * «методист работает по каждому типу отдельно», обобщающего эндпоинта не было). Это не новая
 * бизнес-логика — только объединяющий список поверх уже существующих таблиц/сервисов (тот же
 * принцип, что и в `taskContent.ts#listContent`, только без фильтра «только опубликованное»
 * и с полем `updatedAt`, чтобы методист видел последние правки по всем типам разом).
 * Видимость типа в списке — по тому же скоупу, что и у существующего CRUD-эндпоинта этого типа;
 * `notice` эталона сюда не входит (это объявление докс/21 §14.5, у него свой список).
 */

export interface ContentRow { id: string, contentType: ContentType, title: string, status: string, updatedAt: string }

interface TypeDef { type: ContentType, scope: string, fetch: (tx: TenantTx, like: string | null) => Promise<{ id: string, title: string, status: string, updatedAt: Date }[]> }

const TYPES: TypeDef[] = [
  {
    type: 'course',
    scope: 'course.view',
    fetch: (tx, like) => tx.select({ id: courses.id, title: courses.title, status: courses.status, updatedAt: courses.updatedAt }).from(courses)
      .where(and(isNull(courses.deletedAt), ...(like ? [ilike(courses.title, like)] : []))),
  },
  {
    type: 'training_program',
    scope: 'program.manage',
    fetch: (tx, like) => tx.select({ id: programs.id, title: programs.title, status: programs.status, updatedAt: programs.updatedAt }).from(programs)
      .where(like ? ilike(programs.title, like) : undefined),
  },
  {
    type: 'resource',
    scope: 'course.view',
    fetch: (tx, like) => tx.select({ id: resources.id, title: resources.title, status: resources.status, updatedAt: resources.updatedAt }).from(resources)
      .where(and(isNull(resources.deletedAt), ...(like ? [ilike(resources.title, like)] : []))),
  },
  {
    type: 'test',
    scope: 'course.view',
    fetch: (tx, like) => tx.select({ id: quizzes.id, title: quizzes.title, status: quizzes.status, updatedAt: quizzes.updatedAt }).from(quizzes)
      .where(and(isNull(quizzes.deletedAt), ...(like ? [ilike(quizzes.title, like)] : []))),
  },
  {
    type: 'complex_test',
    scope: 'complextest.manage',
    fetch: (tx, like) => tx.select({ id: complexTests.id, title: complexTests.title, status: sql<string>`case when ${complexTests.isActive} then 'active' else 'inactive' end`, updatedAt: complexTests.updatedAt }).from(complexTests)
      .where(like ? ilike(complexTests.title, like) : undefined),
  },
  {
    type: 'workshop',
    scope: 'course.view',
    fetch: (tx, like) => tx.select({ id: workshops.id, title: workshops.title, status: workshops.status, updatedAt: workshops.updatedAt }).from(workshops)
      .where(and(isNull(workshops.deletedAt), ...(like ? [ilike(workshops.title, like)] : []))),
  },
  {
    type: 'poll',
    scope: 'survey.manage',
    fetch: (tx, like) => tx.select({ id: surveys.id, title: surveys.title, status: surveys.status, updatedAt: surveys.updatedAt }).from(surveys)
      .where(like ? ilike(surveys.title, like) : undefined),
  },
  {
    type: 'assessment',
    scope: 'assessment.run',
    fetch: (tx, like) => tx.select({ id: assessmentForms.id, title: assessmentForms.title, status: sql<string>`case when ${assessmentForms.isActive} then 'active' else 'inactive' end`, updatedAt: assessmentForms.updatedAt }).from(assessmentForms)
      .where(like ? ilike(assessmentForms.title, like) : undefined),
  },
  {
    type: 'check_list',
    scope: 'checklist.run',
    fetch: (tx, like) => tx.select({ id: checklists.id, title: checklists.title, status: sql<string>`case when ${checklists.isActive} then 'active' else 'inactive' end`, updatedAt: checklists.updatedAt }).from(checklists)
      .where(like ? ilike(checklists.title, like) : undefined),
  },
  {
    type: 'meetup',
    scope: 'meetup.view',
    fetch: (tx, like) => tx.select({ id: meetups.id, title: meetups.title, status: meetups.status, updatedAt: meetups.updatedAt }).from(meetups)
      .where(and(inArray(meetups.kind, ['meetup', 'event']), ...(like ? [ilike(meetups.title, like)] : []))),
  },
  {
    type: 'webinar',
    scope: 'meetup.view',
    fetch: (tx, like) => tx.select({ id: meetups.id, title: meetups.title, status: meetups.status, updatedAt: meetups.updatedAt }).from(meetups)
      .where(and(eq(meetups.kind, 'webinar'), ...(like ? [ilike(meetups.title, like)] : []))),
  },
]

export interface ContentCatalogQuery { q?: string, type?: ContentType, page?: number, perPage?: number }
export interface ContentCatalogResult { total: number, page: number, perPage: number, items: ContentRow[] }

/** `GET /content` — только то, на что у access уже есть скоуп «своего» CRUD этого типа (не шире). */
export async function listAllContent(access: Access, opts: ContentCatalogQuery = {}): Promise<ContentCatalogResult> {
  const page = opts.page ?? 1
  const perPage = Math.min(opts.perPage ?? 50, 200)
  const like = opts.q ? `%${opts.q}%` : null
  const defs = TYPES.filter(d => (!opts.type || opts.type === d.type) && can(access, d.scope))

  return withTenant(access.tenantId, access.userId, async (tx) => {
    const rows = (await Promise.all(defs.map(async (d) => {
      const found = await d.fetch(tx, like)
      return found.map(f => ({ id: f.id, contentType: d.type, title: f.title, status: f.status, updatedAt: f.updatedAt.toISOString() }))
    }))).flat()
    rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const total = rows.length
    const items = rows.slice((page - 1) * perPage, (page - 1) * perPage + perPage)
    return { total, page, perPage, items }
  })
}

/** Полный список типов витрины — для теста «пустого» доступа и документации эндпоинта. */
export const CONTENT_CATALOG_TYPES = TYPES.map(d => d.type)
