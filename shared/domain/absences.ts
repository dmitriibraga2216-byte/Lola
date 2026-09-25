import { ABSENCE_LIMITS } from '../enums'
import type { AbsenceStatus } from '../enums'
import { daysBetween } from './personRecords'
import type { IsoDate } from './personRecords'

/**
 * Правила отсутствий человека (docs/v2/38-people-extensions.md §3.6, §4, §7.12–7.14; PR-33) —
 * чистые функции над календарными датами `YYYY-MM-DD`, одни для сервера, формы и тестов.
 *
 * Lola не ведёт кадровый учёт (§7.12): дни здесь **календарные**, производственного календаря
 * нет. Единственное место, где различаются будни и выходные, — «первый рабочий день после
 * возвращения» (§7.14): суббота и воскресенье не рабочие, как у срока починки жалобы (`36` §7.6).
 */

export interface DateRange { dateFrom: IsoDate, dateTo: IsoDate }

/** `date + days` календарно. */
export function addDays(date: IsoDate, days: number): IsoDate {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

/** Календарные дни диапазона включительно (`days_count`, §7.13). */
export function absenceDays(from: IsoDate, to: IsoDate): number {
  return daysBetween(from, to) + 1
}

/** Сколько дней диапазона приходится на календарный год: частично попавший период — пересечением (§7.13). */
export function daysInYear(from: IsoDate, to: IsoDate, year: number): number {
  const first = `${String(year).padStart(4, '0')}-01-01`
  const last = `${String(year).padStart(4, '0')}-12-31`
  const a = from > first ? from : first
  const b = to < last ? to : last
  return a > b ? 0 : absenceDays(a, b)
}

export type AbsenceRangeError = 'order' | 'too_long'

/** «Період»: конец не раньше начала, не длиннее `ABSENCE_LIMITS.maxRangeDays` (§6.4). */
export function validateAbsenceRange(from: IsoDate, to: IsoDate): AbsenceRangeError | null {
  if (to < from) return 'order'
  if (absenceDays(from, to) > ABSENCE_LIMITS.maxRangeDays) return 'too_long'
  return null
}

/** Пересекаются ли периоды (границы включительно): §6.4 «Відсутність перетинається з наявним записом». */
export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  return a.dateFrom <= b.dateTo && b.dateFrom <= a.dateTo
}

const NEXT_STATUS: Record<AbsenceStatus, readonly AbsenceStatus[]> = {
  planned: ['approved', 'cancelled'],
  approved: ['cancelled'],
  cancelled: [],
}

/**
 * Переход состояния записи (§4: `planned → approved → cancelled`). Обратно не ходят: отменённая
 * запись конечна, подтверждённая не становится снова «заплановано» — иначе остаток (он считает
 * только `approved`) молча менялся бы задним числом.
 */
export function absenceTransitionAllowed(from: AbsenceStatus, to: AbsenceStatus): boolean {
  return from === to || NEXT_STATUS[from].includes(to)
}

/** Остаток нормы (§7.13): может быть отрицательным — показывается красным, не обрезается (§7.14). */
export function remainingDays(norm: number, used: number): number {
  return Math.round((norm - used) * 10) / 10
}

/** Первый рабочий день начиная с `date` включительно: суббота и воскресенье переносятся на понедельник. */
export function firstWorkingDayFrom(date: IsoDate): IsoDate {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
  return weekday === 6 ? addDays(date, 2) : weekday === 0 ? addDays(date, 1) : date
}

/**
 * Последний день отсутствия, которое покрывает `date`, **с учётом смыкающихся записей**:
 * отпуск 10–20 и сразу за ним больничный 21–25 — человек вернётся 26-го, а не 21-го.
 * `null` — дата не покрыта ни одной записью.
 */
export function absentThrough(date: IsoDate, ranges: readonly DateRange[]): IsoDate | null {
  let end: IsoDate | null = null
  let cursor = date
  // Курсор строго растёт, записей конечное число — цикл конечен; предел — страховка от мусора
  for (let step = 0; step < 1000; step++) {
    const covering = ranges.filter(r => r.dateFrom <= cursor && cursor <= r.dateTo)
    if (!covering.length) break
    end = covering.reduce((max, r) => (r.dateTo > max ? r.dateTo : max), covering[0]!.dateTo)
    cursor = addDays(end, 1)
  }
  return end
}

export interface DeadlinePlanInput {
  /** Местная дата срока записи. */
  due: IsoDate
  /** Местная дата старта записи (`starts_at`, иначе создания). */
  start: IsoDate | null
  /** Можно ли сдвинуть старт: запись ещё не начата. Начатую не переводим в «Заплановано». */
  movableStart: boolean
  /** Срок назначения «N днів з моменту призначення» (docs/15 §7.4), иначе null. */
  relativeDays: number | null
  /** Отсутствия человека, блокирующие дедлайн: `planned` и `approved` (§4). */
  absences: readonly DateRange[]
}

export interface DeadlinePlan {
  due: IsoDate
  /** Новая дата старта — только если весь срок прохождения попал в отсутствие; иначе null. */
  start: IsoDate | null
}

/**
 * Сдвиг срока обязательного назначения из-за отсутствия (§7.14). `null` — срок не покрыт.
 *
 * - Срок, попавший в отсутствие, переносится на **первый рабочий день после возвращения**
 *   (день после всей цепочки смыкающихся записей): отпуск 10–20 июля, срок 15-го → 21-го (§13 к. 10).
 * - **Весь срок прохождения в отсутствии** (старт тоже в той же цепочке) — запись «создаётся, но
 *   стартует в день возвращения». У относительного срока отсчёт идёт от этого старта, как и при
 *   обычном отложенном старте (`expandAssignment`: срок = старт + N дней); у календарного —
 *   общее правило. Начатую запись в «Заплановано» не возвращаем — сдвигается только срок.
 * - Новый срок, снова попавший в отсутствие, сдвигается ещё раз.
 */
export function planAroundAbsences(input: DeadlinePlanInput): DeadlinePlan | null {
  if (!absentThrough(input.due, input.absences)) return null
  let due = input.due
  let start = input.start
  for (let step = 0; step < 100; step++) {
    const end = absentThrough(due, input.absences)
    if (!end) break
    const back = addDays(end, 1)
    const wholeWindow = input.movableStart && start !== null && start <= due && absentThrough(start, input.absences) === end
    if (wholeWindow) {
      start = back
      due = input.relativeDays ? addDays(back, input.relativeDays) : firstWorkingDayFrom(back)
    }
    else {
      due = firstWorkingDayFrom(back)
    }
  }
  return { due, start: start !== input.start ? start : null }
}
