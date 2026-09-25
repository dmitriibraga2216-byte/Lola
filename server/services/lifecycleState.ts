import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { employeeLifecycleState, lifecycleStages, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { LIFECYCLE_STAGE_FLOW } from '../../shared/enums'
import type { LifecycleStageCode } from '../../shared/enums'
import { recordAudit } from './audit'
import { frameJoins, frameWhere, periodSql } from './reportFrame'
import type { ReportFilter } from '../../shared/schemas/reports'

/**
 * Состояние человека в жизненном цикле (docs/v2/33-lifecycle.md §3.5, §4.1, §7.6).
 *
 * Этап человека хранится явно, а не выводится из его назначений (§3.5, гипотеза Г-33.2):
 * вывод ломается в первом же реальном случае — сотрудник с параллельными назначениями двух
 * этапов. Текущая запись ровно одна, это держит частичный уникальный индекс
 * `uq_employee_lifecycle_current`, а не проверка в коде.
 *
 * Ветвления по коду этапа здесь нет: граф переходов — данные (`LIFECYCLE_STAGE_FLOW`
 * в `shared/enums.ts`, рядом с самим перечнем кодов), а не `if (stage.code === '…')`
 * (§7.1, сквозная проверка 1 в `scripts/v2-crosschecks.sh`).
 */

export interface StateRow {
  id: string
  stageId: string
  stageCode: string
  stageName: string
  enteredAt: Date
  leftAt: Date | null
  enteredBy: string | null
  reasonCode: string | null
  isCurrent: boolean
  /** Сколько дней человек в этапе; для закрытых записей — сколько пробыл. */
  daysInStage: number
  /** Норма времени этапа (§7.11); `null` — нормы нет. */
  expectedDays: number | null
  /** Норма превышена — сигнал для отчёта «застрягли», ничего не блокирует (§7.11). */
  overdue: boolean
}

const DAY_MS = 86_400_000

function toRow(r: {
  id: string
  stageId: string
  code: string
  nameUk: string
  expectedDays: number | null
  enteredAt: Date
  leftAt: Date | null
  enteredBy: string | null
  reasonCode: string | null
  isCurrent: boolean
}): StateRow {
  const until = r.leftAt ?? new Date()
  const days = Math.max(0, Math.floor((until.getTime() - r.enteredAt.getTime()) / DAY_MS))
  return {
    id: r.id,
    stageId: r.stageId,
    stageCode: r.code,
    stageName: r.nameUk,
    enteredAt: r.enteredAt,
    leftAt: r.leftAt,
    enteredBy: r.enteredBy,
    reasonCode: r.reasonCode,
    isCurrent: r.isCurrent,
    daysInStage: days,
    expectedDays: r.expectedDays,
    overdue: r.isCurrent && r.expectedDays != null && days > r.expectedDays,
  }
}

const SELECT = {
  id: employeeLifecycleState.id,
  stageId: employeeLifecycleState.stageId,
  code: lifecycleStages.code,
  nameUk: lifecycleStages.nameUk,
  expectedDays: lifecycleStages.expectedDays,
  enteredAt: employeeLifecycleState.enteredAt,
  leftAt: employeeLifecycleState.leftAt,
  enteredBy: employeeLifecycleState.enteredBy,
  reasonCode: employeeLifecycleState.reasonCode,
  isCurrent: employeeLifecycleState.isCurrent,
}

/** Этап тенанта по платформенному коду; `null` — этап не заведён (старый тенант без посева). */
export async function stageByCode(tx: TenantTx, code: LifecycleStageCode): Promise<{ id: string, code: string } | null> {
  const [s] = await tx
    .select({ id: lifecycleStages.id, code: lifecycleStages.code })
    .from(lifecycleStages)
    .where(eq(lifecycleStages.code, code))
  return s ?? null
}

/**
 * Перевод человека на этап внутри чужой транзакции: закрывает текущую запись (`left_at`,
 * `is_current = false`) и открывает новую. Возвращает `null`, если этапа у тенанта нет или
 * человек уже на нём — повторный вход не создаёт вторую запись и не сбивает счётчик дней
 * (§12.1: «счётчик дней в этапе не обнуляется»).
 */
export async function enterStageTx(tx: TenantTx, input: {
  tenantId: string
  userId: string
  stageId: string
  reasonCode: string
  enteredBy?: string | null
}): Promise<{ id: string, stageId: string } | null> {
  const [current] = await tx
    .select({ id: employeeLifecycleState.id, stageId: employeeLifecycleState.stageId })
    .from(employeeLifecycleState)
    .where(and(eq(employeeLifecycleState.userId, input.userId), eq(employeeLifecycleState.isCurrent, true)))
  if (current?.stageId === input.stageId) return null

  if (current) {
    await tx
      .update(employeeLifecycleState)
      .set({ leftAt: new Date(), isCurrent: false, updatedAt: new Date() })
      .where(eq(employeeLifecycleState.id, current.id))
  }
  const [row] = await tx
    .insert(employeeLifecycleState)
    .values({
      tenantId: input.tenantId,
      userId: input.userId,
      stageId: input.stageId,
      reasonCode: input.reasonCode,
      enteredBy: input.enteredBy ?? null,
    })
    .returning({ id: employeeLifecycleState.id, stageId: employeeLifecycleState.stageId })
  await recordAudit(tx, {
    tenantId: input.tenantId,
    actorId: input.enteredBy ?? null,
    action: 'lifecycle.stage_entered',
    entity: 'employee_lifecycle_state',
    entityId: row!.id,
    before: current ? { stageId: current.stageId } : null,
    after: { stageId: input.stageId, reasonCode: input.reasonCode },
  })
  return row!
}

/** То же по платформенному коду этапа — для найма (`onboarding`) и офбординга. */
export async function enterStageByCodeTx(tx: TenantTx, input: {
  tenantId: string
  userId: string
  code: LifecycleStageCode
  reasonCode: string
  enteredBy?: string | null
}): Promise<{ id: string, stageId: string } | null> {
  const stage = await stageByCode(tx, input.code)
  if (!stage) return null
  return enterStageTx(tx, { ...input, stageId: stage.id })
}

export interface Ctx { tenantId: string, actorId: string }

/** Текущий этап и история (`33` §10 `GET /lifecycle/state/:userId`, §5.3 блок «Етап»). */
export async function personState(ctx: Ctx, userId: string): Promise<{ current: StateRow | null, history: StateRow[] } | null> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [person] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId))
    if (!person) return null
    const rows = await tx
      .select(SELECT)
      .from(employeeLifecycleState)
      .innerJoin(lifecycleStages, eq(lifecycleStages.id, employeeLifecycleState.stageId))
      .where(eq(employeeLifecycleState.userId, userId))
      .orderBy(desc(employeeLifecycleState.enteredAt))
    const history = rows.map(toRow)
    return { current: history.find(r => r.isCurrent) ?? null, history }
  })
}

export type StateError = 'not_found' | 'stage_disabled' | 'same_stage'

/** Ручной перевод HR с указанием причины (`33` §7.6, §10 `POST /lifecycle/state/:userId`). */
export async function setPersonStage(ctx: Ctx, userId: string, input: { stageId: string, reasonCode: string }): Promise<StateRow | StateError> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [person] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId))
    if (!person) return 'not_found'
    const [stage] = await tx.select().from(lifecycleStages).where(eq(lifecycleStages.id, input.stageId))
    if (!stage) return 'not_found'
    // Выключенный этап — не место для человека: §7.10 «курсы выключенного этапа не назначаются»,
    // §5.2 «выключить можно только этап без активных людей».
    if (!stage.isEnabled) return 'stage_disabled'
    const entered = await enterStageTx(tx, { tenantId: ctx.tenantId, userId, stageId: input.stageId, reasonCode: input.reasonCode, enteredBy: ctx.actorId })
    if (!entered) return 'same_stage'
    const [row] = await tx
      .select(SELECT)
      .from(employeeLifecycleState)
      .innerJoin(lifecycleStages, eq(lifecycleStages.id, employeeLifecycleState.stageId))
      .where(eq(employeeLifecycleState.id, entered.id))
    return toRow(row!)
  })
}

/**
 * `lifecycle.advance` (`33` §11, §7.6; критерий §13 п. 7).
 *
 * Переход вперёд происходит, когда завершены **все** обязательные назначения текущего этапа.
 * Необязательные переход не блокируют. Пустой этап (ни одного обязательного назначения) не
 * завершается сам собой — иначе человек проскакивал бы онбординг, которому ещё ничего не выдали.
 *
 * Куда переводить, решает `LIFECYCLE_STAGE_FLOW`: этап без продолжения (`training` — рабочее
 * состояние по умолчанию) оставляет человека на месте.
 */
export async function advanceLifecycleTx(tx: TenantTx, tenantId: string, userId: string): Promise<{ from: string, to: string } | null> {
  const [current] = await tx
    .select({ id: employeeLifecycleState.id, stageId: employeeLifecycleState.stageId, code: lifecycleStages.code })
    .from(employeeLifecycleState)
    .innerJoin(lifecycleStages, eq(lifecycleStages.id, employeeLifecycleState.stageId))
    .where(and(eq(employeeLifecycleState.userId, userId), eq(employeeLifecycleState.isCurrent, true)))
  if (!current) return null

  const nextCode = LIFECYCLE_STAGE_FLOW[current.code as LifecycleStageCode]
  if (!nextCode) return null

  // Обязательные назначения этапа: записи по курсам этого этапа, выданные обязательным
  // назначением и не снятые. `done` и `failed` — завершённые состояния (docs/02 enrollment_status).
  const [counts] = await tx.execute(sql`
    select
      count(*)::int as total,
      count(*) filter (where e.status not in ('done', 'failed'))::int as open
    from enrollments e
    join courses c on c.id = e.subject_id
    join assignments a on a.id = e.assignment_id
    where e.user_id = ${userId}::uuid
      and c.lifecycle_stage_id = ${current.stageId}::uuid
      and a.is_mandatory
      and e.cancelled_at is null`) as unknown as { total: number, open: number }[]
  if (!counts || counts.total === 0 || counts.open > 0) return null

  const moved = await enterStageByCodeTx(tx, { tenantId, userId, code: nextCode, reasonCode: 'advance', enteredBy: null })
  return moved ? { from: current.code, to: nextCode } : null
}

/** Сколько людей сейчас в каждом этапе — счётчик экрана `/settings/lifecycle` (`33` §5.2). */
export async function peopleCounts(tx: TenantTx): Promise<Map<string, number>> {
  const rows = await tx
    .select({ stageId: employeeLifecycleState.stageId, n: sql<number>`count(*)::int` })
    .from(employeeLifecycleState)
    .where(and(eq(employeeLifecycleState.isCurrent, true), isNull(employeeLifecycleState.leftAt)))
    .groupBy(employeeLifecycleState.stageId)
  return new Map(rows.map(r => [r.stageId, Number(r.n)]))
}

export interface StageSpeedRow {
  stageId: string
  stage: string
  code: string
  expectedDays: number | null
  n: number
  medianDays: number | null
  p90Days: number | null
  exceededSharePct: number
}

/**
 * «Швидкість проходження етапів» (`33` §9 п. 2, PR-38, П-22). Строка — этап, метрика — только по
 * **завершённым** пребываниям (`left_at is not null`): отчёт о скорости прохождения, а не о том,
 * кто застрял сейчас (для этого — карточка и дайджест руководителя, `33` §7.11). Область людей —
 * тем же каркасом (`frameWhere`), фильтр точки/підрозділу/посади — по текущему розміщенню.
 */
export async function stageSpeedReport(ctx: Ctx & { scope?: string[] | null }, f: ReportFilter & { stageCode?: string }): Promise<StageSpeedRow[]> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const stageFilter = f.stageCode ? sql`and ls.code = ${f.stageCode}` : sql``
    const rows = await tx.execute(sql`
      select ls.id as stage_id, ls.name_uk as stage, ls.code, ls.expected_days, ls.sort,
             count(*)::int as n,
             round((percentile_cont(0.5) within group (order by extract(epoch from (els.left_at - els.entered_at)) / 86400))::numeric, 1) as median_days,
             round((percentile_cont(0.9) within group (order by extract(epoch from (els.left_at - els.entered_at)) / 86400))::numeric, 1) as p90_days,
             count(*) filter (where ls.expected_days is not null and extract(epoch from (els.left_at - els.entered_at)) / 86400 > ls.expected_days)::int as exceeded
        from employee_lifecycle_state els
        join users u on u.id = els.user_id
        join lifecycle_stages ls on ls.id = els.stage_id
        ${frameJoins()}
       where els.left_at is not null
             ${frameWhere({ positionIds: f.positionIds, orgUnitId: f.orgUnitId, tags: f.tags, includeArchived: f.includeArchived, scope: ctx.scope ?? null })}
             ${periodSql(sql`els.left_at`, f)} ${stageFilter}
       group by ls.id, ls.name_uk, ls.code, ls.expected_days, ls.sort
       order by ls.sort`) as unknown as { stage_id: string, stage: string, code: string, expected_days: number | null, n: number, median_days: string | null, p90_days: string | null, exceeded: number }[]
    return rows.map(r => ({
      stageId: r.stage_id, stage: r.stage, code: r.code, expectedDays: r.expected_days,
      n: Number(r.n), medianDays: r.median_days == null ? null : Number(r.median_days), p90Days: r.p90_days == null ? null : Number(r.p90_days),
      exceededSharePct: r.n ? Math.round((Number(r.exceeded) / Number(r.n)) * 1000) / 10 : 0,
    }))
  })
}
