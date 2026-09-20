import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import type { ContentType } from '../../shared/enums'
import type { TaskReportQuery } from '../../shared/schemas/reports'
import { resolveAudience } from './audience'
import type { Audience } from '../../shared/schemas/assignments'
import { frameFirst, frameJoins, frameSelect, frameTail, frameWhere, passContextSelect, passContextWhere, periodSql } from './reportFrame'

interface Ctx { tenantId: string, actorId: string }
type Row = Record<string, unknown>
export type TaskReportFilter = TaskReportQuery & { scope?: string[] | null }

/**
 * Отчёт по типу контента (docs/22 §13.2, §13.7; docs/04 `/reports/tasks/:contentType`).
 * Один экран на тип, назначение (`taskId`) или предмет (`subjectId`) задаётся фильтром. Четыре части:
 * 1. «Огляд успішності» — Призначено · Не розпочато · В процесі · Провалено · Успішно (N, %);
 * 2. «Кількість звернень» по датам — из журнала обращений к заданиям (`task_access_log`): звернень и людей;
 * 3. «Статистика» из шести строк: призначених · виконали успішно · не відкривали · виконали неуспішно · в процесі · на перевірці;
 * 4. таблица людей: единый каркас + правая часть по типу (для теста — кращий результат · результат · спроб · ліміт).
 * Поддержаны типы с записями прохождения: course, training_program, test. Остальные — `unsupported` (docs/28 «Spec 22»).
 */

export const TASK_REPORT_TYPES: ContentType[] = ['course', 'training_program', 'test']

export interface TaskReport {
  contentType: ContentType
  subject: { id: string, title: string } | null
  task: { id: string, title: string, attemptsAllowed: number | null } | null
  overview: { assigned: number, notStarted: number, inProgress: number, failed: number, done: number, donePct: number }
  accesses: { day: string, hits: number, users: number }[]
  stats: { assigned: number, doneOk: number, notOpened: number, doneFail: number, inProgress: number, onReview: number }
  rows: Row[]
  period: { from?: string, to?: string }
}

const n = (v: unknown) => Number(v ?? 0)

function overviewOf(rows: Row[]) {
  const by = (s: string) => rows.filter(r => r.status === s).length
  const done = by('done')
  return { assigned: rows.length, notStarted: by('not_started'), inProgress: by('in_progress'), failed: by('failed'), done, donePct: rows.length ? Math.round(done / rows.length * 100) : 0 }
}
function statsOf(rows: Row[]) {
  const o = overviewOf(rows)
  return { assigned: o.assigned, doneOk: o.done, notOpened: o.notStarted, doneFail: o.failed, inProgress: o.inProgress, onReview: rows.filter(r => r.on_review === true).length }
}

/** Обращения к заданию по дням (часть 2): каждое открытие — строка журнала, людей — distinct. */
async function accessesOf(tx: TenantTx, contentType: ContentType, f: { subjectId?: string, taskId?: string, from?: string, to?: string }) {
  if (!f.subjectId && !f.taskId) return []
  const rows = await tx.execute(sql`
    select to_char(created_at::date, 'YYYY-MM-DD') as day, count(*)::int as hits, count(distinct user_id)::int as users
    from task_access_log
    where content_type = ${contentType} ${f.subjectId ? sql`and content_id = ${f.subjectId}::uuid` : sql``} ${f.taskId ? sql`and assignment_id = ${f.taskId}::uuid` : sql``}
      ${periodSql(sql`created_at`, f)}
    group by 1 order by 1`) as unknown as Row[]
  return rows.map(r => ({ day: String(r.day), hits: n(r.hits), users: n(r.users) }))
}

async function taskOf(tx: TenantTx, contentType: ContentType, taskId?: string, subjectId?: string) {
  const [a] = taskId
    ? await tx.execute(sql`select id, title, subject_id, (params->>'attemptsAllowed')::int as attempts_allowed from assignments where id = ${taskId}::uuid and subject_type = ${contentType}`) as unknown as Row[]
    : []
  if (taskId && !a) return null
  const sid = subjectId ?? (a ? String(a.subject_id) : undefined)
  const table = contentType === 'course' ? sql`courses` : contentType === 'training_program' ? sql`programs` : sql`quizzes`
  const [s] = sid ? await tx.execute(sql`select id, title from ${table} where id = ${sid}::uuid`) as unknown as Row[] : []
  if (sid && !s) return null
  return {
    task: a ? { id: String(a.id), title: String(a.title), attemptsAllowed: a.attempts_allowed == null ? null : n(a.attempts_allowed) } : null,
    subject: s ? { id: String(s.id), title: String(s.title) } : null,
  }
}

/** Часть 4 для курса и программы: записи прохождения. */
function enrollmentRows(contentType: 'course' | 'training_program', f: TaskReportFilter): SQL {
  const subjectFilter = f.taskId ? sql`and e.assignment_id = ${f.taskId}::uuid` : f.subjectId ? sql`and e.subject_id = ${f.subjectId}::uuid` : sql``
  if (contentType === 'course') {
    return sql`
      select ${frameSelect()}, ${frameTail({ assignedAt: sql`e.created_at`, completedAt: sql`e.completed_at`, status: sql`e.status`, result: sql`round(coalesce(e.score, e.progress_pct))::int` })},
             e.id as enrollment_id, c.title, e.progress_pct::int as progress_pct, e.due_at, e.last_activity_at,
             (e.cancelled_at is null and e.status in ('not_started', 'in_progress') and e.due_at < now()) as overdue,
             exists (select 1 from attempts at where at.enrollment_id = e.id and at.status = 'review') as on_review,
             ${passContextSelect('enrollment')}
      from enrollments e join users u on u.id = e.user_id join courses c on c.id = e.subject_id ${frameJoins()}
      where e.subject_type = 'course' and e.cancelled_at is null ${subjectFilter} ${periodSql(sql`e.created_at`, f)} ${frameWhere(f)}
        ${f.status ? sql`and e.status = ${f.status}` : sql``} ${passContextWhere('enrollment', f.context, f.contextId)}
      order by u.full_name limit 5000`
  }
  return sql`
    select ${frameSelect()}, ${frameTail({ assignedAt: sql`e.created_at`, completedAt: sql`e.completed_at`, status: sql`e.status`, result: sql`e.progress_pct::int` })},
           e.id as enrollment_id, pr.title, e.progress_pct::int as progress_pct, e.due_at, e.last_activity_at,
           (e.cancelled_at is null and e.status in ('not_started', 'in_progress') and e.due_at < now()) as overdue,
           false as on_review, 'standalone' as context, null::text as context_title
    from program_enrollments e join users u on u.id = e.user_id join programs pr on pr.id = e.program_id ${frameJoins()}
    where e.cancelled_at is null ${f.taskId ? sql`and e.assignment_id = ${f.taskId}::uuid` : f.subjectId ? sql`and e.program_id = ${f.subjectId}::uuid` : sql``} ${periodSql(sql`e.created_at`, f)} ${frameWhere(f)}
      ${f.status ? sql`and e.status = ${f.status}` : sql``}
    order by u.full_name limit 5000`
}

/**
 * Часть 4 для теста: у теста нет записей прохождения — люди берутся из аудитории назначения плюс все,
 * у кого есть попытки; статус — по попыткам (any passed → done; остання failed/expired → failed; есть попытка → in_progress; иначе not_started).
 */
async function testRows(tx: TenantTx, f: TaskReportFilter, quizId: string | undefined): Promise<Row[]> {
  const assigned = await tx.execute(sql`select id, audience, exclude, created_at, (params->>'attemptsAllowed')::int as attempts_allowed from assignments where subject_type = 'test' and status = 'active' ${f.taskId ? sql`and id = ${f.taskId}::uuid` : quizId ? sql`and subject_id = ${quizId}::uuid` : sql``}`) as unknown as Row[]
  const audience = new Map<string, { assignedAt: unknown, attemptsAllowed: number | null }>()
  for (const a of assigned) {
    const ids = await resolveAudience(tx, a.audience as Audience, a.exclude as Audience | null)
    for (const id of ids) if (!audience.has(id)) audience.set(id, { assignedAt: a.created_at, attemptsAllowed: a.attempts_allowed == null ? null : n(a.attempts_allowed) })
  }
  const ids = [...audience.keys()]
  const idList = ids.length ? sql`select unnest(array[${sql.join(ids.map(i => sql`${i}::uuid`), sql`, `)}])` : sql`select null::uuid where false`
  const attemptFilter = f.taskId ? sql`at.assignment_id = ${f.taskId}::uuid` : quizId ? sql`at.quiz_id = ${quizId}::uuid` : sql`false`
  const rows = await tx.execute(sql`
    with people as (
      select id as user_id from (${idList}) x(id)
      union
      select at.user_id from attempts at where ${attemptFilter}
    ),
    last as (
      select distinct on (at.user_id) at.user_id, at.id as attempt_id, at.status, at.score, at.max_score, at.submitted_at, at.created_at, at.attempt_no, at.lesson_id, at.enrollment_id, at.assignment_id
      from attempts at where ${attemptFilter} ${passContextWhere('attempt', f.context, f.contextId)}
      order by at.user_id, at.created_at desc
    ),
    agg as (
      select at.user_id, count(*)::int as attempts_used,
             max(round(at.score))::int as best_pct,
             bool_or(at.passed) as any_passed,
             min(at.created_at) as first_at, max(coalesce(at.submitted_at, at.created_at)) as last_at
      from attempts at where ${attemptFilter} and at.status <> 'in_progress' group by at.user_id
    )
    select ${frameSelect()},
           ${frameTail({
             assignedAt: sql`null::timestamptz`,
             completedAt: sql`case when coalesce(agg.any_passed, false) then agg.last_at end`,
             status: sql`case when coalesce(agg.any_passed, false) then 'done' when last.status in ('failed', 'expired') then 'failed' when last.attempt_id is not null then 'in_progress' else 'not_started' end`,
             result: sql`round(last.score)::int`,
           })},
           agg.best_pct, coalesce(agg.attempts_used, 0) as attempts_used, last.attempt_id as last_attempt_id, agg.last_at as last_attempt_at,
           (last.status in ('review', 'submitted')) as on_review, agg.first_at,
           coalesce(cx.context, 'standalone') as context, cx.context_title
    from people pe join users u on u.id = pe.user_id ${frameJoins()}
    left join last on last.user_id = u.id left join agg on agg.user_id = u.id
    left join lateral (select ${passContextSelect('attempt')} from attempts at where at.id = last.attempt_id) cx on true
    where true ${frameWhere(f)} ${f.context && f.context !== 'any' ? sql`and last.attempt_id is not null` : sql``}
    order by u.full_name limit 5000`) as unknown as Row[]
  for (const r of rows) {
    const a = audience.get(String(r.user_id))
    r.assigned_at = a?.assignedAt ?? r.first_at ?? null
    r.attempts_allowed = a?.attemptsAllowed ?? null
    if (f.status && r.status !== f.status) r._drop = true
  }
  return rows.filter(r => !r._drop)
}

export async function taskReport(ctx: Ctx, contentType: ContentType, f: TaskReportFilter): Promise<TaskReport | { error: 'unsupported' | 'not_found' }> {
  if (!TASK_REPORT_TYPES.includes(contentType)) return { error: 'unsupported' }
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const head = await taskOf(tx, contentType, f.taskId, f.subjectId)
    if (!head) return { error: 'not_found' as const }
    const subjectId = head.subject?.id
    const rows = contentType === 'test'
      ? await testRows(tx, f, subjectId)
      : (await tx.execute(enrollmentRows(contentType as 'course' | 'training_program', f))) as unknown as Row[]
    const accesses = await accessesOf(tx, contentType, { subjectId, taskId: f.taskId, from: f.from, to: f.to })
    return { contentType, subject: head.subject, task: head.task, overview: overviewOf(rows), accesses, stats: statsOf(rows), rows, period: { from: f.from, to: f.to } }
  })
}

/** Строки для выгрузки: каркас первыми, служебные поля убраны. */
export async function taskReportRows(ctx: Ctx, contentType: ContentType, f: TaskReportFilter): Promise<Row[]> {
  const r = await taskReport(ctx, contentType, f)
  if ('error' in r) return []
  return frameFirst(r.rows.map(({ enrollment_id: _e, last_attempt_id: _l, on_review: _o, first_at: _f, ...rest }) => rest))
}
