import ExcelJS from 'exceljs'
import { sql } from 'drizzle-orm'
import { withTenant } from '../utils/withTenant'
import { scopeSql } from './access'
import { EMPLOYEES_ONLY } from './repo/people'
import { managerIdsOf } from './orgManager'

interface Ctx { tenantId: string, actorId: string }
/** `scope` — область видимости (docs/22 §2): null — вся сеть, массив — только эти точки; уже сужена фильтром `locationId`. */
interface Filter { from?: string, to?: string, locationId?: string, positionId?: string, courseId?: string, scope?: string[] | null }

/**
 * Отчёты (docs/03 §3.9, docs/10 §9): цифры считаются на сервере, выгрузка
 * содержит те же цифры, что экран. Все — с фильтрами по датам/точке/позиции/курсу.
 */

type Row = Record<string, unknown>

async function q(ctx: Ctx, query: ReturnType<typeof sql>): Promise<Row[]> {
  return withTenant(ctx.tenantId, ctx.actorId, async tx => (await tx.execute(query)) as unknown as Row[])
}

/** Готовность смены: строки — точки, колонки — позиции, ячейка — % людей со всеми обязательными completed. */
export async function readiness(ctx: Ctx, f: Filter = {}) {
  const rows = await q(ctx, sql`
    with people as (
      select u.id as user_id, up.location_id, up.position_id
      from users u
      join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null
      where u.status = 'active' ${EMPLOYEES_ONLY()}
        ${scopeSql(f.scope ?? null, sql`up.location_id`)}
        ${f.positionId ? sql`and up.position_id = ${f.positionId}` : sql``}
    ),
    mandatory as (
      select e.user_id,
             count(*) filter (where a.is_mandatory) as total,
             count(*) filter (where a.is_mandatory and e.status = 'done'
                              and (e.valid_until is null or e.valid_until > now())) as done
      from enrollments e
      join assignments a on a.id = e.assignment_id
      where e.cancelled_at is null
      group by e.user_id
    )
    select l.id as location_id, l.name as location, p.id as position_id, p.name as position,
           count(*)::int as people,
           count(*) filter (where coalesce(m.total, 0) = 0 or m.done = m.total)::int as ready
    from people pe
    join locations l on l.id = pe.location_id
    join positions p on p.id = pe.position_id
    left join mandatory m on m.user_id = pe.user_id
    group by l.id, l.name, p.id, p.name
    order by l.name, p.name
  `)
  return rows.map(r => ({ ...r, pct: Number(r.people) ? Math.round(Number(r.ready) / Number(r.people) * 100) : 100 })) as (Row & { pct: number })[]
}

/** Люди в ячейке готовности (клик проваливается в список). */
export async function readinessPeople(ctx: Ctx, locationId: string, positionId: string) {
  return q(ctx, sql`
    select u.id, u.full_name,
           count(e.id) filter (where a.is_mandatory)::int as mandatory,
           count(e.id) filter (where a.is_mandatory and e.status = 'done')::int as done,
           count(e.id) filter (where a.is_mandatory and e.status in ('not_started','in_progress') and e.due_at < now())::int as overdue
    from users u
    join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null
    left join enrollments e on e.user_id = u.id and e.cancelled_at is null
    left join assignments a on a.id = e.assignment_id
    where u.status = 'active' and up.location_id = ${locationId} and up.position_id = ${positionId} ${EMPLOYEES_ONLY()}
    group by u.id, u.full_name order by u.full_name
  `)
}

/** Воронка курса: назначено → начали → завершили → сдали; по урокам — где отваливаются. */
export async function courseFunnel(ctx: Ctx, courseId: string, scope: string[] | null = null) {
  const inScope = scope === null ? sql`` : sql`and user_id in (select up.user_id from user_placements up where up.is_primary and up.ended_at is null ${scopeSql(scope, sql`up.location_id`)})`
  const [funnel] = await q(ctx, sql`
    select count(*)::int as enrolled,
           count(*) filter (where status in ('in_progress','done','failed') and started_at is not null)::int as started,
           count(*) filter (where status = 'done')::int as completed,
           count(*) filter (where status in ('not_started','in_progress') and due_at < now())::int as overdue,
           round(avg(progress_pct))::int as avg_progress,
           round(percentile_cont(0.5) within group (order by extract(epoch from (completed_at - started_at)) / 60))::int as median_minutes
    from enrollments where subject_id = ${courseId} and cancelled_at is null ${inScope}
  `)
  const lessons = await q(ctx, sql`
    select l.id, l.title, m.sort as module_sort, l.sort,
           count(lp.id)::int as opened,
           count(lp.id) filter (where lp.status = 'completed')::int as completed,
           round(avg(lp.seconds_spent))::int as avg_seconds
    from courses c
    join course_versions cv on cv.id = c.published_version_id
    join modules m on m.course_version_id = cv.id
    join lessons l on l.module_id = m.id
    left join lesson_progress lp on lp.lesson_id = l.id and lp.enrollment_id in (select id from enrollments where subject_id = ${courseId} ${inScope})
    where c.id = ${courseId}
    group by l.id, l.title, m.sort, l.sort order by m.sort, l.sort
  `)
  return { funnel, lessons }
}

/**
 * Просроченные: человек, курс, дней просрочки, руководитель, последняя активность.
 *
 * Колонка «Керівник» больше не берётся соединением с `locations.manager_id` (П-16.4):
 * имя подставляется по результату `resolveManager()` уже после выборки. Отчёт и уведомление
 * об этой же просрочке (`dueScan`) обязаны называть одного и того же человека.
 */
export async function overdue(ctx: Ctx, f: Filter = {}) {
  const rows = await q(ctx, sql`
    select e.id, u.id as user_id, u.full_name, c.title as course, e.due_at,
           (current_date - e.due_at::date)::int as days_over, e.last_activity_at, e.progress_pct,
           l.name as location
    from enrollments e
    join users u on u.id = e.user_id
    join courses c on c.id = e.subject_id
    left join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null
    left join locations l on l.id = up.location_id
    where e.cancelled_at is null and e.status in ('not_started','in_progress') and e.due_at < now()
      ${scopeSql(f.scope ?? null, sql`up.location_id`)}
      ${f.courseId ? sql`and e.subject_id = ${f.courseId}` : sql``}
    order by e.due_at
  `)
  if (!rows.length) return rows
  return withTenant(ctx.tenantId, ctx.actorId, async (tx): Promise<Row[]> => {
    const managers = await managerIdsOf(tx, rows.map(r => String(r.user_id)))
    const ids = [...new Set(managers.values())]
    const names = ids.length
      ? new Map(((await tx.execute(sql`select id, full_name from users where id in (${sql.join(ids.map(i => sql`${i}::uuid`), sql`, `)})`)) as unknown as { id: string, full_name: string }[]).map(r => [r.id, r.full_name]))
      : new Map<string, string>()
    return rows.map(r => ({ ...r, manager: names.get(managers.get(String(r.user_id)) ?? '') ?? null }))
  })
}

/** Результаты аттестаций: попытки, баллы, проверяющие, время. */
export async function attemptsReport(ctx: Ctx, f: Filter = {}) {
  return q(ctx, sql`
    select a.id, u.full_name, qz.title as quiz, a.attempt_no, a.status, a.score, a.passed,
           a.started_at, a.submitted_at, a.time_spent_sec, l.name as location, p.name as position,
           (select string_agg(distinct r.full_name, ', ') from attempt_answers aa join users r on r.id = aa.reviewed_by where aa.attempt_id = a.id) as reviewers
    from attempts a
    join users u on u.id = a.user_id
    join quizzes qz on qz.id = a.quiz_id
    left join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null
    left join locations l on l.id = up.location_id
    left join positions p on p.id = up.position_id
    where a.status <> 'in_progress'
      ${f.from ? sql`and a.started_at >= ${f.from}` : sql``}
      ${f.to ? sql`and a.started_at < ${f.to}::date + 1` : sql``}
      ${scopeSql(f.scope ?? null, sql`up.location_id`)}
    order by a.started_at desc limit 1000
  `)
}

/** Активность: DAU/WAU, среднее время на урок, доля с телефона. */
export async function activity(ctx: Ctx, f: Filter = {}) {
  const from = f.from ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
  const scope = f.scope ?? null
  const inScope = scope === null ? sql`` : sql`and user_id in (select up.user_id from user_placements up where up.is_primary and up.ended_at is null ${scopeSql(scope, sql`up.location_id`)})`
  const [summary] = await q(ctx, sql`
    select
      (select count(distinct user_id)::int from sessions where created_at >= current_date ${inScope}) as dau,
      (select count(distinct user_id)::int from sessions where created_at >= current_date - 7 ${inScope}) as wau,
      (select round(avg(seconds_spent))::int from lesson_progress where status = 'completed' and completed_at >= ${from} ${inScope}) as avg_lesson_seconds,
      (select round(100.0 * count(*) filter (where device = 'mobile') / nullif(count(*), 0))::int from lesson_progress where first_opened_at >= ${from} ${inScope}) as mobile_pct,
      (select count(*)::int from lesson_progress where completed_at >= ${from} ${inScope}) as lessons_completed,
      (select count(*)::int from attempts where submitted_at >= ${from} ${inScope}) as attempts_submitted
  `)
  const daily = await q(ctx, sql`
    select d::date as day,
           (select count(distinct user_id)::int from sessions s where s.created_at::date = d::date ${inScope}) as active,
           (select count(*)::int from lesson_progress lp where lp.completed_at::date = d::date ${inScope}) as lessons
    from generate_series(${from}::date, current_date, '1 day') d order by d
  `)
  return { summary, daily }
}

/** Личный отчёт: свои курсы, баллы, сертификаты. */
export async function personal(ctx: Ctx, userId: string) {
  const enrollments = await q(ctx, sql`
    select e.id, c.title as course, e.status, e.progress_pct, e.score, e.started_at, e.completed_at, e.due_at, e.valid_until, e.time_spent_sec
    from enrollments e join courses c on c.id = e.subject_id
    where e.user_id = ${userId} order by e.created_at desc
  `)
  const certificates = await q(ctx, sql`
    select ce.number, c.title as course, ce.issued_at, ce.valid_until, ce.revoked_at
    from certificates ce left join courses c on c.id = ce.course_id where ce.user_id = ${userId} order by ce.issued_at desc
  `)
  return { enrollments, certificates }
}

/** По наставникам: сколько проверок, средний срок ответа, доля зачётов. */
export async function mentors(ctx: Ctx, f: Filter = {}) {
  return q(ctx, sql`
    select r.id, r.full_name,
           count(aa.id)::int as reviews,
           round(avg(extract(epoch from (aa.reviewed_at - a.submitted_at)) / 3600), 1) as avg_hours,
           round(100.0 * count(*) filter (where aa.is_correct) / nullif(count(*), 0))::int as accept_pct,
           count(*) filter (where aa.reviewed_at - a.submitted_at > interval '48 hours')::int as sla_breaches,
           -- Кто решил по практикуму — теперь только review_queue_items.assigned_reviewer_id
           -- (В-2, PR-20 сняла зеркало workshop_submissions.reviewer_id): closeReview() пишет
           -- его туда же, кто принял решение.
           (select round(avg(ws.mentor_rating), 1) from workshop_submissions ws
              join review_queue_items q on q.task_type = 'workshop' and q.source_id = ws.id
             where q.assigned_reviewer_id = r.id and ws.mentor_rating is not null) as learner_rating
    from attempt_answers aa
    join attempts a on a.id = aa.attempt_id
    join users r on r.id = aa.reviewed_by
    left join user_placements up on up.user_id = r.id and up.is_primary and up.ended_at is null
    where aa.reviewed_by is not null
      ${scopeSql(f.scope ?? null, sql`up.location_id`)}
      ${f.from ? sql`and aa.reviewed_at >= ${f.from}` : sql``}
      ${f.to ? sql`and aa.reviewed_at < ${f.to}::date + 1` : sql``}
    group by r.id, r.full_name order by reviews desc
  `)
}

/** Выгрузка любого табличного отчёта в xlsx: те же цифры, что на экране. */
export async function toXlsx(title: string, rows: Row[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet(title.slice(0, 31))
  if (rows.length) {
    const cols = Object.keys(rows[0]!)
    ws.addRow(cols)
    ws.getRow(1).font = { bold: true }
    for (const r of rows) ws.addRow(cols.map(c => r[c] instanceof Date ? (r[c] as Date).toISOString() : r[c] ?? ''))
  }
  return Buffer.from(await wb.xlsx.writeBuffer())
}
