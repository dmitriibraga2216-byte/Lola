import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { courses, lifecycleStages, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import type { ContentType, StageCapability, StageCapabilityMap } from '../../shared/enums'
import type { LifecycleStagePatch, StageCapabilitiesInput } from '../../shared/schemas/lifecycle'
import { recordAudit } from './audit'
import { peopleCounts } from './lifecycleState'
import { CANDIDATE } from './repo/people'

/**
 * Этапы жизненного цикла (docs/v2/33-lifecycle.md; решение docs/v2/44-decisions.md В-3).
 *
 * Здесь живёт `stageCan()` — **единственная** точка, где поведение продукта зависит от этапа.
 * Инвариант пакета (CLAUDE.md п. 16, `33` §7.1): ветвления `if (stage.code === '…')` в
 * `server/` и `app/` нет ни одного, коды этапов встречаются только в справочнике
 * (`shared/enums.ts`), посеве (`server/db/tenantDefaults.ts`) и миграции. Держится сквозной
 * проверкой 1 в `scripts/v2-crosschecks.sh`.
 */

export interface Ctx { tenantId: string, actorId: string }

export interface StageRow {
  id: string
  code: string
  nameUk: string
  nameEn: string | null
  icon: string | null
  color: string
  sort: number
  isEnabled: boolean
  expectedDays: number | null
  capabilities: StageCapabilityMap
  appliesToCandidate: boolean
  /** Счётчики для экрана настроек (`33` §5.2) — курсов в этапе. */
  coursesCount: number
  /** …и людей, находящихся в этапе сейчас (PR-07: `employee_lifecycle_state`). */
  peopleCount: number
}

export type StageError = 'not_found' | 'capabilities_readonly' | 'stage_in_use'
export type CourseStageError = 'not_found' | 'stage_locked' | 'stage_disabled'

/** Носитель возможностей: этап или его отсутствие. `null` — курс без этапа. */
export interface StageLike { capabilities: StageCapabilityMap | null }

/**
 * Единственная точка проверки возможности этапа (`33` §7.1).
 *
 * Правила, которые она реализует:
 * - курс **без этапа** работает с полным набором возможностей, как обычный курс каталога
 *   базового ТЗ (`33` §7.3) — поэтому `null` отвечает `true` на любой ключ;
 * - **отсутствующий** ключ у этапа читается как `false` (`33` §3.3);
 * - ключ типизирован (`StageCapability`), то есть опечатка ломается компилятором, а не
 *   тихо выключает возможность (`44` В-3).
 */
export function stageCan(stage: StageLike | null | undefined, capability: StageCapability): boolean {
  if (!stage || !stage.capabilities) return true
  return stage.capabilities[capability] === true
}

/**
 * Носитель возможностей курса: `null` — у курса нет этапа либо самого курса нет (тогда
 * действует полный набор, `33` §7.3). Возвращает карту целиком — для тех мест, где ключей
 * спрашивают много (фильтр `params` назначения, `taskParams.ts`); решение по каждому ключу
 * всё равно принимает `stageCan()`.
 */
export async function courseStage(tx: TenantTx, courseId: string): Promise<StageLike | null> {
  const [row] = await tx
    .select({ capabilities: lifecycleStages.capabilities })
    .from(courses)
    .leftJoin(lifecycleStages, eq(lifecycleStages.id, courses.lifecycleStageId))
    .where(eq(courses.id, courseId))
  if (!row?.capabilities) return null
  return { capabilities: row.capabilities }
}

/** `stageCan()` для курса: читает этап курса и спрашивает у него возможность. */
export async function courseStageCan(tx: TenantTx, courseId: string, capability: StageCapability): Promise<boolean> {
  return stageCan(await courseStage(tx, courseId), capability)
}

const toRow = (s: typeof lifecycleStages.$inferSelect, coursesCount: number, peopleCount = 0): StageRow => ({
  id: s.id,
  code: s.code,
  nameUk: s.nameUk,
  nameEn: s.nameEn,
  icon: s.icon,
  color: s.color,
  sort: s.sort,
  isEnabled: s.isEnabled,
  expectedDays: s.expectedDays,
  capabilities: s.capabilities ?? {},
  appliesToCandidate: s.appliesToCandidate,
  coursesCount,
  peopleCount,
})

/** Справочник этапов тенанта с возможностями (`33` §10 `GET /lifecycle/stages`). */
export async function listStages(ctx: Ctx): Promise<StageRow[]> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select().from(lifecycleStages).orderBy(asc(lifecycleStages.sort))
    const counts = await courseCounts(tx)
    const people = await peopleCounts(tx)
    return rows.map(r => toRow(r, counts.get(r.id) ?? 0, people.get(r.id) ?? 0))
  })
}

async function courseCounts(tx: TenantTx): Promise<Map<string, number>> {
  const rows = await tx.execute(sql`
    select lifecycle_stage_id as stage_id, count(*)::int as n
    from courses
    where lifecycle_stage_id is not null and deleted_at is null
    group by lifecycle_stage_id`) as unknown as { stage_id: string, n: number }[]
  return new Map(rows.map(r => [r.stage_id, r.n]))
}

/**
 * Правка этапа тенантом (`33` §5.2, §10 `PATCH /lifecycle/stages/:id`).
 *
 * `code` не принимается контрактом вовсе — код неизменяем. `capabilities` тенанту недоступны:
 * набор возможностей задаёт платформа (`33` §2 — «отдавать их тенанту означает позволить ему
 * сломать продукт настройкой»), поэтому тело с ними отвергается `403 capabilities.readonly`.
 * Выключение этапа, в котором есть курсы, блокируется до переноса — `409 lifecycle_stage.in_use`
 * (`33` §5.2, критерий приёмки §13 п. 8).
 */
export async function updateStage(ctx: Ctx, id: string, patch: LifecycleStagePatch): Promise<StageRow | StageError> {
  if (patch.capabilities !== undefined) return 'capabilities_readonly'
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(lifecycleStages).where(eq(lifecycleStages.id, id))
    if (!before) return 'not_found'
    // §5.2: выключить можно только этап без курсов **и без людей** — §12.5 («выключен этап,
    // в котором люди сейчас находятся» → блокируется). Люди появились в PR-07 вместе с
    // `employee_lifecycle_state`; до него проверялись только курсы.
    if (patch.isEnabled === false && before.isEnabled) {
      const counts = await courseCounts(tx)
      const people = await peopleCounts(tx)
      if ((counts.get(id) ?? 0) > 0 || (people.get(id) ?? 0) > 0) return 'stage_in_use'
    }
    const [after] = await tx
      .update(lifecycleStages)
      .set({
        ...(patch.nameUk !== undefined ? { nameUk: patch.nameUk } : {}),
        ...(patch.nameEn !== undefined ? { nameEn: patch.nameEn } : {}),
        ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
        ...(patch.color !== undefined ? { color: patch.color } : {}),
        ...(patch.sort !== undefined ? { sort: patch.sort } : {}),
        ...(patch.isEnabled !== undefined ? { isEnabled: patch.isEnabled } : {}),
        ...(patch.expectedDays !== undefined ? { expectedDays: patch.expectedDays } : {}),
        updatedAt: new Date(),
      })
      .where(eq(lifecycleStages.id, id))
      .returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'lifecycle.stage_updated', entity: 'lifecycle_stages', entityId: id, before, after })
    const counts = await courseCounts(tx)
    const people = await peopleCounts(tx)
    return toRow(after!, counts.get(id) ?? 0, people.get(id) ?? 0)
  })
}

/**
 * Смена набора возможностей — **оператор платформы**, не администратор тенанта (`33` §2).
 * Неизвестный ключ сюда не доходит: его отвергает `stageCapabilitiesSchema` (`422`), а на
 * случай записи мимо API тот же перечень закрыт констрейнтом
 * `lifecycle_stages_capabilities_keys_check`.
 */
export async function setStageCapabilities(
  tenantId: string,
  stageId: string,
  capabilities: StageCapabilitiesInput,
): Promise<StageRow | StageError> {
  return withTenant(tenantId, null, async (tx) => {
    const [before] = await tx.select().from(lifecycleStages).where(eq(lifecycleStages.id, stageId))
    if (!before) return 'not_found'
    const [after] = await tx
      .update(lifecycleStages)
      .set({ capabilities: capabilities as StageCapabilityMap, updatedAt: new Date() })
      .where(eq(lifecycleStages.id, stageId))
      .returning()
    await recordAudit(tx, { tenantId, actorId: null, action: 'lifecycle.capabilities_changed', entity: 'lifecycle_stages', entityId: stageId, before, after })
    const counts = await courseCounts(tx)
    const people = await peopleCounts(tx)
    return toRow(after!, counts.get(stageId) ?? 0, people.get(stageId) ?? 0)
  })
}

/**
 * Присвоение и смена этапа курса (`33` §6.1, §7.4, §10 `PATCH /courses/:id/stage`).
 *
 * `stage_locked` выставляется в `true` после первого завершённого прохождения; смена этапа
 * у такого курса требует явного подтверждения администратора (модальное окно §6.1), без него —
 * `409 course.stage_locked` (критерий приёмки §13 п. 11). Уже созданные назначения при смене
 * **не пересчитываются** — их параметры зафиксированы в момент создания (инвариант 1).
 */
export async function setCourseStage(
  ctx: Ctx,
  courseId: string,
  stageId: string | null,
  confirm = false,
): Promise<{ id: string, lifecycleStageId: string | null, stageLocked: boolean, completedCount: number } | CourseStageError> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [course] = await tx.select().from(courses).where(eq(courses.id, courseId))
    if (!course || course.deletedAt) return 'not_found'
    if (stageId) {
      const [stage] = await tx.select().from(lifecycleStages).where(eq(lifecycleStages.id, stageId))
      if (!stage) return 'not_found'
      if (!stage.isEnabled) return 'stage_disabled'
    }
    const done = await tx.execute(sql`
      select count(*)::int as n from enrollments
      where subject_type = 'course' and subject_id = ${courseId} and status = 'done'`) as unknown as { n: number }[]
    const completedCount = done[0]?.n ?? 0
    // Правило §7.4: первое завершённое прохождение запирает этап курса.
    const locked = course.stageLocked || completedCount > 0
    if (locked && stageId !== course.lifecycleStageId && !confirm) return 'stage_locked'
    const [after] = await tx
      .update(courses)
      .set({ lifecycleStageId: stageId, stageLocked: locked, updatedAt: new Date() })
      .where(eq(courses.id, courseId))
      .returning({ id: courses.id, lifecycleStageId: courses.lifecycleStageId, stageLocked: courses.stageLocked })
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'course.stage_changed', entity: 'courses', entityId: courseId, before: { lifecycleStageId: course.lifecycleStageId }, after })
    return { ...after!, completedCount }
  })
}

/**
 * Правило §7.9 (критерий приёмки §13 п. 5): кандидату можно назначить только курсы этапов с
 * `applies_to_candidate = true` (по умолчанию `recruiting` и `psychological`). Попытка назначить
 * иной курс — `422 lifecycle.not_for_candidate`, назначение не создаётся.
 *
 * Проверка стоит **до** раскрытия аудитории и смотрит на людей, названных в правиле поимённо:
 * так отказ приходит именно как «этап не для кандидата», а не как «под условие никто не
 * подпадает». Решение принимает `stageCan()` — ветвления по коду этапа нет (§7.1).
 *
 * Обратная сторона (`applies_to_employee`) здесь не проверяется намеренно: документ её в
 * правилах не называет, а курс рекрутингового этапа сотруднику назначают в реальных сценариях
 * (кандидат нанят с незакрытым назначением — §12.6). Выдумывать запрет запрещено (CLAUDE.md).
 */
export async function stageForbidsCandidates(tx: TenantTx, contentType: ContentType, subjectId: string, userIds: string[]): Promise<boolean> {
  if (contentType !== 'course' || userIds.length === 0) return false
  if (stageCan(await courseStage(tx, subjectId), 'applies_to_candidate')) return false
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, userIds), eq(users.kind, CANDIDATE)))
    .limit(1)
  return rows.length > 0
}

/** Этапы, доступные кандидату (`33` §7.9): фильтр по зеркалу `applies_to_candidate`. */
export async function listCandidateStages(ctx: Ctx): Promise<StageRow[]> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx
      .select()
      .from(lifecycleStages)
      .where(and(eq(lifecycleStages.appliesToCandidate, true), eq(lifecycleStages.isEnabled, true)))
      .orderBy(asc(lifecycleStages.sort))
    const counts = await courseCounts(tx)
    const people = await peopleCounts(tx)
    return rows.map(r => toRow(r, counts.get(r.id) ?? 0, people.get(r.id) ?? 0))
  })
}
