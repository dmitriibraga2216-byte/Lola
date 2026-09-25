import { describe, expect, it } from 'vitest'
import {
  ENGAGEMENT_CAP, computeEngagementIndex, earlyShare, enrollmentCredit, isEngagementStale, ratingIsOnlyCondition,
  ratingOnlyBulkForbidden, round1,
} from '../../shared/domain/engagementIndex'
import type { IndexEnrollment } from '../../shared/domain/engagementIndex'
import { deadlineLight, formatHms } from '../../shared/domain/personTracks'

/**
 * Індекс навчальної залученості — формула `docs/v2/38` §7.1 и правила показа §7.3 (PR-35).
 * Сквозной расчёт на настоящих записях (критерии §13 к. 1–3) — `tests/integration/v2-person-rating.spec.ts`.
 */

const DAY = 86_400_000
const T0 = Date.UTC(2026, 0, 1)
const at = (days: number) => new Date(T0 + days * DAY).toISOString()

let seq = 0
function enrollment(p: Partial<IndexEnrollment> & { status: string }): IndexEnrollment {
  seq++
  return {
    enrollmentId: `e${seq}`,
    subjectId: `c${seq}`,
    title: `Курс ${seq}`,
    mandatory: true,
    progressPct: 0,
    assignedAt: at(0),
    dueAt: at(10),
    completedAt: null,
    ...p,
  }
}

describe('формула §7.1', () => {
  it('критерий 1: 8 из 10 обязательных, на 20 % раньше срока, серия 15, 10 действий → 80 + 2 + 5 + 5 = 92.0', () => {
    const done = Array.from({ length: 8 }, () => enrollment({ status: 'done', completedAt: at(8) })) // (10 − 8) / (10 − 0) = 0.2
    const open = Array.from({ length: 2 }, () => enrollment({ status: 'not_started' }))
    const r = computeEngagementIndex({ enrollments: [...done, ...open], longestStreak: 15, help: { reviews: 6, issues: 4 } })!
    expect([r.base, r.early, r.streak, r.help, r.total]).toEqual([80, 2, 5, 5, 92])
    expect(r.breakdown.base).toMatchObject({ weighted_done: 16, weighted_total: 20 })
    expect(r.breakdown.early).toMatchObject({ avg_share: 0.2, counted: 8 })
    expect(r.breakdown.streak).toEqual({ longest: 15, target: 30 })
    expect(r.breakdown.help).toEqual({ actions: 10, credited: 10, reviews: 6, issues: 4, target: 20 })
  })

  it('критерий 2: 100 % основы и максимальные бонусы → 130, выше 100 не обрезается', () => {
    const r = computeEngagementIndex({
      enrollments: [enrollment({ status: 'done', completedAt: at(0) }), enrollment({ status: 'done', completedAt: at(0), mandatory: false })],
      longestStreak: 45,
      help: { reviews: 30, issues: 0 },
    })!
    expect(r.total).toBe(ENGAGEMENT_CAP)
    expect([r.base, r.early, r.streak, r.help]).toEqual([100, 10, 10, 10])
    expect(r.breakdown.help.credited).toBe(20) // двадцать первое действие индекс не повышает
  })

  it('обязательное весит вдвое: лёгкие добровольные треки разбавляют числитель и знаменатель', () => {
    const r = computeEngagementIndex({
      enrollments: [enrollment({ status: 'not_started', mandatory: true }), enrollment({ status: 'done', mandatory: false, completedAt: at(5) })],
      longestStreak: 0,
      help: { reviews: 0, issues: 0 },
    })!
    expect(r.base).toBe(33.3) // 100 × 1 / 3
    expect(r.breakdown.base.items.map(i => [i.weight, i.contribution])).toEqual([[2, 0], [1, 1]])
  })

  it('cᵢ: завершено — 1, в процессе — доля прогресса, провал, просрочка и «не начато» — 0 в знаменателе', () => {
    expect(enrollmentCredit('done', 0)).toBe(1)
    expect(enrollmentCredit('in_progress', 45)).toBe(0.45)
    expect(enrollmentCredit('in_progress', 250)).toBe(1)
    expect(enrollmentCredit('failed', 90)).toBe(0)
    expect(enrollmentCredit('not_started', 0)).toBe(0)
    const r = computeEngagementIndex({ enrollments: [enrollment({ status: 'in_progress', progressPct: 50 }), enrollment({ status: 'failed' })], longestStreak: 0, help: { reviews: 0, issues: 0 } })!
    expect(r.base).toBe(25)
  })

  it('E — только завершённые в срок с дедлайном; опоздание, срок до назначения и запись без срока в E не входят', () => {
    expect(earlyShare({ status: 'done', assignedAt: at(0), dueAt: at(10), completedAt: at(12) })).toBeNull() // опоздал
    expect(earlyShare({ status: 'done', assignedAt: at(0), dueAt: null, completedAt: at(2) })).toBeNull()
    expect(earlyShare({ status: 'done', assignedAt: at(10), dueAt: at(10), completedAt: at(10) })).toBeNull()
    expect(earlyShare({ status: 'in_progress', assignedAt: at(0), dueAt: at(10), completedAt: null })).toBeNull()
    expect(earlyShare({ status: 'done', assignedAt: at(0), dueAt: at(10), completedAt: at(10) })).toBe(0) // день в день
    expect(earlyShare({ status: 'done', assignedAt: at(0), dueAt: at(10), completedAt: at(5) })).toBe(0.5)
    // Опоздавшая запись не тянет среднее вниз: считается по тем, кто успел
    const r = computeEngagementIndex({
      enrollments: [enrollment({ status: 'done', completedAt: at(5) }), enrollment({ status: 'done', completedAt: at(15) })],
      longestStreak: 0,
      help: { reviews: 0, issues: 0 },
    })!
    expect(r.early).toBe(5)
    expect(r.breakdown.early.counted).toBe(1)
  })

  it('нет записей в окне → null («—»), а не ноль; без бонусов индекс не отрицательный', () => {
    expect(computeEngagementIndex({ enrollments: [], longestStreak: 40, help: { reviews: 40, issues: 0 } })).toBeNull()
    const r = computeEngagementIndex({ enrollments: [enrollment({ status: 'failed' })], longestStreak: -3, help: { reviews: -1, issues: 0 } })!
    expect(r.total).toBe(0)
  })

  it('итог — сумма показанных слагаемых: экран складывает ровно то, что видит', () => {
    const r = computeEngagementIndex({
      enrollments: [enrollment({ status: 'in_progress', progressPct: 33.33 }), enrollment({ status: 'done', completedAt: at(3) }), enrollment({ status: 'not_started', mandatory: false })],
      longestStreak: 7,
      help: { reviews: 3, issues: 0 },
    })!
    expect(r.total).toBe(round1(r.base + r.early + r.streak + r.help))
  })
})

describe('правила показа §7.3', () => {
  it('индекс — единственное условие: порог есть, второго сужающего условия нет', () => {
    expect(ratingIsOnlyCondition({ ratingLt: 50 })).toBe(true)
    expect(ratingIsOnlyCondition({ ratingLt: 50, ratingGte: 10, tab: 'active', includeHidden: true })).toBe(true)
    expect(ratingIsOnlyCondition({ ratingLt: 50, locationId: 'x' })).toBe(false)
    expect(ratingIsOnlyCondition({ ratingLt: 50, q: 'Іван' })).toBe(false)
    expect(ratingIsOnlyCondition({ locationId: 'x' })).toBe(false)
    expect(ratingIsOnlyCondition({ ratingLt: 0 })).toBe(true) // ноль — тоже порог
  })

  it('запрет — для архивирования и блокировки, прочие массовые действия с таким фильтром можно', () => {
    expect(ratingOnlyBulkForbidden('archive', { ratingLt: 50 })).toBe(true)
    expect(ratingOnlyBulkForbidden('block', { ratingLt: 50 })).toBe(true)
    expect(ratingOnlyBulkForbidden('add_tag', { ratingLt: 50 })).toBe(false)
    expect(ratingOnlyBulkForbidden('archive', { ratingLt: 50, tag: 'кухня' })).toBe(false)
    expect(ratingOnlyBulkForbidden('archive', null)).toBe(false)
  })

  it('значение старше 48 часов — серое', () => {
    const now = new Date('2026-09-25T12:00:00Z')
    expect(isEngagementStale('2026-09-23T11:59:00Z', now)).toBe(true)
    expect(isEngagementStale('2026-09-23T12:30:00Z', now)).toBe(false)
    expect(isEngagementStale(null, now)).toBe(false)
  })
})

describe('«Призначені треки» §5.1, §7.15', () => {
  const now = new Date('2026-09-25T12:00:00Z')
  it('светофор: больше 3 дней — бирюза, 3 дня и меньше — солнце, просрочен — коралл, без срока — серый', () => {
    expect(deadlineLight('2026-10-01T12:00:00Z', false, now)).toBe('ok')
    expect(deadlineLight('2026-09-28T12:00:00Z', false, now)).toBe('soon')
    expect(deadlineLight('2026-09-25T11:00:00Z', false, now)).toBe('overdue')
    expect(deadlineLight(null, false, now)).toBe('none')
    expect(deadlineLight('2026-09-20T12:00:00Z', true, now)).toBe('done') // завершённое не «просрочено»
  })

  it('время — HH:MM:SS, часы не сворачиваются в сутки', () => {
    expect(formatHms(0)).toBe('00:00:00')
    expect(formatHms(3725)).toBe('01:02:05')
    expect(formatHms(90_061)).toBe('25:01:01')
    expect(formatHms(null)).toBe('00:00:00')
  })
})
