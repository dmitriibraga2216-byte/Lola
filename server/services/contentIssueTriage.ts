import { eq, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { attempts, contentIssueEvents, contentIssues, contentReporterStats } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { currentRequestContext } from '../utils/requestContext'
import { keysetAfter, keysetAt } from '../utils/keyset'
import type { Access } from './access'
import { can, scopeForGrants } from './access'
import { recordAudit } from './audit'
import { ACTIVE_EMPLOYEES_ONLY } from './repo/people'
import { assignTx, authorIdsSql, uuidArray } from './contentIssueRouting'
import { notifyAssignee, notifyMuted, notifyRescoreReady, notifyRescored, notifyReporters } from './contentIssueNotify'
import { applyResolutionToReportersTx } from './contentIssues'
import { RECALCULABLE_ATTEMPT_STATUSES, planRecalc, recalculateAttempt } from './attempts'
import {
  CONFIRMING_RESOLUTIONS, OPEN_STATUSES, RESCORE_RESOLUTIONS, availableActions, checkTransition,
} from '../../shared/domain/contentIssues'
import { KEYSETS, encodeKeyset } from '../../shared/domain/keyset'
import type { TransitionError } from '../../shared/domain/contentIssues'
import type {
  ContentIssueRescoreState, ContentIssueResolution, ContentIssueStatus, ContentIssueTargetType,
} from '../../shared/enums'
import type {
  ContentIssueCard, ContentIssueEventRow, ContentIssuePatch, ContentIssueQueue, ContentIssueQueueQuery,
  ContentIssueQueueRow, ContentIssueReporterRow, ContentIssueRescoreMode, IssuePerson, IssueTrack,
  RescorePreview, RescoreResult, RescoreWorseRow,
} from '../../shared/schemas/contentIssues'

/**
 * Разбор жалобы (docs/v2/36-content-feedback.md §4, §5.3–5.4, §7.8, §7.9; PR-24): очередь
 * «Звіт про помилки», карточка, переходы статусов, резолюции, пересчёт результатов и
 * закрытие по публикации новой версии материала.
 *
 * Три правила, на которых держится модуль:
 *
 * - **карточку нельзя закрыть тихо.** Закрытие — только когда стоит резолюция, для
 *   исправления опубликована версия выше жалобы, баллы не ждут пересчёта и заявителям ушёл
 *   ответ (§7.9). Правка в черновике закрытием не считается: люди видят ту же ошибку;
 * - **пересчёт — та же кнопка «Перерахувати», что в отчёте по тесту** (П-12.4): считает
 *   `planRecalc()`, пишет `recalculateAttempt()` из `attempts.ts`. Здесь — только выборка
 *   попыток по жалобе и политика «результат может только улучшиться»;
 * - **журнал — источник правды о разборе.** Каждый переход, назначение, заметка и пересчёт —
 *   событие `content_issue_events`; изменения чужих данных — ещё и `audit_log`.
 */

export interface Viewer {
  tenantId: string
  actorId: string
  /** `content_issue.triage`: брать в работу, менять статус, отклонять (автор, админ). */
  canTriage: boolean
  /** `content_issue.assign`: администратор очереди — переназначение, ручное закрытие, переоткрытие. */
  isAdmin: boolean
  /** `content_issue.rescore`: менять выставленные людям результаты (§2). */
  canRescore: boolean
  /**
   * Какие карточки видны (§2): администратору — все; автору — по своему контенту (он автор
   * элемента или ответственный); керівнику точки — где хотя бы один заявитель с его точек.
   */
  visibility: 'all' | 'own' | { locations: string[] }
}

/** Видимость и права из активной роли сессии (docs/01 §1.9.2). */
export async function viewerOf(a: Access): Promise<Viewer> {
  const isAdmin = can(a, 'content_issue.assign')
  const canTriage = can(a, 'content_issue.triage')
  let visibility: Viewer['visibility'] = 'all'
  if (!isAdmin) {
    if (canTriage) {
      visibility = 'own'
    }
    else {
      const locations = await scopeForGrants(a, 'content_issue.assign', 'content_issue.view')
      visibility = locations === null ? 'all' : { locations }
    }
  }
  return { tenantId: a.tenantId, actorId: a.userId, canTriage, isAdmin, canRescore: can(a, 'content_issue.rescore'), visibility }
}

const OPEN = sql.raw(OPEN_STATUSES.map(s => `'${s}'`).join(', '))

/** Карточки, видимые человеку (алиас `i`). Чужая карточка — «не найдено», а не 403 (правило 15). */
function visibleSql(v: Viewer): SQL {
  if (v.visibility === 'all') return sql``
  if (v.visibility === 'own') {
    return sql`and (i.assignee_id = ${v.actorId}::uuid or ${v.actorId}::uuid = any(${authorIdsSql('i')}))`
  }
  const locations = v.visibility.locations
  if (!locations.length) return sql`and false`
  return sql`and exists (select 1 from content_reports cr
                           join user_placements up on up.user_id = cr.user_id and up.ended_at is null
                          where cr.issue_id = i.id and up.location_id = any(${uuidArray(locations)}))`
}

function tracksSql(alias = 'i'): SQL {
  const i = sql.raw(alias)
  return sql`(select coalesce(json_agg(json_build_object('id', c.id, 'title', c.title) order by c.title), '[]'::json)
                from courses c where c.id = any(${i}.course_ids))`
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString()
}

// ── Очередь «Звіт про помилки» (§5.3) ─────────────────────────────────────────────────────

function tabSql(tab: ContentIssueQueueQuery['tab']): SQL {
  switch (tab) {
    case 'new': return sql`and i.status = 'new'`
    // Отложенная карточка — всё ещё работа ответственного: она не пропадает из «В роботі»
    case 'in_progress': return sql`and i.status in ('in_progress', 'deferred')`
    case 'fixed': return sql`and i.status in ('fixed', 'closed')`
    case 'rejected': return sql`and i.status = 'rejected'`
    case 'all': return sql``
  }
}

/**
 * «Надійний» заявитель среди заявителей карточки (§7.11, `isTrustedReporter()`): не меньше пяти
 * жалоб и доля подтверждённых выше 60 %. Число 0/1 — оно же часть ключа курсора очереди.
 */
const TRUSTED = sql`(case when exists (
    select 1 from content_reports cr join content_reporter_stats st on st.user_id = cr.user_id
     where cr.issue_id = i.id and st.reports_total >= 5 and st.confirmed_count::float / st.reports_total > 0.6)
  then 1 else 0 end)`

/**
 * Очередь с фильтрами §5.3. Сортировка — `reports_count desc, last_reported_at desc`: сначала то,
 * на что жалуются многие; при равном числе жалоб выше карточка «надійного» заявителя (§7.11).
 * Листается ключевым курсором (`KEYSETS.contentIssues`, docs/04 §4.1): страница не «съезжает»,
 * когда в очередь, пока её листают, приходят новые жалобы.
 */
export async function listQueue(v: Viewer, f: ContentIssueQueueQuery): Promise<ContentIssueQueue> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const where = sql`
      ${tabSql(f.tab)}
      ${f.issueType ? sql`and i.issue_type = ${f.issueType}` : sql``}
      ${f.targetType ? sql`and i.target_type = ${f.targetType}` : sql``}
      ${f.courseId ? sql`and ${f.courseId}::uuid = any(i.course_ids)` : sql``}
      ${f.authorId ? sql`and ${f.authorId}::uuid = any(${authorIdsSql('i')})` : sql``}
      ${f.assigneeId ? sql`and i.assignee_id = ${f.assigneeId}::uuid` : sql``}
      ${f.locationId ? sql`and exists (select 1 from content_reports cr join user_placements up on up.user_id = cr.user_id and up.ended_at is null where cr.issue_id = i.id and up.location_id = ${f.locationId}::uuid)` : sql``}
      ${f.from ? sql`and i.last_reported_at >= ${f.from}::date` : sql``}
      ${f.to ? sql`and i.last_reported_at < (${f.to}::date + 1)` : sql``}
      ${f.affectsScoring ? sql`and i.affects_scoring` : sql``}
      ${visibleSql(v)}`
    const after = keysetAfter(KEYSETS.contentIssues, f.cursor, [sql`i.reports_count`, TRUSTED, sql`i.last_reported_at`, sql`i.id`], 'desc')
    const rows = await tx.execute(sql`
      select i.id, i.issue_type, i.target_type, i.title, i.reports_count, i.status, i.severity,
             i.affects_scoring, i.rescore_state, i.last_reported_at, i.due_at, i.assignee_id,
             a.full_name as assignee_name,
             exists (select 1 from users x where x.id = i.assignee_id ${ACTIVE_EMPLOYEES_ONLY('x')}) as assignee_active,
             ${tracksSql('i')} as tracks,
             ${TRUSTED} as trusted,
             ${keysetAt(sql`i.last_reported_at`)} as last_at,
             (i.due_at < now() and i.status in (${OPEN})) as overdue
        from content_issues i
        left join users a on a.id = i.assignee_id
       where true ${where} ${after ? sql`and ${after}` : sql``}
       order by i.reports_count desc, trusted desc, i.last_reported_at desc, i.id desc
       limit ${f.limit + 1}`) as unknown as Record<string, unknown>[]
    const [count] = await tx.execute(sql`select count(*)::int as n from content_issues i where true ${where}`) as unknown as { n: number }[]
    const page = rows.slice(0, f.limit)
    const last = page.at(-1)
    const nextCursor = rows.length > f.limit && last
      ? encodeKeyset(KEYSETS.contentIssues, [Number(last.reports_count), Number(last.trusted), last.last_at as string, last.id as string])
      : null
    const items: ContentIssueQueueRow[] = page.map(r => ({
      id: r.id as string,
      issueType: r.issue_type as ContentIssueQueueRow['issueType'],
      targetType: r.target_type as ContentIssueQueueRow['targetType'],
      title: r.title as string,
      tracks: (r.tracks ?? []) as IssueTrack[],
      reportsCount: Number(r.reports_count),
      status: r.status as ContentIssueStatus,
      severity: r.severity as ContentIssueQueueRow['severity'],
      affectsScoring: r.affects_scoring as boolean,
      rescoreState: r.rescore_state as ContentIssueRescoreState,
      assignee: r.assignee_id ? { id: r.assignee_id as string, fullName: (r.assignee_name as string) ?? '', active: r.assignee_active as boolean } : null,
      lastReportedAt: iso(r.last_reported_at)!,
      dueAt: iso(r.due_at),
      overdue: r.overdue === true,
      trusted: Number(r.trusted) === 1,
    }))
    return { items, total: count?.n ?? 0, limit: f.limit, nextCursor }
  })
}

// ── Карточка (§5.4) ─────────────────────────────────────────────────────────────────────

type IssueRow = typeof contentIssues.$inferSelect

/** Карточка под замком строки: второй разбирающий ждёт первого и видит его итог (§12). */
async function lockIssue(tx: TenantTx, v: Viewer, id: string): Promise<IssueRow | null> {
  const [visible] = await tx.execute(sql`select i.id from content_issues i where i.id = ${id}::uuid ${visibleSql(v)}`) as unknown as { id: string }[]
  if (!visible) return null
  const [row] = await tx.select().from(contentIssues).where(eq(contentIssues.id, id)).for('update')
  return row ?? null
}

/** Где элемент правится и какая версия действует сейчас (для сравнения с `content_version`). */
async function targetInfo(tx: TenantTx, i: IssueRow): Promise<ContentIssueCard['target']> {
  const [r] = await tx.execute(sql`
    select case ${i.targetType}
        when 'resource' then (select case when r.published_version_id is not null then r.version end from resources r where r.id = ${i.targetId}::uuid)
        when 'block' then (select case when r.published_version_id is not null then r.version end from resources r where r.id = ${i.targetId}::uuid)
        when 'question' then (select q.version from questions q where q.id = ${i.targetId}::uuid)
        when 'lesson' then (select pv.version from lessons l join modules m on m.id = l.module_id
                              join course_versions cv on cv.id = m.course_version_id
                              join courses c on c.id = cv.course_id
                              join course_versions pv on pv.id = c.published_version_id
                             where l.id = ${i.targetId}::uuid)
        when 'knowledge_article' then (select ka.version from knowledge_articles ka where ka.id = ${i.targetId}::uuid)
      end as current_version,
      case ${i.targetType}
        when 'lesson' then (select cv.course_id::text from lessons l join modules m on m.id = l.module_id
                              join course_versions cv on cv.id = m.course_version_id where l.id = ${i.targetId}::uuid)
      end as lesson_course,
      case ${i.targetType}
        when 'resource' then exists (select 1 from resources r where r.id = ${i.targetId}::uuid and r.deleted_at is null)
        when 'block' then exists (select 1 from resources r where r.id = ${i.targetId}::uuid and r.deleted_at is null)
        when 'quiz' then exists (select 1 from quizzes q where q.id = ${i.targetId}::uuid and q.deleted_at is null)
        when 'question' then exists (select 1 from questions q where q.id = ${i.targetId}::uuid)
        when 'lesson' then exists (select 1 from lessons l where l.id = ${i.targetId}::uuid)
        when 'workshop' then exists (select 1 from workshops w where w.id = ${i.targetId}::uuid)
        when 'survey' then exists (select 1 from surveys s where s.id = ${i.targetId}::uuid)
        when 'knowledge_article' then exists (select 1 from knowledge_articles ka where ka.id = ${i.targetId}::uuid)
        when 'media' then exists (select 1 from media_assets ma where ma.id = ${i.targetId}::uuid)
      end as present`) as unknown as { current_version: number | null, lesson_course: string | null, present: boolean }[]
  const urls: Partial<Record<ContentIssueTargetType, string>> = {
    resource: `/admin/resources/${i.targetId}`,
    block: `/admin/resources/${i.targetId}`,
    quiz: `/admin/quizzes/${i.targetId}`,
    question: `/admin/questions/${i.targetId}`,
    knowledge_article: `/admin/knowledge/${i.targetId}`,
    workshop: '/admin/workshops',
    survey: '/admin/surveys',
  }
  const editUrl = i.targetType === 'lesson'
    ? (r?.lesson_course ? `/admin/courses/${r.lesson_course}` : null)
    : urls[i.targetType as ContentIssueTargetType] ?? null
  return { editUrl, currentVersion: r?.current_version == null ? null : Number(r.current_version), missing: r?.present === false }
}

/**
 * Выборка попыток по жалобе на вопрос (§7.8): снимок содержит вопрос версии не выше
 * `content_version`, попытка завершена и не аннулирована, за последние 365 дней. Статусы — те
 * же, что у «Перерахувати» отчёта по тесту (`RECALCULABLE_ATTEMPT_STATUSES`). Снимок —
 * массив вопросов; форма `{ questions: […] }` поддержана для старых записей тестов.
 */
function rescoreAttemptsSql(questionId: string, contentVersion: number): SQL {
  return sql`
    select a.id, a.user_id from attempts a
     where a.status in (${sql.join(RECALCULABLE_ATTEMPT_STATUSES.map(s => sql`${s}`), sql`, `)})
       and coalesce(a.submitted_at, a.started_at) >= now() - interval '365 days'
       and exists (
         select 1 from jsonb_array_elements(case jsonb_typeof(a.snapshot) when 'array' then a.snapshot
                                                 else coalesce(a.snapshot->'questions', '[]'::jsonb) end) q
          where q->>'id' = ${questionId} and coalesce((q->>'version')::int, 1) <= ${contentVersion})
     order by a.id`
}

async function impactOf(tx: TenantTx, i: IssueRow): Promise<ContentIssueCard['impact']> {
  if (i.targetType !== 'question') return null
  const [r] = await tx.execute(sql`
    with pool as (${rescoreAttemptsSql(i.targetId, i.contentVersion)})
    select (select count(*)::int from pool) as total,
           (select count(*)::int from pool p join attempts a on a.id = p.id
             where a.status = 'failed'
               and exists (select 1 from attempt_answers aa where aa.attempt_id = a.id and aa.question_id = ${i.targetId}::uuid
                              and aa.is_correct = false)) as failed`) as unknown as { total: number, failed: number }[]
  return { attemptsTotal: r?.total ?? 0, failedOnQuestion: r?.failed ?? 0 }
}

export async function getCard(v: Viewer, id: string): Promise<ContentIssueCard | null> {
  return withTenant(v.tenantId, v.actorId, tx => cardTx(tx, v, id))
}

async function cardTx(tx: TenantTx, v: Viewer, id: string): Promise<ContentIssueCard | null> {
  const [visible] = await tx.execute(sql`select i.id from content_issues i where i.id = ${id}::uuid ${visibleSql(v)}`) as unknown as { id: string }[]
  if (!visible) return null
  const [i] = await tx.select().from(contentIssues).where(eq(contentIssues.id, id))
  if (!i) return null

  const [extra] = await tx.execute(sql`
    select a.full_name as assignee_name,
           exists (select 1 from users x where x.id = i.assignee_id ${ACTIVE_EMPLOYEES_ONLY('x')}) as assignee_active,
           ${tracksSql('i')} as tracks,
           (i.due_at < now() and i.status in (${OPEN})) as overdue
      from content_issues i left join users a on a.id = i.assignee_id
     where i.id = ${id}::uuid`) as unknown as { assignee_name: string | null, assignee_active: boolean, tracks: IssueTrack[], overdue: boolean }[]

  const reporterRows = await tx.execute(sql`
    select r.id, r.user_id, r.comment, r.screenshot_media_id, r.source, r.created_at, r.attempt_id, r.question_version, r.context,
           u.full_name,
           exists (select 1 from users x where x.id = r.user_id ${ACTIVE_EMPLOYEES_ONLY('x')}) as active
      from content_reports r left join users u on u.id = r.user_id
     where r.issue_id = ${id}::uuid
     order by r.created_at`) as unknown as Record<string, unknown>[]
  const reporters: ContentIssueReporterRow[] = reporterRows.map((r) => {
    const c = (r.context ?? {}) as Record<string, unknown>
    return {
      reportId: r.id as string,
      user: { id: r.user_id as string, fullName: (r.full_name as string) ?? '', active: r.active as boolean },
      comment: (r.comment as string) ?? null,
      screenshotMediaId: (r.screenshot_media_id as string) ?? null,
      source: r.source as ContentIssueReporterRow['source'],
      createdAt: iso(r.created_at)!,
      attemptId: (r.attempt_id as string) ?? null,
      questionVersion: r.question_version == null ? null : Number(r.question_version),
      context: {
        ...(typeof c.playerPositionSec === 'number' ? { playerPositionSec: c.playerPositionSec } : {}),
        ...(typeof c.scrollPct === 'number' ? { scrollPct: c.scrollPct } : {}),
        ...(typeof c.device === 'string' ? { device: c.device } : {}),
        ...(typeof c.viewport === 'string' ? { viewport: c.viewport } : {}),
        ...(typeof c.url === 'string' ? { url: c.url } : {}),
      },
    }
  })

  // Внутренние заметки видит тот, кто разбирает; керівник точки — только открытую часть журнала
  const eventRows = await tx.execute(sql`
    select e.id, e.kind, e.from_status, e.to_status, e.comment, e.is_internal, e.payload, e.created_at,
           e.actor_id, u.full_name as actor_name, s.full_name as subject_name
      from content_issue_events e
      left join users u on u.id = e.actor_id
      left join users s on s.id = case when e.kind = 'assigned' then (e.payload->>'to')::uuid end
     where e.issue_id = ${id}::uuid ${v.canTriage ? sql`` : sql`and not e.is_internal`}
     order by e.created_at, e.id`) as unknown as Record<string, unknown>[]
  const events: ContentIssueEventRow[] = eventRows.map(e => ({
    id: e.id as string,
    kind: e.kind as ContentIssueEventRow['kind'],
    fromStatus: (e.from_status as ContentIssueStatus) ?? null,
    toStatus: (e.to_status as ContentIssueStatus) ?? null,
    comment: (e.comment as string) ?? null,
    isInternal: e.is_internal as boolean,
    payload: (e.payload ?? {}) as Record<string, unknown>,
    actor: e.actor_id ? { id: e.actor_id as string, fullName: (e.actor_name as string) ?? '' } : null,
    subjectName: (e.subject_name as string) ?? null,
    createdAt: iso(e.created_at)!,
  }))

  const assignee: IssuePerson | null = i.assigneeId
    ? { id: i.assigneeId, fullName: extra?.assignee_name ?? '', active: extra?.assignee_active ?? false }
    : null
  return {
    id: i.id,
    issueType: i.issueType as ContentIssueCard['issueType'],
    targetType: i.targetType as ContentIssueTargetType,
    targetId: i.targetId,
    blockId: i.blockId,
    title: i.title,
    contentVersion: i.contentVersion,
    status: i.status as ContentIssueStatus,
    resolution: i.resolution as ContentIssueResolution | null,
    resolutionComment: i.resolutionComment,
    severity: i.severity as ContentIssueCard['severity'],
    affectsScoring: i.affectsScoring,
    rescoreState: i.rescoreState as ContentIssueRescoreState,
    rescoredAttempts: i.rescoredAttempts,
    reportsCount: i.reportsCount,
    firstReportedAt: i.firstReportedAt.toISOString(),
    lastReportedAt: i.lastReportedAt.toISOString(),
    dueAt: i.dueAt ? i.dueAt.toISOString() : null,
    closedAt: i.closedAt ? i.closedAt.toISOString() : null,
    overdue: extra?.overdue === true,
    assignee,
    tracks: extra?.tracks ?? [],
    target: await targetInfo(tx, i),
    reporters,
    events,
    impact: await impactOf(tx, i),
    actions: availableActions({
      status: i.status as ContentIssueStatus,
      targetType: i.targetType as ContentIssueTargetType,
      resolution: i.resolution as ContentIssueResolution | null,
      rescoreState: i.rescoreState as ContentIssueRescoreState,
    }, v),
  }
}

// ── Закрытие (§7.9) и публикация новой версии материала ──────────────────────────────────

/**
 * Опубликована ли версия выше той, на которую жаловались (§7.9). Версионированные элементы
 * сравнивают номер: материал — `resources.version` опубликованной редакции, вопрос —
 * `questions.version`, урок — опубликованную версию курса, статья — `knowledge_articles.version`.
 * Тест, практикум и опрос версий не имеют: правка у них сразу живая, поэтому «выше» значит
 * «изменены после жалобы». Медиа — только вручную.
 */
async function fixPublished(tx: TenantTx, i: IssueRow): Promise<boolean> {
  const reported = i.firstReportedAt.toISOString()
  const [r] = await tx.execute(sql`
    select coalesce(case ${i.targetType}
        when 'resource' then (select r.published_version_id is not null and r.version > ${i.contentVersion} from resources r where r.id = ${i.targetId}::uuid)
        when 'block' then (select r.published_version_id is not null and r.version > ${i.contentVersion} from resources r where r.id = ${i.targetId}::uuid)
        when 'question' then (select q.version > ${i.contentVersion} from questions q where q.id = ${i.targetId}::uuid)
        when 'lesson' then (select pv.version > ${i.contentVersion} from lessons l join modules m on m.id = l.module_id
                              join course_versions cv on cv.id = m.course_version_id
                              join courses c on c.id = cv.course_id
                              join course_versions pv on pv.id = c.published_version_id
                             where l.id = ${i.targetId}::uuid)
        when 'knowledge_article' then (select ka.status = 'published' and ka.version > ${i.contentVersion} from knowledge_articles ka where ka.id = ${i.targetId}::uuid)
        when 'quiz' then (select q.updated_at > ${reported}::timestamptz from quizzes q where q.id = ${i.targetId}::uuid)
        when 'workshop' then (select w.updated_at > ${reported}::timestamptz from workshops w where w.id = ${i.targetId}::uuid)
        when 'survey' then (select s.updated_at > ${reported}::timestamptz from surveys s where s.id = ${i.targetId}::uuid)
      end, false) as published`) as unknown as { published: boolean }[]
  return r?.published === true
}

/**
 * Закрыть карточку `fixed → closed` и ответить заявителям (`content_issue_fixed`, §8).
 * `actorId = null` — закрыла система (публикация версии, завершённый пересчёт).
 */
async function closeTx(tx: TenantTx, tenantId: string, i: IssueRow, meta: { actorId: string | null, by: 'publication' | 'manual' | 'rescore' }): Promise<void> {
  const now = new Date()
  await tx.update(contentIssues).set({ status: 'closed', closedAt: now, updatedAt: now }).where(eq(contentIssues.id, i.id))
  const [event] = await tx.insert(contentIssueEvents).values({
    tenantId, issueId: i.id, actorId: meta.actorId, kind: 'status_changed',
    fromStatus: i.status, toStatus: 'closed', payload: { by: meta.by, resolution: i.resolution },
    requestContext: currentRequestContext(),
  }).returning({ id: contentIssueEvents.id })
  await notifyReporters(tx, tenantId, i.id, 'content_issue_fixed', event!.id)
  await recordAudit(tx, { tenantId, actorId: meta.actorId, action: 'content_issue.close', entity: 'content_issue', entityId: i.id, before: { status: i.status }, after: { status: 'closed', by: meta.by } })
}

/**
 * Закрыть, если выполнены все условия §7.9: резолюция-подтверждение, для `fixed` и
 * `question_fixed` опубликована версия выше жалобы, баллы не ждут пересчёта. Ответ
 * заявителям уходит самим закрытием. Возвращает, закрыта ли карточка.
 */
export async function tryAutoCloseTx(tx: TenantTx, tenantId: string, issueId: string, by: 'publication' | 'rescore' = 'publication'): Promise<boolean> {
  const [i] = await tx.select().from(contentIssues).where(eq(contentIssues.id, issueId)).for('update')
  if (!i || i.status !== 'fixed' || !i.resolution) return false
  if (!(CONFIRMING_RESOLUTIONS as readonly string[]).includes(i.resolution)) return false
  if (i.rescoreState === 'needed' || i.rescoreState === 'in_progress') return false
  // «Питання анульовано» новой версии не ждёт: вопрос исключён из подсчёта, а не исправлен
  if (i.resolution !== 'question_void' && !await fixPublished(tx, i)) return false
  await closeTx(tx, tenantId, i, { actorId: null, by })
  return true
}

/**
 * `content_issue.autoclose_scan` по событию публикации (§11, критерий 6): вызывается из той же
 * транзакции, что и публикация, — `markContentChanged()` (материал, курс, тест, практикум,
 * опрос) и правка вопроса, поднявшая его версию. Карточка не закроется, пока правка лежит в
 * черновике: без публикации версия не растёт.
 */
export async function onContentPublished(tx: TenantTx, kind: string, contentId: string): Promise<number> {
  const match: SQL | null = (() => {
    switch (kind) {
      case 'resource': return sql`i.target_type in ('resource', 'block') and i.target_id = ${contentId}::uuid`
      case 'question': return sql`i.target_type = 'question' and i.target_id = ${contentId}::uuid`
      case 'test': return sql`((i.target_type = 'quiz' and i.target_id = ${contentId}::uuid)
        or (i.target_type = 'question' and i.target_id in (select qq.question_id from quiz_questions qq where qq.quiz_id = ${contentId}::uuid)))`
      case 'workshop': return sql`i.target_type = 'workshop' and i.target_id = ${contentId}::uuid`
      case 'poll': return sql`i.target_type = 'survey' and i.target_id = ${contentId}::uuid`
      // Публикация курса: уроки его версий и материалы, закреплённые публикацией (pinResourceVersions)
      case 'course': return sql`((i.target_type = 'lesson' and i.target_id in (
          select l.id from lessons l join modules m on m.id = l.module_id
            join course_versions cv on cv.id = m.course_version_id where cv.course_id = ${contentId}::uuid))
        or (i.target_type in ('resource', 'block') and i.target_id in (
          select l.item_id from lessons l join modules m on m.id = l.module_id
            join course_versions cv on cv.id = m.course_version_id
           where cv.course_id = ${contentId}::uuid and l.item_type = 'resource')))`
      default: return null
    }
  })()
  if (!match) return 0
  const candidates = await tx.execute(sql`select i.id, i.tenant_id from content_issues i where i.status = 'fixed' and ${match}`) as unknown as { id: string, tenant_id: string }[]
  if (!candidates.length) return 0
  // Тенант — из самой транзакции (RLS уже сузила выборку): публикация знает его, хук — нет
  const tenantId = candidates[0]!.tenant_id
  let closed = 0
  for (const c of candidates) if (await tryAutoCloseTx(tx, tenantId, c.id, 'publication')) closed++
  return closed
}

// ── Переходы и резолюции (§4, §6.2, PATCH /content-issues/:id) ───────────────────────────

export type UpdateError = TransitionError | 'not_found' | 'affects_scoring_invalid' | 'duplicate_open'
export type UpdateResult = { ok: true, card: ContentIssueCard } | { ok: false, code: UpdateError, card?: ContentIssueCard | null }

async function event(tx: TenantTx, tenantId: string, issueId: string, actorId: string | null, e: {
  kind: 'status_changed' | 'reopened' | 'commented' | 'rescored'
  fromStatus?: string | null
  toStatus?: string | null
  comment?: string | null
  isInternal?: boolean
  payload?: Record<string, unknown>
}): Promise<string> {
  const [row] = await tx.insert(contentIssueEvents).values({
    tenantId,
    issueId,
    actorId,
    kind: e.kind,
    fromStatus: e.fromStatus ?? null,
    toStatus: e.toStatus ?? null,
    comment: e.comment ?? null,
    isInternal: e.isInternal ?? false,
    payload: e.payload ?? {},
    requestContext: currentRequestContext(),
  }).returning({ id: contentIssueEvents.id })
  return row!.id
}

/** Сколько попыток попадёт в пересчёт — число для `content_issue_rescore_ready`. */
async function rescorePoolSize(tx: TenantTx, i: IssueRow): Promise<number> {
  if (i.targetType !== 'question') return 0
  const [r] = await tx.execute(sql`select count(*)::int as n from (${rescoreAttemptsSql(i.targetId, i.contentVersion)}) p`) as unknown as { n: number }[]
  return r?.n ?? 0
}

/**
 * Разбор карточки: переход статуса с резолюцией, флаг «Впливає на бали», внутренняя заметка.
 * Одна транзакция под замком строки: два автора с разными резолюциями — выигрывает первый,
 * второй получает 409 и видит актуальное состояние (§12).
 */
export async function updateIssue(v: Viewer, id: string, input: ContentIssuePatch): Promise<UpdateResult> {
  return withTenant(v.tenantId, v.actorId, async (tx): Promise<UpdateResult> => {
    const i = await lockIssue(tx, v, id)
    if (!i) return { ok: false, code: 'not_found' }
    const now = new Date()
    const from = i.status as ContentIssueStatus
    const fail = async (code: UpdateError): Promise<UpdateResult> => ({ ok: false, code, card: await cardTx(tx, v, id) })

    // ── 1. Проверки — до первой записи: отказ не должен оставить половину изменений ─────────
    const flagChange = input.affectsScoring !== undefined && input.affectsScoring !== i.affectsScoring
    if (flagChange) {
      // «Впливає на бали» — только тест и вопрос (§6.2). Снять флаг, пока баллы ждут пересчёта,
      // нельзя: это и есть «тихо закрыть» (§7.7 в); ложный флаг снимает администратор `skipped`
      if (i.targetType !== 'quiz' && i.targetType !== 'question') return fail('affects_scoring_invalid')
      if (!input.affectsScoring && (i.rescoreState === 'needed' || i.rescoreState === 'in_progress')) return fail('rescore_pending')
    }
    const to = input.status
    const dueAt = input.dueAt ? new Date(`${input.dueAt}T23:59:59Z`) : null
    if (to !== undefined) {
      // Тот же статус — второй из двух одновременных разборов: 409 и актуальная карточка (§12)
      if (to === from) return fail('invalid_transition')
      const check = checkTransition({
        from, to, isAdmin: v.isAdmin, targetType: i.targetType as ContentIssueTargetType,
        rescoreState: i.rescoreState as ContentIssueRescoreState,
        resolution: input.resolution ?? null, resolutionComment: input.resolutionComment ?? null, dueAt, now,
      })
      if (!check.ok) return fail(check.error)
    }
    else if (input.resolution || input.dueAt || input.resolutionComment) {
      // Резолюция, срок и ответ заявителю меняются только вместе с переходом статуса
      return fail('invalid_transition')
    }
    if (to === 'in_progress' && (from === 'rejected' || from === 'closed')) {
      // Переоткрыть можно, только если по тому же месту нет новой открытой карточки: жалоба
      // после закрытия заводит новую (§4), и две открытые на один дефект сломали бы склейку
      const [twin] = await tx.execute(sql`select 1 from content_issues where dedupe_key = ${i.dedupeKey} and status <> 'closed' and id <> ${id}::uuid`) as unknown as unknown[]
      if (twin) return fail('duplicate_open')
    }

    // ── 2. Флаг и заметка ────────────────────────────────────────────────────────────────
    if (flagChange) {
      await tx.update(contentIssues).set({
        affectsScoring: input.affectsScoring!,
        rescoreState: input.affectsScoring && i.rescoreState === 'none' ? 'needed' : i.rescoreState,
        updatedAt: now,
      }).where(eq(contentIssues.id, id))
      await event(tx, v.tenantId, id, v.actorId, { kind: 'commented', isInternal: true, payload: { affects_scoring: input.affectsScoring } })
    }
    if (input.internalNote) {
      await event(tx, v.tenantId, id, v.actorId, { kind: 'commented', comment: input.internalNote, isInternal: true })
    }
    if (to === undefined) return { ok: true, card: (await cardTx(tx, v, id))! }

    // ── 3. Переход (§4) ──────────────────────────────────────────────────────────────────
    if (to === 'in_progress') {
      if (from === 'rejected' || from === 'closed') {
        await tx.update(contentIssues).set({ status: 'in_progress', resolution: null, resolutionComment: null, closedAt: null, updatedAt: now }).where(eq(contentIssues.id, id))
        await event(tx, v.tenantId, id, v.actorId, { kind: 'reopened', fromStatus: from, toStatus: to })
      }
      else {
        // «Взяти в роботу» — назначил себя, если ответственного ещё нет (§4)
        if (!i.assigneeId) await assignTx(tx, v.tenantId, id, v.actorId, { actorId: v.actorId, from: null, step: 'manual' })
        await tx.update(contentIssues).set({ status: 'in_progress', updatedAt: now }).where(eq(contentIssues.id, id))
        const eventId = await event(tx, v.tenantId, id, v.actorId, { kind: 'status_changed', fromStatus: from, toStatus: to })
        if (from === 'new') await notifyReporters(tx, v.tenantId, id, 'content_issue_accepted', eventId)
      }
    }

    if (to === 'fixed') {
      const resolution = input.resolution!
      const rescore = (RESCORE_RESOLUTIONS as readonly string[]).includes(resolution)
      const rescoreState = rescore && i.rescoreState === 'none' ? 'needed' : i.rescoreState
      await tx.update(contentIssues).set({
        status: 'fixed',
        resolution,
        resolutionComment: input.resolutionComment || i.resolutionComment,
        ...(rescore ? { affectsScoring: true } : {}),
        rescoreState,
        updatedAt: now,
      }).where(eq(contentIssues.id, id))
      await event(tx, v.tenantId, id, v.actorId, { kind: 'status_changed', fromStatus: from, toStatus: to, comment: input.resolutionComment || null, payload: { resolution } })
      await applyResolutionToReportersTx(tx, v, id, 'confirmed')
      if (rescoreState === 'needed') await notifyRescoreReady(tx, v.tenantId, id, await rescorePoolSize(tx, i))
      // Исправление уже опубликовано до отметки «Виправлено» — карточка закрывается сразу
      await tryAutoCloseTx(tx, v.tenantId, id, 'publication')
    }

    if (to === 'rejected') {
      const resolution = input.resolution!
      const comment = input.resolutionComment!.trim()
      await tx.update(contentIssues).set({
        status: 'rejected',
        resolution,
        resolutionComment: comment,
        // Отказ — явное решение с объяснением заявителям: баллы по нему не пересчитываются
        rescoreState: i.rescoreState === 'needed' ? 'skipped' : i.rescoreState,
        updatedAt: now,
      }).where(eq(contentIssues.id, id))
      const eventId = await event(tx, v.tenantId, id, v.actorId, { kind: 'status_changed', fromStatus: from, toStatus: to, comment, payload: { resolution } })
      const muted = await applyResolutionToReportersTx(tx, v, id, resolution === 'spam' ? 'spam' : 'rejected')
      for (const userId of muted) {
        const [st] = await tx.select({ until: contentReporterStats.mutedUntil }).from(contentReporterStats).where(eq(contentReporterStats.userId, userId))
        if (st?.until) await notifyMuted(tx, v.tenantId, userId, st.until)
      }
      await notifyReporters(tx, v.tenantId, id, 'content_issue_rejected', eventId)
    }

    if (to === 'deferred') {
      await tx.update(contentIssues).set({ status: 'deferred', dueAt: dueAt!, updatedAt: now }).where(eq(contentIssues.id, id))
      await event(tx, v.tenantId, id, v.actorId, { kind: 'status_changed', fromStatus: from, toStatus: to, comment: input.resolutionComment || null, payload: { due_at: dueAt!.toISOString() } })
    }

    if (to === 'closed') {
      await closeTx(tx, v.tenantId, i, { actorId: v.actorId, by: 'manual' })
    }

    await recordAudit(tx, {
      tenantId: v.tenantId, actorId: v.actorId, action: 'content_issue.update', entity: 'content_issue', entityId: id,
      before: { status: from, resolution: i.resolution },
      after: { status: to, resolution: input.resolution ?? null },
    })
    return { ok: true, card: (await cardTx(tx, v, id))! }
  })
}

/**
 * Переназначить (§2: только администратор, `content_issue.assign`). Адресат — действующий
 * сотрудник, который вправе разбирать (`content_issue.triage`): иначе карточка повиснет на
 * человеке без кнопок.
 */
export async function assignIssue(v: Viewer, id: string, userId: string): Promise<{ ok: true, card: ContentIssueCard } | { ok: false, code: 'not_found' | 'assignee_invalid' }> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const i = await lockIssue(tx, v, id)
    if (!i) return { ok: false as const, code: 'not_found' as const }
    const [who] = await tx.execute(sql`
      select u.id from users u
       where u.id = ${userId}::uuid ${ACTIVE_EMPLOYEES_ONLY('u')}
         and exists (select 1 from user_roles ur join roles r on r.id = ur.role_id
                      where ur.user_id = u.id and r.scopes @> array['content_issue.triage']::text[]
                        and (ur.valid_until is null or ur.valid_until > now()))`) as unknown as { id: string }[]
    if (!who) return { ok: false as const, code: 'assignee_invalid' as const }
    if (i.assigneeId !== userId) {
      await assignTx(tx, v.tenantId, id, userId, { actorId: v.actorId, from: i.assigneeId, step: 'manual' })
      await notifyAssignee(tx, v.tenantId, id, 'content_issue_created')
      await recordAudit(tx, { tenantId: v.tenantId, actorId: v.actorId, action: 'content_issue.assign', entity: 'content_issue', entityId: id, before: { assigneeId: i.assigneeId }, after: { assigneeId: userId } })
    }
    return { ok: true as const, card: (await cardTx(tx, v, id))! }
  })
}

/** Комментарий в журнал карточки (§10): внутренний — только тем, кто разбирает. */
export async function commentIssue(v: Viewer, id: string, input: { comment: string, isInternal: boolean }): Promise<{ ok: true, card: ContentIssueCard } | { ok: false, code: 'not_found' }> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const i = await lockIssue(tx, v, id)
    if (!i) return { ok: false as const, code: 'not_found' as const }
    await event(tx, v.tenantId, id, v.actorId, { kind: 'commented', comment: input.comment, isInternal: input.isInternal && v.canTriage })
    return { ok: true as const, card: (await cardTx(tx, v, id))! }
  })
}

// ── Пересчёт результатов из карточки (§7.8, П-12.4) ─────────────────────────────────────

export type RescoreError = 'not_found' | 'not_a_quiz_issue' | 'resolution_required' | 'already_rescored' | 'in_progress'

function modeOf(i: IssueRow, asked?: ContentIssueRescoreMode): ContentIssueRescoreMode {
  return asked ?? (i.resolution === 'question_void' ? 'void' : 'recalc')
}

function recalcOptions(i: IssueRow, mode: 'recalc' | 'void') {
  return mode === 'void'
    ? { rekeyQuestionIds: [], voidQuestionIds: [i.targetId], policy: 'improve_only' as const, issueId: i.id }
    : { rekeyQuestionIds: [i.targetId], policy: 'improve_only' as const, issueId: i.id }
}

/** Проверки до пересчёта: вопрос, подтверждение, пересчёт ещё не выполнен. */
function rescoreGate(i: IssueRow): RescoreError | null {
  if (i.targetType !== 'question') return 'not_a_quiz_issue'
  if (!i.resolution || !(RESCORE_RESOLUTIONS as readonly string[]).includes(i.resolution)) return 'resolution_required'
  if (i.rescoreState === 'done' || i.rescoreState === 'skipped') return 'already_rescored'
  return null
}

/**
 * Предпросмотр (§7.8, §10 `rescore-preview`): та же функция подсчёта, что и у применения
 * (`planRecalc()`), только без записи — «Зміниться 37 спроб із 214, з них 12 стануть
 * «ВИКОНАНО», 0 стануть «ПРОВАЛЕНО», середній бал +4.1».
 */
export async function rescorePreview(v: Viewer, id: string, askedMode?: ContentIssueRescoreMode): Promise<{ ok: true, preview: RescorePreview } | { ok: false, code: RescoreError }> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const [visible] = await tx.execute(sql`select i.id from content_issues i where i.id = ${id}::uuid ${visibleSql(v)}`) as unknown as { id: string }[]
    if (!visible) return { ok: false as const, code: 'not_found' as const }
    const [i] = await tx.select().from(contentIssues).where(eq(contentIssues.id, id))
    if (!i) return { ok: false as const, code: 'not_found' as const }
    if (i.targetType !== 'question') return { ok: false as const, code: 'not_a_quiz_issue' as const }
    const mode = modeOf(i, askedMode) === 'void' ? 'void' as const : 'recalc' as const
    const pool = await tx.execute(rescoreAttemptsSql(i.targetId, i.contentVersion)) as unknown as { id: string }[]
    let changed = 0
    let toPassed = 0
    let toFailed = 0
    let worse = 0
    let deltaSum = 0
    for (const p of pool) {
      const [attempt] = await tx.select().from(attempts).where(eq(attempts.id, p.id))
      if (!attempt) continue
      const plan = await planRecalc(tx, attempt, recalcOptions(i, mode))
      if (plan.verdict === 'improved') {
        changed++
        deltaSum += plan.after.score - (plan.before.score ?? 0)
        if (plan.before.passed !== true && plan.after.passed === true) toPassed++
      }
      else if (plan.verdict === 'worse') {
        worse++
        if (plan.before.passed === true && plan.after.passed === false) toFailed++
      }
    }
    return {
      ok: true as const,
      preview: {
        mode,
        attemptsTotal: pool.length,
        attemptsChanged: changed,
        toPassed,
        toFailedSkipped: toFailed,
        worseSkipped: worse,
        avgDelta: changed ? Math.round((deltaSum / changed) * 10) / 10 : null,
      },
    }
  })
}

/** Партия пересчёта (§11 `content_issue.rescore`: партиями по 200 попыток). */
const RESCORE_BATCH = 200

/**
 * Пересчёт из карточки (§7.8, критерии 4 и 5). Каждая попытка — своей транзакцией через
 * `recalculateAttempt()` (как у «Перерахувати» теста), с политикой «только улучшение»:
 * ухудшения не применяются и возвращаются отдельным списком. Повторный пересчёт по той же
 * карточке запрещён (`rescore_state = done`); прерванный — продолжается с места обрыва,
 * уже пересчитанные попытки пропускаются по `attempt_results.issue_id`.
 *
 * `skip` — «не перераховувати»: комментарий обязателен и виден заявителям.
 */
export async function rescoreIssue(v: Viewer, id: string, input: { mode?: ContentIssueRescoreMode, reason: string }): Promise<{ ok: true, result: RescoreResult } | { ok: false, code: RescoreError }> {
  const prepared = await withTenant(v.tenantId, v.actorId, async (tx) => {
    const i = await lockIssue(tx, v, id)
    if (!i) return { ok: false as const, code: 'not_found' as const }
    const gate = rescoreGate(i)
    if (gate) return { ok: false as const, code: gate }
    // Идущий пересчёт не запускается второй раз; зависший дольше 10 минут — продолжается
    if (i.rescoreState === 'in_progress' && i.updatedAt.getTime() > Date.now() - 10 * 60_000) return { ok: false as const, code: 'in_progress' as const }
    const mode = modeOf(i, input.mode)

    if (mode === 'skip') {
      const now = new Date()
      await tx.update(contentIssues).set({
        rescoreState: 'skipped',
        resolutionComment: i.resolutionComment ?? input.reason,
        updatedAt: now,
      }).where(eq(contentIssues.id, id))
      await event(tx, v.tenantId, id, v.actorId, { kind: 'rescored', comment: input.reason, payload: { mode, rescored_attempts: 0 } })
      await recordAudit(tx, { tenantId: v.tenantId, actorId: v.actorId, action: 'content_issue.rescore', entity: 'content_issue', entityId: id, after: { issueId: id, mode, reason: input.reason, rescoredAttempts: 0 } })
      await tryAutoCloseTx(tx, v.tenantId, id, 'rescore')
      return { ok: true as const, skip: true as const, mode }
    }

    await tx.update(contentIssues).set({ rescoreState: 'in_progress', updatedAt: new Date() }).where(eq(contentIssues.id, id))
    const pool = await tx.execute(rescoreAttemptsSql(i.targetId, i.contentVersion)) as unknown as { id: string, user_id: string }[]
    return { ok: true as const, skip: false as const, mode, issue: i, pool }
  })
  if (!prepared.ok) return prepared
  if (prepared.skip) return { ok: true, result: { mode: 'skip', attemptsTotal: 0, rescoredAttempts: 0, toPassed: 0, unchanged: 0, worse: [] } }

  const { issue, pool } = prepared
  const mode = prepared.mode as 'recalc' | 'void'
  const ctx = { tenantId: v.tenantId, actorId: v.actorId }
  const applied: { userId: string, attemptId: string, scoreBefore: number | null, scoreAfter: number, toPassed: boolean }[] = []
  const worse: Omit<RescoreWorseRow, 'fullName'>[] = []
  let unchanged = 0
  for (let from = 0; from < pool.length; from += RESCORE_BATCH) {
    for (const p of pool.slice(from, from + RESCORE_BATCH)) {
      const r = await recalculateAttempt(ctx, p.id, input.reason, recalcOptions(issue, mode))
      if (!r.ok) continue
      if (r.applied) {
        applied.push({ userId: r.userId, attemptId: p.id, scoreBefore: r.before.score, scoreAfter: r.after.score, toPassed: r.before.passed !== true && r.after.passed === true })
      }
      else if (r.verdict === 'worse') {
        worse.push({ attemptId: p.id, userId: r.userId, scoreBefore: r.before.score, scoreAfter: r.after.score, passedBefore: r.before.passed, passedAfter: r.after.passed })
      }
      else {
        unchanged++
      }
    }
  }

  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const worseIds = [...new Set(worse.map(w => w.userId))]
    const names = worseIds.length
      ? await tx.execute(sql`select u.id, u.full_name from users u where u.id in (${sql.join(worseIds.map(w => sql`${w}::uuid`), sql`, `)})`) as unknown as { id: string, full_name: string }[]
      : []
    const nameOf = new Map(names.map(n => [n.id, n.full_name]))
    const now = new Date()
    const [before] = await tx.select({ rescored: contentIssues.rescoredAttempts }).from(contentIssues).where(eq(contentIssues.id, id))
    const rescoredAttempts = (before?.rescored ?? 0) + applied.length
    await tx.update(contentIssues).set({ rescoreState: 'done', rescoredAttempts, updatedAt: now }).where(eq(contentIssues.id, id))
    const summary = {
      mode,
      attempts_total: pool.length,
      rescored_attempts: applied.length,
      to_passed: applied.filter(a => a.toPassed).length,
      unchanged,
      worse_attempt_ids: worse.map(w => w.attemptId),
    }
    await event(tx, v.tenantId, id, v.actorId, { kind: 'rescored', comment: input.reason, payload: summary })
    // Каждый пересчёт — в audit_log с issue_id, числом затронутых попыток и причиной (§7.8)
    await recordAudit(tx, { tenantId: v.tenantId, actorId: v.actorId, action: 'content_issue.rescore', entity: 'content_issue', entityId: id, after: { issueId: id, reason: input.reason, ...summary } })
    await notifyRescored(tx, v.tenantId, id, applied.filter(a => a.scoreAfter !== a.scoreBefore || a.toPassed))
    await tryAutoCloseTx(tx, v.tenantId, id, 'rescore')
    return {
      ok: true as const,
      result: {
        mode,
        attemptsTotal: pool.length,
        rescoredAttempts: applied.length,
        toPassed: summary.to_passed,
        unchanged,
        worse: worse.map(w => ({ ...w, fullName: nameOf.get(w.userId) ?? '' })),
      },
    }
  })
}

// ── Mute заявителя вручную (§7.11, §10) ──────────────────────────────────────────────────

/**
 * Приостановить или вернуть приём жалоб от человека (`content_issue.mute`, только админ).
 * Авто-mute ставит разбор (три `spam` подряд); снимает его — администратор (§7.11).
 */
export async function setReporterMute(v: Viewer, userId: string, input: { until: string, reason: string } | null): Promise<{ ok: true } | { ok: false, code: 'not_found' }> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const [person] = await tx.execute(sql`select u.id from users u where u.id = ${userId}::uuid`) as unknown as { id: string }[]
    if (!person) return { ok: false as const, code: 'not_found' as const }
    const now = new Date()
    const mutedUntil = input ? new Date(`${input.until}T23:59:59Z`) : null
    await tx.insert(contentReporterStats).values({
      tenantId: v.tenantId, userId, mutedUntil, mutedBy: input ? v.actorId : null, muteReason: input?.reason ?? null,
    }).onConflictDoUpdate({
      target: [contentReporterStats.tenantId, contentReporterStats.userId],
      // Снятие mute обнуляет и серию `spam`: иначе следующая же пустая жалоба вернула бы mute
      set: input
        ? { mutedUntil, mutedBy: v.actorId, muteReason: input.reason, updatedAt: now }
        : { mutedUntil: null, mutedBy: null, muteReason: null, consecutiveSpam: 0, updatedAt: now },
    })
    await recordAudit(tx, {
      tenantId: v.tenantId, actorId: v.actorId, action: input ? 'content_reporter.mute' : 'content_reporter.unmute',
      entity: 'user', entityId: userId, after: input ? { until: input.until, reason: input.reason } : { until: null },
    })
    if (input && mutedUntil) await notifyMuted(tx, v.tenantId, userId, mutedUntil)
    return { ok: true as const }
  })
}
