import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  missingForPublish, newPublicToken, rollupCriterionScores, templateOf, unreviewedAiBlocks,
} from '../../server/services/vacancies'
import { vacancyAssignmentTemplateSchema, vacancyCloseSchema, vacancyCriterionSchema } from '../../shared/schemas/vacancies'

/**
 * Правила вакансии, проверяемые без БД (docs/v2/29-vacancies.md §3.3, §3.5, §7.1, §7.2, §7.9).
 * Всё, чей смысл — в том, что делает база (RLS, изоляция, неизменность созданного назначения),
 * живёт в `tests/integration/v2-vacancies.spec.ts`.
 */

describe('свёртка баллов по критериям (§3.3, критерий §13 к. 11)', () => {
  it('веса 3, 1, 1 и баллы 5, 2, 0 по шкале 0–5 дают ровно 6.80', () => {
    const { value } = rollupCriterionScores([
      { value: 5, weight: 3, scaleMin: 0, scaleMax: 5 },
      { value: 2, weight: 1, scaleMin: 0, scaleMax: 5 },
      { value: 0, weight: 1, scaleMin: 0, scaleMax: 5 },
    ])
    expect(value).toBe(6.8)
  })

  it('шкалы с разным началом сравнимы после нормировки', () => {
    // Середина шкалы 0–5 и середина шкалы 10–20 — одно и то же число 5.00 из десяти.
    expect(rollupCriterionScores([{ value: 2.5, weight: 1, scaleMin: 0, scaleMax: 5 }]).value).toBe(5)
    expect(rollupCriterionScores([{ value: 15, weight: 1, scaleMin: 10, scaleMax: 20 }]).value).toBe(5)
  })

  it('округление до сотых, а не до целых: 1/3 шкалы даёт 3.33', () => {
    expect(rollupCriterionScores([{ value: 1, weight: 1, scaleMin: 0, scaleMax: 3 }]).value).toBe(3.33)
  })

  it('пустой список не делит на ноль', () => {
    expect(rollupCriterionScores([]).value).toBe(0)
  })

  it('критический критерий с минимальным баллом предупреждает, но не запрещает (инвариант 18)', () => {
    const r = rollupCriterionScores([
      { value: 0, weight: 1, scaleMin: 0, scaleMax: 5, isCritical: true, name: 'Досвід' },
      { value: 5, weight: 1, scaleMin: 0, scaleMax: 5 },
    ])
    expect(r.criticalLow).toEqual(['Досвід'])
    // Итог посчитан, а не обнулён: решение принимает человек, а не критерий.
    expect(r.value).toBe(5)
  })
})

describe('публичный токен (§7.2)', () => {
  it('22 знака base62', () => {
    const token = newPublicToken()
    expect(token).toHaveLength(22)
    expect(token).toMatch(/^[A-Za-z0-9]{22}$/)
  })

  it('не повторяется на тысяче выдач', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => newPublicToken()))
    expect(seen.size).toBe(1000)
  })
})

describe('условия публикации (§7.1, критерий §13 к. 1)', () => {
  const base = { courseId: 'c', locationId: 'l', recruiterId: 'r', title: 'Бариста' } as never

  it('вакансия без курса не публикуется и называет, чего не хватает', () => {
    expect(missingForPublish({ ...(base as object), courseId: null } as never)).toEqual(['courseId'])
  })

  it('заполненная вакансия проходит', () => {
    expect(missingForPublish(base)).toEqual([])
  })
})

describe('непроверенный AI-текст (§7.9, критерий §13 к. 9)', () => {
  it('блок без правки и без подтверждения блокирует публикацию', () => {
    expect(unreviewedAiBlocks({ requirementsHtml: { acknowledged: false, editedAt: null } })).toEqual(['requirementsHtml'])
  })

  it('правка человеком или «Текст перевірено» снимают блокировку', () => {
    expect(unreviewedAiBlocks({ a: { editedAt: '2026-09-23T10:00:00Z' }, b: { acknowledged: true } })).toEqual([])
  })
})

describe('шаблон параметров назначения (§3.5, инвариант 1)', () => {
  it('неизвестные ключи отбрасываются, а не сохраняются', () => {
    const parsed = templateOf({ dueMode: 'relative', dueDays: 3, params: { passScore: 70, неизвестный: 1 } })
    expect(parsed.dueDays).toBe(3)
    expect(Object.keys(parsed.params)).not.toContain('неизвестный')
  })

  it('битая строка из БД не роняет карточку, а даёт пустой шаблон', () => {
    expect(templateOf('не объект').params).toEqual({})
    expect(templateOf(null).dueMode).toBe('relative')
  })

  it('абсолютного срока в шаблоне нет: вакансия живёт месяцами (решение PR-15)', () => {
    expect(vacancyAssignmentTemplateSchema.safeParse({ dueMode: 'absolute' }).success).toBe(false)
  })

  it('перечень ключей прохождения у шаблона тот же, что у назначения — своего второго нет', async () => {
    const { assignmentParamsSchema } = await import('../../shared/schemas/assignments')
    const template = vacancyAssignmentTemplateSchema.parse({ params: { passScore: 70, attemptsAllowed: 2 } })
    expect(assignmentParamsSchema.safeParse(template.params).success).toBe(true)
  })
})

/**
 * Сквозная проверка 13 (`docs/v2/42-stages-delta.md` §5): в схемах вакансии нет ключей
 * правил прохождения вне шаблона параметров. Здесь — тот же инвариант, что и в
 * `scripts/v2-crosschecks.sh`, но со стороны теста: скрипт легко забыть запустить локально.
 */
describe('вакансия не стала вторым носителем правил прохождения (сквозная проверка 13)', () => {
  it('в shared/schemas/vacancies.ts нет attempts / pass_score / due_at / time_limit', () => {
    const src = readFileSync(resolve(__dirname, '../../shared/schemas/vacancies.ts'), 'utf8')
    const hits = src.split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /attempts|pass_score|due_at|time_limit/i.test(line))
      .map(({ line, n }) => `${n}: ${line.trim()}`)
    expect(hits, `правила прохождения в схеме вакансии:\n${hits.join('\n')}`).toEqual([])
  })
})

describe('формы вакансии (§4, Г-29.5)', () => {
  it('причина «інше» требует текста — иначе other становится свалкой', () => {
    expect(vacancyCloseSchema.safeParse({ reason: 'other' }).success).toBe(false)
    expect(vacancyCloseSchema.safeParse({ reason: 'other', reasonText: 'Змінили структуру' }).success).toBe(true)
    expect(vacancyCloseSchema.safeParse({ reason: 'filled' }).success).toBe(true)
  })

  it('шкала критерия должна быть непустой', () => {
    expect(vacancyCriterionSchema.safeParse({ name: 'Досвід', scaleMin: 5, scaleMax: 5 }).success).toBe(false)
    expect(vacancyCriterionSchema.safeParse({ name: 'Досвід', scaleMin: 0, scaleMax: 5 }).success).toBe(true)
  })

  it('вес критерия строго больше нуля: нулевой вес — это выключенный критерий, а не оценка', () => {
    expect(vacancyCriterionSchema.safeParse({ name: 'Досвід', weight: 0 }).success).toBe(false)
  })
})
