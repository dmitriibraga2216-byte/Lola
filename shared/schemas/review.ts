import { z } from 'zod'
import { REVIEWER_ABSENCE_KINDS, REVIEW_DELEGATION_REASONS, REVIEW_ROUTING_STRATEGIES, REVIEW_TASK_TYPES, USER_KINDS } from '../enums'
import { KEYSETS } from '../domain/keyset'
import { keysetCursorSchema } from './keyset'

/**
 * Контракт единой очереди проверки — `GET /review/queue` (docs/v2/37 §10, решение
 * docs/v2/44 В-15). Один источник для клиента и сервера (CLAUDE.md п. 7).
 *
 * **Две разные оси, которые пакет называл одним словом `tab`.** `37` §10 перечисляет табы
 * `mine | delegated_out | delegated_in | done` (кто отвечает за работу), В-15 — значения
 * `quiz_open_answer | workshop | offline_confirm | survey_open` (что за работа). Это
 * расходящиеся описания одного параметра; разведены на `tab` (ответственность) и `taskType`
 * (вид работы), потому что экран `37` §5.1 показывает их одновременно: четыре таба сверху и
 * фильтр «Тип завдання» рядом с «Філії» и «Трек». Решение — Р-18.2 в `docs/v2/46-progress.md`.
 */
export const reviewQueueTabs = ['mine', 'delegated_in', 'delegated_out', 'done'] as const
export type ReviewQueueTab = typeof reviewQueueTabs[number]

export const reviewQueueQuerySchema = z.object({
  tab: z.enum(reviewQueueTabs).default('mine'),
  taskType: z.enum(REVIEW_TASK_TYPES).optional(), // «Тип завдання»
  locationId: z.string().uuid().optional(), // «Філії»
  trackId: z.string().uuid().optional(), // «Трек»
  reviewerId: z.string().uuid().optional(), // «Перевіряючий»
  subjectKind: z.enum(USER_KINDS).optional(), // «Тип суб'єкта»: Співробітники / Кандидати / Усі
  from: z.string().date().optional(), // «Вибрати період», нижняя граница по submitted_at
  to: z.string().date().optional(),
  overdue: z.boolean().default(false), // «Лише прострочені»
  /** Ключевой курсор `(-priority, submitted_at, id)` — непрозрачный, выдаёт сервер (`shared/domain/keyset.ts`). */
  cursor: keysetCursorSchema(KEYSETS.reviewQueue).optional(),
  limit: z.number().int().min(1).max(200).default(50),
})

export type ReviewQueueQuery = z.infer<typeof reviewQueueQuerySchema>

// ── Делегирование, распределение, отсутствия (`docs/v2/37` §6, §10; PR-19) ───────────────────

/**
 * «Делегування перевірки» (`37` §6.1). Срок делегата проверяет сервис: нижняя граница (+12 год)
 * и верхняя (срок проверки элемента) зависят от самого элемента, схема их не знает.
 */
export const reviewDelegateSchema = z.object({
  toUserId: z.string().uuid(),
  reasonCode: z.enum(REVIEW_DELEGATION_REASONS),
  reasonText: z.string().trim().max(500).optional(),
  dueAt: z.string().datetime({ offset: true }),
  notify: z.boolean().default(true),
}).superRefine((v, ctx) => {
  // «Поясніть причину: 10–500 символів» — только при «Інше» (§6.1), как и `rd_text_chk` в БД.
  if (v.reasonCode === 'other' && (v.reasonText ?? '').length < 10) {
    ctx.addIssue({ code: 'custom', path: ['reasonText'], message: 'reason_text_required' })
  }
})
export type ReviewDelegateInput = z.infer<typeof reviewDelegateSchema>

/**
 * «Делегувати обрані» (`37` §5.1, §10). Потолок 25 проверяет сервис (`422 review.bulk_limit`),
 * а не схема: иначе превышение превратилось бы в безликий `validation_failed`.
 */
export const reviewBulkDelegateSchema = z.object({
  itemIds: z.array(z.string().uuid()).min(1).max(500),
  toUserId: z.string().uuid(),
  reasonCode: z.enum(REVIEW_DELEGATION_REASONS),
  reasonText: z.string().trim().max(500).optional(),
  dueAt: z.string().datetime({ offset: true }),
  notify: z.boolean().default(true),
})
export type ReviewBulkDelegateInput = z.infer<typeof reviewBulkDelegateSchema>

/** «Відкликання делегування» (`37` §6.1): причина необязательна автору, обязательна руководителю. */
export const reviewRevokeSchema = z.object({
  reason: z.string().trim().max(500).optional(),
})

/** «Переназначити» (`37` §5.1, §10) — только `review.delegate.any`, причина обязательна. */
export const reviewReassignSchema = z.object({
  toUserId: z.string().uuid(),
  reason: z.string().trim().min(3).max(500),
})

/** «Відсутність перевіряючого» (`37` §6.2). Диапазон и «не сам себе» проверяет сервис — со своими кодами ошибок. */
export const reviewAbsenceSchema = z.object({
  userId: z.string().uuid(),
  kind: z.enum(REVIEWER_ABSENCE_KINDS),
  startsOn: z.string().date(),
  endsOn: z.string().date().optional(),
  substituteId: z.string().uuid().optional(),
  moveOpenItems: z.boolean().default(true),
})
export type ReviewAbsenceInput = z.infer<typeof reviewAbsenceSchema>

/** «Змінити ліміт» на экране нагрузки (`37` §5.3) и «приймаю делегування» самого проверяющего (§7.2 (д)). */
export const reviewCapacitySchema = z.object({
  maxOpenItems: z.number().int().min(1).max(200).optional(),
  dailyTarget: z.number().int().min(1).max(200).optional(),
  acceptsDelegation: z.boolean().optional(),
  taskTypes: z.array(z.enum(REVIEW_TASK_TYPES)).optional(),
})
export type ReviewCapacityInput = z.infer<typeof reviewCapacitySchema>

/** Правило распределения (`37` §3.3). Область пустая — весь тенант. */
export const reviewRoutingRuleSchema = z.object({
  nameUk: z.string().trim().min(1).max(200),
  priority: z.number().int().min(0).max(10_000).default(100),
  matchScope: z.object({
    locationIds: z.array(z.string().uuid()).optional(),
    orgNodeIds: z.array(z.string().uuid()).optional(),
    positionIds: z.array(z.string().uuid()).optional(),
    courseIds: z.array(z.string().uuid()).optional(),
  }).default({}),
  matchSubjectKind: z.enum(USER_KINDS).nullable().optional(),
  matchTaskTypes: z.array(z.enum(REVIEW_TASK_TYPES)).default([]),
  strategy: z.enum(REVIEW_ROUTING_STRATEGIES).default('round_robin'),
  reviewerIds: z.array(z.string().uuid()).max(100).default([]),
  fallbackUserId: z.string().uuid().nullable().optional(),
  slaHoursOverride: z.number().int().min(1).max(720).nullable().optional(),
  isActive: z.boolean().default(true),
})
export type ReviewRoutingRuleInput = z.infer<typeof reviewRoutingRuleSchema>

/** Экран нагрузки (`37` §5.3, §10 `GET /review/workload`): фильтр по точке. */
export const reviewWorkloadQuerySchema = z.object({
  locationId: z.string().uuid().optional(),
})
