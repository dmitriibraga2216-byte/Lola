import { and, isNull, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { enrollments } from '../db/schema'

/**
 * Пять статусов прохождения (CLAUDE.md п. 12, docs/02 enrollment_status):
 * not_assigned | not_started | in_progress | done | failed. Всё остальное — признаки строки:
 *   «заплановано»   — starts_at > now();
 *   «протерміновано» — due_at < now() и статус не done;
 *   автозакрытие по сроку — failed + expired_at;
 *   снятие назначения — cancelled_at (статус замораживается, строка исчезает из списков и отчётов).
 * Пять групп экрана «Мої завдання» (docs/04 §4.4, docs/10 Г-10.3) считаются отсюда же.
 */
export type TaskGroup = 'new' | 'planned' | 'failed' | 'overdue' | 'done'
export const TASK_GROUPS: TaskGroup[] = ['new', 'planned', 'failed', 'overdue', 'done']

type EnrollmentCols = { status: typeof enrollments.status, startsAt: typeof enrollments.startsAt, dueAt: typeof enrollments.dueAt, cancelledAt: typeof enrollments.cancelledAt }

/** Строка живая: назначение не снято. */
export function notCancelled(e: Pick<EnrollmentCols, 'cancelledAt'> = enrollments): SQL {
  return isNull(e.cancelledAt)
}

/** Условие группы «Мої завдання». «Нові» = не розпочато або в процесі, без прострочення і не заплановане. */
export function taskGroupWhere(group: TaskGroup, e: EnrollmentCols = enrollments): SQL {
  const planned = sql`${e.startsAt} is not null and ${e.startsAt} > now()`
  const overdue = sql`${e.dueAt} is not null and ${e.dueAt} < now()`
  switch (group) {
    case 'planned': return and(notCancelled(e), sql`${e.status} in ('not_started', 'in_progress')`, planned)!
    case 'failed': return and(notCancelled(e), sql`${e.status} = 'failed'`)!
    case 'overdue': return and(notCancelled(e), sql`${e.status} in ('not_started', 'in_progress')`, overdue)!
    case 'done': return and(notCancelled(e), sql`${e.status} = 'done'`)!
    case 'new':
    default:
      return and(notCancelled(e), sql`${e.status} in ('not_started', 'in_progress')`, sql`not (${planned})`, sql`not (${overdue})`)!
  }
}

/** SQL-условие «протерміновано» для count/filter: открытая, не снятая, срок прошёл. */
export function overdueSql(e: EnrollmentCols = enrollments): SQL {
  return sql`${e.cancelledAt} is null and ${e.status} in ('not_started', 'in_progress') and ${e.dueAt} is not null and ${e.dueAt} < now()`
}

/** Производное состояние строки для интерфейса и отчётов: статус + признаки. */
export function deriveTaskState(row: { status: string, startsAt?: Date | string | null, dueAt?: Date | string | null, cancelledAt?: Date | string | null, expiredAt?: Date | string | null }) {
  const now = Date.now()
  const startsAt = row.startsAt ? +new Date(row.startsAt) : null
  const dueAt = row.dueAt ? +new Date(row.dueAt) : null
  const open = row.status === 'not_started' || row.status === 'in_progress'
  return {
    status: row.status,
    cancelled: !!row.cancelledAt,
    planned: open && startsAt != null && startsAt > now,
    overdue: open && dueAt != null && dueAt < now,
    autoClosed: row.status === 'failed' && !!row.expiredAt,
    group: (row.status === 'done' ? 'done' : row.status === 'failed' ? 'failed' : open && startsAt != null && startsAt > now ? 'planned' : open && dueAt != null && dueAt < now ? 'overdue' : 'new') as TaskGroup,
  }
}
