import { describe, expect, it } from 'vitest'
import {
  absenceDays, absenceTransitionAllowed, absentThrough, addDays, daysInYear, firstWorkingDayFrom, planAroundAbsences,
  rangesOverlap, remainingDays, validateAbsenceRange,
} from '../../shared/domain/absences'
import { ABSENCE_LIMITS } from '../../shared/enums'

/**
 * Правила отсутствий (docs/v2/38 §3.6, §4, §7.13–7.14; PR-33) — чистые функции над датами.
 * Интеграция с БД, правами и напоминаниями — `tests/integration/v2-absences.spec.ts`.
 */

describe('календарные дни (§7.13)', () => {
  it('диапазон включительно; частично попавший в год период — пересечением', () => {
    expect(absenceDays('2027-07-10', '2027-07-20')).toBe(11)
    expect(absenceDays('2027-07-10', '2027-07-10')).toBe(1)
    expect(daysInYear('2026-12-28', '2027-01-04', 2026)).toBe(4)
    expect(daysInYear('2026-12-28', '2027-01-04', 2027)).toBe(4)
    expect(daysInYear('2026-12-28', '2027-01-04', 2028)).toBe(0)
    // 2028 високосный: февраль целиком — 29 дней
    expect(daysInYear('2028-02-01', '2028-02-29', 2028)).toBe(29)
    expect(addDays('2027-12-31', 1)).toBe('2028-01-01')
  })

  it('период: конец не раньше начала и не длиннее года', () => {
    expect(validateAbsenceRange('2027-07-20', '2027-07-10')).toBe('order')
    expect(validateAbsenceRange('2027-01-01', addDays('2027-01-01', ABSENCE_LIMITS.maxRangeDays - 1))).toBeNull()
    expect(validateAbsenceRange('2027-01-01', addDays('2027-01-01', ABSENCE_LIMITS.maxRangeDays))).toBe('too_long')
  })

  it('пересечение — границы включительно (§6.4)', () => {
    expect(rangesOverlap({ dateFrom: '2027-07-10', dateTo: '2027-07-20' }, { dateFrom: '2027-07-20', dateTo: '2027-07-25' })).toBe(true)
    expect(rangesOverlap({ dateFrom: '2027-07-10', dateTo: '2027-07-20' }, { dateFrom: '2027-07-21', dateTo: '2027-07-25' })).toBe(false)
  })

  it('остаток может уйти в минус и не обрезается (§7.14)', () => {
    expect(remainingDays(24, 11)).toBe(13)
    expect(remainingDays(24.5, 11)).toBe(13.5)
    expect(remainingDays(20, 23)).toBe(-3)
  })
})

describe('состояния записи (§4): planned → approved → cancelled', () => {
  it('только вперёд; отменённая — конечная', () => {
    expect(absenceTransitionAllowed('planned', 'approved')).toBe(true)
    expect(absenceTransitionAllowed('planned', 'cancelled')).toBe(true)
    expect(absenceTransitionAllowed('approved', 'cancelled')).toBe(true)
    expect(absenceTransitionAllowed('approved', 'planned')).toBe(false)
    expect(absenceTransitionAllowed('cancelled', 'approved')).toBe(false)
    expect(absenceTransitionAllowed('approved', 'approved')).toBe(true)
  })
})

describe('сдвиг срока с дней отсутствия (§7.14)', () => {
  const july = [{ dateFrom: '2027-07-10', dateTo: '2027-07-20' }]

  it('§13 к. 10: срок 15 июля, отпуск 10–20 июля → 21 июля', () => {
    // 2027-07-21 — среда: день возвращения рабочий
    expect(planAroundAbsences({ due: '2027-07-15', start: '2027-07-01', movableStart: true, relativeDays: null, absences: july }))
      .toEqual({ due: '2027-07-21', start: null })
  })

  it('срок вне отсутствия — сдвига нет', () => {
    expect(planAroundAbsences({ due: '2027-07-09', start: '2027-07-01', movableStart: true, relativeDays: null, absences: july })).toBeNull()
    expect(planAroundAbsences({ due: '2027-07-21', start: '2027-07-01', movableStart: true, relativeDays: null, absences: july })).toBeNull()
  })

  it('возвращение в субботу — первый рабочий день понедельник', () => {
    // 2027-07-17 — суббота, 2027-07-19 — понедельник
    expect(firstWorkingDayFrom('2027-07-17')).toBe('2027-07-19')
    expect(firstWorkingDayFrom('2027-07-18')).toBe('2027-07-19')
    expect(firstWorkingDayFrom('2027-07-19')).toBe('2027-07-19')
    expect(planAroundAbsences({ due: '2027-07-14', start: '2027-07-01', movableStart: true, relativeDays: null, absences: [{ dateFrom: '2027-07-10', dateTo: '2027-07-16' }] }))
      .toEqual({ due: '2027-07-19', start: null })
  })

  it('смыкающиеся записи — возвращение после всей цепочки; новый срок в следующем отсутствии сдвигается снова', () => {
    const chain = [{ dateFrom: '2027-07-10', dateTo: '2027-07-20' }, { dateFrom: '2027-07-21', dateTo: '2027-07-23' }]
    expect(absentThrough('2027-07-15', chain)).toBe('2027-07-23')
    expect(absentThrough('2027-07-24', chain)).toBeNull()
    // 24-е — суббота → понедельник 26-е
    expect(planAroundAbsences({ due: '2027-07-15', start: '2027-07-01', movableStart: true, relativeDays: null, absences: chain }))
      .toEqual({ due: '2027-07-26', start: null })
    // Возвращение в понедельник 26-го, а 26–27 — ещё одна запись (через выходные цепочка не смыкается)
    const gap = [{ dateFrom: '2027-07-10', dateTo: '2027-07-23' }, { dateFrom: '2027-07-26', dateTo: '2027-07-27' }]
    expect(planAroundAbsences({ due: '2027-07-15', start: '2027-07-01', movableStart: true, relativeDays: null, absences: gap }))
      .toEqual({ due: '2027-07-28', start: null })
  })

  it('весь срок прохождения в отсутствии — старт в день возвращения; относительный срок считается от старта', () => {
    expect(planAroundAbsences({ due: '2027-07-15', start: '2027-07-12', movableStart: true, relativeDays: 3, absences: july }))
      .toEqual({ due: '2027-07-24', start: '2027-07-21' })
    // Календарный срок — общее правило: первый рабочий день после возвращения
    expect(planAroundAbsences({ due: '2027-07-15', start: '2027-07-12', movableStart: true, relativeDays: null, absences: july }))
      .toEqual({ due: '2027-07-21', start: '2027-07-21' })
  })

  it('начатую запись в «Заплановано» не возвращаем — сдвигается только срок', () => {
    expect(planAroundAbsences({ due: '2027-07-15', start: '2027-07-12', movableStart: false, relativeDays: 3, absences: july }))
      .toEqual({ due: '2027-07-21', start: null })
  })
})
