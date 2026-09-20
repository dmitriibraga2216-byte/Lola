import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import type { SummaryReportInput } from '../../shared/schemas/reports'
import { frameFirst, frameJoins, frameSelect, frameWhere, periodSql } from './reportFrame'

interface Ctx { tenantId: string, actorId: string }
type Row = Record<string, unknown>
type Input = SummaryReportInput & { scope?: string[] | null }

/**
 * Зведений звіт — мастер (docs/22 §13.1, docs/04 `/reports/summary`): Користувачі → Завдання → Конфігурація → Результат.
 * Отчёт строится пересечением двух выборок — людей и заданий, а не «по курсу». Каждый шаг считается
 * на сервере по текущему состоянию мастера, ничего не сохраняется: шаг `users` — сколько людей попало
 * и первые строки каркаса, шаг `tasks` — назначения с числом назначенных, шаг `result` — таблица людей
 * (каркас) с колонкой на каждое задание и группировка по конфигурации.
 */

const MAX_TASKS = 50

function usersSql(f: Input, limit: number): SQL {
  const uf = f.userFilter
  return sql`
    select ${frameSelect()}, u.created_at as registered_at
    from users u ${frameJoins()}
    where u.status <> 'invited' ${frameWhere({ ...uf, scope: f.scope })}
      ${uf.locationIds?.length ? sql`and pl.location_id in ${uf.locationIds}` : sql``}
      ${uf.userIds?.length ? sql`and u.id in ${uf.userIds}` : sql``}
      ${uf.orgUnitIds?.length ? sql`and coalesce(pl.org_unit_id, l.org_unit_id) in (select id from org_units where path <@ any(array(select path from org_units where id in ${uf.orgUnitIds})))` : sql``}
    order by u.full_name limit ${limit}`
}

async function tasksSql(tx: TenantTx, f: Input, limit: number): Promise<Row[]> {
  const tf = f.taskFilter
  return tx.execute(sql`
    select a.id, a.title, a.subject_type as content_type, a.subject_id, a.kind, a.created_at, a.status,
           coalesce((a.stats->>'assigned')::int, (select count(*) from enrollments e where e.assignment_id = a.id and e.cancelled_at is null)::int, 0) as assigned
    from assignments a
    where a.status in ('active', 'paused', 'archived')
      ${tf.assignmentIds?.length ? sql`and a.id in ${tf.assignmentIds}` : sql``}
      ${tf.contentTypes?.length ? sql`and a.subject_type in ${tf.contentTypes}` : sql``}
      ${tf.q ? sql`and a.title ilike ${`%${tf.q}%`}` : sql``}
      ${periodSql(sql`a.created_at`, tf)}
    order by a.created_at desc limit ${limit}`) as unknown as Promise<Row[]>
}

/** Прохождения выбранных людей по выбранным заданиям: курс — записи, программа — записи программы, тест — попытки. */
async function cells(tx: TenantTx, userIds: string[], tasks: Row[]): Promise<Row[]> {
  if (!userIds.length || !tasks.length) return []
  const ids = tasks.map(t => String(t.id))
  return tx.execute(sql`
    select e.user_id, e.assignment_id, e.status, round(coalesce(e.score, e.progress_pct))::int as result, e.created_at as assigned_at, e.completed_at, e.due_at, null::int as attempts
    from enrollments e where e.cancelled_at is null and e.assignment_id in ${ids} and e.user_id in ${userIds}
    union all
    select pe.user_id, pe.assignment_id, pe.status, pe.progress_pct::int, pe.created_at, pe.completed_at, pe.due_at, null::int
    from program_enrollments pe where pe.cancelled_at is null and pe.assignment_id in ${ids} and pe.user_id in ${userIds}
    union all
    select at.user_id, at.assignment_id,
           case when bool_or(at.passed) then 'done' when bool_or(at.status in ('failed', 'expired')) then 'failed' else 'in_progress' end,
           max(round(at.score))::int,
           min(at.created_at), max(at.submitted_at) filter (where at.passed), null::timestamptz,
           count(*) filter (where at.status <> 'in_progress')::int
    from attempts at where at.assignment_id in ${ids} and at.user_id in ${userIds}
    group by at.user_id, at.assignment_id`) as unknown as Promise<Row[]>
}

export async function summaryReport(ctx: Ctx, f: Input) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    if (f.step === 'users') {
      const rows = await tx.execute(usersSql(f, f.limit ?? 100)) as unknown as Row[]
      const [c] = await tx.execute(sql`select count(*)::int as n from (${usersSql(f, 100_000)}) x`) as unknown as { n: number }[]
      return { step: 'users' as const, count: Number(c?.n ?? 0), rows }
    }
    if (f.step === 'tasks') {
      const rows = await tasksSql(tx, f, f.limit ?? 200)
      return { step: 'tasks' as const, count: rows.length, rows }
    }
    const people = await tx.execute(usersSql(f, f.limit ?? 5000)) as unknown as Row[]
    const tasks = await tasksSql(tx, f, MAX_TASKS)
    const got = await cells(tx, people.map(p => String(p.user_id)), tasks)
    const byUser = new Map<string, Row[]>()
    for (const c of got) { const k = String(c.user_id); byUser.set(k, [...(byUser.get(k) ?? []), c]) }
    const rows: Row[] = people.map((p) => {
      const mine = byUser.get(String(p.user_id)) ?? []
      const perTask: Record<string, Row> = {}
      for (const t of tasks) {
        const c = mine.find(x => String(x.assignment_id) === String(t.id))
        // Пять статусов (CLAUDE.md п. 12): нет записи по заданию — «не призначено», не «не розпочато»
        perTask[String(t.id)] = c
          ? Object.fromEntries(Object.entries({ status: c.status, result: c.result, assigned_at: c.assigned_at, completed_at: c.completed_at, due_at: c.due_at, attempts: c.attempts }).filter(([k]) => f.columns.includes(k as never)))
          : { status: 'not_assigned' }
      }
      const done = mine.filter(c => c.status === 'done').length
      return { ...p, tasks: perTask, done, total: tasks.length, status: mine.length === 0 ? 'not_assigned' : done === tasks.length ? 'done' : mine.some(c => c.status === 'failed') ? 'failed' : mine.some(c => c.status === 'in_progress' || c.status === 'done') ? 'in_progress' : 'not_started', result: tasks.length ? Math.round(done / tasks.length * 100) : null, assigned_at: mine.map(c => c.assigned_at).filter(Boolean).sort()[0] ?? null, completed_at: done === tasks.length && tasks.length ? mine.map(c => c.completed_at).filter(Boolean).sort().at(-1) ?? null : null }
    })
    // Группировка (шаг «Конфігурація»): по точке, посаде, підрозділу или заданию — счётчики статусов
    const groups: { key: string, label: string, total: number, done: number, inProgress: number, failed: number, notStarted: number, notAssigned: number }[] = []
    if (f.groupBy !== 'none') {
      const acc = new Map<string, typeof groups[number]>()
      const add = (key: string, label: string, status: unknown) => {
        const g = acc.get(key) ?? { key, label, total: 0, done: 0, inProgress: 0, failed: 0, notStarted: 0, notAssigned: 0 }
        g.total++
        if (status === 'done') g.done++
        else if (status === 'in_progress') g.inProgress++
        else if (status === 'failed') g.failed++
        else if (status === 'not_started') g.notStarted++
        else g.notAssigned++
        acc.set(key, g)
      }
      for (const r of rows) {
        if (f.groupBy === 'task') for (const t of tasks) add(String(t.id), String(t.title), (r.tasks as Record<string, Row>)[String(t.id)]?.status)
        else { const label = String(r[f.groupBy] ?? '—'); add(label, label, r.status) }
      }
      groups.push(...[...acc.values()].sort((a, b) => a.label.localeCompare(b.label, 'uk')))
    }
    return { step: 'result' as const, people: people.length, tasks: tasks.map(t => ({ id: String(t.id), title: String(t.title), contentType: String(t.content_type), assigned: Number(t.assigned) })), columns: f.columns, groupBy: f.groupBy, rows, groups }
  })
}

/** Строки выгрузки: каркас первым, затем по колонке на задание («Назва · статус · результат»). */
export async function summaryRows(ctx: Ctx, f: Input): Promise<Row[]> {
  const r = await summaryReport(ctx, { ...f, step: 'result' })
  if (r.step !== 'result') return []
  return frameFirst(r.rows.map(({ tasks, done: _d, total: _t, registered_at: _r, ...rest }) => {
    const out: Row = { ...rest }
    for (const t of r.tasks) {
      const c = (tasks as Record<string, Row>)[t.id] ?? {}
      out[`${t.title} · статус`] = c.status ?? 'not_assigned'
      if (f.columns.includes('result')) out[`${t.title} · результат`] = c.result ?? null
    }
    return out
  }))
}
