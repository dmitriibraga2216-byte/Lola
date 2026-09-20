import { asc, eq, inArray } from 'drizzle-orm'
import { scaleLevels, scales } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { ScaleInput } from '../../shared/schemas/settings'
import { recordAudit } from './audit'

/**
 * Шкалы (docs/24 Г-24.4, docs/02 «Геймификация и шкалы»): одна сущность с `kind`.
 * `range` — «Шкали оцінки завдань»: диапазон процентов → название + характеристика (85–100 → Зараховано);
 * `levels` — «Шкали оцінювання» анкет и «Шкала компетенцій»: перечень уровней, `display_as label|value`.
 * Границы диапазонов проверяет zod (`scaleSchema`): подряд от 0 до 100, без дыр.
 */

export interface Ctx { tenantId: string, actorId: string }

export interface ScaleLevelOut { id: string, label: string, value: number | null, rangeFrom: number | null, rangeTo: number | null, characteristic: string | null, showInReports: boolean, sortOrder: number }
export interface ScaleOut { id: string, name: string, description: string | null, kind: 'range' | 'levels', displayAs: 'label' | 'value' | null, levels: ScaleLevelOut[], updatedAt: string }

const num = (v: string | null) => (v == null ? null : Number(v))

function assemble(rows: typeof scales.$inferSelect[], levels: typeof scaleLevels.$inferSelect[]): ScaleOut[] {
  return rows.map(s => ({
    id: s.id, name: s.name, description: s.description, kind: s.kind as ScaleOut['kind'], displayAs: s.displayAs as ScaleOut['displayAs'], updatedAt: s.updatedAt.toISOString(),
    levels: levels.filter(l => l.scaleId === s.id).sort((a, b) => a.sortOrder - b.sortOrder)
      .map(l => ({ id: l.id, label: l.label, value: num(l.value), rangeFrom: num(l.rangeFrom), rangeTo: num(l.rangeTo), characteristic: l.characteristic, showInReports: l.showInReports, sortOrder: l.sortOrder })),
  }))
}

export async function listScales(ctx: Ctx, kind?: 'range' | 'levels'): Promise<ScaleOut[]> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select().from(scales).where(kind ? eq(scales.kind, kind) : undefined).orderBy(asc(scales.name))
    const levels = rows.length ? await tx.select().from(scaleLevels).where(inArray(scaleLevels.scaleId, rows.map(r => r.id))) : []
    return assemble(rows, levels)
  })
}

export async function getScale(ctx: Ctx, id: string): Promise<ScaleOut | null> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select().from(scales).where(eq(scales.id, id))
    if (!rows.length) return null
    return assemble(rows, await tx.select().from(scaleLevels).where(eq(scaleLevels.scaleId, id)))[0]!
  })
}

function levelValues(tenantId: string, scaleId: string, input: ScaleInput) {
  return input.levels.map((l, i) => ({
    tenantId, scaleId, label: l.label, sortOrder: i,
    value: l.value == null ? null : String(l.value),
    rangeFrom: input.kind === 'range' ? String(l.rangeFrom) : null,
    rangeTo: input.kind === 'range' ? String(l.rangeTo) : null,
    characteristic: l.characteristic ?? null,
    showInReports: l.showInReports,
  }))
}

export type ScaleError = 'not_found' | 'name_taken'

export async function createScale(ctx: Ctx, input: ScaleInput): Promise<{ ok: true, scale: ScaleOut } | { ok: false, code: ScaleError }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [dup] = await tx.select({ id: scales.id }).from(scales).where(eq(scales.name, input.name))
    if (dup) return { ok: false as const, code: 'name_taken' as const }
    const [s] = await tx.insert(scales).values({ tenantId: ctx.tenantId, name: input.name, description: input.description ?? null, kind: input.kind, displayAs: input.kind === 'levels' ? (input.displayAs ?? 'label') : null }).returning()
    await tx.insert(scaleLevels).values(levelValues(ctx.tenantId, s!.id, input))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'scale.create', entity: 'scale', entityId: s!.id, after: { name: input.name, kind: input.kind, levels: input.levels.length } })
    return { ok: true as const, scale: assemble([s!], await tx.select().from(scaleLevels).where(eq(scaleLevels.scaleId, s!.id)))[0]! }
  })
}

/** Уровни пересобираются целиком: шкала — единый справочник, а не список независимых строк. */
export async function updateScale(ctx: Ctx, id: string, input: ScaleInput): Promise<{ ok: true, scale: ScaleOut } | { ok: false, code: ScaleError }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select().from(scales).where(eq(scales.id, id))
    if (!before) return { ok: false as const, code: 'not_found' as const }
    const [dup] = await tx.select({ id: scales.id }).from(scales).where(eq(scales.name, input.name))
    if (dup && dup.id !== id) return { ok: false as const, code: 'name_taken' as const }
    const oldLevels = await tx.select().from(scaleLevels).where(eq(scaleLevels.scaleId, id))
    const [s] = await tx.update(scales).set({ name: input.name, description: input.description ?? null, kind: input.kind, displayAs: input.kind === 'levels' ? (input.displayAs ?? 'label') : null, updatedAt: new Date() }).where(eq(scales.id, id)).returning()
    await tx.delete(scaleLevels).where(eq(scaleLevels.scaleId, id))
    await tx.insert(scaleLevels).values(levelValues(ctx.tenantId, id, input))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'scale.update', entity: 'scale', entityId: id, before: { name: before.name, kind: before.kind, levels: oldLevels.map(l => l.label) }, after: { name: input.name, kind: input.kind, levels: input.levels.map(l => l.label) } })
    return { ok: true as const, scale: assemble([s!], await tx.select().from(scaleLevels).where(eq(scaleLevels.scaleId, id)))[0]! }
  })
}

export async function deleteScale(ctx: Ctx, id: string): Promise<boolean> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [s] = await tx.delete(scales).where(eq(scales.id, id)).returning({ id: scales.id, name: scales.name })
    if (!s) return false
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'scale.delete', entity: 'scale', entityId: id, before: { name: s.name } })
    return true
  })
}

/** Название уровня по проценту для шкалы `range` — «85 → Зараховано». */
export function levelForPercent(scale: ScaleOut, pct: number): ScaleLevelOut | null {
  if (scale.kind !== 'range') return null
  return scale.levels.find(l => l.rangeFrom != null && l.rangeTo != null && pct >= l.rangeFrom && pct <= l.rangeTo) ?? null
}
