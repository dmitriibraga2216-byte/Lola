import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import {
  certificates, employeeLifecycleState, enrollments, lifecycleStages, locations,
  offboardingCases, positions, sessions, userPlacements, users,
} from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { REASON_OFFBOARDING, REASON_OFFBOARDING_CANCELLED, STAGE_ON_HIRE, STAGE_ON_OFFBOARDING } from '../../shared/enums'
import type { HireInput, OffboardingListFilter, OffboardingStartInput } from '../../shared/schemas/offboarding'
import { recordAudit } from './audit'
import { logSecurity } from './securityLog'
import { createAssignmentTx, expandAssignment } from './assignments'
import { enterStageByCodeTx, enterStageTx, stageByCode } from './lifecycleState'
import { isLastAdmin, isLastOwner, splitName } from './people'

/**
 * Офбординг и повторный найм (docs/v2/33-lifecycle.md §3.6, §4.2, §7.7, §7.8).
 *
 * Почему офбординг — процесс продукта, а не «архивировать человека руками»: пока закрытие
 * доступа и освобождение лимита делаются вне системы, тенант платит за уволенных, а они
 * продолжают получать уведомления (§15 Г-33.3). Завершение при этом **ничего не стирает**
 * (§4.2): история обучения — доказательство того, что инструктаж проводился, и нужна дольше,
 * чем человек работает. Обезличивание — отдельная операция по запросу субъекта (`gdpr.erase`).
 *
 * Ветвления по коду этапа здесь нет: коды приходят именованными константами из справочника
 * (`shared/enums.ts`), решения о возможностях принимает `stageCan()` (§7.1).
 */

export interface Ctx { tenantId: string, actorId: string }

export interface CaseRow {
  id: string
  userId: string
  fullName: string
  locationName: string | null
  positionName: string | null
  state: string
  reasonCode: string
  reasonText: string | null
  lastWorkingDay: string
  initiatedBy: string | null
  responsibleId: string | null
  responsibleName: string | null
  exitInterviewEnrollmentId: string | null
  handoverDoneAt: Date | null
  accessRevokedAt: Date | null
  completedAt: Date | null
  cancelledAt: Date | null
  cancelReason: string | null
  createdAt: Date
}

const ACTIVE_STATES = ['started', 'handover', 'interview'] as const

/**
 * ФИО ответственного подзапросом, а не вторым соединением с `users`: соединение с людьми в
 * этой выборке уже есть (уходящий человек), а второе ради одного имени только запутало бы
 * сканер П-16.1. Выборка по первичному ключу — фильтр по виду людей здесь бессмыслен (В-8).
 */
const responsible = sql<string | null>`(select u2.full_name from users u2 where u2.id = ${offboardingCases.responsibleId})`

const SELECT = {
  id: offboardingCases.id,
  userId: offboardingCases.userId,
  fullName: users.fullName,
  state: offboardingCases.state,
  reasonCode: offboardingCases.reasonCode,
  reasonText: offboardingCases.reasonText,
  lastWorkingDay: offboardingCases.lastWorkingDay,
  initiatedBy: offboardingCases.initiatedBy,
  responsibleId: offboardingCases.responsibleId,
  responsibleName: responsible,
  exitInterviewEnrollmentId: offboardingCases.exitInterviewEnrollmentId,
  handoverDoneAt: offboardingCases.handoverDoneAt,
  accessRevokedAt: offboardingCases.accessRevokedAt,
  completedAt: offboardingCases.completedAt,
  cancelledAt: offboardingCases.cancelledAt,
  cancelReason: offboardingCases.cancelReason,
  createdAt: offboardingCases.createdAt,
  locationName: locations.name,
  positionName: positions.name,
}

/**
 * Список случаев (`33` §5.4, §10 `GET /offboarding`). Соединение с людьми — ради ФИО, точки
 * и должности: ведущая таблица здесь `offboarding_cases`, а вид человека в ней всегда
 * сотрудник (кандидата не увольняют — его отклоняют, `docs/v2/28`).
 */
export async function listCases(ctx: Ctx, filter: OffboardingListFilter = {}): Promise<CaseRow[]> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const conds = [
      filter.state ? eq(offboardingCases.state, filter.state) : undefined,
      filter.active ? inArray(offboardingCases.state, [...ACTIVE_STATES]) : undefined,
      filter.reasonCode ? eq(offboardingCases.reasonCode, filter.reasonCode) : undefined,
      filter.locationId ? eq(userPlacements.locationId, filter.locationId) : undefined,
      filter.from ? sql`${offboardingCases.lastWorkingDay} >= ${filter.from}::date` : undefined,
      filter.to ? sql`${offboardingCases.lastWorkingDay} <= ${filter.to}::date` : undefined,
    ].filter(Boolean)
    const rows = await tx
      .select(SELECT)
      .from(offboardingCases)
      .innerJoin(users, eq(users.id, offboardingCases.userId))
      .leftJoin(userPlacements, and(eq(userPlacements.userId, offboardingCases.userId), eq(userPlacements.isPrimary, true)))
      .leftJoin(locations, eq(locations.id, userPlacements.locationId))
      .leftJoin(positions, eq(positions.id, userPlacements.positionId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(offboardingCases.createdAt))
      .limit(200)
    return rows as CaseRow[]
  })
}

/** Карточка случая (`33` §5.4, §10 `GET /offboarding/:id`). */
export async function getCase(ctx: Ctx, id: string): Promise<CaseRow | null> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await tx
      .select(SELECT)
      .from(offboardingCases)
      .innerJoin(users, eq(users.id, offboardingCases.userId))
      .leftJoin(userPlacements, and(eq(userPlacements.userId, offboardingCases.userId), eq(userPlacements.isPrimary, true)))
      .leftJoin(locations, eq(locations.id, userPlacements.locationId))
      .leftJoin(positions, eq(positions.id, userPlacements.positionId))
      .where(eq(offboardingCases.id, id))
    return (row as CaseRow | undefined) ?? null
  })
}

export type StartError = 'not_found' | 'active_exists' | 'last_admin' | 'last_owner' | 'stage_missing'

export interface StartResult { id: string, state: string, assigned: number, exitInterviewEnrollmentId: string | null }

/**
 * Инициация офбординга (`33` §4.2 строка 1, форма §6.2).
 *
 * Что происходит одной транзакцией: заводится случай, человек переходит в этап «Офбординг»,
 * выдаются курсы офбординга и — если запрошено — выходное интервью. Раскрытие аудитории в
 * записи идёт после фиксации (как в `createAssignment`), поэтому идентификатор записи
 * выходного интервью проставляется вторым шагом.
 *
 * Состояние: `started`, и сразу `handover`, если передача дел входит в случай — то есть всегда,
 * когда у человека остаются активные назначения или размещение. Чек-лист передачи дел как
 * объект (`docs/20`) в этот PR не входит; решение — `docs/28` §28.13.
 */
export async function startOffboarding(ctx: Ctx, input: OffboardingStartInput): Promise<StartResult | StartError> {
  const prepared = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [person] = await tx
      .select({ id: users.id, kind: users.kind, fullName: users.fullName, status: users.status })
      .from(users)
      .where(eq(users.id, input.userId))
    if (!person) return 'not_found' as const
    if (await isLastAdmin(tx, input.userId)) return 'last_admin' as const
    // Владелец уходит из пространства только передав владение (docs/01 §1.9.4)
    if (await isLastOwner(tx, input.userId)) return 'last_owner' as const

    const [active] = await tx
      .select({ id: offboardingCases.id })
      .from(offboardingCases)
      .where(and(eq(offboardingCases.userId, input.userId), inArray(offboardingCases.state, [...ACTIVE_STATES])))
    if (active) return 'active_exists' as const

    const stage = await stageByCode(tx, STAGE_ON_OFFBOARDING)
    if (!stage) return 'stage_missing' as const

    const [row] = await tx
      .insert(offboardingCases)
      .values({
        tenantId: ctx.tenantId,
        userId: input.userId,
        state: 'started',
        reasonCode: input.reasonCode,
        reasonText: input.reasonText ?? null,
        lastWorkingDay: input.lastWorkingDay,
        initiatedBy: ctx.actorId,
        responsibleId: input.responsibleId,
      })
      .returning({ id: offboardingCases.id })

    await enterStageTx(tx, { tenantId: ctx.tenantId, userId: input.userId, stageId: stage.id, reasonCode: REASON_OFFBOARDING, enteredBy: ctx.actorId })

    // Курсы офбординга и выходное интервью — обычные назначения (инвариант 1: правила
    // прохождения живут в назначении, а не в случае увольнения). Срок — последний рабочий день.
    const assignmentIds: string[] = []
    let interviewAssignmentId: string | null = null
    const dueAt = new Date(`${input.lastWorkingDay}T23:59:00Z`).toISOString()
    const subjects = [
      ...input.courseIds.map(id => ({ id, interview: false })),
      ...(input.exitInterviewCourseId ? [{ id: input.exitInterviewCourseId, interview: true }] : []),
    ]
    for (const subject of subjects) {
      const created = await createAssignmentTx(tx, ctx, {
        subjectType: 'course',
        subjectId: subject.id,
        lockVersion: false,
        audience: { rules: [{ type: 'user', ids: [input.userId] }], match: 'any' },
        dueMode: 'absolute',
        dueAt,
        dueDays: 14,
        isMandatory: true,
        autoSync: false,
        tags: [],
        status: 'active',
      })
      if (!created.ok) continue
      assignmentIds.push(created.assignmentId)
      if (subject.interview) interviewAssignmentId = created.assignmentId
    }

    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'offboarding.started',
      entity: 'offboarding_case',
      entityId: row!.id,
      after: { userId: input.userId, reasonCode: input.reasonCode, lastWorkingDay: input.lastWorkingDay, assigned: assignmentIds.length },
    })
    return { id: row!.id, assignmentIds, interviewAssignmentId }
  })
  if (typeof prepared === 'string') return prepared

  for (const id of prepared.assignmentIds) await expandAssignment(ctx.tenantId, id)

  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    let exitInterviewEnrollmentId: string | null = null
    if (prepared.interviewAssignmentId) {
      const [enr] = await tx
        .select({ id: enrollments.id })
        .from(enrollments)
        .where(and(eq(enrollments.assignmentId, prepared.interviewAssignmentId), eq(enrollments.userId, input.userId)))
      exitInterviewEnrollmentId = enr?.id ?? null
    }
    // Передача дел — следующий шаг процесса сразу после инициации (§4.2).
    const [after] = await tx
      .update(offboardingCases)
      .set({ state: 'handover', exitInterviewEnrollmentId, updatedAt: new Date() })
      .where(eq(offboardingCases.id, prepared.id))
      .returning({ id: offboardingCases.id, state: offboardingCases.state })
    return { id: after!.id, state: after!.state, assigned: prepared.assignmentIds.length, exitInterviewEnrollmentId }
  })
}

export type StepError = 'not_found' | 'bad_state'

/**
 * Передача дел закрыта (`33` §4.2, `handover → interview`). Дальше остаётся выходное интервью,
 * если оно назначено; если нет — случай ждёт последнего рабочего дня и завершения.
 */
export async function markHandoverDone(ctx: Ctx, id: string): Promise<{ id: string, state: string } | StepError> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [c] = await tx.select().from(offboardingCases).where(eq(offboardingCases.id, id))
    if (!c) return 'not_found'
    if (!ACTIVE_STATES.includes(c.state as typeof ACTIVE_STATES[number])) return 'bad_state'
    const [after] = await tx
      .update(offboardingCases)
      .set({ handoverDoneAt: new Date(), state: c.exitInterviewEnrollmentId ? 'interview' : c.state, updatedAt: new Date() })
      .where(eq(offboardingCases.id, id))
      .returning({ id: offboardingCases.id, state: offboardingCases.state })
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'offboarding.handover_done', entity: 'offboarding_case', entityId: id, before: { state: c.state }, after })
    return after!
  })
}

export type CompleteError = 'not_found' | 'bad_state' | 'before_last_day' | 'last_admin' | 'last_owner'

export interface CompleteResult {
  id: string
  state: string
  /** Сколько незавершённых назначений переведено в `НЕ ПРИЗНАЧЕНО` с пометкой «звільнення». */
  cancelled: number
  /** Сколько сессий закрыто. */
  sessionsClosed: number
  /** Сертификаты не отзываются (П-14) — их число возвращается как доказательство. */
  certificatesKept: number
}

/**
 * Завершение офбординга (`33` §7.7, критерий §13 п. 9) — одной транзакцией:
 * `state='done'`, `access_revoked_at=now()`, активные сессии закрыты, незавершённые назначения
 * переведены в `НЕ ПРИЗНАЧЕНО` с пометкой «звільнення», человек исключён из лимита активных
 * (`status='archived'`, счётчик `docs/v2/35` считает по `status='active'`), размещения закрыты.
 *
 * Чего здесь **нет** намеренно: удаления записи, обезличивания и отзыва сертификатов. Первые
 * два — §4.2 («история обучения нужна дольше, чем сам сотрудник работает»), третье — П-14
 * (`39-patches.md`): при завершении офбординга ранее выданные сертификаты не отзываются.
 */
export async function completeOffboarding(ctx: Ctx, id: string): Promise<CompleteResult | CompleteError> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [c] = await tx.select().from(offboardingCases).where(eq(offboardingCases.id, id))
    if (!c) return 'not_found'
    if (!ACTIVE_STATES.includes(c.state as typeof ACTIVE_STATES[number])) return 'bad_state'
    const [when] = await tx.execute(sql`select (${c.lastWorkingDay}::date > current_date) as too_early`) as unknown as { too_early: boolean }[]
    if (when?.too_early) return 'before_last_day'
    if (await isLastAdmin(tx, c.userId)) return 'last_admin'
    if (await isLastOwner(tx, c.userId)) return 'last_owner'

    const now = new Date()
    const closed = await tx
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(eq(sessions.userId, c.userId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id })

    // Пять статусов, а не четыре (CLAUDE.md п. 12): незавершённое обучение уволенного — это
    // `НЕ ПРИЗНАЧЕНО`, а не «провалено». Пометка «звільнення» остаётся в `cancel_reason`.
    const cancelled = await tx
      .update(enrollments)
      .set({ status: 'not_assigned', cancelledAt: now, cancelledBy: ctx.actorId, cancelReason: REASON_OFFBOARDING, updatedAt: now })
      .where(and(
        eq(enrollments.userId, c.userId),
        inArray(enrollments.status, ['not_started', 'in_progress']),
        isNull(enrollments.cancelledAt),
      ))
      .returning({ id: enrollments.id })

    await tx
      .update(users)
      .set({ status: 'archived', archivedAt: now, updatedAt: now })
      .where(eq(users.id, c.userId))
    await tx
      .update(userPlacements)
      .set({ endedAt: c.lastWorkingDay, updatedAt: now })
      .where(and(eq(userPlacements.userId, c.userId), isNull(userPlacements.endedAt)))

    const kept = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(certificates)
      .where(and(eq(certificates.userId, c.userId), isNull(certificates.revokedAt)))

    const [after] = await tx
      .update(offboardingCases)
      .set({ state: 'done', completedAt: now, accessRevokedAt: now, updatedAt: now })
      .where(eq(offboardingCases.id, id))
      .returning({ id: offboardingCases.id, state: offboardingCases.state })

    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'offboarding.completed',
      entity: 'offboarding_case',
      entityId: id,
      before: { state: c.state },
      after: { state: 'done', cancelled: cancelled.length, sessionsClosed: closed.length },
    })
    await logSecurity({ tenantId: ctx.tenantId, userId: c.userId, event: 'user.archived', meta: { by: ctx.actorId, reason: REASON_OFFBOARDING } })
    if (closed.length) await logSecurity({ tenantId: ctx.tenantId, userId: c.userId, event: 'session.revoked', meta: { by: ctx.actorId, reason: REASON_OFFBOARDING, closed: closed.length } })

    return {
      id: after!.id,
      state: after!.state,
      cancelled: cancelled.length,
      sessionsClosed: closed.length,
      certificatesKept: Number(kept[0]?.n ?? 0),
    }
  })
}

/**
 * Отмена (`33` §4.2 последняя строка, §12.3): человек остаётся, этап возвращается к прежнему,
 * назначения офбординга снимаются. После `done` отмены нет — только повторный найм (§7.8).
 */
export async function cancelOffboarding(ctx: Ctx, id: string, reasonText: string): Promise<{ id: string, state: string, restoredStageId: string | null } | 'not_found' | 'completed'> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [c] = await tx.select().from(offboardingCases).where(eq(offboardingCases.id, id))
    if (!c) return 'not_found'
    if (c.state === 'done') return 'completed'
    const now = new Date()

    // Прежний этап — последняя закрытая запись состояния; если её нет, человек остаётся там же.
    const [prev] = await tx
      .select({ stageId: employeeLifecycleState.stageId })
      .from(employeeLifecycleState)
      .where(and(eq(employeeLifecycleState.userId, c.userId), eq(employeeLifecycleState.isCurrent, false)))
      .orderBy(desc(employeeLifecycleState.enteredAt))
      .limit(1)
    let restoredStageId: string | null = null
    if (prev) {
      const entered = await enterStageTx(tx, { tenantId: ctx.tenantId, userId: c.userId, stageId: prev.stageId, reasonCode: REASON_OFFBOARDING_CANCELLED, enteredBy: ctx.actorId })
      restoredStageId = entered?.stageId ?? prev.stageId
    }

    const stage = await stageByCode(tx, STAGE_ON_OFFBOARDING)
    if (stage) {
      await tx.execute(sql`
        update enrollments e
        set status = 'not_assigned', cancelled_at = now(), cancelled_by = ${ctx.actorId}::uuid,
            cancel_reason = ${REASON_OFFBOARDING_CANCELLED}, updated_at = now()
        from courses c
        where c.id = e.subject_id
          and e.user_id = ${c.userId}::uuid
          and c.lifecycle_stage_id = ${stage.id}::uuid
          and e.cancelled_at is null
          and e.status in ('not_started', 'in_progress')`)
    }

    const [after] = await tx
      .update(offboardingCases)
      .set({ state: 'cancelled', cancelledAt: now, cancelReason: reasonText, updatedAt: now })
      .where(eq(offboardingCases.id, id))
      .returning({ id: offboardingCases.id, state: offboardingCases.state })
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'offboarding.cancelled', entity: 'offboarding_case', entityId: id, before: { state: c.state }, after: { state: 'cancelled', reasonText } })
    return { id: after!.id, state: after!.state, restoredStageId }
  })
}

export type HireError = 'not_found' | 'offboarding_active' | 'needs_name' | 'stage_missing' | 'place_not_found'

export interface HireResult {
  userId: string
  /** `true` — использована существующая запись `users` (критерий `33` §13 п. 10). */
  reused: boolean
  placementId: string
  stageId: string | null
  /** Сколько завершённых периодов работы было до этого — блок «Попередній період роботи». */
  previousPeriods: number
}

/**
 * Найм и повторный найм (`33` §7.8, критерий §13 п. 10).
 *
 * Инвариант пакета: **повторный найм того же человека не создаёт новую запись `users`**.
 * Снимается `archived_at`, заводится новое `user_placements`, открывается новое состояние
 * с этапом «Онбординг»; прошлые периоды видны отдельным блоком. Это то же правило, что
 * превращает кандидата в сотрудника сменой `kind` (`44` В-8): человек в системе один,
 * а его история — одна, иначе сертификаты, попытки и стаж рвутся пополам.
 *
 * Поиск идёт по тем же ключам, которыми человек заводится: `users.id`, телефон, `external_id`.
 */
export async function hire(ctx: Ctx, input: HireInput): Promise<HireResult | HireError> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [place] = await tx.select({ id: locations.id }).from(locations).where(eq(locations.id, input.locationId))
    const [pos] = await tx.select({ id: positions.id }).from(positions).where(eq(positions.id, input.positionId))
    if (!place || !pos) return 'place_not_found'

    // Вид человека читается явно (П-16.1): кандидат найдётся здесь так же, как бывший
    // сотрудник, и найм переведёт его `kind` — второй записи `users` не появится.
    const keys = [
      input.userId ? eq(users.id, input.userId) : undefined,
      input.phone ? eq(users.phone, input.phone) : undefined,
      input.externalId ? eq(users.externalId, input.externalId) : undefined,
    ].filter(Boolean)
    const found = keys.length
      ? (await tx
          .select({ id: users.id, kind: users.kind, fullName: users.fullName, status: users.status })
          .from(users)
          .where(or(...keys))
          .limit(1))[0]
      : undefined

    const hiredAt = input.hiredAt ?? new Date().toISOString().slice(0, 10)
    let userId: string
    let reused = false
    let previousPeriods = 0

    if (found) {
      const [active] = await tx
        .select({ id: offboardingCases.id })
        .from(offboardingCases)
        .where(and(eq(offboardingCases.userId, found.id), inArray(offboardingCases.state, [...ACTIVE_STATES])))
      if (active) return 'offboarding_active'

      const [done] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(offboardingCases)
        .where(and(eq(offboardingCases.userId, found.id), eq(offboardingCases.state, 'done')))
      previousPeriods = Number(done?.n ?? 0)

      await tx
        .update(users)
        .set({ kind: 'employee', status: 'active', isBlocked: false, archivedAt: null, hiredAt, updatedAt: new Date() })
        .where(eq(users.id, found.id))
      userId = found.id
      reused = true
      await recordAudit(tx, {
        tenantId: ctx.tenantId,
        actorId: ctx.actorId,
        action: 'people.rehire',
        entity: 'user',
        entityId: userId,
        before: { kind: found.kind, status: found.status },
        after: { kind: 'employee', status: 'active', hiredAt, previousPeriods },
      })
      await logSecurity({ tenantId: ctx.tenantId, userId, event: 'user.created', meta: { by: ctx.actorId, rehire: true } })
    }
    else {
      if (!input.fullName) return 'needs_name'
      const parts = splitName({ fullName: input.fullName })
      const [person] = await tx
        .insert(users)
        .values({
          tenantId: ctx.tenantId,
          kind: 'employee',
          fullName: parts.fullName,
          lastName: parts.lastName,
          firstName: parts.firstName,
          middleName: parts.middleName,
          phone: input.phone ?? null,
          externalId: input.externalId ?? null,
          status: 'invited',
          hiredAt,
        })
        .returning({ id: users.id })
      userId = person!.id
      await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'people.create', entity: 'user', entityId: userId, after: { fullName: parts.fullName, hiredAt, source: 'hire' } })
    }

    await tx
      .update(userPlacements)
      .set({ endedAt: hiredAt, updatedAt: new Date() })
      .where(and(eq(userPlacements.userId, userId), isNull(userPlacements.endedAt)))
    const [placement] = await tx
      .insert(userPlacements)
      .values({
        tenantId: ctx.tenantId,
        userId,
        locationId: input.locationId,
        positionId: input.positionId,
        isPrimary: true,
        startedAt: hiredAt,
      })
      .returning({ id: userPlacements.id })

    const entered = await enterStageByCodeTx(tx, { tenantId: ctx.tenantId, userId, code: STAGE_ON_HIRE, reasonCode: reused ? 'rehire' : 'hire', enteredBy: ctx.actorId })
    return { userId, reused, placementId: placement!.id, stageId: entered?.stageId ?? null, previousPeriods }
  })
}

/** Предыдущие периоды работы — блок «Попередній період роботи» карточки (`33` §7.8). */
export async function previousPeriods(ctx: Ctx, userId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx
      .select({
        id: offboardingCases.id,
        reasonCode: offboardingCases.reasonCode,
        lastWorkingDay: offboardingCases.lastWorkingDay,
        completedAt: offboardingCases.completedAt,
      })
      .from(offboardingCases)
      .where(and(eq(offboardingCases.userId, userId), eq(offboardingCases.state, 'done')))
      .orderBy(desc(offboardingCases.lastWorkingDay))
  })
}

/** Этапы тенанта для формы запуска: курсы офбординга предзаполняются курсами этапа (§6.2). */
export async function offboardingStageCourses(tx: TenantTx): Promise<string[]> {
  const stage = await stageByCode(tx, STAGE_ON_OFFBOARDING)
  if (!stage) return []
  const rows = await tx.execute(sql`
    select id::text as id from courses
    where lifecycle_stage_id = ${stage.id}::uuid and deleted_at is null and status = 'published'`) as unknown as { id: string }[]
  return rows.map(r => r.id)
}

/** Справочник этапов — чтобы экран офбординга не ходил за ним отдельной ручкой. */
export async function offboardingStage(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const stage = await stageByCode(tx, STAGE_ON_OFFBOARDING)
    if (!stage) return null
    const [row] = await tx.select({ id: lifecycleStages.id, nameUk: lifecycleStages.nameUk, isEnabled: lifecycleStages.isEnabled }).from(lifecycleStages).where(eq(lifecycleStages.id, stage.id))
    return { ...row!, courseIds: await offboardingStageCourses(tx) }
  })
}
