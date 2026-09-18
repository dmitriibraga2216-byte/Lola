import { describe, expect, it } from 'vitest'
import { computeTotals, gradeAnswer, type SnapshotQuestion } from '../../shared/domain/grading'

const base = (over: Partial<SnapshotQuestion>): SnapshotQuestion => ({
  id: 'q',
  version: 1,
  kind: 'single',
  stem: [],
  options: null,
  answer: null,
  explanation: null,
  points: 1,
  isCritical: false,
  partialCredit: true,
  negativeMarking: false,
  ...over,
})

describe('gradeAnswer', () => {
  it('single: верно / неверно / пусто', () => {
    const q = base({ kind: 'single', answer: { correctId: 'b' } })
    expect(gradeAnswer(q, { optionId: 'b' })).toMatchObject({ isCorrect: true, score: 1 })
    expect(gradeAnswer(q, { optionId: 'a' })).toMatchObject({ isCorrect: false, score: 0 })
    expect(gradeAnswer(q, null)).toMatchObject({ isCorrect: false, score: 0 })
  })

  it('multiple с частичным баллом: 3 верных из 4 + 1 лишний → points × (3−1)/4 при negativeMarking', () => {
    const q = base({ kind: 'multiple', points: 4, negativeMarking: true, answer: { correctIds: ['a', 'b', 'c', 'd'] } })
    const r = gradeAnswer(q, { optionIds: ['a', 'b', 'c', 'x'] })
    expect(r.isCorrect).toBe(false)
    expect(r.score).toBe(2) // 4 × (3−1)/4
  })

  it('multiple без штрафа: лишний не вычитается; requireExact — всё или ничего', () => {
    const q = base({ kind: 'multiple', points: 4, answer: { correctIds: ['a', 'b', 'c', 'd'] } })
    expect(gradeAnswer(q, { optionIds: ['a', 'b', 'c', 'x'] }).score).toBe(3)
    const exact = base({ kind: 'multiple', points: 4, requireExact: true, answer: { correctIds: ['a', 'b'] } })
    expect(gradeAnswer(exact, { optionIds: ['a'] }).score).toBe(0)
    expect(gradeAnswer(exact, { optionIds: ['a', 'b'] }).score).toBe(4)
  })

  it('multiple: балл не меньше 0', () => {
    const q = base({ kind: 'multiple', points: 2, negativeMarking: true, answer: { correctIds: ['a'] } })
    expect(gradeAnswer(q, { optionIds: ['x', 'y', 'z'] }).score).toBe(0)
  })

  it('order: частичный балл по парам', () => {
    const q = base({ kind: 'order', points: 3, answer: { order: ['a', 'b', 'c'] } })
    expect(gradeAnswer(q, { order: ['a', 'b', 'c'] })).toMatchObject({ isCorrect: true, score: 3 })
    // b,a,c: пары (a,b) нет, (a,c) есть, (b,c) есть → 2/3
    expect(gradeAnswer(q, { order: ['b', 'a', 'c'] }).score).toBe(2)
    expect(gradeAnswer(q, { order: ['c', 'b', 'a'] }).score).toBe(0)
  })

  it('match: доля верных пар', () => {
    const q = base({ kind: 'match', points: 2, answer: { pairs: [{ leftId: 'l1', rightId: 'r1' }, { leftId: 'l2', rightId: 'r2' }] } })
    expect(gradeAnswer(q, { pairs: [{ leftId: 'l1', rightId: 'r1' }, { leftId: 'l2', rightId: 'r9' }] }).score).toBe(1)
  })

  it('number: допуск абсолютный и процентный, запятая как разделитель', () => {
    const abs = base({ kind: 'number', answer: { value: 4, tolerance: 0.5 } })
    expect(gradeAnswer(abs, { value: 4.4 }).isCorrect).toBe(true)
    expect(gradeAnswer(abs, { value: '4,5' }).isCorrect).toBe(true)
    expect(gradeAnswer(abs, { value: 4.6 }).isCorrect).toBe(false)
    const pct = base({ kind: 'number', answer: { value: 200, tolerance: 10, toleranceType: 'pct' } })
    expect(gradeAnswer(pct, { value: 219 }).isCorrect).toBe(true)
    expect(gradeAnswer(pct, { value: 221 }).isCorrect).toBe(false)
  })

  it('text_short: нормализация регистра/пробелов и опечатки по Левенштейну', () => {
    const q = base({ kind: 'text_short', answer: { accepted: ['Моцарела', 'моцарелла'], allowTypos: 1 } })
    expect(gradeAnswer(q, { text: '  моцарела ' }).isCorrect).toBe(true)
    expect(gradeAnswer(q, { text: 'моцарэла' }).isCorrect).toBe(true) // 1 опечатка
    expect(gradeAnswer(q, { text: 'пармезан' }).isCorrect).toBe(false)
    const strict = base({ kind: 'text_short', answer: { accepted: ['Так'], caseSensitive: true } })
    expect(gradeAnswer(strict, { text: 'так' }).isCorrect).toBe(false)
  })

  it('text_long и file — ручная проверка', () => {
    expect(gradeAnswer(base({ kind: 'text_long' }), { text: 'довга відповідь' })).toMatchObject({ isCorrect: null, auto: false })
    expect(gradeAnswer(base({ kind: 'file' }), { mediaIds: ['x'] })).toMatchObject({ isCorrect: null, auto: false })
  })
})

describe('computeTotals', () => {
  const qs = [
    base({ id: 'a', kind: 'single', points: 1, answer: { correctId: 'x' } }),
    base({ id: 'b', kind: 'single', points: 1, answer: { correctId: 'x' } }),
    base({ id: 'c', kind: 'single', points: 2, isCritical: true, answer: { correctId: 'x' } }),
  ]

  it('95% но ошибка в критическом → failed', () => {
    const answers = new Map([
      ['a', gradeAnswer(qs[0]!, { optionId: 'x' })],
      ['b', gradeAnswer(qs[1]!, { optionId: 'x' })],
      ['c', gradeAnswer(qs[2]!, { optionId: 'wrong' })],
    ])
    const t = computeTotals(qs, answers, 40)
    expect(t.score).toBe(50)
    expect(t.criticalFailed).toBe(true)
    expect(t.passed).toBe(false)
  })

  it('все верно → passed, score 100', () => {
    const answers = new Map(qs.map(q => [q.id, gradeAnswer(q, { optionId: 'x' })]))
    expect(computeTotals(qs, answers, 80)).toMatchObject({ score: 100, passed: true })
  })

  it('есть ручные непроверенные → passed = null', () => {
    const withManual = [...qs, base({ id: 'd', kind: 'text_long', points: 1 })]
    const answers = new Map(withManual.map(q => [q.id, gradeAnswer(q, { optionId: 'x', text: 'x' })]))
    const t = computeTotals(withManual, answers, 80)
    expect(t.pendingManual).toBe(1)
    expect(t.passed).toBeNull()
  })

  it('неотвеченный критический считается провалом', () => {
    const answers = new Map([['a', gradeAnswer(qs[0]!, { optionId: 'x' })]])
    expect(computeTotals(qs, answers, 10).criticalFailed).toBe(true)
  })
})
