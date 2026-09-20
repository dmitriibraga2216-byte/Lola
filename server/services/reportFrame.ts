import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { PassContext, ReportFilter } from '../../shared/schemas/reports'
import { FRAME_COLUMNS } from '../../shared/schemas/reports'
import { scopeSql } from './access'

/**
 * Единый каркас отчётов и журналов (docs/22 §13.3, §13.4; CLAUDE.md «Отчёт или журнал»).
 * Левая часть у всех отчётов «по предмету», сквозных отчётов и журналов одна и та же:
 * ПІБ · Посада · Місто · Підрозділ · Мітки · Дата призначення · Дата завершення · Поточний статус · Результат.
 * Здесь — SQL-фрагменты, которые каждый отчёт и журнал подставляет в свой запрос: выбор человека
 * с основным размещением (`frameSelect`/`frameJoins`), фильтры каркаса (`frameWhere`) и
 * «контекст проходження» (Г-22.1: самостійне призначення · у складі курсу · у складі програми або траєкторії).
 *
 * Соглашение: в запросе таблица людей имеет алиас `u`; каркас добавляет `pl` (размещение), `p`, `l`, `ou`, `ci`.
 */

export { FRAME_COLUMNS }

/** Колонки человека: ПІБ (со статусом), посада, місто, підрозділ, точка, мітки. */
export function frameSelect(): SQL {
  return sql`u.id as user_id, u.full_name, u.status as user_status, p.name as position, ci.name as city, ou.name as unit, l.name as location, coalesce(u.tags, '{}'::text[]) as tags`
}

/** Хвост каркаса — четыре колонки, которые считает конкретный отчёт. */
export function frameTail(c: { assignedAt: SQL, completedAt: SQL, status: SQL, result: SQL }): SQL {
  return sql`${c.assignedAt} as assigned_at, ${c.completedAt} as completed_at, ${c.status} as status, ${c.result} as result`
}

/** Основное размещение человека (открытое, is_primary первым) и справочники к нему. `u` уже должен быть в запросе. */
export function frameJoins(): SQL {
  return sql`
    left join lateral (
      select up.position_id, up.location_id, up.org_unit_id, up.city_id
      from user_placements up
      where up.user_id = u.id and up.ended_at is null
      order by up.is_primary desc, up.started_at desc limit 1
    ) pl on true
    left join positions p on p.id = pl.position_id
    left join locations l on l.id = pl.location_id
    left join org_units ou on ou.id = coalesce(pl.org_unit_id, l.org_unit_id)
    left join cities ci on ci.id = coalesce(pl.city_id, l.city_id, u.city_id)`
}

type FrameFilter = Partial<Pick<ReportFilter, 'positionIds' | 'orgUnitId' | 'tags' | 'includeArchived' | 'q'>> & { scope?: string[] | null }

/**
 * Фильтры каркаса (docs/22 §3, §7.1, §7.5): область видимости применяется всегда и первой,
 * архивированные исключены по умолчанию, посада/підрозділ/мітки/пошук — по запросу.
 */
export function frameWhere(f: FrameFilter = {}): SQL {
  return sql`
    ${scopeSql(f.scope ?? null, sql`pl.location_id`)}
    ${f.includeArchived ? sql`` : sql`and u.status <> 'archived'`}
    ${f.positionIds?.length ? sql`and pl.position_id in ${f.positionIds}` : sql``}
    ${f.orgUnitId ? sql`and coalesce(pl.org_unit_id, l.org_unit_id) in (select id from org_units where path <@ (select path from org_units where id = ${f.orgUnitId}::uuid))` : sql``}
    ${f.tags?.length ? sql`and u.tags && array[${sql.join(f.tags.map(t => sql`${t}::text`), sql`, `)}]::text[]` : sql``}
    ${f.q ? sql`and u.full_name ilike ${`%${f.q}%`}` : sql``}`
}

/** Период по колонке даты: `[from, to]` включительно, по датам. */
export function periodSql(col: SQL, f: { from?: string, to?: string }): SQL {
  return sql`${f.from ? sql`and ${col} >= ${f.from}::date` : sql``} ${f.to ? sql`and ${col} < (${f.to}::date + 1)` : sql``}`
}

/**
 * Контекст проходження (Г-22.1). Для записи на курс (`e`): у складі програми або траєкторії —
 * назначение узла траектории или узел программы ссылается на эту запись; «у складі курсу» — не бывает.
 * Для попытки теста (`at`): у складі курсу — попытка из урока; у складі програми — через запись курса
 * или назначение траектории; остальное — самостійне призначення.
 */
export function passContextParts(kind: 'enrollment' | 'attempt', contextId?: string): { inCourse: SQL, inProgram: SQL, title: SQL } {
  const enrollmentCol = kind === 'enrollment' ? sql`e.id` : sql`at.enrollment_id`
  const assignmentCol = kind === 'enrollment' ? sql`e.assignment_id` : sql`at.assignment_id`
  const programNode = sql`select pe.program_id from program_enrollments pe, jsonb_each(pe.nodes_state) ns where ns.value->>'enrollmentId' = ${enrollmentCol}::text ${contextId ? sql`and pe.program_id = ${contextId}::uuid` : sql``}`
  const trajectoryTask = sql`select tj.id from assignments ax join trajectories tj on tj.id = (ax.audience->>'trajectoryId')::uuid where ax.id = ${assignmentCol} and ax.kind = 'trajectory' ${contextId ? sql`and tj.id = ${contextId}::uuid` : sql``}`
  const inProgram = sql`(exists (${programNode}) or exists (${trajectoryTask}))`
  const inCourse = kind === 'attempt'
    ? sql`(at.lesson_id is not null ${contextId ? sql`and exists (select 1 from enrollments ce where ce.id = at.enrollment_id and ce.subject_id = ${contextId}::uuid)` : sql``})`
    : sql`false`
  const title = kind === 'attempt'
    ? sql`coalesce((select c.title from enrollments ce join courses c on c.id = ce.subject_id where ce.id = at.enrollment_id and at.lesson_id is not null), (select pr.title from programs pr where pr.id = (${programNode} limit 1)), (select tj.title from trajectories tj where tj.id = (${trajectoryTask} limit 1)), (select ax.title from assignments ax where ax.id = at.assignment_id))`
    : sql`coalesce((select pr.title from programs pr where pr.id = (${programNode} limit 1)), (select tj.title from trajectories tj where tj.id = (${trajectoryTask} limit 1)), (select ax.title from assignments ax where ax.id = e.assignment_id))`
  return { inCourse, inProgram, title }
}

/** Колонки `context`, `context_title` — из какого назначения, курса или программы пришло прохождение. */
export function passContextSelect(kind: 'enrollment' | 'attempt'): SQL {
  const p = passContextParts(kind)
  return sql`case when ${p.inCourse} then 'in_course' when ${p.inProgram} then 'in_program' else 'standalone' end as context, ${p.title} as context_title`
}

/** Условие фильтра «Контекст проходження»; `any` — без ограничения. */
export function passContextWhere(kind: 'enrollment' | 'attempt', context: PassContext | undefined, contextId?: string): SQL {
  if (!context || context === 'any') return sql``
  const p = passContextParts(kind, contextId)
  switch (context) {
    case 'in_course': return sql`and ${p.inCourse}`
    case 'in_program': return sql`and ${p.inProgram}`
    case 'standalone': return sql`and not ${p.inCourse} and not ${p.inProgram}`
  }
}

/** Ключи каркаса в строке ответа — чтобы отчёты и журналы можно было сверить тестом. */
export const FRAME_KEYS = ['user_id', 'full_name', 'user_status', 'position', 'city', 'unit', 'location', 'tags', 'assigned_at', 'completed_at', 'status', 'result'] as const

/** Строки для выгрузки: колонки каркаса — первыми, в порядке `FRAME_COLUMNS`, затем остальное. */
export function frameFirst<T extends Record<string, unknown>>(rows: T[]): Record<string, unknown>[] {
  return rows.map((r) => {
    const out: Record<string, unknown> = {}
    for (const k of FRAME_COLUMNS) if (k in r) out[k] = Array.isArray(r[k]) ? (r[k] as unknown[]).join(', ') : r[k]
    for (const [k, v] of Object.entries(r)) if (!(k in out) && !['user_id', 'user_status', 'location'].includes(k)) out[k] = Array.isArray(v) ? v.join(', ') : typeof v === 'object' && v !== null && !(v instanceof Date) ? JSON.stringify(v) : v
    return out
  })
}
