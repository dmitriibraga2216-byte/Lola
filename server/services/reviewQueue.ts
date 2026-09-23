import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { attempts, locations, positions, reviewQueueItems, userPlacements, users, workshops } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { personById } from './repo/people'
import type { ReviewQueueQuery } from '../../shared/schemas/review'
import type { ReviewTaskType } from '../../shared/enums'

interface Ctx { tenantId: string, actorId: string }

/**
 * Единая очередь проверки — единственный писатель таблицы `review_queue_items`
 * (docs/14 §3.3, docs/v2/37-review-delegation.md, решения docs/v2/44 В-2 и В-15).
 *
 * Очередь **поддерживается, а не пересобирается**: сквозная проверка 21 (`docs/v2/42` §5)
 * требует, чтобы в коде не было ни `truncate`, ни `delete from review_queue_items`. Причина
 * не в аккуратности, а в том, что собственное состояние строки — `assigned_reviewer_id`,
 * `sla_breached_at`, `delegation_depth`, `origin_reviewer_id` — из источников не
 * восстанавливается: пересборка «с нуля» молча стёрла бы делегирование и историю SLA.
 *
 * Отсюда два правила, которым подчиняются все функции ниже:
 *   1. **Ставит в очередь только `enqueueReview()`**, и только в транзакции самого события
 *      (сдача практикума, отправка попытки с ручными ответами). Никакого триггера и никакой
 *      задачи «раз в минуту»: два наставника не должны брать одну работу в окне обновления.
 *   2. **Закрывает только `closeReview()`** — строка переходит в `done`, а не исчезает.
 *      Повторная сдача после доработки открывает **ту же** строку заново (источник
 *      переиспользует ту же `workshop_submissions.id`).
 */

/** Захват карточки протухает через 30 минут бездействия (docs/13 §4.2) — как у практикумов. */
const CLAIM_TTL_MS = 30 * 60_000

export interface EnqueueInput {
  tenantId: string
  taskType: ReviewTaskType
  /** Строка источника: `attempt_answers.id` | `workshop_submissions.id` | … */
  sourceId: string
  /** Чья работа. `subject_kind` снимается отсюда один раз — при постановке. */
  userId: string
  taskTitle?: string | null
  /** Курс или траектория, внутри которой сдана работа. Вне трека — `null`, и это не ошибка. */
  trackId?: string | null
  submittedAt?: Date
  attemptNo?: number
  slaHours?: number
  estimatedSeconds?: number | null
  /** Просроченные и аттестации выше (docs/14 §3.3). Больше — раньше. */
  priority?: number
}

/**
 * Единственная точка постановки работы в очередь.
 *
 * `subject_kind` берётся из `users.kind` **здесь и один раз** (решения В-8 × В-2): дальше
 * очередь читается без join к `users` и без фильтра по виду человека вовсе — фильтр уже
 * применён. Найм кандидата не переписывает стоящие в очереди работы: карточка проверки
 * маскирует ПД по состоянию на момент сдачи, а не на момент открытия.
 *
 * Точка (`location_id`) и должность (`position_id`) — тоже снимки: перевод человека на другую
 * точку не должен задним числом перекладывать его старую работу в чужую очередь.
 *
 * Идемпотентна по `(tenant_id, task_type, source_id)`. Повторный вызов на той же работе
 * (пересдача после доработки) **открывает ту же строку заново** — `status` возвращается в
 * `waiting`, захват и решение снимаются, срок считается от новой сдачи. Делегирование и
 * происхождение (`origin_reviewer_id`, `delegation_depth`) сохраняются: передача
 * ответственности пережила доработку.
 */
export async function enqueueReview(tx: TenantTx, input: EnqueueInput): Promise<string> {
  const [person] = await personById(tx, { kind: users.kind }, input.userId)
  const [placement] = await tx.select({ locationId: userPlacements.locationId, positionId: userPlacements.positionId })
    .from(userPlacements)
    .where(and(eq(userPlacements.userId, input.userId), eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt)))
    .limit(1)

  const submittedAt = input.submittedAt ?? new Date()
  const slaHours = input.slaHours ?? 48
  const slaDueAt = new Date(submittedAt.getTime() + slaHours * 3_600_000)

  const [row] = await tx.insert(reviewQueueItems).values({
    tenantId: input.tenantId,
    taskType: input.taskType,
    sourceId: input.sourceId,
    userId: input.userId,
    subjectKind: person?.kind ?? 'employee',
    taskTitle: input.taskTitle ?? null,
    trackId: input.trackId ?? null,
    locationId: placement?.locationId ?? null,
    positionId: placement?.positionId ?? null,
    submittedAt,
    attemptNo: input.attemptNo ?? 1,
    status: 'waiting',
    priority: input.priority ?? 0,
    slaHours,
    slaDueAt,
    estimatedSeconds: input.estimatedSeconds ?? null,
  }).onConflictDoUpdate({
    target: [reviewQueueItems.tenantId, reviewQueueItems.taskType, reviewQueueItems.sourceId],
    set: {
      status: 'waiting',
      submittedAt,
      slaHours,
      slaDueAt,
      attemptNo: input.attemptNo ?? 1,
      taskTitle: input.taskTitle ?? null,
      trackId: input.trackId ?? null,
      locationId: placement?.locationId ?? null,
      positionId: placement?.positionId ?? null,
      priority: input.priority ?? 0,
      // Пересдача — новая работа: захват, решение и отметки порогов снимаются…
      assignedReviewerId: null,
      assignedAt: null,
      completedAt: null,
      slaWarnedAt: null,
      slaBreachedAt: null,
      escalatedAt: null,
      escalatedToId: null,
      updatedAt: new Date(),
      // …а делегирование и происхождение остаются: ответственность передана раньше и не
      // отменяется доработкой (`37` §7.3). Поэтому delegation_id / origin_reviewer_id /
      // delegation_depth здесь не трогаются.
    },
  }).returning({ id: reviewQueueItems.id })

  return row!.id
}

/**
 * Закрытие элемента очереди: решение принято. Строка остаётся — она нужна архиву «Завершені»,
 * статистике проверяющего и отчёту по делегированиям; `delete` запрещён (проверка 21).
 *
 * `reviewerId` проставляется, если работа закрыта без явного захвата: ручной ответ теста
 * оценивают прямо из карточки, `claim` там не вызывается, а знать, кто решил, нужно.
 */
export async function closeReview(tx: TenantTx, input: { taskType: ReviewTaskType, sourceIds: string[], reviewerId?: string | null, at?: Date }): Promise<number> {
  if (!input.sourceIds.length) return 0
  const at = input.at ?? new Date()
  const rows = await tx.update(reviewQueueItems).set({
    status: 'done',
    completedAt: at,
    updatedAt: at,
    ...(input.reviewerId ? { assignedReviewerId: sql`coalesce(${reviewQueueItems.assignedReviewerId}, ${input.reviewerId}::uuid)` } : {}),
  }).where(and(
    eq(reviewQueueItems.taskType, input.taskType),
    inArray(reviewQueueItems.sourceId, input.sourceIds),
    sql`${reviewQueueItems.status} <> 'done'`,
  )).returning({ id: reviewQueueItems.id })
  return rows.length
}

/** Взятие работы в проверку. Зеркало `workshop_submissions.reviewer_id` пишет вызывающий сервис. */
export async function claimReview(tx: TenantTx, input: { taskType: ReviewTaskType, sourceId: string, reviewerId: string, at?: Date }): Promise<void> {
  const at = input.at ?? new Date()
  await tx.update(reviewQueueItems).set({ status: 'in_review', assignedReviewerId: input.reviewerId, assignedAt: at, updatedAt: at })
    .where(and(eq(reviewQueueItems.taskType, input.taskType), eq(reviewQueueItems.sourceId, input.sourceId), sql`${reviewQueueItems.status} <> 'done'`))
}

/** Возврат работы в очередь: «Пропустити», освобождение протухшего захвата, снятие назначения. */
export async function releaseReview(tx: TenantTx, input: { taskType: ReviewTaskType, sourceIds: string[], at?: Date }): Promise<void> {
  if (!input.sourceIds.length) return
  const at = input.at ?? new Date()
  await tx.update(reviewQueueItems).set({ status: 'waiting', assignedReviewerId: null, assignedAt: null, updatedAt: at })
    .where(and(eq(reviewQueueItems.taskType, input.taskType), inArray(reviewQueueItems.sourceId, input.sourceIds), eq(reviewQueueItems.status, 'in_review')))
}

export type ReviewConflict = 'self' | 'author' | null

/**
 * Конфликт интересов проверяющего (docs/v2/37 §7.7–7.8, критерий приёмки `37` §13 п. 6).
 *
 * Два разных случая и два разных ответа, их нельзя смешивать:
 *   - `self` — своя работа. Решение запрещено, кнопки заблокированы; в очередь такая работа
 *     не попадает вовсе (критерий `37` §13 п. 5).
 *   - `author` — наставник входит в `author_ids` материала. Решение **разрешено**: он и есть
 *     эксперт по этому материалу. Карточка показывает жёлтую плашку «оцінюйте роботу, а не
 *     свій контент», а факт пишется в `audit_log` и попадает в отчёт `37` §9.2.
 */
export async function reviewConflict(tx: TenantTx, input: { actorId: string, subjectUserId: string, authorIds?: string[] | null }): Promise<ReviewConflict> {
  if (input.actorId === input.subjectUserId) return 'self'
  if (input.authorIds?.includes(input.actorId)) return 'author'
  return null
}

/** Строка очереди в ответе `/review/queue` (`37` §5.1 — первые десять колонок в порядке эталона). */
export interface ReviewQueueRow {
  id: string
  taskType: ReviewTaskType
  sourceId: string
  userId: string
  fullName: string | null
  subjectKind: string
  locationName: string | null
  positionName: string | null
  trackId: string | null
  taskTitle: string | null
  attemptNo: number
  estimatedSeconds: number | null
  contentSeconds: number
  attemptSeconds: number
  timeConfidence: string
  submittedAt: Date
  completedAt: Date | null
  status: string
  priority: number
  assignedReviewerId: string | null
  reviewerName: string | null
  delegationDepth: number
  slaDueAt: Date | null
  hoursLeft: number | null
  overdue: boolean
}

/**
 * Единая очередь поверх таблицы (решение В-15). Три базовых пути (`/review/answers`,
 * `/review/workshops`, действия на `/review/submissions/:id/*`) остаются: они несут фильтры,
 * которых у очереди нет (метки вопросов, «Поза програмами», «Поза курсами») и завязаны на
 * работающие экраны.
 *
 * Своя работа не показывается ни в одном табе (`37` §13 критерий 5) — условие стоит в базе
 * выборки, а не в табе, чтобы его нельзя было обойти сменой фильтра.
 *
 * Ответ несёт `total` (счётчик на табе «Мої» из `37` §5.1) и ключевой курсор: прежние очереди
 * отдавали голый массив с жёстким `limit 200`, на котором экран `37` §5 не рисуется.
 */
export async function listReviewQueue(ctx: Ctx, filter: ReviewQueueQuery): Promise<{ items: ReviewQueueRow[], total: number, cursor: string | null }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    // ISO-строка с явным приведением: postgres.js не связывает Date в сыром фрагменте sql``
    // (тип параметра там не выводится) — так же сделано в workshops.ts.
    const staleClaim = new Date(Date.now() - CLAIM_TTL_MS).toISOString()
    const conds = [
      // Своя работа не попадает в очередь проверяющего ни при каком табе и фильтре.
      sql`${reviewQueueItems.userId} <> ${ctx.actorId}::uuid`,
      ...(filter.taskType ? [eq(reviewQueueItems.taskType, filter.taskType)] : []),
      ...(filter.locationId ? [eq(reviewQueueItems.locationId, filter.locationId)] : []),
      ...(filter.trackId ? [eq(reviewQueueItems.trackId, filter.trackId)] : []),
      ...(filter.reviewerId ? [eq(reviewQueueItems.assignedReviewerId, filter.reviewerId)] : []),
      ...(filter.subjectKind ? [eq(reviewQueueItems.subjectKind, filter.subjectKind)] : []),
      ...(filter.from ? [sql`${reviewQueueItems.submittedAt} >= ${filter.from}::date`] : []),
      ...(filter.to ? [sql`${reviewQueueItems.submittedAt} < (${filter.to}::date + 1)`] : []),
      ...(filter.overdue ? [sql`${reviewQueueItems.slaDueAt} < now()`] : []),
    ]

    // Табы — ось ответственности (`37` §10). «Делеговані» наполнятся с PR-19, когда появится
    // `review_delegations`; до него оба таба честно пусты, а не отсутствуют: условие
    // проверяемо уже сейчас, колонки `delegation_id` и `origin_reviewer_id` есть.
    if (filter.tab === 'mine') {
      conds.push(sql`${reviewQueueItems.status} in ('waiting', 'in_review')`)
      conds.push(sql`(${reviewQueueItems.assignedReviewerId} is null
        or ${reviewQueueItems.assignedReviewerId} = ${ctx.actorId}::uuid
        or ${reviewQueueItems.assignedAt} < ${staleClaim}::timestamptz)`)
    }
    if (filter.tab === 'delegated_in') {
      conds.push(sql`${reviewQueueItems.status} in ('waiting', 'in_review')`)
      conds.push(sql`${reviewQueueItems.delegationId} is not null and ${reviewQueueItems.assignedReviewerId} = ${ctx.actorId}::uuid`)
    }
    if (filter.tab === 'delegated_out') {
      conds.push(sql`${reviewQueueItems.delegationId} is not null and ${reviewQueueItems.originReviewerId} = ${ctx.actorId}::uuid`)
    }
    if (filter.tab === 'done') {
      // «Завершені» — архив области, а не личный список: проверяющий должен видеть, чем
      // закончились работы, которые он отдал или которые брал не он (`37` §5.1, четвёртый
      // таб). Область видимости задаёт скоуп `review.queue` и RLS, а не сам таб.
      conds.push(eq(reviewQueueItems.status, 'done'))
    }

    const [counted] = await tx.select({ total: sql<number>`count(*)::int` }).from(reviewQueueItems).where(and(...conds))

    const page = [...conds]
    if (filter.cursor) {
      const [priority, ms, id] = filter.cursor.split('_')
      // Ключевой курсор по тому же ключу, что и сортировка: одинаковое направление всех
      // колонок достигнуто знаком у priority — строчное сравнение иначе неприменимо.
      page.push(sql`(-${reviewQueueItems.priority}, ${reviewQueueItems.submittedAt}, ${reviewQueueItems.id})
        > (${-Number(priority)}, ${new Date(Number(ms)).toISOString()}::timestamptz, ${id}::uuid)`)
    }

    // Псевдоним `users` ради имени проверяющего — выборка по первичному ключу, вид человека
    // здесь не при чём (`repo/people.ts`, «Точечные выборки»).
    const reviewer = alias(users, 'reviewer')
    const rows = await tx.select({
      id: reviewQueueItems.id,
      taskType: reviewQueueItems.taskType,
      sourceId: reviewQueueItems.sourceId,
      userId: reviewQueueItems.userId,
      fullName: users.fullName,
      subjectKind: reviewQueueItems.subjectKind,
      locationName: locations.name,
      positionName: positions.name,
      trackId: reviewQueueItems.trackId,
      taskTitle: reviewQueueItems.taskTitle,
      attemptNo: reviewQueueItems.attemptNo,
      estimatedSeconds: reviewQueueItems.estimatedSeconds,
      contentSeconds: reviewQueueItems.contentSeconds,
      attemptSeconds: reviewQueueItems.attemptSeconds,
      timeConfidence: reviewQueueItems.timeConfidence,
      submittedAt: reviewQueueItems.submittedAt,
      completedAt: reviewQueueItems.completedAt,
      status: reviewQueueItems.status,
      priority: reviewQueueItems.priority,
      assignedReviewerId: reviewQueueItems.assignedReviewerId,
      reviewerName: reviewer.fullName,
      delegationDepth: reviewQueueItems.delegationDepth,
      slaDueAt: reviewQueueItems.slaDueAt,
    })
      .from(reviewQueueItems)
      // Соединение ради ФИО и снимков названий: вид человека уже снят в subject_kind,
      // повторно фильтровать `users.kind` здесь не нужно и нечем (docs/v2/44 В-8 × В-2).
      .innerJoin(users, eq(users.id, reviewQueueItems.userId))
      .leftJoin(locations, eq(locations.id, reviewQueueItems.locationId))
      .leftJoin(positions, eq(positions.id, reviewQueueItems.positionId))
      .leftJoin(reviewer, eq(reviewer.id, reviewQueueItems.assignedReviewerId))
      .where(and(...page))
      .orderBy(sql`-${reviewQueueItems.priority}`, reviewQueueItems.submittedAt, reviewQueueItems.id)
      .limit(filter.limit + 1)

    const hasMore = rows.length > filter.limit
    const items = (hasMore ? rows.slice(0, filter.limit) : rows).map(r => ({
      ...r,
      taskType: r.taskType as ReviewTaskType,
      hoursLeft: r.slaDueAt ? Math.round((r.slaDueAt.getTime() - Date.now()) / 3_600_000) : null,
      overdue: !!r.slaDueAt && r.slaDueAt.getTime() < Date.now() && r.status !== 'done',
    }))
    const last = items[items.length - 1]

    return {
      items,
      total: counted?.total ?? 0,
      cursor: hasMore && last ? `${last.priority}_${last.submittedAt.getTime()}_${last.id}` : null,
    }
  })
}

/**
 * Название и трек работы для снимка очереди. Отдельной функцией, чтобы оба писателя
 * (практикум и ответ теста) клали в очередь одно и то же, а не каждый своё.
 */
export async function workshopSnapshot(tx: TenantTx, workshopId: string) {
  const [w] = await tx.select({ title: workshops.title, slaHours: workshops.slaHours, authorIds: workshops.authorIds })
    .from(workshops).where(eq(workshops.id, workshopId))
  return w ?? null
}

/** Номер попытки теста — «Кількість спроб» строки очереди для развёрнутого ответа. */
export async function attemptSnapshot(tx: TenantTx, attemptId: string) {
  const [a] = await tx.select({ attemptNo: attempts.attemptNo, userId: attempts.userId, enrollmentId: attempts.enrollmentId, submittedAt: attempts.submittedAt })
    .from(attempts).where(eq(attempts.id, attemptId))
  return a ?? null
}
