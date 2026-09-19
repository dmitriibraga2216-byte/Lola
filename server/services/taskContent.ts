import { and, desc, eq, ilike, inArray, isNull, ne, sql } from 'drizzle-orm'
import { assessmentForms, checklists, complexTests, courses, meetups, programs, quizzes, resources, surveys, workshops } from '../db/schema'
import type { TenantTx } from '../utils/withTenant'
import { withTenant } from '../utils/withTenant'
import type { ContentType } from '../../shared/enums'

/**
 * Назначаемый контент — одиннадцать типов эталона (docs/15 §14.1, docs/02 content_type).
 * Здесь один ответ на два вопроса: «что можно выбрать» (список для блока «Контент»)
 * и «существует ли и доступен ли контент» (проверка при создании назначения).
 * Правил прохождения контент не содержит (CLAUDE.md п. 11) — только название и состояние.
 */

export interface ContentRef { id: string, title: string, summary: string | null }

interface Ctx { tenantId: string, actorId: string }

/** Название и краткая сводка контента; null — не найден или недоступен для назначения. */
export async function findContent(tx: TenantTx, contentType: ContentType, id: string): Promise<ContentRef | null> {
  switch (contentType) {
    case 'course': {
      const [c] = await tx.select({ id: courses.id, title: courses.title, status: courses.status }).from(courses)
        .where(and(eq(courses.id, id), isNull(courses.deletedAt)))
      return c?.status === 'published' ? { id: c.id, title: c.title, summary: null } : null
    }
    case 'training_program': {
      const [p] = await tx.select({ id: programs.id, title: programs.title, status: programs.status }).from(programs).where(eq(programs.id, id))
      return p?.status === 'published' ? { id: p.id, title: p.title, summary: null } : null
    }
    case 'resource': {
      const [r] = await tx.select({ id: resources.id, title: resources.title, status: resources.status, kind: resources.kind }).from(resources)
        .where(and(eq(resources.id, id), isNull(resources.deletedAt)))
      return r?.status === 'published' ? { id: r.id, title: r.title, summary: r.kind } : null
    }
    case 'test': {
      const [q] = await tx.select({ id: quizzes.id, title: quizzes.title, n: sql<number>`(select count(*)::int from quiz_questions qq where qq.quiz_id = ${quizzes.id})` }).from(quizzes)
        .where(and(eq(quizzes.id, id), isNull(quizzes.deletedAt)))
      return q ? { id: q.id, title: q.title, summary: `${q.n}` } : null
    }
    case 'complex_test': {
      const [c] = await tx.select({ id: complexTests.id, title: complexTests.title, isActive: complexTests.isActive }).from(complexTests).where(eq(complexTests.id, id))
      return c?.isActive ? { id: c.id, title: c.title, summary: null } : null
    }
    case 'workshop': {
      const [w] = await tx.select({ id: workshops.id, title: workshops.title, status: workshops.status }).from(workshops)
        .where(and(eq(workshops.id, id), isNull(workshops.deletedAt)))
      return w?.status === 'published' ? { id: w.id, title: w.title, summary: null } : null
    }
    case 'poll': {
      const [s] = await tx.select({ id: surveys.id, title: surveys.title, status: surveys.status }).from(surveys).where(eq(surveys.id, id))
      return s && s.status !== 'closed' ? { id: s.id, title: s.title, summary: null } : null
    }
    case 'assessment': {
      const [f] = await tx.select({ id: assessmentForms.id, title: assessmentForms.title, isActive: assessmentForms.isActive }).from(assessmentForms).where(eq(assessmentForms.id, id))
      return f?.isActive ? { id: f.id, title: f.title, summary: null } : null
    }
    case 'check_list': {
      const [c] = await tx.select({ id: checklists.id, title: checklists.title, isActive: checklists.isActive, kind: checklists.kind }).from(checklists).where(eq(checklists.id, id))
      return c?.isActive ? { id: c.id, title: c.title, summary: c.kind } : null
    }
    case 'meetup':
    case 'webinar': {
      const [m] = await tx.select({ id: meetups.id, title: meetups.title, status: meetups.status, kind: meetups.kind, startsAt: meetups.startsAt }).from(meetups)
        .where(and(eq(meetups.id, id), contentType === 'webinar' ? eq(meetups.kind, 'webinar') : inArray(meetups.kind, ['meetup', 'event'])))
      return m && m.status !== 'cancelled' ? { id: m.id, title: m.title, summary: m.startsAt ? m.startsAt.toISOString() : null } : null
    }
  }
}

/** Список контента типа для «Обрати з існуючих» (docs/15 §14.2): только то, что можно назначить. */
export async function listContent(ctx: Ctx, contentType: ContentType, q?: string): Promise<ContentRef[]> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const like = q ? `%${q}%` : null
    switch (contentType) {
      case 'course':
        return tx.select({ id: courses.id, title: courses.title, summary: sql<string | null>`null` }).from(courses)
          .where(and(eq(courses.status, 'published'), isNull(courses.deletedAt), ...(like ? [ilike(courses.title, like)] : []))).orderBy(courses.title).limit(200)
      case 'training_program':
        return tx.select({ id: programs.id, title: programs.title, summary: programs.mode }).from(programs)
          .where(and(eq(programs.status, 'published'), ...(like ? [ilike(programs.title, like)] : []))).orderBy(programs.title).limit(200)
      case 'resource':
        return tx.select({ id: resources.id, title: resources.title, summary: resources.kind }).from(resources)
          .where(and(eq(resources.status, 'published'), isNull(resources.deletedAt), ...(like ? [ilike(resources.title, like)] : []))).orderBy(resources.title).limit(200)
      case 'test':
        return tx.select({ id: quizzes.id, title: quizzes.title, summary: sql<string | null>`(select count(*)::text from quiz_questions qq where qq.quiz_id = ${quizzes.id})` }).from(quizzes)
          .where(and(isNull(quizzes.deletedAt), ...(like ? [ilike(quizzes.title, like)] : []))).orderBy(quizzes.title).limit(200)
      case 'complex_test':
        return tx.select({ id: complexTests.id, title: complexTests.title, summary: sql<string | null>`null` }).from(complexTests)
          .where(and(eq(complexTests.isActive, true), ...(like ? [ilike(complexTests.title, like)] : []))).orderBy(complexTests.title).limit(200)
      case 'workshop':
        return tx.select({ id: workshops.id, title: workshops.title, summary: sql<string | null>`null` }).from(workshops)
          .where(and(eq(workshops.status, 'published'), isNull(workshops.deletedAt), ...(like ? [ilike(workshops.title, like)] : []))).orderBy(workshops.title).limit(200)
      case 'poll':
        return tx.select({ id: surveys.id, title: surveys.title, summary: surveys.kind }).from(surveys)
          .where(and(ne(surveys.status, 'closed'), ...(like ? [ilike(surveys.title, like)] : []))).orderBy(surveys.title).limit(200)
      case 'assessment':
        return tx.select({ id: assessmentForms.id, title: assessmentForms.title, summary: sql<string | null>`null` }).from(assessmentForms)
          .where(and(eq(assessmentForms.isActive, true), ...(like ? [ilike(assessmentForms.title, like)] : []))).orderBy(assessmentForms.title).limit(200)
      case 'check_list':
        return tx.select({ id: checklists.id, title: checklists.title, summary: checklists.kind }).from(checklists)
          .where(and(eq(checklists.isActive, true), ...(like ? [ilike(checklists.title, like)] : []))).orderBy(checklists.title).limit(200)
      case 'meetup':
      case 'webinar':
        return tx.select({ id: meetups.id, title: meetups.title, summary: sql<string | null>`${meetups.startsAt}::text` }).from(meetups)
          .where(and(
            contentType === 'webinar' ? eq(meetups.kind, 'webinar') : inArray(meetups.kind, ['meetup', 'event']),
            ne(meetups.status, 'cancelled'),
            ...(like ? [ilike(meetups.title, like)] : []),
          )).orderBy(desc(meetups.startsAt)).limit(200)
    }
  })
}
