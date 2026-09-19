import { desc, eq, sql } from 'drizzle-orm'
import { savedReports, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { enqueueNotification } from './notifications'
import { toXlsx } from './reports'

interface Ctx { tenantId: string, actorId: string }

/**
 * Конструктор сводных отчётов (docs/03 §3.26): сущность → поля → фильтры → группировка,
 * сохранение под именем, расписание с отправкой в Telegram/на почту.
 * Поля — только из белого списка: SQL собирается из известных колонок, не из ввода.
 */
export const ENTITIES = {
  people: {
    from: sql`users u left join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null left join locations l on l.id = up.location_id left join positions p on p.id = up.position_id`,
    fields: {
      full_name: sql`u.full_name`, phone: sql`u.phone`, status: sql`u.status`, hired_at: sql`u.hired_at`, location: sql`l.name`, position: sql`p.name`,
      courses_done: sql`(select count(*) from enrollments e where e.user_id = u.id and e.status = 'done' and e.cancelled_at is null)`,
      courses_overdue: sql`(select count(*) from enrollments e where e.user_id = u.id and e.cancelled_at is null and e.status in ('not_started','in_progress') and e.due_at < now())`,
    },
    filters: { location_id: sql`up.location_id`, position_id: sql`up.position_id`, status: sql`u.status`, hired_from: sql`u.hired_at`, hired_to: sql`u.hired_at` },
    tenantCol: sql`u.tenant_id`,
  },
  enrollments: {
    from: sql`enrollments e join users u on u.id = e.user_id join courses c on c.id = e.subject_id left join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null left join locations l on l.id = up.location_id`,
    // Пять статусов + признаки: overdue (due_at < now при незавершённом), cancelled_at (снято)
    fields: { full_name: sql`u.full_name`, course: sql`c.title`, status: sql`e.status`, overdue: sql`(e.cancelled_at is null and e.status in ('not_started','in_progress') and e.due_at < now())`, cancelled_at: sql`e.cancelled_at`, progress_pct: sql`e.progress_pct`, due_at: sql`e.due_at`, completed_at: sql`e.completed_at`, location: sql`l.name`, source: sql`e.source` },
    filters: { location_id: sql`up.location_id`, course_id: sql`e.subject_id`, status: sql`e.status`, due_from: sql`e.due_at`, due_to: sql`e.due_at` },
    tenantCol: sql`e.tenant_id`,
  },
  attempts: {
    from: sql`attempts a join users u on u.id = a.user_id join quizzes q on q.id = a.quiz_id left join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null left join locations l on l.id = up.location_id`,
    fields: { full_name: sql`u.full_name`, quiz: sql`q.title`, attempt_no: sql`a.attempt_no`, status: sql`a.status`, score: sql`a.score`, passed: sql`a.passed`, started_at: sql`a.started_at`, finished_at: sql`a.finished_at`, location: sql`l.name` },
    filters: { location_id: sql`up.location_id`, quiz_id: sql`a.quiz_id`, status: sql`a.status`, from: sql`a.started_at`, to: sql`a.started_at` },
    tenantCol: sql`a.tenant_id`,
  },
} as const

export type Entity = keyof typeof ENTITIES

export function describeEntities() {
  return Object.fromEntries(Object.entries(ENTITIES).map(([k, v]) => [k, { fields: Object.keys(v.fields), filters: Object.keys(v.filters) }]))
}

export interface ReportSpec { entity: Entity, fields: string[], filters?: Record<string, unknown>, groupBy?: string | null }

/** Выполнение: при groupBy — количество строк и средние по числовым полям в группе. */
export async function runReport(ctx: Ctx, spec: ReportSpec, limit = 2000, scope: string[] | null = null): Promise<Record<string, unknown>[]> {
  const ent = ENTITIES[spec.entity]
  if (!ent) return []
  const fields = spec.fields.filter(f => f in ent.fields)
  if (!fields.length) return []
  const where: ReturnType<typeof sql>[] = []
  for (const [k, v] of Object.entries(spec.filters ?? {})) {
    if (v === undefined || v === null || v === '' || !(k in ent.filters)) continue
    const col = (ent.filters as Record<string, ReturnType<typeof sql>>)[k]!
    if (k.endsWith('_from') || k === 'from') where.push(sql`${col} >= ${String(v)}::timestamptz`)
    else if (k.endsWith('_to') || k === 'to') where.push(sql`${col} < (${String(v)}::date + 1)`)
    else if (Array.isArray(v)) where.push(sql`${col}::text in (${sql.join(v.map(x => sql`${String(x)}`), sql`, `)})`)
    else where.push(sql`${col}::text = ${String(v)}`)
  }
  // Область видимости (docs/22 §7.1): применяется до фильтров, расширить параметром нельзя
  if (scope !== null) where.push(scope.length ? sql`up.location_id in (${sql.join(scope.map(id => sql`${id}::uuid`), sql`, `)})` : sql`false`)
  const whereSql = where.length ? sql`where ${sql.join(where, sql` and `)}` : sql``
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const F = ent.fields as Record<string, ReturnType<typeof sql>>
    if (spec.groupBy && spec.groupBy in ent.fields) {
      const g = F[spec.groupBy]!
      const numeric = fields.filter(f => f !== spec.groupBy && /(_pct|score|_done|_overdue|attempt_no)$/.test(f))
      const aggs = numeric.map(f => sql`round(avg((${F[f]!})::numeric), 2) as ${sql.identifier(`avg_${f}`)}`)
      return tx.execute(sql`select ${g} as ${sql.identifier(spec.groupBy)}, count(*)::int as rows${aggs.length ? sql`, ${sql.join(aggs, sql`, `)}` : sql``} from ${ent.from} ${whereSql} group by 1 order by 2 desc limit ${limit}`) as unknown as Record<string, unknown>[]
    }
    const cols = fields.map(f => sql`${F[f]!} as ${sql.identifier(f)}`)
    return tx.execute(sql`select ${sql.join(cols, sql`, `)} from ${ent.from} ${whereSql} order by 1 limit ${limit}`) as unknown as Record<string, unknown>[]
  })
}

export async function listSaved(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, tx => tx.select({ id: savedReports.id, name: savedReports.name, entity: savedReports.entity, fields: savedReports.fields, filters: savedReports.filters, groupBy: savedReports.groupBy, schedule: savedReports.schedule, lastRunAt: savedReports.lastRunAt, createdAt: savedReports.createdAt, author: users.fullName })
    .from(savedReports).leftJoin(users, eq(users.id, savedReports.createdBy)).orderBy(desc(savedReports.createdAt)))
}

export interface Schedule { every: 'daily' | 'weekly', hour: number, weekday?: number, channel: 'telegram' | 'email', recipients: string[] }

export async function saveReport(ctx: Ctx, input: { id?: string, name: string, spec: ReportSpec, schedule?: Schedule | null }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const values = { name: input.name, entity: input.spec.entity, fields: input.spec.fields, filters: input.spec.filters ?? {}, groupBy: input.spec.groupBy ?? null, schedule: input.schedule ?? null }
    if (input.id) {
      const [r] = await tx.update(savedReports).set({ ...values, updatedAt: new Date() }).where(eq(savedReports.id, input.id)).returning()
      return r ?? null
    }
    const [r] = await tx.insert(savedReports).values({ tenantId: ctx.tenantId, createdBy: ctx.actorId, ...values }).returning()
    return r!
  })
}

export async function deleteSaved(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => (await tx.delete(savedReports).where(eq(savedReports.id, id)).returning({ id: savedReports.id })).length > 0)
}

export async function savedToXlsx(ctx: Ctx, id: string, scope: string[] | null = null): Promise<{ name: string, buffer: Buffer } | null> {
  const [r] = await withTenant(ctx.tenantId, ctx.actorId, tx => tx.select().from(savedReports).where(eq(savedReports.id, id)))
  if (!r) return null
  const rows = await runReport(ctx, { entity: r.entity as Entity, fields: r.fields, filters: r.filters as Record<string, unknown>, groupBy: r.groupBy }, 2000, scope)
  return { name: r.name, buffer: await toXlsx(r.name, rows as never) }
}

/** Ежечасно: отчёты по расписанию — получателям уходит уведомление со сводкой и ссылкой на xlsx. */
export async function scheduledReportsScan(tenantId: string, now = new Date()): Promise<number> {
  const kyivHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: 'numeric', hour12: false }).format(now))
  const kyivWeekday = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Kyiv' })).getDay()
  const day = now.toISOString().slice(0, 10)
  let n = 0
  const reports = await withTenant(tenantId, null, tx => tx.select().from(savedReports).where(sql`${savedReports.schedule} is not null`))
  for (const r of reports) {
    const s = r.schedule as Schedule
    if (s.hour !== kyivHour) continue
    if (s.every === 'weekly' && (s.weekday ?? 1) !== kyivWeekday) continue
    if (r.lastRunAt && r.lastRunAt.toISOString().slice(0, 10) === day) continue
    const rows = await runReport({ tenantId, actorId: r.createdBy ?? '' }, { entity: r.entity as Entity, fields: r.fields, filters: r.filters as Record<string, unknown>, groupBy: r.groupBy }, 50)
    await withTenant(tenantId, null, async (tx) => {
      for (const uid of s.recipients) {
        await enqueueNotification(tx, { tenantId, userId: uid, code: 'scheduled_report', channel: s.channel, payload: { name: r.name, rows: rows.length, url: `/admin/reports/builder?saved=${r.id}` }, dedupKey: `rep:${r.id}:${uid}:${day}` })
      }
      await tx.update(savedReports).set({ lastRunAt: now }).where(eq(savedReports.id, r.id))
    })
    n++
  }
  return n
}
