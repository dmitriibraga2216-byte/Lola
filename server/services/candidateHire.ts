import { and, eq, isNull, sql } from 'drizzle-orm'
import {
  candidateComments, candidateStatusHistory, candidateStatuses, functionalChiefs, locations,
  positions, userPlacements, users,
} from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { currentRequestContext } from '../utils/requestContext'
import { MENTOR_SCOPE_ONBOARDING, STAGE_ON_HIRE } from '../../shared/enums'
import type { CandidateState } from '../../shared/enums'
import type {
  CandidateArchiveInput, CandidateHireInput, CandidateRejectInput, CandidateReopenInput,
} from '../../shared/schemas/candidates'
import { candidateOnly, candidates as candidatesQuery } from './repo/people'
import { COLUMNS, canMove, maskRow, scopeCond } from './candidates'
import type { CandidateRow, Viewer } from './candidates'
import { closeCandidateSessionsTx } from './candidateAccess'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import { emitWebhook } from './webhooks'
import { readSettings } from './settings'
import { enterStageByCodeTx } from './lifecycleState'
import { applyPositionRoles } from './positionRoleMap'
import { redactInterviewData } from './interview/redaction'
import { LimitExceededError, assertSeatsWithinLimit, seatText } from './tenantLimits'

/**
 * Решения по кандидату: найм, отказ, архивация, самоотвод, повторное открытие
 * (docs/v2/28-recruiting-candidates.md §4.2, §7.6, §12.5; план docs/v2/45-plan.md PR-14).
 *
 * **Найм не создаёт второго человека.** Та же строка `users` меняет `kind` на `employee`:
 * прохождение, оценки, комментарии и история остаются на том же `user_id` и становятся
 * историей сотрудника (§3.1, решение docs/v2/44 В-8). Переносится ноль строк — именно ради
 * этого кандидат с самого начала живёт в `users`, а не в своей таблице.
 *
 * **Состояние воронки при найме снимается, а не ставится в `hired`.** §7.6 требует и
 * `kind='employee'`, и `candidate_state='hired'` одновременно, но `users_candidate_coherence_chk`
 * (§3.2) прямо это запрещает: у сотрудника состояния воронки нет. Выполнить оба нельзя;
 * побеждает констрейнт — он конкретнее прозы и не даёт двум осям разъехаться. Факт прихода
 * через воронку хранят `converted_from_candidate_at` и `hired_at` (решение PR-13,
 * `docs/28-implementation-notes.md` §28.15 п. 2), а отчёт по воронке считает найм по ним же.
 *
 * **Оба лимита пересчитываются одной транзакцией.** После `commit` кандидат перестал
 * считаться в `candidates_active` (ось смотрит на `kind = 'candidate'`) и начал считаться в
 * `users_active` (`kind = 'employee'`, `status = 'active'`): ровно −1 и +1, без промежуточного
 * состояния, в котором человек не считается нигде или считается дважды.
 */

export interface HireOutcome {
  userId: string
  /** Сколько курсов онбординга выдано назначением (§5.5, §7.6). */
  assigned: number
  usersActive: number
  candidatesActive: number
}

export type HireResult =
  | { ok: true, outcome: HireOutcome }
  | { ok: false, code: 'not_found' }
  | { ok: false, code: 'not_active' }
  | { ok: false, code: 'location_not_found' }
  | { ok: false, code: 'position_not_found' }
  /** Мест нет (`docs/v2/35` §12): найм не проведён, человек остаётся кандидатом с продлённым входом. */
  | { ok: false, code: 'limit_exceeded', used: number, limit: number | null, accessUntil: string | null, message: string }

export type DecisionResult =
  | { ok: true, candidate: CandidateRow }
  | { ok: false, code: 'not_found' }
  | { ok: false, code: 'not_allowed', from: CandidateState, to: CandidateState }
  | { ok: false, code: 'consent_expired' }

/** Системная колонка, к которой приравнивается состояние: отказ кладёт карточку в «Відхилені». */
async function statusForState(tx: TenantTx, state: CandidateState) {
  const [byMapping] = await tx.select().from(candidateStatuses)
    .where(and(eq(candidateStatuses.mapsTo, state), eq(candidateStatuses.isActive, true)))
    .orderBy(candidateStatuses.sort)
  return byMapping ?? null
}

/**
 * Смена состояния воронки одним местом (§4.2): проверка перехода, запись `candidate_state_at`,
 * строка истории, `audit_log`. Все решения — отказ, архивация, самоотвод, возврат — ходят
 * через неё, поэтому «когда состояние изменилось» одинаково верно для всех путей, в том числе
 * для фоновых задач, которые колонку канбана не двигают вовсе.
 */
export async function changeState(
  v: Viewer,
  id: string,
  to: CandidateState,
  opts: { reasonCode?: string | null, reasonText?: string | null, action: string, automatic?: boolean } ,
): Promise<DecisionResult> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const [row] = await candidatesQuery(tx, COLUMNS, eq(users.id, id), scopeCond(v)) as unknown as CandidateRow[]
    if (!row) return { ok: false, code: 'not_found' }
    if (!canMove(row.state, to)) return { ok: false, code: 'not_allowed', from: row.state, to }
    // Возврат в воронку невозможен, если согласие на обработку ПД истекло (§4.2): человек,
    // чьи данные пора стирать, не может снова стать активным кандидатом.
    if (to === 'active' && row.consentExpiresAt && row.consentExpiresAt < new Date().toISOString().slice(0, 10)) {
      return { ok: false, code: 'consent_expired' }
    }

    const target = await statusForState(tx, to)
    await tx.update(users).set({
      candidateState: to,
      candidateStateAt: new Date(),
      ...(target ? { candidateStatusId: target.id } : {}),
      updatedAt: new Date(),
    }).where(and(eq(users.id, id), candidateOnly()))
    // Отказ, архив, самоотвод закрывают доступ (§4.2, §7.7): действующие сессии гаснут той же
    // транзакцией, а не «когда-нибудь» — иначе вход закрыт, а человек всё ещё внутри
    if (to !== 'active') await closeCandidateSessionsTx(tx, v.tenantId, [id], { by: v.actorId, state: to })

    if (target && target.id !== row.statusId) {
      await tx.insert(candidateStatusHistory).values({
        tenantId: v.tenantId,
        candidateId: id,
        fromStatusId: row.statusId,
        toStatusId: target.id,
        reasonCode: opts.reasonCode ?? null,
        reasonText: opts.reasonText ?? null,
        actorId: v.actorId,
        isAutomatic: opts.automatic ?? false,
        requestContext: currentRequestContext(),
      })
    }

    await recordAudit(tx, {
      tenantId: v.tenantId,
      actorId: v.actorId,
      action: opts.action,
      entity: 'user',
      entityId: id,
      before: { state: row.state, statusId: row.statusId },
      after: { state: to, statusId: target?.id ?? row.statusId, reasonCode: opts.reasonCode ?? null, automatic: opts.automatic ?? false },
    })

    const [updated] = await candidatesQuery(tx, COLUMNS, eq(users.id, id)) as unknown as CandidateRow[]
    return { ok: true, candidate: maskRow(v, updated!) }
  })
}

/**
 * Отказ (§4.2, §6.2). Причина обязательна — она уходит в отчёт «Відмови за причинами» (§9 п. 5)
 * и в письмо кандидату; восстановить её задним числом неоткуда. Письмо уходит только если
 * рекрутер попросил: кандидат не должен узнавать решение от системы раньше, чем от человека,
 * если тенант так не настроил (§6.2, `settings.recruiting.notifyRejected`).
 */
export async function rejectCandidate(v: Viewer, id: string, input: CandidateRejectInput): Promise<DecisionResult> {
  const res = await changeState(v, id, 'rejected', {
    reasonCode: input.reasonCode,
    reasonText: input.reasonText ?? null,
    action: 'candidate.rejected',
  })
  if (!res.ok) return res
  const notify = input.notify || (await withTenant(v.tenantId, v.actorId, tx => readSettings(tx, v.tenantId))).recruiting.notifyRejected
  if (notify) {
    await withTenant(v.tenantId, v.actorId, tx => enqueueNotification(tx, {
      tenantId: v.tenantId,
      userId: id,
      code: 'candidate_rejected',
      channel: 'email',
      payload: { comment: input.reasonText ?? '' },
      dedupKey: `candidate_rejected:${id}`,
      refType: 'user',
      refId: id,
    })).catch(err => console.error('candidate_rejected notify', err))
  }
  return res
}

/** Архивация вручную (§4.2). Ту же смену делает ночная `candidate.auto_archive` (§7.5). */
export async function archiveCandidate(v: Viewer, id: string, input: CandidateArchiveInput): Promise<DecisionResult> {
  return changeState(v, id, 'archived', { reasonText: input.reasonText ?? null, action: 'candidate.archived' })
}

/** Самоотвод (§4.2): кандидат сам отказался от участия, доступ закрывается. */
export async function withdrawCandidate(v: Viewer, id: string, input: CandidateArchiveInput): Promise<DecisionResult> {
  return changeState(v, id, 'withdrawn', { reasonText: input.reasonText ?? null, action: 'candidate.withdrawn' })
}

/** Возврат в воронку (§4.2): только админ, с причиной и только пока согласие не истекло. */
export async function reopenCandidate(v: Viewer, id: string, input: CandidateReopenInput): Promise<DecisionResult> {
  return changeState(v, id, 'active', { reasonText: input.reasonText, action: 'candidate.reopened' })
}

// ── Найм (§5.5, §7.6, §12.5) ───────────────────────────────────────────────────────────────

/** На сколько дней продлевается вход кандидата, которого не наняли из-за лимита (§12.5). */
const ACCESS_ON_LIMIT_DAYS = 14

/**
 * Перевод кандидата в штат одной транзакцией (§7.6).
 *
 * Место сотрудника проверяется **внутри этой транзакции**, до смены вида (`assertSeatsWithinLimit`,
 * `docs/v2/35` §7.5, §12): проверка «до транзакции» пропускала два параллельных найма на последнее
 * место, а сбой самой проверки ронял найм без объяснения. Мест нет — транзакция откатывается
 * целиком, кандидат остаётся кандидатом, рекрутер получает понятный отказ, а кандидату
 * продлевается право входа на 14 дней, чтобы не потерять человека из-за биллинга (§12.5).
 * Внутри транзакции — смена вида, размещение, наставник, этап жизненного цикла, роли по
 * должности и `audit_log`; при ошибке на любом шаге откатывается всё.
 *
 * Курсы онбординга выдаются **после** фиксации: назначение — обычный `assignments` со своей
 * транзакцией и раскрытием аудитории (инвариант 1, §1 «Границы ответственности»). Провал
 * выдачи не отменяет найма: человек уже сотрудник, а не выданный курс виден в карточке и
 * выдаётся повторно, тогда как откат найма оставил бы сотрудника кандидатом с размещением.
 */
export async function hireCandidate(v: Viewer, id: string, input: CandidateHireInput): Promise<HireResult> {
  let hired: HireResult
  try {
    hired = await hireTx(v, id, input)
  }
  catch (err) {
    if (!(err instanceof LimitExceededError)) throw err // сбой проверки мест — `503`, не найм
    const accessUntil = await extendAccess(v, id, ACCESS_ON_LIMIT_DAYS)
    const { used, limit } = err.details
    const message = [
      seatText('hireBlocked', { used, limit: limit ?? '∞' }),
      ...(accessUntil ? [seatText('hireAccessExtended', { days: ACCESS_ON_LIMIT_DAYS })] : []),
    ].join(' ')
    return { ok: false, code: 'limit_exceeded', used, limit, accessUntil, message }
  }
  if (!hired.ok) return hired

  const assigned = await assignOnboarding(v, id, input)
  const { measureLive, syncCounter } = await import('./usageCounters')
  const usersActive = await measureLive(v.tenantId, 'users_active')
  const candidatesActive = await measureLive(v.tenantId, 'candidates_active')
  await syncCounter(v.tenantId, 'users_active', usersActive).catch(() => null)
  await syncCounter(v.tenantId, 'candidates_active', candidatesActive).catch(() => null)
  await notifyHired(v, id, input).catch(err => console.error('candidate_hired notify', err))

  return { ok: true, outcome: { userId: id, assigned, usersActive, candidatesActive } }
}

/** Транзакция найма: проверки, место сотрудника, смена вида и всё, что едет с ней (§7.6). */
async function hireTx(v: Viewer, id: string, input: CandidateHireInput): Promise<HireResult> {
  return withTenant(v.tenantId, v.actorId, async (tx): Promise<HireResult> => {
    const [row] = await candidatesQuery(tx, COLUMNS, eq(users.id, id), scopeCond(v)) as unknown as CandidateRow[]
    if (!row) return { ok: false, code: 'not_found' }
    if (row.state !== 'active') return { ok: false, code: 'not_active' }

    const [loc] = await tx.select({ id: locations.id, orgUnitId: locations.orgUnitId, cityId: locations.cityId })
      .from(locations).where(eq(locations.id, input.locationId))
    if (!loc) return { ok: false, code: 'location_not_found' }
    const [pos] = await tx.select({ id: positions.id }).from(positions).where(eq(positions.id, input.positionId))
    if (!pos) return { ok: false, code: 'position_not_found' }

    // Кандидат места сотрудника не занимает — после смены вида займёт. Проверка здесь, в этой же
    // транзакции и до записи: отказ бросается исключением и откатывает найм целиком.
    await assertSeatsWithinLimit(tx, v.tenantId, 1)

    await tx.update(users).set({
      kind: 'employee',
      // §3.2 сильнее §7.6: у сотрудника состояния воронки нет, факт хранят две даты ниже.
      candidateState: null,
      candidateStatusId: null,
      candidateStateAt: new Date(),
      status: 'active',
      hiredAt: input.startDate,
      convertedFromCandidateAt: new Date(),
      // Право входа кандидата (§3.2) сотруднику не нужно: он входит как все, без срока.
      accessUntil: null,
      updatedAt: new Date(),
    }).where(eq(users.id, id))

    // Прошлых размещений у кандидата нет по определению, но закрытие основного оставлено
    // тем же правилом, что и в `people.addPlacement` (docs/01 §1.8): история цела.
    await tx.update(userPlacements).set({ endedAt: sql`current_date` })
      .where(and(eq(userPlacements.userId, id), eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt)))
    await tx.insert(userPlacements).values({
      tenantId: v.tenantId,
      userId: id,
      locationId: input.locationId,
      positionId: input.positionId,
      positionLevelId: input.positionLevelId ?? null,
      cityId: loc.cityId ?? null,
      orgUnitId: input.orgUnitId ?? loc.orgUnitId,
      isPrimary: true,
      startedAt: input.startDate,
    })

    // Наставник онбординга (§5.5). Отдельной колонки «наставник сотрудника» в схеме нет и
    // выдумывать её не стали: ближайшее существующее понятие — функциональный руководитель
    // с областью, и область здесь названа явно («onboarding»), чтобы наставника онбординга
    // можно было отличить от прочих функциональных связей.
    if (input.mentorId && input.mentorId !== id) {
      await tx.insert(functionalChiefs)
        .values({ tenantId: v.tenantId, userId: id, chiefId: input.mentorId, kind: 'functional', scope: MENTOR_SCOPE_ONBOARDING })
        .onConflictDoUpdate({ target: [functionalChiefs.userId, functionalChiefs.chiefId, functionalChiefs.kind], set: { scope: MENTOR_SCOPE_ONBOARDING, updatedAt: new Date() } })
    }

    // Этап жизненного цикла нового сотрудника — «Онбординг» (docs/v2/33 §4.1): человек вышел
    // из рекрутинга, и следующий этап определяется этим фактом, а не кодом в ветвлении
    // (инвариант 16 — здесь код этапа называется как данность справочника, не как условие).
    await enterStageByCodeTx(tx, { tenantId: v.tenantId, userId: id, code: STAGE_ON_HIRE, reasonCode: 'hire', enteredBy: v.actorId })
      .catch(err => console.error('lifecycle onboarding', err))
    await applyPositionRoles(tx, { tenantId: v.tenantId, actorId: v.actorId }, id)

    await recordAudit(tx, {
      tenantId: v.tenantId,
      actorId: v.actorId,
      action: 'candidate.hired',
      entity: 'user',
      entityId: id,
      before: { kind: 'candidate', state: row.state, statusId: row.statusId },
      after: {
        kind: 'employee',
        locationId: input.locationId,
        positionId: input.positionId,
        startDate: input.startDate,
        mentorId: input.mentorId ?? null,
      },
    })
    // Вебхук наружу (докс/v2/44 В-18): только идентификаторы и время, без ФИО и контактов —
    // получатель добирает подробности через API под своими скоупами.
    await emitWebhook(tx, v.tenantId, 'candidate.hired', { userId: id, vacancyId: row.vacancyId, hiredAt: input.startDate })
    return { ok: true, outcome: { userId: id, assigned: 0, usersActive: 0, candidatesActive: 0 } }
  })
}

/**
 * Продление права входа на N дней — §12.5: кандидат не должен теряться из-за исчерпанного тарифа.
 * `::int` обязателен: `date + <параметр без типа>` Postgres не разрешает («operator is not
 * unique»), и без приведения продление молча не происходило никогда (ошибку глотает `catch`).
 */
async function extendAccess(v: Viewer, id: string, days: number): Promise<string | null> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const [row] = await tx.update(users)
      .set({ accessUntil: sql`greatest(coalesce(${users.accessUntil}, current_date), current_date) + ${days}::int`, updatedAt: new Date() })
      .where(and(eq(users.id, id), candidateOnly()))
      .returning({ accessUntil: users.accessUntil })
    return row?.accessUntil ?? null
  }).catch(() => null)
}

/** Курсы онбординга обычным назначением (§5.5): своего механизма выдачи у найма нет. */
async function assignOnboarding(v: Viewer, id: string, input: CandidateHireInput): Promise<number> {
  if (!input.onboardingCourseIds.length) return 0
  const { createAssignment } = await import('./assignments')
  const { assignmentCreateSchema } = await import('../../shared/schemas/assignments')
  let done = 0
  for (const courseId of input.onboardingCourseIds) {
    const payload = assignmentCreateSchema.parse({
      subjectType: 'course',
      subjectId: courseId,
      audience: { rules: [{ type: 'user', ids: [id] }] },
      status: 'active',
      isMandatory: true,
    })
    const res = await createAssignment({ tenantId: v.tenantId, actorId: v.actorId }, payload)
      .catch((err) => {
        console.error('onboarding assignment', err)
        return { ok: false as const, code: 'subject_not_found' as const }
      })
    if (res.ok) done += 1
  }
  return done
}

/** Письма найма (§8): кандидату — «Вітаємо у команді», рекрутеру и HR — «виходить <дата>». */
async function notifyHired(v: Viewer, id: string, input: CandidateHireInput): Promise<void> {
  await withTenant(v.tenantId, v.actorId, async (tx) => {
    const [person] = await tx.select({ fullName: users.fullName, recruiterId: users.recruiterId }).from(users).where(eq(users.id, id))
    if (input.welcomeLetter) {
      await enqueueNotification(tx, {
        tenantId: v.tenantId,
        userId: id,
        code: 'candidate_hired',
        channel: 'email',
        payload: { date: input.startDate },
        dedupKey: `candidate_hired:${id}`,
        refType: 'user',
        refId: id,
      })
    }
    const watcher = person?.recruiterId ?? v.actorId
    if (watcher && watcher !== id) {
      await enqueueNotification(tx, {
        tenantId: v.tenantId,
        userId: watcher,
        code: 'candidate_hired_manager',
        payload: { name: person?.fullName ?? '', date: input.startDate },
        dedupKey: `candidate_hired_manager:${id}`,
        refType: 'user',
        refId: id,
      })
    }
  })
}

// ── Стирание ПД по истёкшему согласию (§7.9) ───────────────────────────────────────────────

/**
 * Обезличивание одной записи — тело `candidate.consent_sweep` и ручка «відкликав згоду» (§12.7).
 *
 * Что уходит: ФИО, телефон, e-mail, резюме, комментарии рекрутеров. Что остаётся: прохождение,
 * оценки и история статусов — они уже не персональные данные, а статистика воронки, и без них
 * отчёт по найму задним числом разваливается. Операция необратима и пишется в `audit_log`.
 */
export async function anonymizeCandidate(tx: TenantTx, tenantId: string, id: string, actorId: string | null, reason: string): Promise<boolean> {
  const short = id.slice(0, 8)
  const [row] = await tx.update(users).set({
    fullName: `Кандидат №${short}`,
    lastName: 'Кандидат',
    firstName: `№${short}`,
    middleName: null,
    latinName: null,
    phone: null,
    email: null,
    birthDate: null,
    avatarKey: null,
    comment: null,
    telegramChatId: null,
    externalId: null,
    resumeAssetId: null,
    consentExpiresAt: null,
    anonymizedAt: new Date(),
    candidateState: 'archived',
    candidateStateAt: new Date(),
    isBlocked: true,
    updatedAt: new Date(),
  }).where(and(eq(users.id, id), candidateOnly(), isNull(users.anonymizedAt))).returning({ id: users.id })
  if (!row) return false
  // Стёртый — архивный (§7.9, §12.7 «доступ закрывается»): его сессии гаснут вместе с данными
  await closeCandidateSessionsTx(tx, tenantId, [id], { by: actorId, state: 'archived' })
  await tx.delete(candidateComments).where(eq(candidateComments.candidateId, id))
  // Записи ИИ-собеседования стираются тем же проходом и в той же транзакции (`docs/v2/30` §7.9):
  // аудио, расшифровки, обоснования и цитаты, вход и выход модели — второго механизма сроков ПД нет
  await redactInterviewData(tx, tenantId, id, { reason: 'anonymized', actorId })
  await recordAudit(tx, {
    tenantId,
    actorId,
    action: 'candidate.anonymized',
    entity: 'user',
    entityId: id,
    after: { reason },
  })
  return true
}
