import { sql } from 'drizzle-orm'
import type { TagScope } from '../../shared/enums'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'

interface Ctx { tenantId: string, actorId: string }

/**
 * Справочники (docs/16 §3.3): переименование сохраняет связи; удалить используемый нельзя —
 * только деактивировать; слияние двух значений — отдельная операция с журналом.
 */
export const REF_KINDS = ['cities', 'positions', 'position-levels', 'position-groups', 'org-units', 'locations', 'tags'] as const
export type RefKind = typeof REF_KINDS[number]

const TABLE: Record<RefKind, string> = { 'cities': 'cities', 'positions': 'positions', 'position-levels': 'position_levels', 'position-groups': 'position_groups', 'org-units': 'org_units', 'locations': 'locations', 'tags': 'tags' }

/** Где значение используется — для запрета удаления и для слияния. */
const USAGE: Record<RefKind, { table: string, column: string }[]> = {
  'cities': [{ table: 'users', column: 'city_id' }, { table: 'locations', column: 'city_id' }, { table: 'user_placements', column: 'city_id' }],
  'positions': [{ table: 'user_placements', column: 'position_id' }, { table: 'position_profiles', column: 'position_id' }],
  'position-levels': [{ table: 'positions', column: 'level_id' }, { table: 'user_placements', column: 'position_level_id' }],
  // Группа должностей (docs/v2/39 П-24.5): удалить можно только пустую — иначе вместе с ней
  // тихо пропало бы правило «курси за замовчуванням» группы
  'position-groups': [{ table: 'positions', column: 'group_id' }],
  'org-units': [{ table: 'locations', column: 'org_unit_id' }, { table: 'org_units', column: 'parent_id' }, { table: 'user_placements', column: 'org_unit_id' }, { table: 'user_roles', column: 'scope_id' }],
  'locations': [{ table: 'user_placements', column: 'location_id' }, { table: 'user_roles', column: 'scope_id' }, { table: 'meetups', column: 'location_id' }],
  'tags': [],
}

const EDITABLE: Record<RefKind, string[]> = {
  'cities': ['name', 'is_active'],
  'positions': ['name', 'code', 'level_id', 'group_id', 'is_active'],
  'position-levels': ['name', 'sort'],
  'position-groups': ['name', 'sort_order'],
  'org-units': ['name', 'parent_id'],
  // v2-allow: check9 — (а) список редактируемых полей справочника точек
  'locations': ['name', 'address', 'city_id', 'org_unit_id', 'timezone', 'manager_id', 'is_active'],
  'tags': ['name', 'color', 'description'], // область действия не меняется — иначе метка «переедет» с людей на курсы
}
// v2-allow: check9 — (а) карта camelCase → snake_case справочника точек (тот же список полей)
const CAMEL: Record<string, string> = { isActive: 'is_active', levelId: 'level_id', parentId: 'parent_id', cityId: 'city_id', orgUnitId: 'org_unit_id', managerId: 'manager_id', groupId: 'group_id', sortOrder: 'sort_order' }

export async function usageCount(ctx: Ctx, kind: RefKind, id: string): Promise<number> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    let n = 0
    for (const u of USAGE[kind]) {
      const [r] = await tx.execute(sql`select count(*)::int as n from ${sql.identifier(u.table)} where ${sql.identifier(u.column)} = ${id}::uuid`) as unknown as { n: number }[]
      n += r?.n ?? 0
    }
    return n
  })
}

export async function updateRef(ctx: Ctx, kind: RefKind, id: string, patch: Record<string, unknown>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const sets = Object.entries(patch)
      .map(([k, v]) => [CAMEL[k] ?? k, v] as const)
      .filter(([k]) => EDITABLE[kind].includes(k))
    if (!sets.length) return null
    const [before] = await tx.execute(sql`select * from ${sql.identifier(TABLE[kind])} where id = ${id}::uuid`) as unknown as Record<string, unknown>[]
    if (!before) return null
    // Группа должности — только своя (RLS): чужая или несуществующая даёт отказ, а не висячую ссылку
    const nextGroup = kind === 'positions' ? sets.find(([k]) => k === 'group_id') : undefined
    if (nextGroup && nextGroup[1]) {
      const [g] = await tx.execute(sql`select 1 from position_groups where id = ${nextGroup[1] as string}::uuid`) as unknown as unknown[]
      if (!g) return null
    }
    // Перенос подразделения: пересчёт ltree-пути у него и потомков (docs/16 §5.3 перетаскивание)
    if (kind === 'org-units' && 'parent_id' in Object.fromEntries(sets)) {
      const parentId = Object.fromEntries(sets).parent_id as string | null
      if (parentId === id) return null
      if (parentId) {
        const [cycle] = await tx.execute(sql`select 1 from org_units where id = ${parentId}::uuid and path <@ (select path from org_units where id = ${id}::uuid)`) as unknown as unknown[]
        if (cycle) return null
      }
      const [old] = await tx.execute(sql`select path from org_units where id = ${id}::uuid`) as unknown as { path: string }[]
      const [parent] = parentId ? await tx.execute(sql`select path from org_units where id = ${parentId}::uuid`) as unknown as { path: string }[] : [null]
      const leaf = old!.path.split('.').pop()!
      const newPath = parent ? `${parent.path}.${leaf}` : leaf
      await tx.execute(sql`update org_units set path = (${newPath}::text || case when nlevel(path) > nlevel(${old!.path}::ltree) then '.' || subpath(path, nlevel(${old!.path}::ltree))::text else '' end)::ltree where path <@ ${old!.path}::ltree`)
    }
    const assignments = sets.filter(([k]) => k !== 'parent_id' || kind !== 'org-units').map(([k, v]) => sql`${sql.identifier(k)} = ${v === undefined ? null : v}`)
    if (kind === 'org-units' && sets.some(([k]) => k === 'parent_id')) assignments.push(sql`parent_id = ${(Object.fromEntries(sets).parent_id as string | null) ?? null}::uuid`)
    const [row] = await tx.execute(sql`update ${sql.identifier(TABLE[kind])} set ${sql.join(assignments, sql`, `)}, updated_at = now() where id = ${id}::uuid returning *`) as unknown as Record<string, unknown>[]
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: `refs.${kind}.update`, entity: kind, entityId: id, before: Object.fromEntries(sets.map(([k]) => [k, before[k]])), after: Object.fromEntries(sets) })
    // Курсы по умолчанию (П-24.3): правило группы смотрит на её состав, имя правила — на имя
    // должности или группы. Пересборка — в той же транзакции, что и правка справочника.
    if (kind === 'positions' || kind === 'position-groups') {
      const { syncGroupRule, renameBoundRule } = await import('./positionDefaults')
      if (kind === 'positions' && nextGroup && nextGroup[1] !== before.group_id) {
        await syncGroupRule(tx, ctx.tenantId, (before.group_id as string | null) ?? null)
        await syncGroupRule(tx, ctx.tenantId, (nextGroup[1] as string | null) ?? null)
      }
      if (kind === 'position-groups') await syncGroupRule(tx, ctx.tenantId, id)
      else if (sets.some(([k]) => k === 'name')) await renameBoundRule(tx, id, String(row?.name ?? ''))
    }
    return row ?? null
  })
}

export async function deleteRef(ctx: Ctx, kind: RefKind, id: string): Promise<{ ok: true } | { ok: false, code: 'not_found' | 'in_use', used?: number }> {
  const used = kind === 'tags' ? await tagUsage(ctx, id) : await usageCount(ctx, kind, id)
  if (used > 0) return { ok: false, code: 'in_use', used }
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.execute(sql`delete from ${sql.identifier(TABLE[kind])} where id = ${id}::uuid returning id`) as unknown as unknown[]
    if (!rows.length) return { ok: false as const, code: 'not_found' as const }
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: `refs.${kind}.delete`, entity: kind, entityId: id })
    return { ok: true as const }
  })
}

async function tagUsage(ctx: Ctx, id: string): Promise<number> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [t] = await tx.execute(sql`select name, scope from tags where id = ${id}::uuid`) as unknown as { name: string, scope: TagScope }[]
    if (!t) return 0
    const { usageOf } = await import('./tags')
    return usageOf(tx, t.scope, t.name)
  })
}

/** Слияние значений справочника: все ссылки с `fromId` переводятся на `intoId`, источник удаляется (docs/16 §3.3). */
export async function mergeRefs(ctx: Ctx, kind: RefKind, fromId: string, intoId: string): Promise<{ ok: true, moved: number } | { ok: false, code: 'not_found' | 'same' | 'unsupported' }> {
  if (fromId === intoId) return { ok: false, code: 'same' }
  if (kind === 'org-units') return { ok: false, code: 'unsupported' } // дерево — переносить вручную
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [a] = await tx.execute(sql`select name from ${sql.identifier(TABLE[kind])} where id = ${fromId}::uuid`) as unknown as { name: string }[]
    const [b] = await tx.execute(sql`select name from ${sql.identifier(TABLE[kind])} where id = ${intoId}::uuid`) as unknown as { name: string }[]
    if (!a || !b) return { ok: false as const, code: 'not_found' as const }
    let moved = 0
    if (kind === 'tags') {
      // Сливать можно только метки одной области — по таблицам этой области
      const [sa] = await tx.execute(sql`select scope from tags where id = ${fromId}::uuid`) as unknown as { scope: TagScope }[]
      const [sb] = await tx.execute(sql`select scope from tags where id = ${intoId}::uuid`) as unknown as { scope: TagScope }[]
      if (sa!.scope !== sb!.scope) return { ok: false as const, code: 'unsupported' as const }
      const { TAG_TABLES } = await import('./tags')
      for (const table of TAG_TABLES[sa!.scope]) {
        const rows = await tx.execute(sql`update ${sql.identifier(table)} set tags = array(select distinct unnest(array_replace(tags, ${a.name}::text, ${b.name}::text))) where ${a.name} = any(tags) returning id`) as unknown as unknown[]
        moved += rows.length
      }
    }
    else {
      for (const u of USAGE[kind]) {
        // user_placements могут получить дубль активного размещения — допускаем, это история
        const rows = await tx.execute(sql`update ${sql.identifier(u.table)} set ${sql.identifier(u.column)} = ${intoId}::uuid where ${sql.identifier(u.column)} = ${fromId}::uuid returning 1`) as unknown as unknown[]
        moved += rows.length
      }
    }
    await tx.execute(sql`delete from ${sql.identifier(TABLE[kind])} where id = ${fromId}::uuid`)
    // Слияние меняет состав групп должностей (П-24.3): правило группы-получателя пересобирается;
    // правило удалённой группы или должности уходит каскадом вместе с ней
    if (kind === 'position-groups' || kind === 'positions') {
      const { syncGroupRule } = await import('./positionDefaults')
      if (kind === 'position-groups') await syncGroupRule(tx, ctx.tenantId, intoId)
      else {
        const [g] = await tx.execute(sql`select group_id from positions where id = ${intoId}::uuid`) as unknown as { group_id: string | null }[]
        await syncGroupRule(tx, ctx.tenantId, g?.group_id ?? null)
      }
    }
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: `refs.${kind}.merge`, entity: kind, entityId: intoId, before: { fromId, fromName: a.name }, after: { intoName: b.name, moved } })
    return { ok: true as const, moved }
  })
}
