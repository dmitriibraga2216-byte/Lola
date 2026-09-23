import { describe, expect, it } from 'vitest'
import {
  checkRate, deadlineShiftFor, dedupeKeyOf, dueAtFor, isTrustedReporter, nextReporterState, rateWindows, severityOf,
} from '../../shared/domain/contentIssues'
import { CONTENT_ISSUE_LIMITS } from '../../shared/enums'

/**
 * Правила жалобы на материал (docs/v2/36-content-feedback.md §7.2, §7.4, §7.6, §7.7, §7.10,
 * §7.11; PR-23 плана `docs/v2/45`). Здесь проверяются ровно те два места, где ошибка
 * не видна глазом и дорого стоит:
 *
 * - **склейка**: ключ, по которому сорок жалоб дают одну карточку, а жалоба на новую
 *   версию — новую;
 * - **пределы**: шестая жалоба за сутки обязана быть отвергнута, а время формы —
 *   компенсировано, но не безгранично.
 */

describe('§7.2 ключ склейки', () => {
  const base = { targetType: 'question' as const, targetId: 'q1', issueType: 'wrong_key' as const, contentVersion: 3 }

  it('один и тот же дефект даёт один ключ', () => {
    expect(dedupeKeyOf(base)).toBe(dedupeKeyOf({ ...base }))
  })

  it('блок входит в ключ: битое видео в третьем и в седьмом блоке — разные починки', () => {
    expect(dedupeKeyOf({ ...base, blockId: 'b3' })).not.toBe(dedupeKeyOf({ ...base, blockId: 'b7' }))
  })

  it('без блока в ключе стоит прочерк, а не пустая строка — ключи не схлопываются', () => {
    expect(dedupeKeyOf(base)).toBe('question:q1:-:wrong_key:3')
  })

  it('версия входит в ключ: та же опечатка в новой редакции — другой дефект', () => {
    expect(dedupeKeyOf({ ...base, contentVersion: 4 })).not.toBe(dedupeKeyOf(base))
  })

  it('тип проблемы входит в ключ: «немає звуку» и «застаріло» чинят порознь', () => {
    expect(dedupeKeyOf({ ...base, issueType: 'outdated' })).not.toBe(dedupeKeyOf(base))
  })
})

describe('§7.4 severity считает система', () => {
  it('всё сломанное и техническое — blocking', () => {
    for (const k of ['broken_media', 'broken_file', 'broken_link', 'tech'] as const) {
      expect(severityOf(k), k).toBe('blocking')
    }
  })

  it('опечатка и «незрозуміло» — cosmetic', () => {
    expect(severityOf('typo')).toBe('cosmetic')
    expect(severityOf('unclear')).toBe('cosmetic')
  })

  it('обязательный урок поднимает даже опечатку до blocking', () => {
    expect(severityOf('typo', { lessonRequired: true })).toBe('blocking')
  })

  it('архивный материал — всегда cosmetic и без срока (§7.13)', () => {
    expect(severityOf('tech', { archived: true })).toBe('cosmetic')
    expect(dueAtFor('cosmetic', new Date('2026-09-23T10:00:00Z'), { archived: true })).toBeNull()
  })
})

describe('§7.6 срок починки', () => {
  it('blocking — два рабочих дня: пятница + 2 = вторник, а не воскресенье', () => {
    const friday = new Date('2026-09-25T10:00:00Z')
    expect(friday.getUTCDay()).toBe(5)
    const due = dueAtFor('blocking', friday)!
    expect(due.toISOString().slice(0, 10)).toBe('2026-09-29')
  })

  it('normal — 7 дней, cosmetic — 30, календарных', () => {
    const from = new Date('2026-09-23T10:00:00Z')
    expect(dueAtFor('normal', from)!.toISOString().slice(0, 10)).toBe('2026-09-30')
    expect(dueAtFor('cosmetic', from)!.toISOString().slice(0, 10)).toBe('2026-10-23')
  })
})

describe('§7.10 частота: шестая жалоба блокируется текстом, а не молча', () => {
  it('пять за сутки проходят, шестая — нет, и отказ называет предел', () => {
    expect(checkRate({ day: 4, month: 4 })).toEqual({ ok: true })
    const v = checkRate({ day: 5, month: 5 })
    expect(v).toEqual({ ok: false, reason: 'per_day', used: 5, limit: 5 })
  })

  it('месячный предел ловится отдельно от суточного', () => {
    const v = checkRate({ day: 0, month: CONTENT_ISSUE_LIMITS.perMonth })
    expect(v.ok).toBe(false)
    expect(v.ok === false && v.reason).toBe('per_month')
  })

  it('три жалобы за попытку — предел, и он считается только внутри попытки (§7.7 а)', () => {
    expect(checkRate({ day: 0, month: 0, attempt: 3 }, { inAttempt: false })).toEqual({ ok: true })
    const v = checkRate({ day: 0, month: 0, attempt: 3 }, { inAttempt: true })
    expect(v.ok === false && v.reason).toBe('per_attempt')
  })

  it('носитель content_issue.triage разбирает очередь и в лимиты не упирается', () => {
    expect(checkRate({ day: 99, month: 99 }, { exempt: true })).toEqual({ ok: true })
  })

  it('окна считаются от начала суток и месяца, а не «за последние 24 часа»', () => {
    const { dayFrom, monthFrom } = rateWindows(new Date('2026-09-23T23:59:59Z'))
    expect(dayFrom.toISOString()).toBe('2026-09-23T00:00:00.000Z')
    expect(monthFrom.toISOString()).toBe('2026-09-01T00:00:00.000Z')
  })
})

describe('§7.7 б жалоба не съедает time_limit_sec', () => {
  it('сорок секунд в форме возвращаются полностью', () => {
    expect(deadlineShiftFor(40, 0)).toBe(40)
  })

  it('больше 60 секунд за одну жалобу не возвращается — иначе форма станет паузой', () => {
    expect(deadlineShiftFor(600, 0)).toBe(60)
  })

  it('за попытку суммарно не больше 180 секунд', () => {
    expect(deadlineShiftFor(60, 120)).toBe(60)
    expect(deadlineShiftFor(60, 150)).toBe(30)
    expect(deadlineShiftFor(60, 180)).toBe(0)
  })

  it('отсутствующее и отрицательное время формы не двигают дедлайн назад', () => {
    expect(deadlineShiftFor(undefined, 0)).toBe(0)
    expect(deadlineShiftFor(-30, 0)).toBe(0)
  })
})

describe('§7.11 поток пустых жалоб', () => {
  const now = new Date('2026-09-23T10:00:00Z')
  const zero = { spamCount: 0, consecutiveSpam: 0, confirmedCount: 0, rejectedCount: 0, mutedUntil: null }

  it('три spam подряд дают mute на 14 дней', () => {
    let s = nextReporterState(zero, 'spam', now)
    expect(s.autoMuted).toBe(false)
    s = nextReporterState(s, 'spam', now)
    expect(s.autoMuted).toBe(false)
    s = nextReporterState(s, 'spam', now)
    expect(s.autoMuted).toBe(true)
    expect(s.mutedUntil!.toISOString().slice(0, 10)).toBe('2026-10-07')
  })

  it('подтверждённая жалоба обнуляет серию', () => {
    const two = nextReporterState(nextReporterState(zero, 'spam', now), 'spam', now)
    const after = nextReporterState(two, 'confirmed', now)
    expect(after.consecutiveSpam).toBe(0)
    expect(nextReporterState(after, 'spam', now).autoMuted).toBe(false)
  })

  it('за отклонённые не наказывают: серия spam не растёт (§7.12)', () => {
    const s = nextReporterState(nextReporterState(zero, 'spam', now), 'rejected', now)
    expect(s.consecutiveSpam).toBe(1)
    expect(s.mutedUntil).toBeNull()
  })

  it('«надійний» — выше 60 % подтверждения при не менее пяти жалобах', () => {
    expect(isTrustedReporter({ reportsTotal: 4, confirmedCount: 4 })).toBe(false)
    expect(isTrustedReporter({ reportsTotal: 5, confirmedCount: 3 })).toBe(false)
    expect(isTrustedReporter({ reportsTotal: 5, confirmedCount: 4 })).toBe(true)
  })
})
