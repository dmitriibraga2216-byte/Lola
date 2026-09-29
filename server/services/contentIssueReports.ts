import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { withTenant } from '../utils/withTenant'
import { frameJoins, frameWhere, periodSql } from './reportFrame'
import { ACTIVE_EMPLOYEES_ONLY } from './repo/people'
import {
  CONFIRMING_RESOLUTIONS, OPEN_STATUSES, REJECTING_RESOLUTIONS, isSuspectQuestion, isTrustedReporter, overdueDays, pctOf,
} from '../../shared/domain/contentIssues'
import type {
  AuthorDisciplineRow, ComplaintRow, ContentIssueReport, ContentIssueReportQuery, IssueTrack, ProblemQuestionRow, ReporterRow,
} from '../../shared/schemas/contentIssues'
import type { ContentIssueRescoreState } from '../../shared/enums'

/**
 * Четыре отчёта модуля жалоб (docs/v2/36-content-feedback.md §9) рядом с «Якість контенту»
 * (`contentQuality.ts`): «Скарги» — плоская выгрузка карточек, «Дисципліна авторів» — строка на
 * ответственного, «Проблемні питання» — только `bad_question`/`wrong_key` с долей неверных
 * ответов, «Заявники» — кто сколько подал (только администратор).
 *
 * Область видимости — как у «Якість контенту»: люди отбираются единым каркасом
 * (`frameJoins()`/`frameWhere()`, docs/22 §13.3). Строки первых трёх отчётов — карточки, а не
 * люди, поэтому ограничение области — «есть заявитель в моей области»: керівник точки видит
 * жалобы своих людей (§2 «по своим точкам»). Администратор (`scope = null`) видит все карточки,
 * в том числе поданные системой без заявителя.
 *
 * Период — по дате первой жалобы (`first_reported_at`); у «Заявників» — по дате самой жалобы.
 */

export interface Viewer { tenantId: string, actorId: string, scope: string[] | null }

const CONFIRMED = sql.raw(CONFIRMING_RESOLUTIONS.map(r => `'${r}'`).join(', '))
const REJECTED = sql.raw(REJECTING_RESOLUTIONS.map(r => `'${r}'`).join(', '))
const OPEN = sql.raw(OPEN_STATUSES.map(s => `'${s}'`).join(', '))

/** Карточка видна, если хотя бы один её заявитель — в области смотрящего (и в выбранной точке). */
function areaWhere(v: Viewer, q: ContentIssueReportQuery): SQL {
  if (v.scope === null && !q.locationId) return sql``
  return sql`and exists (
    select 1 from content_reports r join users u on u.id = r.user_id ${frameJoins()}
     where r.issue_id = i.id ${frameWhere({ scope: v.scope, includeArchived: q.includeArchived })}
       ${q.locationId ? sql`and pl.location_id = ${q.locationId}::uuid` : sql``})`
}

/** Фильтры карточки: тип проблемы, тип элемента (блок — это материал), категория курса, статус. */
function issueWhere(q: ContentIssueReportQuery): SQL {
  return sql`
    ${q.issueType ? sql`and i.issue_type = ${q.issueType}` : sql``}
    ${q.targetType ? sql`and i.target_type = ${q.targetType}` : sql``}
    ${q.categoryId ? sql`and exists (select 1 from courses cc where cc.id = any(i.course_ids) and cc.category_id = ${q.categoryId}::uuid)` : sql``}
    ${q.status ? sql`and i.status = ${q.status}` : sql``}`
}

const iso = (d: Date | string | null) => d == null ? null : new Date(d).toISOString()

/** «Скарги»: дата, тип, элемент, трек, версия, заявителей, статус, резолюция, ответственный, срок, просрочка, пересчёт. */
export async function complaintsReport(v: Viewer, q: ContentIssueReportQuery, now: Date = new Date()): Promise<ContentIssueReport<ComplaintRow>> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const rows = await tx.execute(sql`
      select i.id, i.first_reported_at, i.issue_type, i.target_type, i.title, i.content_version, i.reports_count,
             i.status, i.resolution, i.due_at, i.rescore_state, a.full_name as assignee,
             (select coalesce(json_agg(json_build_object('id', c.id, 'title', c.title) order by c.title), '[]'::json)
                from courses c where c.id = any(i.course_ids)) as tracks
        from content_issues i
        left join users a on a.id = i.assignee_id
       where true ${periodSql(sql`i.first_reported_at`, q)} ${issueWhere(q)} ${areaWhere(v, q)}
       order by i.first_reported_at desc, i.id
       limit 5000`) as unknown as {
      id: string, first_reported_at: Date, issue_type: ComplaintRow['issueType'], target_type: ComplaintRow['targetType'],
      title: string, content_version: number, reports_count: number, status: ComplaintRow['status'],
      resolution: ComplaintRow['resolution'], due_at: Date | null, rescore_state: ContentIssueRescoreState,
      assignee: string | null, tracks: IssueTrack[]
    }[]
    return {
      rows: rows.map((r) => {
        const open = (OPEN_STATUSES as readonly string[]).includes(r.status)
        return {
          id: r.id,
          reportedAt: iso(r.first_reported_at)!,
          issueType: r.issue_type,
          targetType: r.target_type,
          title: r.title,
          tracks: r.tracks ?? [],
          contentVersion: Number(r.content_version),
          reporters: Number(r.reports_count),
          status: r.status,
          resolution: r.resolution,
          assignee: r.assignee,
          dueAt: iso(r.due_at),
          overdueDays: open && r.due_at ? overdueDays(new Date(r.due_at), now) : null,
          rescoreState: r.rescore_state,
        }
      }),
    }
  })
}

/**
 * «Дисципліна авторів»: на ответственного — открытых и просроченных **сейчас** (нагрузка не
 * зависит от периода), решённых за период, среднее время от первой жалобы до «Виправлено»
 * и доля отклонённых среди решённых. Строка без ответственного — «не назначено».
 */
export async function authorDisciplineReport(v: Viewer, q: ContentIssueReportQuery, now: Date = new Date()): Promise<ContentIssueReport<AuthorDisciplineRow>> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const rows = await tx.execute(sql`
      with scoped as (
        select i.* from content_issues i where true ${issueWhere(q)} ${areaWhere(v, q)}
      ), period as (
        select i.* from scoped i where true ${periodSql(sql`i.first_reported_at`, q)}
      ), fixed as (
        select i.assignee_id, extract(epoch from (min(e.created_at) - i.first_reported_at)) / 86400 as days
          from period i join content_issue_events e on e.issue_id = i.id and e.kind = 'status_changed' and e.to_status = 'fixed'
         group by i.id, i.assignee_id, i.first_reported_at
      ), keys as (
        select distinct assignee_id from scoped where status in (${OPEN})
        union select distinct assignee_id from period where resolution is not null
      )
      select k.assignee_id, a.full_name,
             case when k.assignee_id is null then null
                  else exists (select 1 from users u where u.id = k.assignee_id ${ACTIVE_EMPLOYEES_ONLY('u')}) end as active,
             (select count(*)::int from scoped s where s.assignee_id is not distinct from k.assignee_id and s.status in (${OPEN})) as open,
             (select count(*)::int from scoped s where s.assignee_id is not distinct from k.assignee_id and s.status in (${OPEN})
                 and s.due_at is not null and s.due_at <= ${now.toISOString()}::timestamptz - interval '1 day') as overdue,
             (select count(*)::int from period p where p.assignee_id is not distinct from k.assignee_id and p.resolution is not null) as decided,
             (select count(*)::int from period p where p.assignee_id is not distinct from k.assignee_id and p.resolution in (${REJECTED})) as rejected,
             (select round(avg(f.days)::numeric, 1)::float from fixed f where f.assignee_id is not distinct from k.assignee_id) as avg_days
        from keys k left join users a on a.id = k.assignee_id
       order by 5 desc, 4 desc, a.full_name nulls last`) as unknown as {
      assignee_id: string | null, full_name: string | null, active: boolean | null, open: number, overdue: number,
      decided: number, rejected: number, avg_days: number | null
    }[]
    return {
      rows: rows.map(r => ({
        assigneeId: r.assignee_id,
        name: r.full_name,
        active: r.active,
        open: Number(r.open),
        overdue: Number(r.overdue),
        decided: Number(r.decided),
        avgDaysToFix: r.avg_days == null ? null : Number(r.avg_days),
        rejectedPct: pctOf(Number(r.rejected), Number(r.decided)),
      })),
    }
  })
}

/**
 * «Проблемні питання»: жалобы `bad_question`/`wrong_key` на вопрос, сгруппированные по вопросу.
 * Доля неверных — по проверенным ответам (`is_correct` не `null`) всех попыток, где вопрос
 * встречался, без аннулированных: это та же статистика вопроса, что в `docs/12` §11, и
 * вместе с жалобами она даёт диагноз (§9).
 */
export async function problemQuestionsReport(v: Viewer, q: ContentIssueReportQuery): Promise<ContentIssueReport<ProblemQuestionRow>> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const qq = { ...q, targetType: undefined, issueType: q.issueType === 'bad_question' || q.issueType === 'wrong_key' ? q.issueType : undefined }
    const rows = await tx.execute(sql`
      with cards as (
        select i.* from content_issues i
         where i.target_type = 'question' and i.issue_type in ('bad_question', 'wrong_key')
           ${periodSql(sql`i.first_reported_at`, q)} ${issueWhere(qq)} ${areaWhere(v, q)}
      )
      select c.target_id as question_id,
             (array_agg(c.title order by c.first_reported_at desc))[1] as title,
             sum(c.reports_count)::int as complaints, count(*)::int as cards,
             array_agg(distinct c.rescore_state) as rescore_states,
             (select count(*)::int from attempt_answers aa join attempts at on at.id = aa.attempt_id
               where aa.question_id = c.target_id and aa.is_correct is not null and at.status <> 'annulled') as answers,
             (select count(*)::int from attempt_answers aa join attempts at on at.id = aa.attempt_id
               where aa.question_id = c.target_id and aa.is_correct = false and at.status <> 'annulled') as wrong,
             (select coalesce(json_agg(json_build_object('id', z.id, 'title', z.title) order by z.title), '[]'::json)
                from quizzes z
               where z.id in (select qz.quiz_id from quiz_questions qz where qz.question_id = c.target_id
                              union select at.quiz_id from attempt_answers aa join attempts at on at.id = aa.attempt_id
                                     where aa.question_id = c.target_id)) as quizzes
        from cards c
       group by c.target_id`) as unknown as {
      question_id: string, title: string, complaints: number, cards: number, rescore_states: ContentIssueRescoreState[],
      answers: number, wrong: number, quizzes: IssueTrack[]
    }[]
    const out: ProblemQuestionRow[] = rows.map((r) => {
      const wrongPct = pctOf(Number(r.wrong), Number(r.answers))
      const states = [...new Set(r.rescore_states ?? [])]
      return {
        questionId: r.question_id,
        title: r.title,
        quizzes: r.quizzes ?? [],
        complaints: Number(r.complaints),
        cards: Number(r.cards),
        answers: Number(r.answers),
        wrongPct,
        rescoreState: states.length === 1 ? states[0]! : 'mixed',
        suspect: isSuspectQuestion(wrongPct, Number(r.complaints)),
      }
    })
    // Сначала «почти наверняка сломанные», дальше — по числу жалоб и доле ошибок
    out.sort((a, b) => Number(b.suspect) - Number(a.suspect) || b.complaints - a.complaints || (b.wrongPct ?? -1) - (a.wrongPct ?? -1))
    return { rows: out }
  })
}

/**
 * «Заявники» (только администратор, §9): за период — подано, подтверждено, отклонено, спам;
 * метка «надійний» и mute — по накопленной репутации `content_reporter_stats` (§7.11), а не
 * по периоду: это текущее состояние человека.
 */
export async function reportersReport(v: Viewer, q: ContentIssueReportQuery): Promise<ContentIssueReport<ReporterRow>> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const rows = await tx.execute(sql`
      select u.id as user_id, u.full_name, l.name as location,
             count(*)::int as reports,
             count(*) filter (where i.resolution in (${CONFIRMED}))::int as confirmed,
             count(*) filter (where i.resolution in (${REJECTED}))::int as rejected,
             count(*) filter (where i.resolution = 'spam')::int as spam,
             max(s.reports_total) as reports_total, max(s.confirmed_count) as confirmed_total, max(s.muted_until) as muted_until
        from content_reports r
        join content_issues i on i.id = r.issue_id
        join users u on u.id = r.user_id
        ${frameJoins()}
        left join content_reporter_stats s on s.user_id = u.id
       where true ${frameWhere({ scope: v.scope, includeArchived: q.includeArchived })}
         ${q.locationId ? sql`and pl.location_id = ${q.locationId}::uuid` : sql``}
         ${periodSql(sql`r.created_at`, q)} ${issueWhere(q)}
       group by u.id, u.full_name, l.name
       order by reports desc, u.full_name`) as unknown as {
      user_id: string, full_name: string, location: string | null, reports: number, confirmed: number, rejected: number,
      spam: number, reports_total: number | null, confirmed_total: number | null, muted_until: Date | null
    }[]
    const nowMs = Date.now()
    return {
      rows: rows.map(r => ({
        userId: r.user_id,
        fullName: r.full_name,
        location: r.location,
        reports: Number(r.reports),
        confirmed: Number(r.confirmed),
        rejected: Number(r.rejected),
        spam: Number(r.spam),
        confirmedPct: pctOf(Number(r.confirmed), Number(r.reports)),
        trusted: isTrustedReporter({ reportsTotal: Number(r.reports_total ?? 0), confirmedCount: Number(r.confirmed_total ?? 0) }),
        mutedUntil: r.muted_until && new Date(r.muted_until).getTime() > nowMs ? iso(r.muted_until) : null,
      })),
    }
  })
}
