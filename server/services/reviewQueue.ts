import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { attempts, locations, positions, reviewDelegations, reviewQueueItems, userPlacements, users, vacancies, workshops } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { keysetAfter, keysetAt } from '../utils/keyset'
import { KEYSETS, encodeKeyset } from '../../shared/domain/keyset'
import { personById } from './repo/people'
import { closeDelegations } from './reviewDelegation'
import { routeQueueItem } from './reviewRouting'
import { CLAIM_TTL_MS, claimIsLive, restingStatus } from './reviewRules'
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
 *
 * **Назначение и захват — разные вещи (PR-19).** `assigned_reviewer_id` — кто отвечает
 * (правило распределения, делегирование, переназначение; `null` — общий пул).
 * `claimed_by` / `claimed_at` — у кого карточка открыта сейчас; через 30 минут бездействия
 * захват протухает (`docs/13` §4.2). «Пропустити» снимает захват, но не назначение.
 */

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
 * Точка работы для снимка. Сотрудник — основное размещение. Кандидат должности не занимает
 * (`docs/v2/28` §2), и без точки его работа не раскрывала бы области проверяющим (`37` §7.2
 * (б)); его точка — точка вакансии, на которую он откликнулся.
 */
async function locationSnapshot(tx: TenantTx, userId: string, kind: string | undefined, vacancyId: string | null | undefined) {
  const [placement] = await tx.select({ locationId: userPlacements.locationId, positionId: userPlacements.positionId })
    .from(userPlacements)
    .where(and(eq(userPlacements.userId, userId), eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt)))
    .limit(1)
  if (placement || kind !== 'candidate' || !vacancyId) return { locationId: placement?.locationId ?? null, positionId: placement?.positionId ?? null }
  const [v] = await tx.select({ locationId: vacancies.locationId }).from(vacancies).where(eq(vacancies.id, vacancyId))
  return { locationId: v?.locationId ?? null, positionId: null }
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
 * (пересдача после доработки) **открывает ту же строку заново** как новую работу: захват,
 * решение, отметки порогов и назначение снимаются, срок считается от новой сдачи. Делегирование
 * к этому моменту уже закрыто самим решением «на доопрацювання» (`37` §7.4: решение делегата
 * окончательное), поэтому пересдача распределяется заново, как любая новая работа (Р-19.5).
 *
 * В той же транзакции работа уходит в распределение (`routeQueueItem`, `37` §7.16): правила
 * назначают проверяющего, без правил работа остаётся в общем пуле.
 */
export async function enqueueReview(tx: TenantTx, input: EnqueueInput): Promise<string> {
  const [person] = await personById(tx, { kind: users.kind, vacancyId: users.vacancyId }, input.userId)
  const place = await locationSnapshot(tx, input.userId, person?.kind, person?.vacancyId)

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
    locationId: place.locationId,
    positionId: place.positionId,
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
      locationId: place.locationId,
      positionId: place.positionId,
      priority: input.priority ?? 0,
      // «Розрахунковий час» — снимок на момент **этой** сдачи (docs/v2/37 §7.14, PR-22): норма,
      // исправленная автором между доработками, доходит до пересдачи, а прежние работы не трогает
      estimatedSeconds: input.estimatedSeconds ?? null,
      // Пересдача — новая работа: назначение, захват, решение, делегирование и отметки порогов
      // снимаются, распределение ниже решает заново (Р-19.5).
      assignedReviewerId: null,
      assignedAt: null,
      assignedByRuleId: null,
      delegationId: null,
      delegationDepth: 0,
      originReviewerId: null,
      claimedBy: null,
      claimedAt: null,
      completedAt: null,
      slaWarnedAt: null,
      slaBreachedAt: null,
      escalatedAt: null,
      escalatedToId: null,
      updatedAt: new Date(),
    },
  }).returning({ id: reviewQueueItems.id })

  // Звенья, оставшиеся активными от прошлой сдачи, закрываются: их некому нести (решение
  // закрывает их само, это страховка от строки, закрытой мимо closeReview()).
  await tx.update(reviewDelegations).set({ state: 'cancelled', resolvedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(reviewDelegations.queueItemId, row!.id), eq(reviewDelegations.state, 'active')))

  await routeQueueItem(tx, input.tenantId, row!.id, { reason: 'enqueue' })

  // Подсказка ИИ проверяющему (`docs/v2/30` §7.13, PR-29): триггер — новая работа на проверке, и
  // точка постановки та же — одна на все пути сдачи. Подсказка не участвует ни в назначении, ни в
  // решении: строка `ai_review_hints` заводится рядом, модель зовёт задача `ai.review_hint`.
  const { requestReviewHintTx } = await import('./reviewHints')
  await requestReviewHintTx(tx, { tenantId: input.tenantId, taskType: input.taskType, sourceId: input.sourceId, userId: input.userId })
  return row!.id
}

/**
 * Закрытие элемента очереди: решение принято. Строка остаётся — она нужна архиву «Завершені»,
 * статистике проверяющего и отчёту по делегированиям; `delete` запрещён (проверка 21).
 *
 * `reviewerId` — кто принял решение; он и становится итоговым `assigned_reviewer_id`
 * (эскалированную работу мог решить руководитель, а не назначенный). Без `reviewerId` работа
 * закрыта без решения (аннулирована попытка, истекла доработка) — делегирование `cancelled`.
 * `decision` — текст результата для `review_delegation_resolved` делегировавшему (`37` §7.4).
 */
export async function closeReview(tx: TenantTx, input: { taskType: ReviewTaskType, sourceIds: string[], reviewerId?: string | null, decision?: string | null, at?: Date }): Promise<number> {
  if (!input.sourceIds.length) return 0
  const at = input.at ?? new Date()
  const rows = await tx.update(reviewQueueItems).set({
    status: 'done',
    completedAt: at,
    updatedAt: at,
    ...(input.reviewerId ? { assignedReviewerId: input.reviewerId } : {}),
  }).where(and(
    eq(reviewQueueItems.taskType, input.taskType),
    inArray(reviewQueueItems.sourceId, input.sourceIds),
    sql`${reviewQueueItems.status} <> 'done'`,
  )).returning({ id: reviewQueueItems.id, userId: reviewQueueItems.userId, taskTitle: reviewQueueItems.taskTitle, tenantId: reviewQueueItems.tenantId })
  if (rows.length) {
    await closeDelegations(tx, rows[0]!.tenantId, rows, { deciderId: input.reviewerId ?? null, decision: input.decision ?? null, at })
  }
  return rows.length
}

export type ReviewGuard = { ok: true } | { ok: false, code: 'already_claimed' | 'assigned_to_other' }

/**
 * Может ли человек брать эту работу в руки — открыть карточку или решить ответ (`37` §7.1).
 * Работа из общего пула — может любой проверяющий; назначенная — только назначенный и тот,
 * на кого она эскалирована (§7.19: единственный случай, когда работу видят двое). Открытая
 * другим карточка держит работу 30 минут. Строки очереди нет (работа старше очереди) —
 * ограничений нет, как было до неё.
 */
export async function reviewGuard(tx: TenantTx, input: { taskType: ReviewTaskType, sourceId: string, actorId: string, now?: Date }): Promise<ReviewGuard> {
  const [q] = await tx.select().from(reviewQueueItems)
    .where(and(eq(reviewQueueItems.taskType, input.taskType), eq(reviewQueueItems.sourceId, input.sourceId)))
  if (!q || q.status === 'done') return { ok: true }
  const now = input.now ?? new Date()
  if (q.claimedBy && q.claimedBy !== input.actorId && claimIsLive(q.claimedAt, now)) return { ok: false, code: 'already_claimed' }
  if (q.assignedReviewerId && q.assignedReviewerId !== input.actorId && !(q.escalatedAt && q.escalatedToId === input.actorId)) {
    return { ok: false, code: 'assigned_to_other' }
  }
  return { ok: true }
}

/** Взятие работы в проверку: захват, а не назначение. Зеркало `workshop_submissions` пишет вызывающий сервис. */
export async function claimReview(tx: TenantTx, input: { taskType: ReviewTaskType, sourceId: string, reviewerId: string, at?: Date }): Promise<ReviewGuard> {
  const at = input.at ?? new Date()
  const guard = await reviewGuard(tx, { taskType: input.taskType, sourceId: input.sourceId, actorId: input.reviewerId, now: at })
  if (!guard.ok) return guard
  await tx.update(reviewQueueItems).set({ status: 'in_review', claimedBy: input.reviewerId, claimedAt: at, updatedAt: at })
    .where(and(eq(reviewQueueItems.taskType, input.taskType), eq(reviewQueueItems.sourceId, input.sourceId), sql`${reviewQueueItems.status} <> 'done'`))
  return { ok: true }
}

/**
 * Возврат работы из рук: «Пропустити» или протухший захват. Снимается только захват —
 * назначение, делегирование и эскалация остаются, и работа возвращается в своё состояние
 * покоя: `escalated`, `delegated` или `waiting` (`37` §4).
 */
export async function releaseReview(tx: TenantTx, input: { taskType: ReviewTaskType, sourceIds: string[], at?: Date }): Promise<void> {
  if (!input.sourceIds.length) return
  const at = input.at ?? new Date()
  await tx.update(reviewQueueItems).set({
    status: sql`case when ${reviewQueueItems.escalatedAt} is not null then 'escalated'
                     when ${reviewQueueItems.delegationId} is not null then 'delegated'
                     else 'waiting' end`,
    claimedBy: null,
    claimedAt: null,
    updatedAt: at,
  }).where(and(eq(reviewQueueItems.taskType, input.taskType), inArray(reviewQueueItems.sourceId, input.sourceIds), eq(reviewQueueItems.status, 'in_review')))
}

/**
 * Источники, захват которых протух (30 минут бездействия, `docs/13` §4.2). Раньше SLA-скан
 * практикумов искал их по зеркалу `workshop_submissions.claimed_at`; теперь — по очереди,
 * источнику истины (В-2), чтобы зеркало можно было снять без потери функции.
 */
export async function staleClaims(tx: TenantTx, taskType: ReviewTaskType, now: Date = new Date()): Promise<string[]> {
  const stale = new Date(now.getTime() - CLAIM_TTL_MS).toISOString()
  const rows = await tx.select({ sourceId: reviewQueueItems.sourceId }).from(reviewQueueItems).where(and(
    eq(reviewQueueItems.taskType, taskType),
    eq(reviewQueueItems.status, 'in_review'),
    sql`${reviewQueueItems.claimedAt} < ${stale}::timestamptz`,
  ))
  return rows.map(r => r.sourceId)
}

/**
 * Фрагмент для узких фильтров (`/review/workshops`, `/review/answers`): работа сейчас в чужих
 * руках — назначена или делегирована другому либо открыта другим меньше 30 минут назад.
 * Такая работа ушла из «Мої» (`37` §13 к. 1) и не должна всплывать и в узком списке.
 */
export function heldByOtherSql(actorId: string, taskType: ReviewTaskType, sourceIdColumn: SQL | unknown): SQL {
  const stale = new Date(Date.now() - CLAIM_TTL_MS).toISOString()
  return sql`exists (
    select 1 from review_queue_items q
     where q.task_type = ${taskType} and q.source_id = ${sourceIdColumn} and q.status <> 'done'
       and ((q.assigned_reviewer_id is not null and q.assigned_reviewer_id <> ${actorId}::uuid
             and not (q.escalated_at is not null and q.escalated_to_id = ${actorId}::uuid))
         or (q.claimed_by is not null and q.claimed_by <> ${actorId}::uuid and q.claimed_at >= ${stale}::timestamptz)))`
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

/** Строка очереди в ответе `/review/queue` (`37` §5.1 — первые десять колонок в порядке эталона плюс наши). */
export interface ReviewQueueRow {
  id: string
  taskType: ReviewTaskType
  sourceId: string
  userId: string
  fullName: string | null
  subjectKind: string
  locationId: string | null
  locationName: string | null
  positionName: string | null
  trackId: string | null
  /** «Трек» словами — название курса-снимка; сам снимок остаётся идентификатором (В-2). */
  trackTitle: string | null
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
  /** «Перевіряючий»: назначенный, а у работы из пула — тот, кто держит карточку. */
  assignedReviewerId: string | null
  reviewerName: string | null
  claimedBy: string | null
  delegationDepth: number
  delegationId: string | null
  /** «Ким делеговано» — у «Делеговані мені»: кто передал текущее звено. */
  delegatedByName: string | null
  /** Звено, которое отдал смотрящий (для «Делеговані мною»): его состояние, кому и до когда. */
  myDelegation: { id: string, state: string, toName: string | null, dueAt: Date } | null
  slaDueAt: Date | null
  slaBreachedAt: Date | null
  escalatedAt: Date | null
  escalatedToId: string | null
  hoursLeft: number | null
  overdue: boolean
}

/**
 * Условие таба «Мої» (`37` §5.1): назначено мне (в том числе делегировано мне); эскалировано
 * на меня (§7.19 — видят двое); открыто мной; либо в общем пуле и не держится в чужих руках
 * (протухший захват не держит).
 */
function mineCondition(actorId: string, staleClaim: string): SQL {
  return sql`(${reviewQueueItems.assignedReviewerId} = ${actorId}::uuid
    or (${reviewQueueItems.escalatedAt} is not null and ${reviewQueueItems.escalatedToId} = ${actorId}::uuid)
    or ${reviewQueueItems.claimedBy} = ${actorId}::uuid
    or (${reviewQueueItems.assignedReviewerId} is null
        and (${reviewQueueItems.claimedBy} is null or ${reviewQueueItems.claimedAt} < ${staleClaim}::timestamptz)))`
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
 * Табы — ось ответственности (`37` §5.1, §10):
 *   - «Мої» — `mineCondition`, только открытые;
 *   - «Делеговані мені» — открытые, у которых текущее звено делегирования ведёт ко мне;
 *   - «Делеговані мною» — все работы, которые я отдавал, в любом состоянии: это контрольный
 *     таб «что я отдал и чем оно кончилось» (§7.4: результат делегат видит здесь же);
 *   - «Завершені» — архив решённого.
 *
 * Ответ несёт `total` (счётчик на табе «Мої» из `37` §5.1) и ключевой курсор: прежние очереди
 * отдавали голый массив с жёстким `limit 200`, на котором экран `37` §5 не рисуется.
 *
 * Курсор — `(-priority, submitted_at, id)` последней строки, момент текстом из Postgres с
 * микросекундами (`shared/domain/keyset.ts`). Прежний курсор нёс `submitted_at` в миллисекундах:
 * на возрастании усечённый момент оказывался *раньше* последней строки, и следующая страница
 * начиналась заново с тех же работ — «Показати ще» крутило одну страницу по кругу.
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

    if (filter.tab === 'mine') {
      conds.push(sql`${reviewQueueItems.status} <> 'done'`)
      conds.push(mineCondition(ctx.actorId, staleClaim))
    }
    if (filter.tab === 'delegated_in') {
      conds.push(sql`${reviewQueueItems.status} <> 'done'`)
      conds.push(sql`${reviewQueueItems.delegationId} is not null and ${reviewQueueItems.assignedReviewerId} = ${ctx.actorId}::uuid`)
    }
    if (filter.tab === 'delegated_out') {
      conds.push(sql`exists (select 1 from review_delegations d
        where d.queue_item_id = ${reviewQueueItems.id} and d.from_user_id = ${ctx.actorId}::uuid)`)
    }
    if (filter.tab === 'done') {
      // «Завершені» — архив области, а не личный список: проверяющий должен видеть, чем
      // закончились работы, которые он отдал или которые брал не он (`37` §5.1, четвёртый
      // таб). Область видимости задаёт скоуп `review.queue` и RLS, а не сам таб.
      conds.push(eq(reviewQueueItems.status, 'done'))
    }

    const [counted] = await tx.select({ total: sql<number>`count(*)::int` }).from(reviewQueueItems).where(and(...conds))

    // Ключевой курсор по тому же ключу, что и сортировка: одинаковое направление всех
    // колонок достигнуто знаком у priority — строчное сравнение иначе неприменимо.
    const sortKey = [sql`-${reviewQueueItems.priority}`, reviewQueueItems.submittedAt, reviewQueueItems.id]
    const after = keysetAfter(KEYSETS.reviewQueue, filter.cursor, sortKey, 'asc')
    const page = after ? [...conds, after] : conds

    // Псевдонимы `users` ради имён проверяющих — выборки по первичному ключу, вид человека
    // здесь не при чём (`repo/people.ts`, «Точечные выборки»).
    const reviewer = alias(users, 'reviewer')
    const rows = await tx.select({
      id: reviewQueueItems.id,
      taskType: reviewQueueItems.taskType,
      sourceId: reviewQueueItems.sourceId,
      userId: reviewQueueItems.userId,
      fullName: users.fullName,
      subjectKind: reviewQueueItems.subjectKind,
      locationId: reviewQueueItems.locationId,
      locationName: locations.name,
      positionName: positions.name,
      trackId: reviewQueueItems.trackId,
      trackTitle: sql<string | null>`(select c.title from courses c where c.id = ${reviewQueueItems.trackId})`,
      taskTitle: reviewQueueItems.taskTitle,
      attemptNo: reviewQueueItems.attemptNo,
      estimatedSeconds: reviewQueueItems.estimatedSeconds,
      contentSeconds: reviewQueueItems.contentSeconds,
      attemptSeconds: reviewQueueItems.attemptSeconds,
      timeConfidence: reviewQueueItems.timeConfidence,
      submittedAt: reviewQueueItems.submittedAt,
      cursorAt: keysetAt(reviewQueueItems.submittedAt),
      completedAt: reviewQueueItems.completedAt,
      status: reviewQueueItems.status,
      priority: reviewQueueItems.priority,
      assignedReviewerId: reviewQueueItems.assignedReviewerId,
      claimedBy: reviewQueueItems.claimedBy,
      reviewerName: reviewer.fullName,
      delegationDepth: reviewQueueItems.delegationDepth,
      delegationId: reviewQueueItems.delegationId,
      slaDueAt: reviewQueueItems.slaDueAt,
      slaBreachedAt: reviewQueueItems.slaBreachedAt,
      escalatedAt: reviewQueueItems.escalatedAt,
      escalatedToId: reviewQueueItems.escalatedToId,
      // Имена участников цепочки — внешним соединением по первичному ключу: оно дописывает
      // ФИО к звену и не может добавить в ответ ни одного человека (В-8, «join ради ФИО»).
      delegatedByName: sql<string | null>`(select fu.full_name from review_delegations d
        left join users fu on fu.id = d.from_user_id where d.id = ${reviewQueueItems.delegationId})`,
      myDelegation: sql<{ id: string, state: string, toName: string | null, dueAt: string } | null>`(select json_build_object(
          'id', d.id, 'state', d.state, 'dueAt', d.due_at, 'toName', tu.full_name)
        from review_delegations d
        left join users tu on tu.id = d.to_user_id
       where d.queue_item_id = ${reviewQueueItems.id} and d.from_user_id = ${ctx.actorId}::uuid
       order by d.created_at desc limit 1)`,
    })
      .from(reviewQueueItems)
      // Соединение ради ФИО и снимков названий: вид человека уже снят в subject_kind,
      // повторно фильтровать `users.kind` здесь не нужно и нечем (docs/v2/44 В-8 × В-2).
      .innerJoin(users, eq(users.id, reviewQueueItems.userId))
      .leftJoin(locations, eq(locations.id, reviewQueueItems.locationId))
      .leftJoin(positions, eq(positions.id, reviewQueueItems.positionId))
      .leftJoin(reviewer, eq(reviewer.id, sql`coalesce(${reviewQueueItems.assignedReviewerId}, ${reviewQueueItems.claimedBy})`))
      .where(and(...page))
      .orderBy(...sortKey)
      .limit(filter.limit + 1)

    const hasMore = rows.length > filter.limit
    const now = Date.now()
    const pageRows = hasMore ? rows.slice(0, filter.limit) : rows
    const items = pageRows.map(({ cursorAt: _cursorAt, ...r }) => ({
      ...r,
      taskType: r.taskType as ReviewTaskType,
      myDelegation: r.myDelegation ? { ...r.myDelegation, dueAt: new Date(r.myDelegation.dueAt) } : null,
      hoursLeft: r.slaDueAt ? Math.round((r.slaDueAt.getTime() - now) / 3_600_000) : null,
      overdue: !!r.slaDueAt && r.slaDueAt.getTime() < now && r.status !== 'done',
    }))
    const last = pageRows[pageRows.length - 1]

    return {
      items,
      total: counted?.total ?? 0,
      cursor: hasMore && last ? encodeKeyset(KEYSETS.reviewQueue, [-last.priority, last.cursorAt, last.id]) : null,
    }
  })
}

/** Счётчики на табах (`37` §5.1: «Мої» считает ждущие и взятые, просроченные — отдельно). */
export async function reviewQueueCounts(ctx: Ctx): Promise<{ mine: number, mineOverdue: number, delegatedIn: number, delegatedOut: number }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const staleClaim = new Date(Date.now() - CLAIM_TTL_MS).toISOString()
    const own = sql`${reviewQueueItems.userId} <> ${ctx.actorId}::uuid`
    const open = sql`${reviewQueueItems.status} <> 'done'`
    const [r] = await tx.select({
      mine: sql<number>`count(*) filter (where ${mineCondition(ctx.actorId, staleClaim)})::int`,
      mineOverdue: sql<number>`count(*) filter (where ${mineCondition(ctx.actorId, staleClaim)} and ${reviewQueueItems.slaDueAt} < now())::int`,
      delegatedIn: sql<number>`count(*) filter (where ${reviewQueueItems.delegationId} is not null and ${reviewQueueItems.assignedReviewerId} = ${ctx.actorId}::uuid)::int`,
    }).from(reviewQueueItems).where(and(own, open))
    const [out] = await tx.execute(sql`
      select count(distinct d.queue_item_id)::int as n from review_delegations d
        join review_queue_items q on q.id = d.queue_item_id
       where d.from_user_id = ${ctx.actorId}::uuid and d.state = 'active' and q.status <> 'done'`) as unknown as { n: number }[]
    return { mine: r?.mine ?? 0, mineOverdue: r?.mineOverdue ?? 0, delegatedIn: r?.delegatedIn ?? 0, delegatedOut: out?.n ?? 0 }
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

/** Для тестов и карточки: состояние покоя строки (тот же расчёт, что и в `releaseReview`). */
export { restingStatus }
