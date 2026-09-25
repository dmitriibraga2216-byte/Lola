import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { locations, orgNodeAssignments, orgNodes, orgUnits, positions, userPlacements, users } from '../db/schema'
import { withTenant, type TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import { logOrgConflict } from './journals'
import { rebuildManagerMap, resolveManager, resolveManagers } from './orgManager'
import { applyPositionRoles } from './positionRoleMap'
import { takeSnapshot } from './orgTreeWrite'
import { ORG_BULK_MOVE_SNAPSHOT_NODES, ORG_MAX_DEPTH, ORG_MAX_ROOTS, orgNodeLabel } from '../../shared/domain/orgLayout'
import type { OrgAssignmentEndReason, OrgAssignmentRole, OrgNodeType, OrgSnapshotKind } from '../../shared/enums'

/**
 * Конструктор дерева подчинения (`docs/v2/32-org-structure.md` §3, §4, §7; PR-30 плана
 * `docs/v2/45-plan.md`).
 *
 * Дерево — не картинка, производная от справочников, а самостоятельная сущность: именно оно
 * отвечает на вопрос «хто керівник людини X» (`resolveManager()`, `server/services/orgManager.ts`).
 * Подразделение (`org_units`) и должность (`positions`) на этот вопрос не отвечают вовсе:
 * кухари точки А подчиняются шефу точки А, а не подразделению «Кухня» (`32` §3.1).
 *
 * Импорт CSV и выгрузка — `server/services/orgImport.ts`, снимки и откат —
 * `server/services/orgSnapshots.ts` (PR-31); общая запись дерева целиком —
 * `server/services/orgTreeWrite.ts`.
 */

interface Ctx { tenantId: string, actorId: string | null }

/** Максимум корней на тенант (`32` §7 п. 1 [решение]): управляющая компания + операционная ветка. */
const MAX_ROOTS = ORG_MAX_ROOTS
/** Максимальная глубина (`32` §7 п. 1, Г-32.5): ветка эталона — 4–5 уровней. */
export const MAX_DEPTH = ORG_MAX_DEPTH

export type OrgError =
  | 'not_found' | 'validation_failed' | 'depth_exceeded' | 'cycle_detected' | 'stale_tree'
  | 'has_children' | 'has_holders' | 'parent_archived' | 'node_archived' | 'primary_exists'
  | 'user_archived' | 'too_many_roots'

export interface NodeInput {
  parentId?: string | null
  type?: OrgNodeType
  title?: string
  positionId?: string | null
  orgUnitId?: string | null
  locationId?: string | null
  headcountPlanned?: number
  isManagerPoint?: boolean
  note?: string | null
  externalKey?: string | null
  sort?: number
}

/** Метка ltree: буквы, цифры и подчёркивание. Берём id узла — она уникальна и не меняется. */
const label = orgNodeLabel

async function nodeById(tx: TenantTx, id: string) {
  const [n] = await tx.select().from(orgNodes).where(eq(orgNodes.id, id))
  return n ?? null
}

/** Дерево целиком (`32` §5.1, §5.2). `mode='view'` — витрина: без заметок и скрытых людей. */
export async function listTree(ctx: Ctx, opts: { mode?: 'admin' | 'view', includeArchived?: boolean, includeVacant?: boolean } = {}) {
  const mode = opts.mode ?? 'view'
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select({
      id: orgNodes.id,
      parentId: orgNodes.parentId,
      depth: orgNodes.depth,
      sort: orgNodes.sort,
      type: orgNodes.type,
      title: orgNodes.title,
      note: orgNodes.note,
      positionId: orgNodes.positionId,
      positionName: positions.name,
      orgUnitId: orgNodes.orgUnitId,
      orgUnitName: orgUnits.name,
      locationId: orgNodes.locationId,
      locationName: locations.name,
      holderUserId: orgNodes.holderUserId,
      headcountPlanned: orgNodes.headcountPlanned,
      isManagerPoint: orgNodes.isManagerPoint,
      state: orgNodes.state,
    })
      .from(orgNodes)
      .leftJoin(positions, eq(positions.id, orgNodes.positionId))
      .leftJoin(orgUnits, eq(orgUnits.id, orgNodes.orgUnitId))
      .leftJoin(locations, eq(locations.id, orgNodes.locationId))
      .where(opts.includeArchived ? sql`true` : sql`${orgNodes.state} <> 'archived'`)
      .orderBy(asc(orgNodes.path))

    // Держатели узлов. `is_hidden` человек в витрине не показывается (`16` §7.5, `32` §12 п. 6),
    // но в расчёте руководителя участвует — поэтому фильтр стоит здесь, а не в выборке узлов.
    const holders = await tx.select({
      assignmentId: orgNodeAssignments.id,
      nodeId: orgNodeAssignments.nodeId,
      userId: orgNodeAssignments.userId,
      fullName: users.fullName,
      email: users.email,
      roleInNode: orgNodeAssignments.roleInNode,
      isPrimary: orgNodeAssignments.isPrimary,
      isHidden: users.isHidden,
    })
      .from(orgNodeAssignments)
      .innerJoin(users, eq(users.id, orgNodeAssignments.userId))
      .where(isNull(orgNodeAssignments.endedAt))
      .orderBy(asc(users.fullName))

    // Идентификатор назначения нужен только конструктору — «Зняти з вузла» (`32` §10 `DELETE /assignments/:id`).
    const byNode = new Map<string, { assignmentId?: string, userId: string, fullName: string, email: string | null, roleInNode: string, isPrimary: boolean }[]>()
    for (const h of holders) {
      if (mode === 'view' && h.isHidden) continue
      byNode.set(h.nodeId, [...(byNode.get(h.nodeId) ?? []), { ...(mode === 'admin' ? { assignmentId: h.assignmentId } : {}), userId: h.userId, fullName: h.fullName, email: h.email, roleInNode: h.roleInNode, isPrimary: h.isPrimary }])
    }

    const build = (parentId: string | null): unknown[] => rows
      .filter(r => r.parentId === parentId)
      .filter(r => opts.includeVacant !== false || r.state !== 'vacant')
      .sort((a, b) => a.sort - b.sort || a.title.localeCompare(b.title))
      .map(r => ({
        ...r,
        note: mode === 'admin' ? r.note : undefined,
        holders: byNode.get(r.id) ?? [],
        headcountActual: (byNode.get(r.id) ?? []).length,
        children: build(r.id),
      }))

    return { nodes: build(null), total: rows.length }
  })
}

/** Создание узла (`32` §6.1). Корней не больше десяти, глубина не больше двенадцати. */
export async function createNode(ctx: Ctx, input: NodeInput): Promise<{ ok: true, node: typeof orgNodes.$inferSelect } | { ok: false, code: OrgError, detail?: string }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    let depth = 1
    let parentPath: string | null = null
    if (input.parentId) {
      const parent = await nodeById(tx, input.parentId)
      if (!parent) return { ok: false as const, code: 'not_found' as const, detail: 'parent' }
      if (parent.state === 'archived') return { ok: false as const, code: 'parent_archived' as const }
      depth = parent.depth + 1
      if (depth > MAX_DEPTH) return { ok: false as const, code: 'depth_exceeded' as const }
      parentPath = parent.path
    }
    else {
      const roots = await tx.execute(sql`select count(*)::int as n from org_nodes where parent_id is null and state <> 'archived'`) as unknown as { n: number }[]
      if ((roots[0]?.n ?? 0) >= MAX_ROOTS) return { ok: false as const, code: 'too_many_roots' as const }
    }

    const type = input.type ?? 'position'
    let title = input.title?.trim() ?? ''
    if (!title && input.positionId) {
      const [p] = await tx.select({ name: positions.name }).from(positions).where(eq(positions.id, input.positionId))
      title = p?.name ?? ''
    }
    if (title.length < 2 || title.length > 120 || /[<>]/.test(title)) return { ok: false as const, code: 'validation_failed' as const, detail: 'title' }
    const headcount = type === 'employee' ? 1 : (input.headcountPlanned ?? 1)
    if (headcount < 1 || headcount > 999) return { ok: false as const, code: 'validation_failed' as const, detail: 'headcount' }

    const id = crypto.randomUUID()
    const [node] = await tx.insert(orgNodes).values({
      id,
      tenantId: ctx.tenantId,
      parentId: input.parentId ?? null,
      path: parentPath ? `${parentPath}.${label(id)}` : label(id),
      depth,
      sort: input.sort ?? 0,
      type,
      title,
      positionId: input.positionId ?? null,
      orgUnitId: input.orgUnitId ?? null,
      locationId: input.locationId ?? null,
      headcountPlanned: headcount,
      isManagerPoint: input.isManagerPoint ?? false,
      note: input.note ?? null,
      externalKey: input.externalKey ?? null,
      createdBy: ctx.actorId,
    }).returning()

    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'org_node.create', entity: 'org_node', entityId: id, after: { title, type, parentId: input.parentId ?? null, depth } })
    return { ok: true as const, node: node! }
  })
}

/** Правка узла (`32` §6.1). Родитель здесь не меняется — для этого есть `moveNode()`. */
export async function updateNode(ctx: Ctx, id: string, input: NodeInput): Promise<{ ok: true, node: typeof orgNodes.$inferSelect } | { ok: false, code: OrgError, detail?: string }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const before = await nodeById(tx, id)
    if (!before) return { ok: false as const, code: 'not_found' as const }
    if (before.state === 'archived') return { ok: false as const, code: 'node_archived' as const }

    const type = input.type ?? (before.type as OrgNodeType)
    const title = (input.title ?? before.title).trim()
    if (title.length < 2 || title.length > 120 || /[<>]/.test(title)) return { ok: false as const, code: 'validation_failed' as const, detail: 'title' }
    const headcount = type === 'employee' ? 1 : (input.headcountPlanned ?? before.headcountPlanned)
    if (headcount < 1 || headcount > 999) return { ok: false as const, code: 'validation_failed' as const, detail: 'headcount' }

    // Конвертация «посада → іменний вузол» держателей не снимает (`32` §3.2 [решение]):
    // именной узел просто кэширует единственного активного держателя.
    let holderUserId = type === 'employee' ? before.holderUserId : null
    if (type === 'employee') {
      const active = await tx.select({ userId: orgNodeAssignments.userId }).from(orgNodeAssignments)
        .where(and(eq(orgNodeAssignments.nodeId, id), isNull(orgNodeAssignments.endedAt)))
        .orderBy(asc(orgNodeAssignments.startedAt))
      if (active.length > 1) return { ok: false as const, code: 'validation_failed' as const, detail: 'headcount' }
      holderUserId = active[0]?.userId ?? null
    }

    const [node] = await tx.update(orgNodes).set({
      type,
      title,
      positionId: input.positionId === undefined ? before.positionId : input.positionId,
      orgUnitId: input.orgUnitId === undefined ? before.orgUnitId : input.orgUnitId,
      locationId: input.locationId === undefined ? before.locationId : input.locationId,
      headcountPlanned: headcount,
      isManagerPoint: input.isManagerPoint ?? before.isManagerPoint,
      note: input.note === undefined ? before.note : input.note,
      sort: input.sort ?? before.sort,
      holderUserId,
      updatedAt: new Date(),
    }).where(eq(orgNodes.id, id)).returning()

    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'org_node.update', entity: 'org_node', entityId: id, before: { title: before.title, type: before.type, isManagerPoint: before.isManagerPoint, headcountPlanned: before.headcountPlanned }, after: { title, type, isManagerPoint: node!.isManagerPoint, headcountPlanned: headcount } })
    // Руководящая точка включилась или погасла — подчинение поддерева поменялось.
    if (before.isManagerPoint !== node!.isManagerPoint) await rebuildSubtree(tx, ctx.tenantId, before.path)
    return { ok: true as const, node: node! }
  })
}

/**
 * Перемещение ветки (`32` §7 п. 2, критерий приёмки 3). Поддерево переносится целиком; с
 * `keepChildren` дети поднимаются к деду, а переезжает один узел.
 *
 * Цикл ловится дважды: здесь — чтобы человек получил `409 cycle_detected`, и в БД триггером
 * `org_nodes_guard` — чтобы его не создал прямой UPDATE мимо сервиса.
 */
export async function moveNode(ctx: Ctx, id: string, input: { parentId: string | null, sort?: number, keepChildren?: boolean }): Promise<{ ok: true, moved: number } | { ok: false, code: OrgError }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const node = await nodeById(tx, id)
    if (!node) return { ok: false as const, code: 'not_found' as const }
    if (node.state === 'archived') return { ok: false as const, code: 'node_archived' as const }

    let parent: typeof orgNodes.$inferSelect | null = null
    if (input.parentId) {
      parent = await nodeById(tx, input.parentId)
      if (!parent) return { ok: false as const, code: 'not_found' as const }
      if (parent.state === 'archived') return { ok: false as const, code: 'parent_archived' as const }
      if (parent.id === node.id) return { ok: false as const, code: 'cycle_detected' as const }
      // `new_parent.path <@ node.path` — родитель лежит в собственном поддереве узла (`32` §7 п. 1)
      const [cycle] = await tx.execute(sql`select 1 where ${parent.path}::ltree <@ ${node.path}::ltree`) as unknown as unknown[]
      if (cycle) return { ok: false as const, code: 'cycle_detected' as const }
    }
    else if (!node.parentId) {
      return { ok: true as const, moved: 0 } // уже корень
    }
    else {
      const roots = await tx.execute(sql`select count(*)::int as n from org_nodes where parent_id is null and state <> 'archived'`) as unknown as { n: number }[]
      if ((roots[0]?.n ?? 0) >= MAX_ROOTS) return { ok: false as const, code: 'too_many_roots' as const }
    }

    const newDepth = parent ? parent.depth + 1 : 1
    const deepestRows = await tx.execute(sql`select coalesce(max(depth), ${node.depth})::int as deepest, count(*)::int as size from org_nodes where path <@ ${node.path}::ltree`) as unknown as { deepest: number, size: number }[]
    const subtreeHeight = input.keepChildren ? 0 : (deepestRows[0]?.deepest ?? node.depth) - node.depth
    if (newDepth + subtreeHeight > MAX_DEPTH) return { ok: false as const, code: 'depth_exceeded' as const }

    // Массовое перемещение (> 20 узлов) — снимок перед ним, чтобы неудачный drop можно было
    // откатить (`32` §7 п. 7, вид `pre_bulk_move`). Ветка переезжает целиком либо её дети
    // поднимаются к деду — в обоих случаях пути переписываются у всего поддерева.
    if ((deepestRows[0]?.size ?? 0) > ORG_BULK_MOVE_SNAPSHOT_NODES) {
      await takeSnapshot(tx, ctx, { label: node.title, kind: 'pre_bulk_move' })
    }

    const oldPath = node.path
    if (input.keepChildren) {
      // Дети поднимаются к деду: сначала они, потом сам узел (`32` §6.2).
      const grandparentPath = node.parentId ? (await nodeById(tx, node.parentId))!.path : null
      const kids = await tx.select({ id: orgNodes.id, path: orgNodes.path }).from(orgNodes).where(eq(orgNodes.parentId, id))
      for (const k of kids) {
        const kidLabel = k.path.split('.').pop()!
        const newKidPath = grandparentPath ? `${grandparentPath}.${kidLabel}` : kidLabel
        await tx.execute(sql`
          update org_nodes
          set parent_id = case when id = ${k.id}::uuid then ${node.parentId}::uuid else parent_id end,
              path = (${newKidPath}::text || case when nlevel(path) > nlevel(${k.path}::ltree) then '.' || subpath(path, nlevel(${k.path}::ltree))::text else '' end)::ltree,
              depth = depth - (nlevel(${k.path}::ltree) - nlevel(${newKidPath}::ltree)),
              updated_at = now()
          where path <@ ${k.path}::ltree`)
      }
    }

    const newPath = parent ? `${parent.path}.${label(id)}` : label(id)
    const res = await tx.execute(sql`
      update org_nodes
      set parent_id = case when id = ${id}::uuid then ${input.parentId}::uuid else parent_id end,
          sort = case when id = ${id}::uuid then ${input.sort ?? node.sort} else sort end,
          path = (${newPath}::text || case when nlevel(path) > nlevel(${oldPath}::ltree) then '.' || subpath(path, nlevel(${oldPath}::ltree))::text else '' end)::ltree,
          depth = depth + ${newDepth - node.depth},
          updated_at = now()
      where path <@ ${oldPath}::ltree`) as unknown as { count?: number }
    const moved = Number((res as unknown as { count?: number }).count ?? 0) || 1

    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'org_node.move', entity: 'org_node', entityId: id, before: { parentId: node.parentId, depth: node.depth }, after: { parentId: input.parentId, depth: newDepth, affected: moved } })
    await rebuildSubtree(tx, ctx.tenantId, newPath)
    return { ok: true as const, moved }
  })
}

/** Смена порядка среди сиблингов — не перемещение (`32` §7 п. 2), пишется своим действием. */
export async function reorderNode(ctx: Ctx, id: string, sort: number): Promise<{ ok: true } | { ok: false, code: OrgError }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const node = await nodeById(tx, id)
    if (!node) return { ok: false as const, code: 'not_found' as const }
    await tx.update(orgNodes).set({ sort, updatedAt: new Date() }).where(eq(orgNodes.id, id))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'org_node.reorder', entity: 'org_node', entityId: id, before: { sort: node.sort }, after: { sort } })
    return { ok: true as const }
  })
}

/** Архивация (`32` §4): узел без детей и без активных держателей. Физического удаления нет. */
export async function archiveNode(ctx: Ctx, id: string): Promise<{ ok: true } | { ok: false, code: OrgError }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const node = await nodeById(tx, id)
    if (!node) return { ok: false as const, code: 'not_found' as const }
    const [kid] = await tx.select({ id: orgNodes.id }).from(orgNodes).where(and(eq(orgNodes.parentId, id), sql`${orgNodes.state} <> 'archived'`)).limit(1)
    if (kid) return { ok: false as const, code: 'has_children' as const }
    const [holder] = await tx.select({ id: orgNodeAssignments.id }).from(orgNodeAssignments).where(and(eq(orgNodeAssignments.nodeId, id), isNull(orgNodeAssignments.endedAt))).limit(1)
    if (holder) return { ok: false as const, code: 'has_holders' as const }
    await tx.update(orgNodes).set({ state: 'archived', archivedAt: new Date(), holderUserId: null, updatedAt: new Date() }).where(eq(orgNodes.id, id))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'org_node.archive', entity: 'org_node', entityId: id, before: { state: node.state } })
    await rebuildSubtree(tx, ctx.tenantId, node.path)
    return { ok: true as const }
  })
}

/** Восстановление в течение 90 дней, если родитель жив (`32` §4). */
export async function restoreNode(ctx: Ctx, id: string): Promise<{ ok: true } | { ok: false, code: OrgError }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const node = await nodeById(tx, id)
    if (!node || node.state !== 'archived') return { ok: false as const, code: 'not_found' as const }
    if (node.parentId) {
      const parent = await nodeById(tx, node.parentId)
      if (!parent || parent.state === 'archived') return { ok: false as const, code: 'parent_archived' as const }
    }
    await tx.update(orgNodes).set({ state: 'vacant', archivedAt: null, updatedAt: new Date() }).where(eq(orgNodes.id, id))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'org_node.restore', entity: 'org_node', entityId: id })
    return { ok: true as const }
  })
}

/**
 * Привязка человека к узлу (`32` §6.2, критерий приёмки 1).
 *
 * `makeNamed` — ответ на вопрос конструктора «Зробити вузол іменним?»: «Так» переводит
 * узел-посаду с планом 1 в именной, «Ні» оставляет посаду со счётчиком «1 з N».
 *
 * Производные роли пересобираются **существующим** механизмом `applyPositionRoles()`
 * (`position_role_map` + `user_roles.is_org_derived`, docs/01 §1.9.3): узел несёт должность,
 * и смена узла — это смена должности. Второго механизма «должность → роль» в системе нет
 * и заводить его нельзя.
 */
export async function assignUser(ctx: Ctx, nodeId: string, input: { userId: string, isPrimary?: boolean, roleInNode?: OrgAssignmentRole, startedAt?: string, makeNamed?: boolean, transferPrimary?: boolean }): Promise<{ ok: true, assignmentId: string, node: typeof orgNodes.$inferSelect } | { ok: false, code: OrgError, detail?: string }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const node = await nodeById(tx, nodeId)
    if (!node) return { ok: false as const, code: 'not_found' as const }
    if (node.state === 'archived') return { ok: false as const, code: 'node_archived' as const }
    const [person] = await tx.select({ id: users.id, status: users.status, kind: users.kind, fullName: users.fullName }).from(users).where(eq(users.id, input.userId))
    if (!person) return { ok: false as const, code: 'not_found' as const }
    if (person.status === 'archived') return { ok: false as const, code: 'user_archived' as const }
    // Правило 17: кандидат в дерево подчинения не попадает — у него нет руководителя.
    if (person.kind !== 'employee') return { ok: false as const, code: 'validation_failed' as const, detail: 'kind' }

    const isPrimary = input.isPrimary ?? true
    if (isPrimary) {
      const [existing] = await tx.select({ id: orgNodeAssignments.id, nodeId: orgNodeAssignments.nodeId }).from(orgNodeAssignments)
        .where(and(eq(orgNodeAssignments.userId, input.userId), eq(orgNodeAssignments.isPrimary, true), isNull(orgNodeAssignments.endedAt)))
      if (existing && existing.nodeId !== nodeId) {
        if (!input.transferPrimary) return { ok: false as const, code: 'primary_exists' as const, detail: existing.nodeId }
        await tx.update(orgNodeAssignments).set({ endedAt: sql`current_date`, endedReason: 'moved', updatedAt: new Date() }).where(eq(orgNodeAssignments.id, existing.id))
        await refreshNodeState(tx, existing.nodeId)
      }
    }

    const [placement] = await tx.select({ id: userPlacements.id, positionId: userPlacements.positionId }).from(userPlacements)
      .where(and(eq(userPlacements.userId, input.userId), eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt)))
      .orderBy(sql`${userPlacements.startedAt} desc`).limit(1)

    const [assignment] = await tx.insert(orgNodeAssignments).values({
      tenantId: ctx.tenantId,
      nodeId,
      userId: input.userId,
      placementId: placement?.id ?? null,
      isPrimary,
      roleInNode: input.roleInNode ?? 'holder',
      ...(input.startedAt ? { startedAt: input.startedAt } : {}),
      createdBy: ctx.actorId,
    }).onConflictDoNothing().returning()
    if (!assignment) return { ok: false as const, code: 'validation_failed' as const, detail: 'already_assigned' }

    // «Зробити вузол іменним?» — только у посады с планом 1 (`32` §3.2 [решение]).
    const makeNamed = input.makeNamed === true && node.type === 'position' && node.headcountPlanned === 1
    if (makeNamed) await tx.update(orgNodes).set({ type: 'employee', holderUserId: input.userId, updatedAt: new Date() }).where(eq(orgNodes.id, nodeId))
    const fresh = await refreshNodeState(tx, nodeId)

    // Должность узла и должность в активном размещении разошлись — `warning`, не отказ (`32` §7 п. 6).
    if (node.positionId && placement && placement.positionId !== node.positionId) {
      await logOrgConflict(tx, { tenantId: ctx.tenantId, userId: input.userId, kind: 'position_mismatch', severity: 'warning', nodeId, actorId: ctx.actorId, details: { nodePositionId: node.positionId, placementPositionId: placement.positionId } })
    }
    // Совместительство внутри собственной ветки разрешено, но пишется (`32` §12 п. 2).
    if (!isPrimary) {
      const [own] = await tx.execute(sql`
        select 1 from org_node_assignments a join org_nodes n on n.id = a.node_id
        where a.user_id = ${input.userId}::uuid and a.ended_at is null and a.is_primary
          and n.path <@ ${node.path}::ltree`) as unknown as unknown[]
      if (own) await logOrgConflict(tx, { tenantId: ctx.tenantId, userId: input.userId, kind: 'manager_self', severity: 'warning', nodeId, actorId: ctx.actorId, details: { reason: 'secondary_in_own_branch' } })
    }

    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'org_node.assign_user', entity: 'org_node', entityId: nodeId, after: { userId: input.userId, isPrimary, roleInNode: input.roleInNode ?? 'holder', madeNamed: makeNamed } })

    // Смена узла — смена должности: производные роли пересобираются существующим механизмом.
    if (isPrimary) await applyPositionRoles(tx, ctx, input.userId)
    await notifyManagerChanges(tx, ctx, node.path, [input.userId], { nodeTitle: fresh.title, userName: person.fullName })
    return { ok: true as const, assignmentId: assignment.id, node: fresh }
  })
}

/** Снятие человека с узла (`32` §10 `DELETE /assignments/:id`). История остаётся строкой. */
export async function endAssignment(ctx: Ctx, assignmentId: string, endedReason: OrgAssignmentEndReason = 'manual'): Promise<{ ok: true } | { ok: false, code: OrgError }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [a] = await tx.select().from(orgNodeAssignments).where(and(eq(orgNodeAssignments.id, assignmentId), isNull(orgNodeAssignments.endedAt)))
    if (!a) return { ok: false as const, code: 'not_found' as const }
    await tx.update(orgNodeAssignments).set({ endedAt: sql`current_date`, endedReason, updatedAt: new Date() }).where(eq(orgNodeAssignments.id, assignmentId))
    const node = await refreshNodeState(tx, a.nodeId)
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'org_node.unassign_user', entity: 'org_node', entityId: a.nodeId, before: { userId: a.userId, roleInNode: a.roleInNode }, after: { endedReason } })
    if (a.isPrimary) await applyPositionRoles(tx, ctx, a.userId)
    await notifyManagerChanges(tx, ctx, node.path, [a.userId], { nodeTitle: node.title })
    return { ok: true as const }
  })
}

/**
 * Состояние узла — производная от активных держателей (`32` §4): `occupied`, пока есть хоть
 * один; `vacant`, когда закрылся последний. Узел при этом остаётся в дереве, и подчинённые
 * ветки не двигаются — это и есть разница между «вакансией в структуре» и архивацией.
 */
async function refreshNodeState(tx: TenantTx, nodeId: string) {
  const active = await tx.select({ userId: orgNodeAssignments.userId }).from(orgNodeAssignments)
    .where(and(eq(orgNodeAssignments.nodeId, nodeId), isNull(orgNodeAssignments.endedAt)))
  const [node] = await tx.select().from(orgNodes).where(eq(orgNodes.id, nodeId))
  if (node!.state === 'archived') return node!
  const state = active.length ? 'occupied' : 'vacant'
  const holderUserId = node!.type === 'employee' ? (active[0]?.userId ?? null) : null
  if (state === node!.state && holderUserId === node!.holderUserId) return node!
  const [updated] = await tx.update(orgNodes).set({ state, holderUserId, updatedAt: new Date() }).where(eq(orgNodes.id, nodeId)).returning()
  return updated!
}

/** Пересборка карты для затронутого поддерева — в той же транзакции (`32` §7.8). */
async function rebuildSubtree(tx: TenantTx, tenantId: string, path: string): Promise<void> {
  const rows = await tx.execute(sql`
    select distinct a.user_id from org_node_assignments a join org_nodes n on n.id = a.node_id
    where a.ended_at is null and n.path <@ ${path}::ltree`) as unknown as { user_id: string }[]
  if (rows.length) await rebuildManagerMap(tx, tenantId, rows.map(r => r.user_id))
}

/**
 * Уведомления о смене руководителя (`32` §8, критерий приёмки 2). Считаются по разнице между
 * сохранённой картой и свежим резолвом — иначе «сменился» пришлось бы угадывать по действию.
 */
async function notifyManagerChanges(tx: TenantTx, ctx: Ctx, path: string, seedUserIds: string[], vars: { nodeTitle?: string, userName?: string } = {}): Promise<void> {
  const affected = await tx.execute(sql`
    select distinct a.user_id from org_node_assignments a join org_nodes n on n.id = a.node_id
    where a.ended_at is null and n.path <@ ${path}::ltree`) as unknown as { user_id: string }[]
  await notifyManagerChangesFor(tx, ctx, [...seedUserIds, ...affected.map(r => r.user_id)], vars)
}

/**
 * То же для заранее известного круга людей — импорт и откат меняют дерево целиком, и круг
 * задаёт вызывающий (все, кто в дереве до и после). Уведомления — по разнице сохранённой
 * карты и свежего резолва, карта пересобирается тут же.
 */
export async function notifyManagerChangesFor(tx: TenantTx, ctx: Ctx, userIds: string[], vars: { nodeTitle?: string, userName?: string } = {}): Promise<void> {
  const ids = [...new Set(userIds)]
  if (!ids.length) return
  const before = new Map((await tx.execute(sql`
    select user_id, manager_user_id from org_manager_map
    where user_id in (${sql.join(ids.map(i => sql`${i}::uuid`), sql`, `)})`) as unknown as { user_id: string, manager_user_id: string | null }[]).map(r => [r.user_id, r.manager_user_id]))
  const now = await resolveManagers(tx, ids, { tenantId: ctx.tenantId })
  const names = new Map((await tx.execute(sql`
    select id, full_name from users where id in (${sql.join(ids.map(i => sql`${i}::uuid`), sql`, `)})`) as unknown as { id: string, full_name: string }[]).map(r => [r.id, r.full_name]))

  for (const id of ids) {
    const next = now.get(id)?.managerUserId ?? null
    const prev = before.get(id) ?? null
    if (next === prev) continue
    const managerName = next ? (names.get(next) ?? (await tx.select({ fullName: users.fullName }).from(users).where(eq(users.id, next)))[0]?.fullName ?? '') : ''
    await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: id, code: 'org_manager_changed', payload: { manager_name: managerName }, dedupKey: `org_mgr:${id}:${next ?? 'none'}` })
    if (next) await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: next, code: 'org_subordinate_added', payload: { user_name: names.get(id) ?? vars.userName ?? '', node_title: vars.nodeTitle ?? '' }, dedupKey: `org_sub:${next}:${id}` })
  }
  await rebuildManagerMap(tx, ctx.tenantId, ids)
}

/**
 * Увольнение держателя (`32` §7 п. 5, критерий приёмки 2). Архивация человека закрывает его
 * активные назначения с `ended_reason='dismissed'`, узел переходит в `vacant` и **остаётся
 * в дереве**: подчинённые не переподчиняются, их руководитель берётся уровнем выше.
 *
 * Вызывается из `people.ts` при архивации и фоновой задачей `org.sync_dismissals` — вторая
 * нужна потому, что человека можно заархивировать импортом и массовой операцией.
 */
export async function syncDismissals(tx: TenantTx, ctx: Ctx): Promise<number> {
  const rows = await tx.execute(sql`
    select a.id, a.node_id, a.user_id, n.title, n.path
    from org_node_assignments a
    join org_nodes n on n.id = a.node_id
    join users u on u.id = a.user_id
    where a.ended_at is null and u.status = 'archived'`) as unknown as { id: string, node_id: string, user_id: string, title: string, path: string }[]
  for (const r of rows) {
    await tx.update(orgNodeAssignments).set({ endedAt: sql`current_date`, endedReason: 'dismissed', updatedAt: new Date() }).where(eq(orgNodeAssignments.id, r.id))
    const node = await refreshNodeState(tx, r.node_id)
    if (node.state === 'vacant') {
      // «Вузол став вакантним» — руководителю уровнем выше (`32` §8).
      const above = await resolveManager(tx, r.user_id, { tenantId: ctx.tenantId })
      if (above.managerUserId) await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: above.managerUserId, code: 'org_node_vacant', payload: { node_title: node.title }, dedupKey: `org_vacant:${r.node_id}` })
    }
    await notifyManagerChanges(tx, ctx, r.path, [])
  }
  return rows.length
}

/** Фоновая задача `org.sync_dismissals` (`32` §11), ежечасно. */
export async function syncDismissalsJob(tenantId: string): Promise<number> {
  return withTenant(tenantId, null, tx => syncDismissals(tx, { tenantId, actorId: null }))
}

/**
 * Валидатор структуры (`32` §11, задача `org.validate_structure`). Прогоняет правила §3.3 и
 * пишет конфликты; сам ничего не чинит — система не падает на конфликте, а показывает его.
 */
export async function validateStructure(tenantId: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    let found = 0
    // Держатель архивирован, а узел числится занятым.
    const stale = await tx.execute(sql`
      select a.user_id, a.node_id from org_node_assignments a join users u on u.id = a.user_id
      where a.ended_at is null and u.status = 'archived'`) as unknown as { user_id: string, node_id: string }[]
    for (const r of stale) {
      await logOrgConflict(tx, { tenantId, userId: r.user_id, nodeId: r.node_id, kind: 'dismissed_holder', severity: 'warning' })
      found++
    }
    // Глубина за пределом — попасть туда можно только прямым UPDATE, но проверить дёшево.
    const deep = await tx.execute(sql`select id from org_nodes where depth > ${MAX_DEPTH}`) as unknown as { id: string }[]
    for (const r of deep) {
      await logOrgConflict(tx, { tenantId, nodeId: r.id, kind: 'depth_exceeded', severity: 'critical' })
      found++
    }
    // `no_manager`, `unit_missing` и `manager_mismatch` пишет сам резолвер при пересборке карты.
    await rebuildManagerMap(tx, tenantId)
    return found
  })
}

/**
 * Снимок дерева «руками» (`32` §7 п. 7, кнопка «Знімок»). Список снимков и откат к ним —
 * `server/services/orgSnapshots.ts`.
 */
export async function createSnapshot(ctx: Ctx, input: { label: string, kind?: OrgSnapshotKind }) {
  return withTenant(ctx.tenantId, ctx.actorId, tx => takeSnapshot(tx, ctx, { label: input.label, kind: input.kind ?? 'manual' }))
}

/**
 * Ветка, которую правит `manager` (`32` §2: «своя ветка» = поддерево узла, где он держатель).
 * Пустой массив — он не держатель ни одного узла, конструктор ему недоступен целиком.
 */
export async function editableBranches(tx: TenantTx, userId: string): Promise<string[]> {
  const rows = await tx.execute(sql`
    select n.path from org_node_assignments a join org_nodes n on n.id = a.node_id
    where a.user_id = ${userId}::uuid and a.ended_at is null and n.state <> 'archived'`) as unknown as { path: string }[]
  return rows.map(r => r.path)
}

/** Лежит ли узел в одной из веток человека — проверка drop'а из критерия приёмки 8. */
export async function nodeInBranches(tx: TenantTx, nodeId: string, branches: string[]): Promise<boolean> {
  if (!branches.length) return false
  const [hit] = await tx.execute(sql`
    select 1 from org_nodes
    where id = ${nodeId}::uuid
      and path <@ any(array[${sql.join(branches.map(b => sql`${b}::ltree`), sql`, `)}])`) as unknown as unknown[]
  return !!hit
}

/**
 * Коды ошибок → HTTP (`32` §10). `not_found` здесь и для чужого тенанта: правило 15
 * корневого CLAUDE.md — чужое не «заборонено», а «не знайдено».
 */
export const ORG_ERROR_STATUS: Record<OrgError, number> = {
  not_found: 404,
  validation_failed: 422,
  user_archived: 422,
  depth_exceeded: 409,
  cycle_detected: 409,
  stale_tree: 409,
  has_children: 409,
  has_holders: 409,
  parent_archived: 409,
  node_archived: 409,
  primary_exists: 409,
  too_many_roots: 409,
}

/**
 * Право править конкретный узел (`32` §2, критерий приёмки 8): `org.structure.edit` на весь
 * тенант — любая ветка; тот же скоуп без тенантной области — только поддерево узлов, где
 * человек держатель. Не держатель ни одного узла — конструктор ему недоступен целиком.
 */
export async function canEditNode(ctx: Ctx, nodeId: string | null, canEditAll: boolean): Promise<boolean> {
  if (canEditAll) return true
  if (!ctx.actorId) return false
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const branches = await editableBranches(tx, ctx.actorId!)
    if (!branches.length) return false
    if (!nodeId) return false // корневой узел создаёт только администратор
    return nodeInBranches(tx, nodeId, branches)
  })
}
