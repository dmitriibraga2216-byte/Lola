import { describe, expect, it } from 'vitest'
import {
  TIME_NORM_RULES, appliedObservedSeconds, authorSecondsValid, autoMediaSeconds, autoQuizSeconds, autoTextSeconds,
  canApplyObserved, clampNorm, comparePlanFact, deviationFactor, deviationFlag, deviationNoticeDue, isDeviation,
  observedShown, plannedSeconds, wholeMinutes,
} from '../../shared/domain/timeNorms'
import { timeNormPutSchema, timePlanFactQuerySchema } from '../../shared/schemas/timeNorms'

/**
 * Нормы времени на контент — правила без базы (docs/v2/37 §6.3, §7.13, §7.14, §8; PR-22).
 * Поведение сервиса и критерий приёмки 11 — `tests/integration/v2-time-norms.spec.ts`.
 */

describe('флаг отклонения (§7.14)', () => {
  it('критерий 11: норма 10 хв, факт 35 хв на выборке 25 — too_slow', () => {
    expect(deviationFlag({ plannedSeconds: 600, observedSeconds: 2100, sample: 25 })).toBe('too_slow')
    expect(deviationFactor(600, 2100)).toBeCloseTo(3.5)
  })

  it('пороги строгие: ровно 2,0 и ровно 0,4 — ещё в норме', () => {
    expect(deviationFlag({ plannedSeconds: 600, observedSeconds: 1200, sample: 10 })).toBe('none')
    expect(deviationFlag({ plannedSeconds: 600, observedSeconds: 1201, sample: 10 })).toBe('too_slow')
    expect(deviationFlag({ plannedSeconds: 1000, observedSeconds: 400, sample: 10 })).toBe('none')
    expect(deviationFlag({ plannedSeconds: 1000, observedSeconds: 399, sample: 10 })).toBe('too_fast')
  })

  it('выборка меньше 10 или нормы нет — no_data, флаг не ставится', () => {
    expect(deviationFlag({ plannedSeconds: 600, observedSeconds: 6000, sample: 9 })).toBe('no_data')
    expect(deviationFlag({ plannedSeconds: null, observedSeconds: 6000, sample: 50 })).toBe('no_data')
    expect(deviationFlag({ plannedSeconds: 600, observedSeconds: null, sample: 50 })).toBe('no_data')
    expect(deviationFactor(null, 100)).toBeNull()
  })

  it('отклонение — только too_slow и too_fast', () => {
    expect(isDeviation('too_slow')).toBe(true)
    expect(isDeviation('too_fast')).toBe(true)
    expect(isDeviation('none')).toBe(false)
    expect(isDeviation('no_data')).toBe(false)
  })

  it('медиана и процентили показываются с 10 прохождений (Р-22.4)', () => {
    expect(observedShown(9)).toBe(false)
    expect(observedShown(TIME_NORM_RULES.minSample)).toBe(true)
  })
})

describe('уведомление автору (§8, Р-22.6): при входе в отклонение на выборке ≥ 20', () => {
  it('первое отклонение на 25 — уведомить', () => {
    expect(deviationNoticeDue(null, { flag: 'too_slow', sample: 25 })).toBe(true)
    expect(deviationNoticeDue({ flag: 'none', sample: 25 }, { flag: 'too_slow', sample: 25 })).toBe(true)
  })

  it('выборка меньше 20 — не уведомлять, даже при флаге', () => {
    expect(deviationNoticeDue(null, { flag: 'too_slow', sample: 19 })).toBe(false)
  })

  it('флаг стоял на 15, выборка доросла до 20 — это вход: уведомить', () => {
    expect(deviationNoticeDue({ flag: 'too_slow', sample: 15 }, { flag: 'too_slow', sample: 20 })).toBe(true)
  })

  it('то же состояние неделю спустя — не повторять', () => {
    expect(deviationNoticeDue({ flag: 'too_slow', sample: 25 }, { flag: 'too_slow', sample: 31 })).toBe(false)
  })

  it('сменилась сторона отклонения — уведомить; вернулось в норму — нет', () => {
    expect(deviationNoticeDue({ flag: 'too_slow', sample: 25 }, { flag: 'too_fast', sample: 25 })).toBe(true)
    expect(deviationNoticeDue({ flag: 'too_slow', sample: 25 }, { flag: 'none', sample: 25 })).toBe(false)
    expect(deviationNoticeDue({ flag: 'too_slow', sample: 25 }, { flag: 'no_data', sample: 5 })).toBe(false)
  })
})

describe('«Розрахунковий час» (§7.13)', () => {
  it('author и observed — число автора, auto — авторасчёт', () => {
    expect(plannedSeconds({ source: 'author', authorSeconds: 600, autoSeconds: 180 })).toBe(600)
    expect(plannedSeconds({ source: 'observed', authorSeconds: 2100, autoSeconds: 180 })).toBe(2100)
    expect(plannedSeconds({ source: 'auto', authorSeconds: 600, autoSeconds: 180 })).toBe(180)
  })

  it('нет числа — нормы нет; меньше минуты — минута (снимок очереди держит 60…216000)', () => {
    expect(plannedSeconds({ source: 'auto', authorSeconds: null, autoSeconds: null })).toBeNull()
    expect(plannedSeconds({ source: 'auto', authorSeconds: null, autoSeconds: 45 })).toBe(60)
    expect(clampNorm(10_000_000)).toBe(216_000)
  })

  it('авторасчёт: текст — знаки/1100 минут вверх; медиа — длительность; тест — 45 с + 150 с на развёрнутый', () => {
    expect(autoTextSeconds(0)).toBeNull()
    expect(autoTextSeconds(1)).toBe(60)
    expect(autoTextSeconds(1100)).toBe(60)
    expect(autoTextSeconds(1101)).toBe(120)
    expect(autoMediaSeconds(null)).toBeNull()
    expect(autoMediaSeconds(754)).toBe(754)
    expect(autoQuizSeconds(0, 0)).toBeNull()
    expect(autoQuizSeconds(10, 0)).toBe(450)
    expect(autoQuizSeconds(10, 2)).toBe(10 * 45 + 2 * 150)
  })

  it('число автора: целые секунды от минуты до 60 часов (`norm.value_range`)', () => {
    expect(authorSecondsValid(60)).toBe(true)
    expect(authorSecondsValid(216_000)).toBe(true)
    expect(authorSecondsValid(59)).toBe(false)
    expect(authorSecondsValid(216_060)).toBe(false)
    expect(authorSecondsValid(90.5)).toBe(false)
    expect(authorSecondsValid('600')).toBe(false)
  })
})

describe('«Застосувати» (§6.3, Р-22.2)', () => {
  it('доступно с 20 прохождений и посчитанной медианы', () => {
    expect(canApplyObserved({ observedSeconds: 2100, observedSample: 20 })).toBe(true)
    expect(canApplyObserved({ observedSeconds: 2100, observedSample: 19 })).toBe(false)
    expect(canApplyObserved({ observedSeconds: null, observedSample: 30 })).toBe(false)
  })

  it('медиана округляется вверх до целой минуты и не выходит за границы нормы', () => {
    expect(appliedObservedSeconds(2100)).toBe(2100)
    expect(appliedObservedSeconds(2101)).toBe(2160)
    expect(appliedObservedSeconds(20)).toBe(60)
  })

  it('минуты в тексте уведомления — целые, не меньше одной', () => {
    expect(wholeMinutes(2100)).toBe(35)
    expect(wholeMinutes(20)).toBe(1)
  })
})

describe('порядок строк отчёта «План і факт часу» (§9.3)', () => {
  it('сначала медленнее плана от тяжёлых, затем быстрее, затем в норме, в конце — без данных', () => {
    const rows = [
      { deviation: 'no_data' as const, factor: null, title: 'А' },
      { deviation: 'none' as const, factor: 1, title: 'Б' },
      { deviation: 'too_fast' as const, factor: 0.3, title: 'В' },
      { deviation: 'too_slow' as const, factor: 2.5, title: 'Г' },
      { deviation: 'too_fast' as const, factor: 0.1, title: 'Ґ' },
      { deviation: 'too_slow' as const, factor: 4, title: 'Д' },
    ]
    expect([...rows].sort(comparePlanFact).map(r => r.title)).toEqual(['Д', 'Г', 'Ґ', 'В', 'Б', 'А'])
  })
})

describe('контракты', () => {
  it('PUT: автор с числом, авто, за фактом; неизвестный источник — ошибка схемы', () => {
    expect(timeNormPutSchema.safeParse({ source: 'author', authorSeconds: 600 }).success).toBe(true)
    expect(timeNormPutSchema.safeParse({ source: 'auto' }).success).toBe(true)
    expect(timeNormPutSchema.safeParse({ source: 'observed' }).success).toBe(true)
    expect(timeNormPutSchema.safeParse({ source: 'author' }).success).toBe(false)
    expect(timeNormPutSchema.safeParse({ source: 'magic' }).success).toBe(false)
  })

  it('отчёт: фильтры §9.3 разбираются из строки запроса, людей среди них нет', () => {
    const q = timePlanFactQuerySchema.parse({ subjectType: 'lesson', deviation: 'too_slow', minSample: '20', includeArchived: 'true' })
    expect(q).toMatchObject({ subjectType: 'lesson', deviation: 'too_slow', minSample: 20, includeArchived: true, format: 'json' })
    expect(Object.keys(timePlanFactQuerySchema.shape)).not.toContain('userId')
    expect(timePlanFactQuerySchema.safeParse({ deviation: 'slow' }).success).toBe(false)
  })
})
