import { describe, expect, it } from 'vitest'

/**
 * PR-37 пакета `docs/v2` (`45-plan.md`): тихие часы кандидата (П-23, `docs/v2/39-patches.md`).
 *
 * Сквозная проверка 19 (`docs/v2/42-stages-delta.md` §5): «событие для кандидата в 22:10 при
 * тихих часах тенанта 21:00–08:00 уходит в 09:00 по локальному времени кандидата; событие для
 * кандидата в 20:30 — тоже в 09:00 следующего дня, а не немедленно». Тенантское окно 21:00–08:00
 * здесь не проверяется числами: пункт и так подчёркивает, что оно роли не играет — кандидатское
 * окно фиксировано (09:00–20:00) и не читает `settings.quietHours` вовсе (см. интеграционный
 * тест `tests/integration/v2-notify-37.spec.ts`, где это проверено на реальном тумблере тенанта).
 *
 * Часовой пояс здесь — `Etc/UTC` (смещение 0, без перехода на летнее время): числа проверяются
 * руками без арифметики DST. Сама подстановка часового пояса кандидата (таймзона точки его
 * вакансии, а не тенанта) — интеграционный тест, там же, где нужна БД.
 */

const { scheduleWithQuietHours, CANDIDATE_QUIET_HOURS } = await import('../../server/services/notifications')

describe('CANDIDATE_QUIET_HOURS: окно 09:00–20:00', () => {
  it('константа — ровно 09:00–20:00 (докс/v2/39 П-23)', () => {
    expect(CANDIDATE_QUIET_HOURS).toEqual({ from: 9, to: 20 })
  })

  it('22:10 → 09:00 СЛЕДУЮЩЕГО дня (проверка 19, первый пример)', () => {
    const now = new Date('2026-09-24T22:10:00.000Z')
    const got = scheduleWithQuietHours(now, 'Etc/UTC', CANDIDATE_QUIET_HOURS)
    expect(got.toISOString()).toBe('2026-09-25T09:00:00.000Z')
  })

  it('20:30 → 09:00 СЛЕДУЮЩЕГО дня, а не немедленно (проверка 19, второй пример)', () => {
    const now = new Date('2026-09-24T20:30:00.000Z')
    const got = scheduleWithQuietHours(now, 'Etc/UTC', CANDIDATE_QUIET_HOURS)
    expect(got.toISOString()).toBe('2026-09-25T09:00:00.000Z')
    expect(got.getTime()).toBeGreaterThan(now.getTime())
  })

  it('внутри окна (14:00) — уходит немедленно, без переноса', () => {
    const now = new Date('2026-09-24T14:00:00.000Z')
    const got = scheduleWithQuietHours(now, 'Etc/UTC', CANDIDATE_QUIET_HOURS)
    expect(got.getTime()).toBe(now.getTime())
  })

  it('ровно 09:00 — начало окна включено (`hour >= from`)', () => {
    const now = new Date('2026-09-24T09:00:00.000Z')
    const got = scheduleWithQuietHours(now, 'Etc/UTC', CANDIDATE_QUIET_HOURS)
    expect(got.getTime()).toBe(now.getTime())
  })
})
