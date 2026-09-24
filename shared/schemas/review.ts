import { z } from 'zod'
import { REVIEW_TASK_TYPES, USER_KINDS } from '../enums'
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
