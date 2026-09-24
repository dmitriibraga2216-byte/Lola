import { describe, expect, it } from 'vitest'
import {
  BULK_DELEGATE_LIMIT, CLAIM_TTL_MS, DELEGATION_MIN_LEAD_MS, MAX_DELEGATION_DEPTH,
  claimIsLive, delegationDueCheck, dueSlaSteps, notifyStep, overdueHours, pickLeastLoaded, pickRoundRobin,
  restingStatus, ruleMatches, scopeIsEmpty, slaMarks,
} from '../../server/services/reviewRules'
import type { ReviewerLoad } from '../../server/services/reviewRules'
import {
  reviewAbsenceSchema, reviewBulkDelegateSchema, reviewDelegateSchema, reviewRoutingRuleSchema,
} from '../../shared/schemas/review'
import {
  ENUMS, REVIEWER_ABSENCE_KINDS, REVIEW_DELEGATION_REASONS, REVIEW_DELEGATION_STATES, REVIEW_ROUTING_STRATEGIES, REVIEW_SLA_EVENTS,
} from '../../shared/enums'

/**
 * PR-19 пакета `docs/v2`: правила делегирования, распределения и срока проверки, которые
 * проверяются без базы (`server/services/reviewRules.ts`). Состояние очереди, цепочки
 * делегирования, RLS и критерии приёмки `37` §13 — в `tests/integration/v2-review-delegation.spec.ts`.
 */

const H = 3_600_000
const at = (iso: string) => new Date(iso)

describe('пороги срока проверки 50 / 100 / 150 % (`37` §7.19, критерий §13 к. 14)', () => {
  const due = at('2026-09-26T12:00:00Z') // сдано 24.09 12:00, SLA 48 ч
  const item = { slaDueAt: due, slaHours: 48, slaWarnedAt: null, slaBreachedAt: null, escalatedAt: null }

  it('окно восстанавливается из срока, а не из назначения: 24-й, 48-й и 72-й час', () => {
    const m = slaMarks(due, 48)
    expect(m.warnAt.toISOString()).toBe('2026-09-25T12:00:00.000Z')
    expect(m.breachAt.toISOString()).toBe('2026-09-26T12:00:00.000Z')
    expect(m.escalateAt.toISOString()).toBe('2026-09-27T12:00:00.000Z')
  })

  it('до половины окна — ничего; на 24-м часу — предупреждение; на 48-м — нарушение; на 72-м — эскалация', () => {
    expect(dueSlaSteps(item, at('2026-09-25T11:59:00Z'))).toEqual([])
    expect(dueSlaSteps(item, at('2026-09-25T12:00:00Z'))).toEqual(['warn'])
    expect(dueSlaSteps({ ...item, slaWarnedAt: at('2026-09-25T12:00:00Z') }, at('2026-09-26T12:00:00Z'))).toEqual(['breach'])
    expect(dueSlaSteps({ ...item, slaWarnedAt: due, slaBreachedAt: due }, at('2026-09-27T12:00:00Z'))).toEqual(['escalate'])
  })

  it('опоздавший прогон отмечает все пороги, но уведомляет одним — самым высоким', () => {
    const steps = dueSlaSteps(item, at('2026-09-28T00:00:00Z'))
    expect(steps).toEqual(['warn', 'breach', 'escalate'])
    expect(notifyStep(steps)).toBe('escalate')
    expect(notifyStep(['warn', 'breach'])).toBe('breach')
    expect(notifyStep([])).toBeNull()
  })

  it('отмеченный порог второй раз не срабатывает; без срока нечего считать', () => {
    const all = { ...item, slaWarnedAt: due, slaBreachedAt: due, escalatedAt: due }
    expect(dueSlaSteps(all, at('2026-10-10T00:00:00Z'))).toEqual([])
    expect(dueSlaSteps({ ...item, slaDueAt: null }, at('2026-10-10T00:00:00Z'))).toEqual([])
  })

  it('часы просрочки — с двумя знаками и не отрицательные', () => {
    expect(overdueHours(due, at('2026-09-26T13:30:00Z'))).toBe(1.5)
    expect(overdueHours(due, at('2026-09-26T11:00:00Z'))).toBe(0)
  })
})

describe('срок делегата (`37` §6.1, §7.5)', () => {
  const now = at('2026-09-24T12:00:00Z')

  it('не раньше чем через 12 часов', () => {
    expect(DELEGATION_MIN_LEAD_MS).toBe(12 * H)
    expect(delegationDueCheck(now, new Date(now.getTime() + 11 * H), null)).toBe('too_soon')
    expect(delegationDueCheck(now, new Date(now.getTime() + 12 * H), null)).toBe('ok')
  })

  it('не позже срока проверки: делегирование не продлевает срок', () => {
    const sla = new Date(now.getTime() + 48 * H)
    expect(delegationDueCheck(now, new Date(now.getTime() + 24 * H), sla)).toBe('ok')
    expect(delegationDueCheck(now, new Date(now.getTime() + 49 * H), sla)).toBe('too_late')
  })

  it('до срока проверки меньше 12 часов — передать уже нельзя: окна не существует', () => {
    const sla = new Date(now.getTime() + 6 * H)
    expect(delegationDueCheck(now, new Date(now.getTime() + 5 * H), sla)).toBe('too_soon')
    expect(delegationDueCheck(now, new Date(now.getTime() + 13 * H), sla)).toBe('too_late')
  })
})

describe('цепочка и захват (`37` §7.3, `docs/13` §4.2)', () => {
  it('предел цепочки — две передачи, массовая передача — до 25 работ', () => {
    expect(MAX_DELEGATION_DEPTH).toBe(2)
    expect(BULK_DELEGATE_LIMIT).toBe(25)
  })

  it('захват живёт 30 минут', () => {
    const now = at('2026-09-24T12:00:00Z')
    expect(CLAIM_TTL_MS).toBe(30 * 60_000)
    expect(claimIsLive(new Date(now.getTime() - 29 * 60_000), now)).toBe(true)
    expect(claimIsLive(new Date(now.getTime() - 31 * 60_000), now)).toBe(false)
    expect(claimIsLive(null, now)).toBe(false)
  })

  it('состояние покоя: эскалация сильнее делегирования, делегирование сильнее ожидания', () => {
    const t = at('2026-09-24T12:00:00Z')
    expect(restingStatus({ delegationId: null, escalatedAt: null })).toBe('waiting')
    expect(restingStatus({ delegationId: 'd1', escalatedAt: null })).toBe('delegated')
    expect(restingStatus({ delegationId: 'd1', escalatedAt: t })).toBe('escalated')
    expect(restingStatus({ delegationId: null, escalatedAt: t })).toBe('escalated')
  })
})

describe('круговое распределение (`37` §7.17, критерий §13 к. 12)', () => {
  const load = (id: string, rrCursor: number, open = 0, max = 20): ReviewerLoad => ({ id, rrCursor, open, max })

  it('на постоянном составе — ровно круг по `users.id`', () => {
    const people = [load('c', 0), load('a', 0), load('b', 0)]
    const order: string[] = []
    for (let i = 0; i < 6; i++) {
      const pick = pickRoundRobin(people)!
      order.push(pick.id)
      people.find(p => p.id === pick.id)!.rrCursor++
    }
    expect(order).toEqual(['a', 'b', 'c', 'a', 'b', 'c'])
  })

  it('достигший лимита пропускается; пропущены все — первый по списку с пометкой перегрузки', () => {
    expect(pickRoundRobin([load('a', 0, 20, 20), load('b', 5)])).toEqual({ id: 'b', overloaded: false })
    expect(pickRoundRobin([load('b', 0, 3, 3), load('a', 9, 20, 20)])).toEqual({ id: 'a', overloaded: true })
    expect(pickRoundRobin([])).toBeNull()
  })

  it('наименее загруженный — минимум открытых работ, при равенстве первый по id; лимит не фильтрует', () => {
    expect(pickLeastLoaded([load('b', 0, 2), load('a', 0, 5), load('c', 0, 2)])).toEqual({ id: 'b', overloaded: false })
    expect(pickLeastLoaded([load('a', 0, 20, 20)])).toEqual({ id: 'a', overloaded: true })
  })
})

describe('сопоставление правила распределения (`37` §3.3, §7.16)', () => {
  const item = { taskType: 'workshop', subjectKind: 'employee', locationId: 'L1', positionId: 'P1', trackId: 'C1' }
  const rule = (over: Partial<Parameters<typeof ruleMatches>[0]> = {}) => ({ matchScope: {}, matchSubjectKind: null, matchTaskTypes: [], ...over })

  it('пустое правило — весь тенант', () => {
    expect(ruleMatches(rule(), item)).toBe(true)
    expect(scopeIsEmpty({})).toBe(true)
    expect(scopeIsEmpty({ location_ids: [] })).toBe(true)
    expect(scopeIsEmpty({ location_ids: ['L1'] })).toBe(false)
  })

  it('каждое измерение области ограничивает', () => {
    expect(ruleMatches(rule({ matchTaskTypes: ['quiz_open_answer'] }), item)).toBe(false)
    expect(ruleMatches(rule({ matchSubjectKind: 'candidate' }), item)).toBe(false)
    expect(ruleMatches(rule({ matchScope: { location_ids: ['L2'] } }), item)).toBe(false)
    expect(ruleMatches(rule({ matchScope: { location_ids: ['L1'], position_ids: ['P1'], course_ids: ['C1'] } }), item)).toBe(true)
    expect(ruleMatches(rule({ matchScope: { course_ids: ['C1'] } }), { ...item, trackId: null })).toBe(false)
  })
})

describe('контракты форм (`37` §6)', () => {
  const base = { toUserId: '00000000-0000-4000-8000-000000000001', reasonCode: 'workload', dueAt: '2026-09-25T12:00:00+03:00' }

  it('«Інше» требует пояснения 10–500 знаков, остальные причины — нет', () => {
    expect(reviewDelegateSchema.safeParse(base).success).toBe(true)
    expect(reviewDelegateSchema.safeParse({ ...base, reasonCode: 'other' }).success).toBe(false)
    expect(reviewDelegateSchema.safeParse({ ...base, reasonCode: 'other', reasonText: 'коротко' }).success).toBe(false)
    expect(reviewDelegateSchema.safeParse({ ...base, reasonCode: 'other', reasonText: 'Колега краще знає цю кухню' }).success).toBe(true)
    expect(reviewDelegateSchema.parse(base).notify).toBe(true)
  })

  it('причина — одна из шести, срок — момент со смещением', () => {
    expect(reviewDelegateSchema.safeParse({ ...base, reasonCode: 'boredom' }).success).toBe(false)
    expect(reviewDelegateSchema.safeParse({ ...base, dueAt: 'завтра' }).success).toBe(false)
  })

  it('массовая передача принимает список, а потолок 25 проверяет сервис своим кодом', () => {
    const ids = Array.from({ length: 26 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    expect(reviewBulkDelegateSchema.safeParse({ ...base, itemIds: ids }).success).toBe(true)
  })

  it('отсутствие: вид из пяти, даты — даты', () => {
    const a = { userId: base.toUserId, kind: 'vacation', startsOn: '2026-10-01', endsOn: '2026-10-12' }
    expect(reviewAbsenceSchema.parse(a).moveOpenItems).toBe(true)
    expect(reviewAbsenceSchema.safeParse({ ...a, kind: 'holiday' }).success).toBe(false)
  })

  it('правило: SLA 1–720 часов, стратегия из шести', () => {
    expect(reviewRoutingRuleSchema.parse({ nameUk: 'Кухня' }).strategy).toBe('round_robin')
    expect(reviewRoutingRuleSchema.safeParse({ nameUk: 'Кухня', slaHoursOverride: 721 }).success).toBe(false)
    expect(reviewRoutingRuleSchema.safeParse({ nameUk: 'Кухня', strategy: 'random' }).success).toBe(false)
  })
})

describe('перечисления PR-19 объявлены в одном месте (CLAUDE.md п. 13)', () => {
  it('все пять есть в ENUMS и совпадают с DDL `37` §3.2–3.4', () => {
    expect(ENUMS.review_delegation_reason).toEqual(REVIEW_DELEGATION_REASONS)
    expect(ENUMS.review_delegation_state).toEqual(REVIEW_DELEGATION_STATES)
    expect(ENUMS.review_routing_strategy).toEqual(REVIEW_ROUTING_STRATEGIES)
    expect(ENUMS.reviewer_absence_kind).toEqual(REVIEWER_ABSENCE_KINDS)
    expect(ENUMS.review_sla_event).toEqual(REVIEW_SLA_EVENTS)
    expect([...REVIEW_DELEGATION_REASONS]).toEqual(['absence', 'workload', 'expertise', 'conflict_of_interest', 'location_change', 'other'])
    expect([...REVIEW_DELEGATION_STATES]).toEqual(['active', 'resolved', 'revoked_by_author', 'revoked_by_manager', 'revoked_sla', 'cancelled'])
  })
})
