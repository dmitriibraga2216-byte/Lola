import ExcelJS from 'exceljs'
import { sql } from 'drizzle-orm'
import { withTenant } from '../utils/withTenant'

interface Ctx { tenantId: string, actorId: string }
interface Filter { from?: string, to?: string, locationId?: string, positionId?: string, courseId?: string }

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
      where u.status = 'active'
        ${f.locationId ? sql`and up.location_id = ${f.locationId}` : sql``}
        ${f.positionId ? sql`and up.position_id = ${f.positionId}` : sql``}
    ),
    mandatory as (
      select e.user_id,
             count(*) filter (where a.is_mandatory) as total,
             count(*) filter (where a.is_mandatory and e.status = 'completed'
                              and (e.valid_until is null or e.valid_until > now())) as done
      from enrollments e
      join assignments a on a.id = e.assignment_id
      where e.status not in ('cancelled')
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
           count(e.id) filter (where a.is_mandatory and e.status = 'completed')::int as done,
           count(e.id) filter (where a.is_mandatory and e.status = 'expired')::int as overdue
    from users u
    join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null
    left join enrollments e on e.user_id = u.id and e.status <> 'cancelled'
    left join assignments a on a.id = e.assignment_id
    where u.status = 'active' and up.location_id = ${locationId} and up.position_id = ${positionId}
    group by u.id, u.full_name order by u.full_name
  `)
}

/** Воронка курса: назначено → начали → завершили → сдали; по урокам — где отваливаются. */
export async function courseFunnel(ctx: Ctx, courseId: string) {
  const [funnel] = await q(ctx, sql`
    select count(*)::int as enrolled,
           count(*) filter (where status in ('in_progress','completed','failed','expired') and started_at is not null)::int as started,
           count(*) filter (where status = 'completed')::int as completed,
           count(*) filter (where status = 'expired')::int as overdue,
           round(avg(progress_pct))::int as avg_progress,
           round(percentile_cont(0.5) within group (order by extract(epoch from (completed_at - started_at)) / 60))::int as median_minutes
    from enrollments where subject_id = ${courseId} and status <> 'cancelled'
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
    left join lesson_progress lp on lp.lesson_id = l.id
    where c.id = ${courseId}
    group by l.id, l.title, m.sort, l.sort order by m.sort, l.sort
  `)
  return { funnel, lessons }
}

/** Просроченные: человек, курс, дней просрочки, руководитель, последняя активность. */
export async function overdue(ctx: Ctx, f: Filter = {}) {
  return q(ctx, sql`
    select e.id, u.id as user_id, u.full_name, c.title as course, e.due_at,
           (current_date - e.due_at::date)::int as days_over, e.last_activity_at, e.progress_pct,
           l.name as location, mgr.full_name as manager
    from enrollments e
    join users u on u.id = e.user_id
    join courses c on c.id = e.subject_id
    left join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null
    left join locations l on l.id = up.location_id
    left join users mgr on mgr.id = l.manager_id
    where e.status = 'expired'
      ${f.locationId ? sql`and up.location_id = ${f.locationId}` : sql``}
      ${f.courseId ? sql`and e.subject_id = ${f.courseId}` : sql``}
    order by e.due_at
  `)
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
      ${f.locationId ? sql`and up.location_id = ${f.locationId}` : sql``}
    order by a.started_at desc limit 1000
  `)
}

/** Активность: DAU/WAU, среднее время на урок, доля с телефона. */
export async function activity(ctx: Ctx, f: Filter = {}) {
  const from = f.from ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
  const [summary] = await q(ctx, sql`
    select
      (select count(distinct user_id)::int from sessions where created_at >= current_date) as dau,
      (select count(distinct user_id)::int from sessions where created_at >= current_date - 7) as wau,
      (select round(avg(seconds_spent))::int from lesson_progress where status = 'completed' and completed_at >= ${from}) as avg_lesson_seconds,
      (select round(100.0 * count(*) filter (where device = 'mobile') / nullif(count(*), 0))::int from lesson_progress where first_opened_at >= ${from}) as mobile_pct,
      (select count(*)::int from lesson_progress where completed_at >= ${from}) as lessons_completed,
      (select count(*)::int from attempts where submitted_at >= ${from}) as attempts_submitted
  `)
  const daily = await q(ctx, sql`
    select d::date as day,
           (select count(distinct user_id)::int from sessions s where s.created_at::date = d::date) as active,
           (select count(*)::int from lesson_progress lp where lp.completed_at::date = d::date) as lessons
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
           count(*) filter (where aa.reviewed_at - a.submitted_at > interval '48 hours')::int as sla_breaches
    from attempt_answers aa
    join attempts a on a.id = aa.attempt_id
    join users r on r.id = aa.reviewed_by
    where aa.reviewed_by is not null
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
