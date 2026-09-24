import { describe, expect, it } from 'vitest'
import { reviewQueueQuerySchema, reviewQueueTabs } from '../../shared/schemas/review'
import { ENUMS, REVIEW_QUEUE_STATUSES, REVIEW_TASK_TYPES, REVIEW_TIME_CONFIDENCE } from '../../shared/enums'
import { reviewConflict } from '../../server/services/reviewQueue'

/**
 * PR-18 пакета `docs/v2`: правила единой очереди проверки, которые проверяются без БД —
 * контракт запроса (`44` В-15) и конфликт интересов проверяющего (`37` §7.7–7.8).
 * Состояние очереди, RLS и изоляция — в `tests/integration/v2-review-queue.spec.ts`.
 */

describe('контракт GET /review/queue', () => {
  it('умолчания: таб «Мої», только не просроченные не фильтруются, страница 50', () => {
    const p = reviewQueueQuerySchema.parse({})
    expect(p.tab).toBe('mine')
    expect(p.overdue).toBe(false)
    expect(p.limit).toBe(50)
    expect(p.taskType).toBeUndefined()
  })

  it('две оси разведены: таб — ответственность, taskType — вид работы (В-15 против 37 §10)', () => {
    expect([...reviewQueueTabs]).toEqual(['mine', 'delegated_in', 'delegated_out', 'done'])
    // Значения, которые `44` В-15 называл табами, — это фильтр «Тип завдання».
    for (const t of ['quiz_open_answer', 'workshop', 'offline_confirm', 'survey_open'] as const) {
      expect(reviewQueueQuerySchema.parse({ taskType: t }).taskType).toBe(t)
      expect(reviewQueueQuerySchema.safeParse({ tab: t }).success, `${t} не должен приниматься как таб`).toBe(false)
    }
  })

  it('страница ограничена сверху: очередь без предела — тот самый «голый массив с limit 200»', () => {
    expect(reviewQueueQuerySchema.safeParse({ limit: 201 }).success).toBe(false)
    expect(reviewQueueQuerySchema.parse({ limit: 200 }).limit).toBe(200)
  })

  it('фильтр «Тип суб\'єкта» принимает только вид человека, а не произвольную строку', () => {
    expect(reviewQueueQuerySchema.parse({ subjectKind: 'candidate' }).subjectKind).toBe('candidate')
    expect(reviewQueueQuerySchema.safeParse({ subjectKind: 'partner' }).success).toBe(false)
  })

  it('период — даты, курсор — короткая строка', () => {
    expect(reviewQueueQuerySchema.parse({ from: '2026-09-01', to: '2026-09-30' }).from).toBe('2026-09-01')
    expect(reviewQueueQuerySchema.safeParse({ from: 'вчора' }).success).toBe(false)
    expect(reviewQueueQuerySchema.safeParse({ cursor: 'x'.repeat(81) }).success).toBe(false)
  })
})

describe('перечисления очереди объявлены в одном месте (CLAUDE.md п. 13)', () => {
  it('review_task_type, review_queue_status и review_time_confidence есть в ENUMS', () => {
    expect(ENUMS.review_task_type).toEqual(REVIEW_TASK_TYPES)
    expect(ENUMS.review_queue_status).toEqual(REVIEW_QUEUE_STATUSES)
    expect(ENUMS.review_time_confidence).toEqual(REVIEW_TIME_CONFIDENCE)
  })

  it('статусов пять (`37` §4, PR-19: делегирование и эскалация), и done — единственный терминальный', () => {
    // PR-18 заводил три — делегирования и эскалации ещё не существовало. `delegated` и
    // `escalated` — не выдуманные значения, а состояния из `37` §4, внесённые в docs/02.
    expect([...REVIEW_QUEUE_STATUSES]).toEqual(['waiting', 'in_review', 'delegated', 'escalated', 'done'])
  })
})

describe('конфликт интересов проверяющего (37 §7.7–7.8)', () => {
  const tx = null as never // reviewConflict решает по входу, к БД не обращается

  it('своя работа — self: решение запрещено', async () => {
    expect(await reviewConflict(tx, { actorId: 'u1', subjectUserId: 'u1', authorIds: ['u2'] })).toBe('self')
  })

  it('автор материала — author: решение разрешено, но карточка предупреждает', async () => {
    expect(await reviewConflict(tx, { actorId: 'u1', subjectUserId: 'u2', authorIds: ['u3', 'u1'] })).toBe('author')
  })

  it('своя работа важнее авторства: автор собственной сдачи всё равно self', async () => {
    expect(await reviewConflict(tx, { actorId: 'u1', subjectUserId: 'u1', authorIds: ['u1'] })).toBe('self')
  })

  it('чужая работа без авторства — конфликта нет', async () => {
    expect(await reviewConflict(tx, { actorId: 'u1', subjectUserId: 'u2', authorIds: [] })).toBeNull()
    expect(await reviewConflict(tx, { actorId: 'u1', subjectUserId: 'u2', authorIds: null })).toBeNull()
  })
})
