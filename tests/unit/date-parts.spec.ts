import { describe, expect, it } from 'vitest'
import { daysInMonth, joinDateParts, splitIsoDate, yearRange } from '../../shared/domain/dateParts'

/**
 * Замечание 27.09, п. 3: в карточке человека на iPad у «Дата народження» выбирались только
 * месяц и год. Поле — три списка (`DateSelect`); здесь — их сборка в ISO-дату.
 */
describe('дата тремя списками', () => {
  it('день, месяц и год дают полную ISO-дату', () => {
    expect(joinDateParts({ y: '1994', m: '3', d: '7' })).toBe('1994-03-07')
  })

  it('пока не выбран день — даты нет (а не «1-е число»)', () => {
    expect(joinDateParts({ y: '1994', m: '3', d: '' })).toBe('')
    expect(joinDateParts({ y: '', m: '3', d: '7' })).toBe('')
  })

  it('31-е в коротком месяце обрезается; 29 лютого — только в високосный', () => {
    expect(joinDateParts({ y: '1990', m: '4', d: '31' })).toBe('1990-04-30')
    expect(joinDateParts({ y: '2001', m: '2', d: '29' })).toBe('2001-02-28')
    expect(joinDateParts({ y: '2000', m: '2', d: '29' })).toBe('2000-02-29')
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2023, 12)).toBe(31)
  })

  it('разбор ISO — туда и обратно; пусто и мусор — пустые части', () => {
    expect(splitIsoDate('1985-11-09')).toEqual({ y: '1985', m: '11', d: '9' })
    expect(joinDateParts(splitIsoDate('1985-11-09'))).toBe('1985-11-09')
    expect(splitIsoDate('')).toEqual({ y: '', m: '', d: '' })
    expect(splitIsoDate(null)).toEqual({ y: '', m: '', d: '' })
  })

  it('годы — от новых к старым, включительно', () => {
    expect(yearRange(2010, 2012)).toEqual([2012, 2011, 2010])
  })
})
