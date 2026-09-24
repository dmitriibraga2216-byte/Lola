import { and, asc, eq, inArray, ne } from 'drizzle-orm'
import { automationRules, courses, positionGroups, positions } from '../db/schema'
import { withTenant, type TenantTx } from '../utils/withTenant'
import type { DefaultCourseItem } from '../../shared/schemas/positions'
import { recordAudit } from './audit'
import { saveDimensions } from './automation'

/**
 * «Посада → курси за замовчуванням» (docs/v2/39 П-24.3; второй эталон — колонка «Треки» в
 * справочнике должностей; потребитель — окно найма `docs/v2/28` §5.5). **Отдельной таблицы
 * нет**: это обычное правило `automation_rules`, привязанное к должности (`position_id`) или к
 * группе должностей (`position_group_id`, П-24.5), с измерением `position` и действиями
 * `assign_content`. Движок правил не меняется: при найме и переводе (`user.placement_changed`)
 * правило назначает курсы так же, как любое другое.
 *
 * Правило группы держит в измерении `position` текущий состав группы — `syncGroupRule`
 * пересобирает его, когда должность входит в группу или выходит из неё. Пустой состав или пустой
 * список курсов — правило выключено: пустое измерение в движке означает «любая должность», и
 * правило группы без должностей назначало бы курсы всем.
 */

interface Ctx { tenantId: string, actorId: string }

export type DefaultsTarget = { kind: 'position', id: string } | { kind: 'group', id: string }

export interface DefaultCourse { courseId: string, title: string, dueDays: number }

export interface PositionDefaults {
  ruleId: string | null
  items: DefaultCourse[]
  /** Для должности — курсы её группы: назначаются тем же найму, правятся в карточке группы */
  group: { id: string, name: string, items: DefaultCourse[] } | null
  /** Что получит человек при найме на должность: свои курсы плюс курсы группы, без повторов */
  effective: DefaultCourse[]
}

type AssignAction = { type: 'assign_content', subjectType: string, subjectId: string, dueDays: number }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function ruleOf(tx: TenantTx, target: DefaultsTarget) {
  const [r] = await tx.select().from(automationRules)
    .where(target.kind === 'position' ? eq(automationRules.positionId, target.id) : eq(automationRules.positionGroupId, target.id))
  return r ?? null
}

async function itemsOf(tx: TenantTx, rule: { actions: unknown } | null): Promise<DefaultCourse[]> {
  const actions = ((rule?.actions ?? []) as AssignAction[]).filter(a => a.type === 'assign_content' && a.subjectType === 'course')
  if (!actions.length) return []
  const rows = await tx.select({ id: courses.id, title: courses.title }).from(courses).where(inArray(courses.id, actions.map(a => a.subjectId)))
  const title = new Map(rows.map(r => [r.id, r.title]))
  // Удалённый курс из списка выпадает молча: назначать его всё равно некому
  return actions.filter(a => title.has(a.subjectId)).map(a => ({ courseId: a.subjectId, title: title.get(a.subjectId)!, dueDays: a.dueDays }))
}

async function targetName(tx: TenantTx, target: DefaultsTarget): Promise<{ name: string, groupId: string | null } | null> {
  if (!UUID_RE.test(target.id)) return null
  if (target.kind === 'position') {
    const [p] = await tx.select({ name: positions.name, groupId: positions.groupId }).from(positions).where(eq(positions.id, target.id))
    return p ?? null
  }
  const [g] = await tx.select({ name: positionGroups.name }).from(positionGroups).where(eq(positionGroups.id, target.id))
  return g ? { name: g.name, groupId: null } : null
}

/** Курсы по умолчанию должности или группы; чужой тенант и несуществующее — null (404). */
export async function getDefaultCourses(ctx: Ctx, target: DefaultsTarget): Promise<PositionDefaults | null> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const t = await targetName(tx, target)
    if (!t) return null
    const rule = await ruleOf(tx, target)
    const items = await itemsOf(tx, rule)
    let group: PositionDefaults['group'] = null
    if (target.kind === 'position' && t.groupId) {
      const [g] = await tx.select({ id: positionGroups.id, name: positionGroups.name }).from(positionGroups).where(eq(positionGroups.id, t.groupId))
      if (g) group = { ...g, items: await itemsOf(tx, await ruleOf(tx, { kind: 'group', id: g.id })) }
    }
    const seen = new Set(items.map(i => i.courseId))
    const effective = [...items, ...(group?.items ?? []).filter(i => !seen.has(i.courseId))]
    return { ruleId: rule?.id ?? null, items, group, effective }
  })
}

/** Должности, на которые смотрит правило: сама должность или текущий состав группы. */
async function positionIdsOf(tx: TenantTx, target: DefaultsTarget): Promise<string[]> {
  if (target.kind === 'position') return [target.id]
  const rows = await tx.select({ id: positions.id }).from(positions).where(eq(positions.groupId, target.id)).orderBy(asc(positions.name))
  return rows.map(r => r.id)
}

async function writeRule(tx: TenantTx, tenantId: string, target: DefaultsTarget, name: string, items: DefaultCourseItem[]): Promise<string | null> {
  const existing = await ruleOf(tx, target)
  const positionIds = await positionIdsOf(tx, target)
  const actions: AssignAction[] = items.map(i => ({ type: 'assign_content', subjectType: 'course', subjectId: i.courseId, dueDays: i.dueDays }))
  const isActive = actions.length > 0 && positionIds.length > 0
  const ruleName = `${target.kind === 'position' ? 'Посада' : 'Група посад'} «${name}»: курси за замовчуванням`
  let ruleId: string
  if (existing) {
    await tx.update(automationRules).set({ name: ruleName, actions, isActive, updatedAt: new Date() }).where(eq(automationRules.id, existing.id))
    ruleId = existing.id
  }
  else {
    if (!actions.length) return null
    const [r] = await tx.insert(automationRules).values({
      tenantId,
      name: ruleName,
      description: 'Створено довідником посад: призначення курсів при найманні та переведенні на посаду (docs/v2/39 П-24.3)',
      trigger: 'user.placement_changed',
      actions,
      isActive,
      positionId: target.kind === 'position' ? target.id : null,
      positionGroupId: target.kind === 'group' ? target.id : null,
    }).returning({ id: automationRules.id })
    ruleId = r!.id
  }
  // Пустой список значений движок читает как «будь-яка посада» — поэтому при пустом составе
  // правило выключено (isActive выше), а измерение хранит ровно то, что есть
  await saveDimensions(tx, tenantId, ruleId, positionIds.length ? [{ dimension: 'position', mode: 'include', valueIds: positionIds }] : [])
  return ruleId
}

export type SetDefaultsResult = { ok: true, defaults: PositionDefaults } | { ok: false, code: 'not_found' | 'course_not_found', courseIds?: string[] }

/**
 * Задать курсы по умолчанию. Пустой список — правило выключается, но не удаляется: назначения,
 * которые оно уже сделало, остаются у людей (снять курс с должности не значит отнять его у тех,
 * кто уже учится), а история срабатываний правила не теряется.
 */
export async function setDefaultCourses(ctx: Ctx, target: DefaultsTarget, items: DefaultCourseItem[]): Promise<SetDefaultsResult> {
  const r = await withTenant(ctx.tenantId, ctx.actorId, async (tx): Promise<SetDefaultsResult | null> => {
    const t = await targetName(tx, target)
    if (!t) return { ok: false, code: 'not_found' }
    if (items.length) {
      const found = await tx.select({ id: courses.id }).from(courses).where(and(inArray(courses.id, items.map(i => i.courseId)), ne(courses.status, 'archived')))
      const missing = items.map(i => i.courseId).filter(id => !found.some(f => f.id === id))
      if (missing.length) return { ok: false, code: 'course_not_found', courseIds: missing }
    }
    const before = await itemsOf(tx, await ruleOf(tx, target))
    await writeRule(tx, ctx.tenantId, target, t.name, items)
    await recordAudit(tx, {
      tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'position.default_courses', entity: target.kind === 'position' ? 'position' : 'position_group', entityId: target.id,
      before: { courses: before.map(i => i.courseId) }, after: { courses: items.map(i => i.courseId) },
    })
    return null
  })
  if (r) return r
  return { ok: true, defaults: (await getDefaultCourses(ctx, target))! }
}

/**
 * Состав группы изменился (должность вошла, вышла, переименована группа): правило группы
 * пересобирает измерение `position`. Зовётся в той же транзакции, что и правка должности.
 */
export async function syncGroupRule(tx: TenantTx, tenantId: string, groupId: string | null): Promise<void> {
  if (!groupId) return
  const target: DefaultsTarget = { kind: 'group', id: groupId }
  const rule = await ruleOf(tx, target)
  if (!rule) return
  const [g] = await tx.select({ name: positionGroups.name }).from(positionGroups).where(eq(positionGroups.id, groupId))
  if (!g) return
  const items = ((rule.actions ?? []) as AssignAction[]).filter(a => a.type === 'assign_content').map(a => ({ courseId: a.subjectId, dueDays: a.dueDays }))
  await writeRule(tx, tenantId, target, g.name, items)
}

/** Должность переименована — правило её курсов по умолчанию называется так же (список правил). */
export async function renameBoundRule(tx: TenantTx, positionId: string, name: string): Promise<void> {
  if (!name) return
  await tx.update(automationRules).set({ name: `Посада «${name}»: курси за замовчуванням`, updatedAt: new Date() })
    .where(eq(automationRules.positionId, positionId))
}
