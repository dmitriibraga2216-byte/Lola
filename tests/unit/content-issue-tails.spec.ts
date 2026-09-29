import { describe, expect, it } from 'vitest'
import { OVERDUE_STEPS, overdueDays, overdueStepsReached, reporterStatusOf } from '../../shared/domain/contentIssues'

/**
 * Хвосты обратной связи по контенту (docs/v2/36-content-feedback.md §5.5, §7.6):
 * ступени просрочки `content_issue.sla_scan` и статус жалобы простыми словами для заявителя.
 */

const due = new Date('2026-09-20T10:00:00Z')
const at = (h: number) => new Date(due.getTime() + h * 3_600_000)

describe('§7.6 ступени просрочки: 1 день — ответственный, 3 — руководитель, 7 — админ', () => {
  it('ступени — ровно 1, 3, 7', () => {
    expect([...OVERDUE_STEPS]).toEqual([1, 3, 7])
  })

  it('до срока и в первые сутки после — ни одной ступени', () => {
    expect(overdueDays(due, at(-5))).toBe(0)
    expect(overdueStepsReached(due, at(-5))).toEqual([])
    expect(overdueStepsReached(due, at(23))).toEqual([])
  })

  it('полные сутки считаются по календарю от `due_at`', () => {
    expect(overdueStepsReached(due, at(24))).toEqual([1])
    expect(overdueDays(due, at(71))).toBe(2)
    expect(overdueStepsReached(due, at(71))).toEqual([1])
    expect(overdueStepsReached(due, at(72))).toEqual([1, 3])
    expect(overdueStepsReached(due, at(7 * 24))).toEqual([1, 3, 7])
    expect(overdueDays(due, at(30 * 24 + 1))).toBe(30)
  })
})

describe('§5.5 статус простыми словами', () => {
  it('новая, в работе и отложенная — «Розглядається»', () => {
    expect(reporterStatusOf('new', null)).toBe('reviewing')
    expect(reporterStatusOf('in_progress', null)).toBe('reviewing')
    expect(reporterStatusOf('deferred', null)).toBe('reviewing')
  })

  it('исправленная и закрытая — «Виправлено»', () => {
    expect(reporterStatusOf('fixed', 'fixed')).toBe('fixed')
    expect(reporterStatusOf('closed', 'question_fixed')).toBe('fixed')
    expect(reporterStatusOf('closed', 'question_void')).toBe('fixed')
  })

  it('отклонённая любой отказной резолюцией — «Не підтвердилось»', () => {
    for (const r of ['not_an_error', 'duplicate', 'wont_fix', 'spam'] as const) {
      expect(reporterStatusOf('rejected', r)).toBe('not_confirmed')
      expect(reporterStatusOf('closed', r)).toBe('not_confirmed')
    }
  })
})
