import { describe, expect, it } from 'vitest'
import {
  availableActions, checkTransition, compareQuality, matchingRules, mergedNotifyDue, perHundred,
  rescoreVerdict, routingSetValid,
} from '../../shared/domain/contentIssues'
import type { TransitionInput } from '../../shared/domain/contentIssues'

/**
 * PR-24 пакета `docs/v2`: правила разбора жалобы без БД (`36-content-feedback.md` §4, §6.3,
 * §7.5, §7.8, §8, §9). Интеграционная часть — `tests/integration/v2-content-triage.spec.ts`.
 */

const now = new Date('2026-09-24T10:00:00Z')
const base: TransitionInput = { from: 'new', to: 'in_progress', isAdmin: false, targetType: 'resource', rescoreState: 'none', now }
const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000)

describe('переходы статусов (§4)', () => {
  it('«Взяти в роботу» — из новой и из отложенной, автору достаточно', () => {
    expect(checkTransition(base)).toEqual({ ok: true })
    expect(checkTransition({ ...base, from: 'deferred' })).toEqual({ ok: true })
  })

  it('переоткрыть отклонённую или закрытую — только администратор', () => {
    expect(checkTransition({ ...base, from: 'rejected' })).toEqual({ ok: false, error: 'forbidden' })
    expect(checkTransition({ ...base, from: 'closed', isAdmin: true })).toEqual({ ok: true })
  })

  it('«Виправлено» — только из «В роботі» и только с резолюцией-подтверждением', () => {
    const fix = { ...base, from: 'in_progress' as const, to: 'fixed' as const }
    expect(checkTransition({ ...fix, from: 'new' })).toEqual({ ok: false, error: 'invalid_transition' })
    expect(checkTransition(fix)).toEqual({ ok: false, error: 'resolution_required' })
    expect(checkTransition({ ...fix, resolution: 'not_an_error' })).toEqual({ ok: false, error: 'resolution_invalid' })
    expect(checkTransition({ ...fix, resolution: 'fixed' })).toEqual({ ok: true })
  })

  it('«Питання виправлено/анульовано» — только у вопроса теста (§6.2)', () => {
    const fix = { ...base, from: 'in_progress' as const, to: 'fixed' as const, resolution: 'question_fixed' as const }
    expect(checkTransition(fix)).toEqual({ ok: false, error: 'resolution_invalid' })
    expect(checkTransition({ ...fix, targetType: 'question' })).toEqual({ ok: true })
    expect(checkTransition({ ...fix, targetType: 'question', resolution: 'question_void' })).toEqual({ ok: true })
  })

  it('отказ требует резолюцию отказа и комментарий заявителю не короче 10 символов', () => {
    const rej = { ...base, to: 'rejected' as const }
    expect(checkTransition(rej)).toEqual({ ok: false, error: 'resolution_required' })
    expect(checkTransition({ ...rej, resolution: 'fixed' })).toEqual({ ok: false, error: 'resolution_invalid' })
    expect(checkTransition({ ...rej, resolution: 'spam', resolutionComment: 'ні' })).toEqual({ ok: false, error: 'comment_required' })
    expect(checkTransition({ ...rej, resolution: 'spam', resolutionComment: 'Порожнє повідомлення' })).toEqual({ ok: true })
    expect(checkTransition({ ...rej, from: 'fixed', resolution: 'spam', resolutionComment: 'Порожнє повідомлення' })).toEqual({ ok: false, error: 'invalid_transition' })
  })

  it('«Відкласти» — со сроком от завтра до 180 дней', () => {
    const d = { ...base, to: 'deferred' as const }
    expect(checkTransition(d)).toEqual({ ok: false, error: 'due_required' })
    expect(checkTransition({ ...d, dueAt: inDays(-1) })).toEqual({ ok: false, error: 'due_required' })
    expect(checkTransition({ ...d, dueAt: inDays(181) })).toEqual({ ok: false, error: 'due_required' })
    expect(checkTransition({ ...d, dueAt: inDays(30) })).toEqual({ ok: true })
  })

  it('ручное закрытие — администратор и только когда баллы не ждут пересчёта (§7.7 в)', () => {
    const c = { ...base, from: 'fixed' as const, to: 'closed' as const }
    expect(checkTransition(c)).toEqual({ ok: false, error: 'forbidden' })
    expect(checkTransition({ ...c, isAdmin: true, rescoreState: 'needed' })).toEqual({ ok: false, error: 'rescore_pending' })
    expect(checkTransition({ ...c, isAdmin: true, rescoreState: 'done' })).toEqual({ ok: true })
  })

  it('тот же статус и возврат в «Нова» — недопустимы', () => {
    expect(checkTransition({ ...base, to: 'new' })).toEqual({ ok: false, error: 'invalid_transition' })
    expect(checkTransition({ ...base, from: 'fixed', to: 'fixed', resolution: 'fixed' })).toEqual({ ok: false, error: 'invalid_transition' })
  })
})

describe('пересчёт «только в сторону улучшения» (§7.8)', () => {
  it('провал → зачёт применяется, зачёт → провал — нет', () => {
    expect(rescoreVerdict({ score: 50, passed: false }, { score: 100, passed: true })).toBe('improved')
    expect(rescoreVerdict({ score: 100, passed: true }, { score: 50, passed: false })).toBe('worse')
  })

  it('падение балла без смены статуса — тоже ухудшение; рост — улучшение', () => {
    expect(rescoreVerdict({ score: 90, passed: true }, { score: 85, passed: true })).toBe('worse')
    expect(rescoreVerdict({ score: 40, passed: false }, { score: 55, passed: false })).toBe('improved')
  })

  it('ничего не меняется — записывать нечего', () => {
    expect(rescoreVerdict({ score: 75, passed: true }, { score: 75, passed: true })).toBe('unchanged')
  })

  it('исключённый критический вопрос даёт зачёт при том же балле — улучшение', () => {
    expect(rescoreVerdict({ score: 80, passed: false }, { score: 80, passed: true })).toBe('improved')
  })
})

describe('уведомления о склейке: 3-я и каждая 5-я жалоба (§8)', () => {
  it('сорок жалоб будят ответственного девять раз, а суточный предел оставляет три', () => {
    const due = Array.from({ length: 40 }, (_, i) => i + 1).filter(mergedNotifyDue)
    expect(due).toEqual([3, 5, 10, 15, 20, 25, 30, 35, 40])
    expect(mergedNotifyDue(1)).toBe(false)
    expect(mergedNotifyDue(2)).toBe(false)
    expect(mergedNotifyDue(4)).toBe(false)
  })
})

describe('маршрутизация: шаг (а) и набор правил (§6.3, §7.5)', () => {
  const rule = (over: Partial<Parameters<typeof matchingRules>[0][number]>) => ({
    id: Math.random().toString(36).slice(2), sort: 100, targetType: null, issueType: null, categoryId: null, fallback: false, isActive: true, ...over,
  })
  const issue = { targetType: 'question', issueType: 'wrong_key', categoryIds: ['cat-kitchen'] }

  it('пустой фильтр — «Будь-який», выигрывает меньший sort, запасное правило не участвует', () => {
    const r1 = rule({ sort: 50, issueType: 'wrong_key' })
    const r2 = rule({ sort: 10, categoryId: 'cat-kitchen' })
    const r3 = rule({ sort: 1, fallback: true })
    const r4 = rule({ sort: 5, issueType: 'typo' })
    const r5 = rule({ sort: 7, isActive: false })
    expect(matchingRules([r1, r2, r3, r4, r5], issue).map(r => r.id)).toEqual([r2.id, r1.id])
  })

  it('ровно одно активное запасное правило, если правила вообще есть', () => {
    expect(routingSetValid([])).toBe(true)
    expect(routingSetValid([{ fallback: false, isActive: true }])).toBe(false)
    expect(routingSetValid([{ fallback: true, isActive: true }, { fallback: false, isActive: true }])).toBe(true)
    expect(routingSetValid([{ fallback: true, isActive: false }])).toBe(false)
    expect(routingSetValid([{ fallback: true, isActive: true }, { fallback: true, isActive: true }])).toBe(false)
  })
})

describe('«Якість контенту»: нормировка на 100 прохождений (§9, критерий 9)', () => {
  it('2 жалобы на 40 прохождений выше 15 жалоб на 3000', () => {
    const small = { per100: perHundred(2, 40), complaints: 2 }
    const big = { per100: perHundred(15, 3000), complaints: 15 }
    expect(small.per100).toBe(5)
    expect(big.per100).toBe(0.5)
    expect([big, small].sort(compareQuality)[0]).toBe(small)
  })

  it('без прохождений нормировать нечего — строка уходит вниз, а не в топ', () => {
    const none = { per100: perHundred(9, 0), complaints: 9 }
    const some = { per100: perHundred(1, 1000), complaints: 1 }
    expect(none.per100).toBeNull()
    expect([none, some].sort(compareQuality)[0]).toBe(some)
  })
})

describe('кнопки карточки (§2, §5.4)', () => {
  const who = { canTriage: false, isAdmin: false, canRescore: false }

  it('керівник точки видит карточку без кнопок разбора', () => {
    expect(availableActions({ status: 'new', targetType: 'resource', resolution: null, rescoreState: 'none' }, who)).toEqual(['comment'])
  })

  it('автор берёт в работу, чинит, отклоняет и откладывает, но не пересчитывает баллы', () => {
    const a = availableActions({ status: 'in_progress', targetType: 'question', resolution: null, rescoreState: 'needed' }, { ...who, canTriage: true })
    expect(a).toEqual(expect.arrayContaining(['fix', 'reject', 'defer', 'note']))
    expect(a).not.toContain('rescore')
    expect(a).not.toContain('assign')
  })

  it('администратор пересчитывает подтверждённую жалобу на вопрос; закрыть вручную — после пересчёта', () => {
    const admin = { canTriage: true, isAdmin: true, canRescore: true }
    const pending = availableActions({ status: 'fixed', targetType: 'question', resolution: 'question_fixed', rescoreState: 'needed' }, admin)
    expect(pending).toContain('rescore')
    expect(pending).not.toContain('close')
    const done = availableActions({ status: 'fixed', targetType: 'question', resolution: 'question_fixed', rescoreState: 'done' }, admin)
    expect(done).toContain('close')
    expect(done).not.toContain('rescore')
  })
})
