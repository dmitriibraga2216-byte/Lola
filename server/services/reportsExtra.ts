import { sql } from 'drizzle-orm'
import { withTenant } from '../utils/withTenant'
import { scopeSql } from './access'
import { enqueueNotification } from './notifications'
import { EMPLOYEES_ONLY } from './repo/people'

interface Ctx { tenantId: string, actorId: string }
type Row = Record<string, unknown>
export interface Period { from?: string, to?: string, scope?: string[] | null }

/**
 * Отчёты, часть 2 (docs/22): «Прогрес навчання» с предметом и воронкой, «Контент», «Активність»
 * с DAU/WAU/MAU и часами суток, разрез аттестаций «по вопросам», плитки со сравнением периодов,
 * «Мої результати» с компетенциями, недельный дайджест руководителю.
 */

async function q(ctx: Ctx, query: ReturnType<typeof sql>): Promise<Row[]> {
  return withTenant(ctx.tenantId, ctx.actorId, async tx => (await tx.execute(query)) as unknown as Row[])
}
const day = (d: Date) => d.toISOString().slice(0, 10)
/** Прошлый период равной длины непосредственно перед выбранным (docs/22 §7.4). */
export function previousPeriod(from: string, to: string): { from: string, to: string } {
  const a = new Date(from), b = new Date(to)
  const len = Math.max(1, Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1)
  const pTo = new Date(a.getTime() - 86_400_000), pFrom = new Date(pTo.getTime() - (len - 1) * 86_400_000)
  return { from: day(pFrom), to: day(pTo) }
}
export function defaultPeriod(f: Period): { from: string, to: string } {
  const to = f.to ?? day(new Date())
  const from = f.from ?? day(new Date(new Date(to).getTime() - 29 * 86_400_000))
  return { from, to }
}
const inScope = (scope: string[] | null | undefined, col = sql`up.location_id`) => scopeSql(scope ?? null, col)

// ── Прогрес навчання (docs/22 §4.2) ───────────────────────────────────

export type Subject = 'course' | 'program' | 'quiz' | 'workshop' | 'meetup' | 'survey'

/** Воронка: назначено → начали → завершили → сдали с первого раза; таблица по людям; разрез «по контенту». */
export async function progress(ctx: Ctx, f: Period & { subject?: Subject, subjectId?: string, status?: string, mandatoryOnly?: boolean }) {
  const subject = f.subject ?? 'course'
  const { from, to } = defaultPeriod(f)
  const people = (subjectSql: ReturnType<typeof sql>) => sql`
    select r.*, u.full_name, l.name as location, p.name as position
    from (${subjectSql}) r
    join users u on u.id = r.user_id
    left join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null
    left join locations l on l.id = up.location_id left join positions p on p.id = up.position_id
    where u.status <> 'archived' ${inScope(f.scope)} ${f.status ? sql`and r.status = ${f.status}` : sql``}
    order by r.created_at desc limit 1000`
  let rows: Row[] = []
  if (subject === 'course' || subject === 'program') {
    rows = await q(ctx, people(subject === 'course'
      ? sql`select e.user_id, e.subject_id, c.title, e.status, e.progress_pct, e.score, e.due_at, e.started_at, e.completed_at, e.created_at,
                   (a.is_mandatory) as is_mandatory,
                   exists (select 1 from attempts at where at.enrollment_id = e.id and at.attempt_no = 1 and at.passed) as passed_first
            from enrollments e join courses c on c.id = e.subject_id left join assignments a on a.id = e.assignment_id
            where e.subject_type = 'course' and e.cancelled_at is null and e.created_at >= ${from}::date and e.created_at < (${to}::date + 1)
              ${f.subjectId ? sql`and e.subject_id = ${f.subjectId}::uuid` : sql``} ${f.mandatoryOnly ? sql`and a.is_mandatory` : sql``}`
      : sql`select pe.user_id, pe.program_id as subject_id, p.title, pe.status, pe.progress_pct, null::numeric as score, pe.due_at, pe.started_at, pe.completed_at, pe.created_at, true as is_mandatory, false as passed_first
            from program_enrollments pe join programs p on p.id = pe.program_id
            where pe.cancelled_at is null and pe.created_at >= ${from}::date and pe.created_at < (${to}::date + 1) ${f.subjectId ? sql`and pe.program_id = ${f.subjectId}::uuid` : sql``}`))
  }
  else if (subject === 'quiz') {
    rows = await q(ctx, people(sql`select a.user_id, a.quiz_id as subject_id, qz.title, a.status, null::int as progress_pct, a.score, null::date as due_at, a.started_at, a.submitted_at as completed_at, a.created_at, false as is_mandatory,
                                       (a.attempt_no = 1 and a.passed) as passed_first
                                from attempts a join quizzes qz on qz.id = a.quiz_id
                                where a.status <> 'in_progress' and a.created_at >= ${from}::date and a.created_at < (${to}::date + 1) ${f.subjectId ? sql`and a.quiz_id = ${f.subjectId}::uuid` : sql``}`))
  }
  else if (subject === 'workshop') {
    rows = await q(ctx, people(sql`select s.user_id, s.workshop_id as subject_id, w.title, s.status, null::int as progress_pct, s.score, s.sla_due_at::date as due_at, s.submitted_at as started_at, s.reviewed_at as completed_at, s.created_at, false as is_mandatory,
                                       (s.rework_count = 0 and s.passed) as passed_first
                                from workshop_submissions s join workshops w on w.id = s.workshop_id
                                where s.created_at >= ${from}::date and s.created_at < (${to}::date + 1) ${f.subjectId ? sql`and s.workshop_id = ${f.subjectId}::uuid` : sql``}`))
  }
  else if (subject === 'meetup') {
    rows = await q(ctx, people(sql`select r.user_id, r.meetup_id as subject_id, m.title, r.status, null::int as progress_pct, null::numeric as score, m.starts_at::date as due_at, r.registered_at as started_at, r.checked_in_at as completed_at, r.created_at, false as is_mandatory,
                                       (r.status = 'attended') as passed_first
                                from meetup_registrations r join meetups m on m.id = r.meetup_id
                                where r.created_at >= ${from}::date and r.created_at < (${to}::date + 1) ${f.subjectId ? sql`and r.meetup_id = ${f.subjectId}::uuid` : sql``}`))
  }
  else {
    rows = await q(ctx, people(sql`select sr.user_id, sr.survey_id as subject_id, sv.title, 'done' as status, 100 as progress_pct, null::numeric as score, sv.closes_at::date as due_at, sr.created_at as started_at, sr.submitted_at as completed_at, sr.created_at, false as is_mandatory, true as passed_first
                                from survey_responses sr join surveys sv on sv.id = sr.survey_id
                                where sr.user_id is not null and sr.created_at >= ${from}::date and sr.created_at < (${to}::date + 1) ${f.subjectId ? sql`and sr.survey_id = ${f.subjectId}::uuid` : sql``}`))
  }
  const started = rows.filter(r => r.started_at || ['in_progress', 'done', 'failed', 'submitted', 'passed', 'attended', 'reviewed'].includes(String(r.status)))
  const completed = rows.filter(r => ['done', 'passed', 'attended', 'reviewed'].includes(String(r.status)) || r.completed_at)
  const funnel = { assigned: rows.length, started: started.length, completed: completed.length, passedFirst: rows.filter(r => r.passed_first === true).length }
  // Разрез «по контенту»: что проходят хуже всего
  const byContent = new Map<string, { subjectId: string, title: string, assigned: number, completed: number }>()
  for (const r of rows) {
    const k = String(r.subject_id)
    const c = byContent.get(k) ?? { subjectId: k, title: String(r.title), assigned: 0, completed: 0 }
    c.assigned++
    if (completed.includes(r)) c.completed++
    byContent.set(k, c)
  }
  const content = [...byContent.values()].map(c => ({ ...c, completionPct: c.assigned ? Math.round(c.completed / c.assigned * 100) : 0 })).sort((a, b) => a.completionPct - b.completionPct)
  return { subject, period: { from, to }, funnel, rows, content }
}

// ── Контент (docs/22 §4.6) ────────────────────────────────────────────

export async function content(ctx: Ctx, f: Period = {}) {
  const rows = await q(ctx, sql`
    select c.id, c.title, c.updated_at, u.full_name as owner,
           count(e.id)::int as assigned,
           count(e.id) filter (where e.status = 'done')::int as completed,
           round(100.0 * count(e.id) filter (where e.status = 'done') / nullif(count(e.id), 0))::int as completion_pct,
           round(avg(e.time_spent_sec) filter (where e.status = 'done') / 60)::int as avg_minutes,
           (select round(avg((r.answers->(s.questions->0->>'id')->>'value')::numeric), 1) from survey_responses r join surveys s on s.id = r.survey_id where s.kind = 'course_feedback' and s.trigger_course_id = c.id) as rating,
           (select l.title from lessons l join modules m on m.id = l.module_id join lesson_progress lp on lp.lesson_id = l.id
              where m.course_version_id = c.published_version_id and lp.status <> 'completed' group by l.id, l.title, m.sort, l.sort order by count(*) desc, m.sort, l.sort limit 1) as dropoff_lesson
    from courses c
    left join users u on u.id = c.created_by
    left join enrollments e on e.subject_id = c.id and e.subject_type = 'course' and e.cancelled_at is null
      ${f.scope ? sql`and e.user_id in (select up.user_id from user_placements up where up.is_primary and up.ended_at is null ${inScope(f.scope)})` : sql``}
    where c.deleted_at is null and c.status = 'published'
    group by c.id, c.title, c.updated_at, u.full_name order by completion_pct nulls last, assigned desc limit 300
  `)
  const yearAgo = new Date(Date.now() - 365 * 86_400_000)
  const attention = rows.filter(r => (r.assigned as number) >= 5 && ((r.completion_pct != null && Number(r.completion_pct) < 50) || new Date(String(r.updated_at)) < yearAgo || (r.rating != null && Number(r.rating) < 3)))
    .map(r => ({ id: r.id, title: r.title, reasons: [...(r.completion_pct != null && Number(r.completion_pct) < 50 ? ['completion'] : []), ...(new Date(String(r.updated_at)) < yearAgo ? ['stale'] : []), ...(r.rating != null && Number(r.rating) < 3 ? ['rating'] : [])] }))
  return { rows, attention }
}

// ── Активність (docs/22 §4.7): DAU/WAU/MAU, часы суток, без активности 30+ ──

export async function activityExtra(ctx: Ctx, f: Period = {}) {
  const scope = f.scope ?? null
  const sc = scope === null ? sql`` : sql`and s.user_id in (select up.user_id from user_placements up where up.is_primary and up.ended_at is null ${inScope(scope)})`
  const [summary] = await q(ctx, sql`
    select
      (select count(distinct s.user_id)::int from sessions s where s.created_at >= current_date ${sc}) as dau,
      (select count(distinct s.user_id)::int from sessions s where s.created_at >= current_date - 7 ${sc}) as wau,
      (select count(distinct s.user_id)::int from sessions s where s.created_at >= current_date - 30 ${sc}) as mau,
      (select count(*)::int from users u where u.status = 'active' and not u.is_hidden ${EMPLOYEES_ONLY()} and coalesce(u.last_seen_at, u.created_at) < now() - interval '30 days'
         ${scope === null ? sql`` : sql`and u.id in (select up.user_id from user_placements up where up.is_primary and up.ended_at is null ${inScope(scope)})`}) as inactive_30
  `)
  const hours = await q(ctx, sql`
    select extract(hour from (lp.first_opened_at at time zone coalesce(l.timezone, 'Europe/Kyiv')))::int as hour, count(*)::int as opens
    from lesson_progress lp join enrollments e on e.id = lp.enrollment_id
    left join user_placements up on up.user_id = e.user_id and up.is_primary and up.ended_at is null left join locations l on l.id = up.location_id
    where lp.first_opened_at >= current_date - 30 ${inScope(scope)}
    group by 1 order by 1
  `)
  return { ...summary, hours: Array.from({ length: 24 }, (_, h) => ({ hour: h, opens: Number(hours.find(x => Number(x.hour) === h)?.opens ?? 0) })) }
}

// ── Аттестации: разрез по вопросам (docs/22 §4.4) ─────────────────────

export async function failedQuestions(ctx: Ctx, f: Period = {}) {
  const { from, to } = defaultPeriod(f)
  return q(ctx, sql`
    select qs.id, qz.title as quiz, left(regexp_replace(coalesce((select string_agg(b->>'html', ' ') from jsonb_array_elements(qs.stem) b), ''), '<[^>]+>', ' ', 'g'), 160) as question,
           count(*)::int as answered, count(*) filter (where aa.is_correct = false)::int as failed,
           round(100.0 * count(*) filter (where aa.is_correct = false) / nullif(count(*), 0))::int as fail_pct
    from attempt_answers aa join attempts a on a.id = aa.attempt_id join questions qs on qs.id = aa.question_id join quizzes qz on qz.id = a.quiz_id
    left join user_placements up on up.user_id = a.user_id and up.is_primary and up.ended_at is null
    where a.submitted_at >= ${from}::date and a.submitted_at < (${to}::date + 1) and aa.is_correct is not null ${inScope(f.scope)}
    group by qs.id, qz.title, qs.stem having count(*) >= 3 order by fail_pct desc, failed desc limit 30
  `)
}

// ── Плитки со сравнением (docs/22 §3.2) ───────────────────────────────

export async function tiles(ctx: Ctx, report: string, f: Period = {}) {
  const { from, to } = defaultPeriod(f)
  const prev = previousPeriod(from, to)
  const scope = f.scope ?? null
  const one = async (a: string, b: string) => {
    const [r] = await q(ctx, sql`
      select
        (select count(*)::int from enrollments e left join user_placements up on up.user_id = e.user_id and up.is_primary and up.ended_at is null where e.status = 'done' and e.cancelled_at is null and e.completed_at >= ${a}::date and e.completed_at < (${b}::date + 1) ${inScope(scope)}) as completed,
        (select count(*)::int from enrollments e left join user_placements up on up.user_id = e.user_id and up.is_primary and up.ended_at is null where e.cancelled_at is null and e.status in ('not_started','in_progress') and e.due_at < now() and e.due_at >= ${a}::date and e.due_at < (${b}::date + 1) ${inScope(scope)}) as overdue,
        (select count(*)::int from attempts at left join user_placements up on up.user_id = at.user_id and up.is_primary and up.ended_at is null where at.submitted_at >= ${a}::date and at.submitted_at < (${b}::date + 1) ${inScope(scope)}) as attempts,
        (select count(*)::int from attempts at left join user_placements up on up.user_id = at.user_id and up.is_primary and up.ended_at is null where at.passed and at.attempt_no = 1 and at.submitted_at >= ${a}::date and at.submitted_at < (${b}::date + 1) ${inScope(scope)}) as passed_first,
        (select count(distinct s.user_id)::int from sessions s ${scope === null ? sql`` : sql`join user_placements up on up.user_id = s.user_id and up.is_primary and up.ended_at is null`} where s.created_at >= ${a}::date and s.created_at < (${b}::date + 1) ${inScope(scope)}) as active
    `)
    return r as Record<string, number>
  }
  const [cur, before] = await Promise.all([one(from, to), one(prev.from, prev.to)])
  const [snap] = await q(ctx, sql`
    select (select count(*)::int from users u where u.status = 'active' and not u.is_hidden ${EMPLOYEES_ONLY()}) as people,
           (select count(*)::int from certificates c where c.revoked_at is null and c.valid_until between now() and now() + interval '30 days') as certs_expiring,
           (select count(distinct e.user_id)::int from enrollments e join assignments a on a.id = e.assignment_id left join user_placements up on up.user_id = e.user_id and up.is_primary and up.ended_at is null where a.is_mandatory and e.cancelled_at is null and e.status in ('in_progress','not_started','failed') ${inScope(scope)}) as not_ready
  `)
  const cmp = (k: string) => ({ value: Number(cur[k] ?? 0), prev: Number(before[k] ?? 0), delta: Number(cur[k] ?? 0) - Number(before[k] ?? 0) })
  const byReport: Record<string, Record<string, unknown>> = {
    readiness: { people: snap!.people, notReady: snap!.not_ready, overdue: cmp('overdue'), certsExpiring: snap!.certs_expiring },
    overdue: { overdue: cmp('overdue'), completed: cmp('completed') },
    attempts: { attempts: cmp('attempts'), passedFirst: cmp('passed_first') },
    activity: { active: cmp('active'), completed: cmp('completed') },
    progress: { completed: cmp('completed'), overdue: cmp('overdue') },
  }
  return { period: { from, to }, previous: prev, ...(byReport[report] ?? { completed: cmp('completed') }) }
}

// ── Мої результати: компетенции (docs/22 §4.8) ────────────────────────

export async function myCompetencies(ctx: Ctx, userId: string) {
  const { currentLevels } = await import('./development')
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const levels = await currentLevels(tx, userId)
    if (!levels.size) return []
    const names = await tx.execute(sql`select id, name from competencies where id in ${[...levels.keys()]}`) as unknown as { id: string, name: string }[]
    return names.map(n => ({ id: n.id, name: n.name, ...levels.get(n.id)! }))
  })
}

// ── Історія навчання і рейтинг у кабінеті (docs/22 §13.5, docs/04 `/me/study-history`) ─

/**
 * Рейтинг — мінімальна формула `[решение]` (docs/28 «Spec 19»): повноцінних балів
 * (`points_ledger`, R3) ще немає, тому рахуємо кількість успішно виконаних призначень
 * (курс/програма/тест) наростаючим підсумком; «зовнішній» ряд — завершені заявки на
 * зовнішнє навчання (`19` §5, «зовнішні бали»). Історія охоплює ті самі типи, що й
 * `TASK_REPORT_TYPES` (`reportTasks.ts`) — інші типи не входять, це задокументований долг.
 */
export async function studyHistory(ctx: Ctx, userId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [profile] = await tx.execute(sql`
      select u.full_name, l.name as location, ou.name as org_unit, p.name as position
      from users u
      left join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null
      left join locations l on l.id = up.location_id
      left join org_units ou on ou.id = up.org_unit_id
      left join positions p on p.id = up.position_id
      where u.id = ${userId}::uuid
    `) as unknown as Row[]

    const mine = await tx.execute(sql`
      select 'course'::text as content_type, c.title, e.status, round(coalesce(e.score, e.progress_pct))::int as result_pct,
             coalesce(e.completed_at, e.updated_at) as at
      from enrollments e join courses c on c.id = e.subject_id
      where e.user_id = ${userId}::uuid and e.cancelled_at is null and e.status in ('done', 'failed')
      union all
      select 'training_program'::text, pr.title, e.status, e.progress_pct::int, coalesce(e.completed_at, e.updated_at)
      from program_enrollments e join programs pr on pr.id = e.program_id
      where e.user_id = ${userId}::uuid and e.cancelled_at is null and e.status in ('done', 'failed')
      union all
      select 'test'::text, q.title, case when a.passed then 'done' else 'failed' end, round(a.score)::int, coalesce(a.submitted_at, a.created_at)
      from attempts a join quizzes q on q.id = a.quiz_id
      where a.user_id = ${userId}::uuid and a.status <> 'in_progress'
        and a.id = (select id from attempts a2 where a2.user_id = a.user_id and a2.quiz_id = a.quiz_id and a2.status <> 'in_progress' order by a2.created_at desc limit 1)
      order by at desc limit 200
    `) as unknown as { content_type: string, title: string, status: string, result_pct: number | null, at: Date }[]

    const external = await tx.execute(sql`
      select title, decided_at as at from external_training_requests where user_id = ${userId}::uuid and status = 'completed' order by decided_at desc limit 200
    `) as unknown as { title: string, at: Date }[]

    const items = [
      ...mine.map(m => ({ title: m.title, contentType: m.content_type, status: m.status, resultPct: m.result_pct, date: m.at, external: false })),
      ...external.map(e => ({ title: e.title, contentType: 'external_learning', status: 'done', resultPct: null, date: e.at, external: true })),
    ].sort((a, b) => +new Date(b.date) - +new Date(a.date))

    const currentRating = mine.filter(m => m.status === 'done').length

    // Динаміка рейтингу — останні 8 місяців, наростаючим підсумком «мій» і «зовнішній» ряд.
    const months: string[] = []
    const now = new Date()
    for (let i = 7; i >= 0; i--) months.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7))
    const monthOf = (d: Date | string) => new Date(d).toISOString().slice(0, 7)
    let mineAcc = 0
    let extAcc = 0
    const series = months.map((period) => {
      mineAcc += mine.filter(m => m.status === 'done' && monthOf(m.at) === period).length
      extAcc += external.filter(e => monthOf(e.at) === period).length
      return { period, mine: mineAcc, external: extAcc }
    })

    return { profile: profile ?? null, currentRating, series, items }
  })
}

// ── Недельный дайджест руководителю (docs/22 §8, §10 digest.weekly) ──

/** Понедельник: каждому руководителю точки — три числа и три ссылки. */
export async function weeklyDigest(tenantId: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const managers = await tx.execute(sql`select distinct l.manager_id, l.id as location_id, l.name from locations l where l.manager_id is not null and l.is_active`) as unknown as { manager_id: string, location_id: string, name: string }[]
    let n = 0
    const week = new Date().toISOString().slice(0, 10)
    for (const m of managers) {
      const [s] = await tx.execute(sql`
        select
          (select count(*)::int from enrollments e join user_placements up on up.user_id = e.user_id and up.is_primary and up.ended_at is null where up.location_id = ${m.location_id}::uuid and e.status = 'done' and e.cancelled_at is null and e.completed_at >= current_date - 7) as completed,
          (select count(*)::int from enrollments e join user_placements up on up.user_id = e.user_id and up.is_primary and up.ended_at is null where up.location_id = ${m.location_id}::uuid and e.cancelled_at is null and e.status in ('not_started','in_progress') and e.due_at < now()) as overdue,
          (select count(*)::int from enrollments e join user_placements up on up.user_id = e.user_id and up.is_primary and up.ended_at is null where up.location_id = ${m.location_id}::uuid and e.created_at >= current_date - 7) as assigned
      `) as unknown as { completed: number, overdue: number, assigned: number }[]
      if (await enqueueNotification(tx, { tenantId, userId: m.manager_id, code: 'weekly_digest', payload: { location: m.name, completed: s!.completed, overdue: s!.overdue, assigned: s!.assigned }, dedupKey: `digest:${m.location_id}:${week}` })) n++
    }
    return n
  })
}
