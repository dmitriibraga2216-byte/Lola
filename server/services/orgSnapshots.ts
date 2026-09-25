import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { orgNodeAssignments, orgStructureSnapshots, userPlacements, users } from '../db/schema'
import { withTenant, type TenantTx } from '../utils/withTenant'
import { keysetAfter, keysetAt } from '../utils/keyset'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import { scopeHolders } from './contentIssueNotify'
import { notifyManagerChangesFor } from './orgStructure'
import { applyPositionRoles } from './positionRoleMap'
import { loadNodes, lockOrgStructure, recomputeNodeStates, stateOf, takeSnapshot, writeNodeStates } from './orgTreeWrite'
import type { NodeState } from './orgTreeWrite'
import { orgImportActive } from './orgImport'
import { layoutTree } from '../../shared/domain/orgLayout'
import { KEYSETS, encodeKeyset } from '../../shared/domain/keyset'
import { ORG_ASSIGNMENT_ROLES, ORG_NODE_STATES, ORG_NODE_TYPES } from '../../shared/enums'
import type { OrgAssignmentEndReason, OrgSnapshotKind } from '../../shared/enums'

/**
 * Снимки дерева подчинения и откат к ним (`docs/v2/32-org-structure.md` §3.3, §7 п. 7, §13
 * критерий 7; PR-31 плана `docs/v2/45-plan.md`).
 *
 * **Откат восстанавливает не только узлы, но и активные назначения** — иначе «откатить
 * неудачную реорганизацию» значило бы вернуть пустые коробки: дерево на месте, а люди
 * остались там, куда их переставили. Уволенные после снимка не возвращаются: у них нет
 * руководителя, и привязать архивного человека к узлу нельзя (`32` §4, §7 п. 5).
 *
 * Сам откат — тоже реорганизация: перед ним делается снимок текущего состояния, и откат
 * можно откатить. Узлов физически не удаляет ни один шаг: всё, что появилось после снимка,
 * уходит в архив (`32` §4: «физического удаления узла нет»).
 */

interface Ctx { tenantId: string, actorId: string | null }

// ── Снимок: чтение ───────────────────────────────────────────────────────────────────────

/**
 * Формат снимка — строки `org_nodes` и активные строки `org_node_assignments` так, как их
 * отдаёт Drizzle (`camelCase`, даты строками). Так писал снимок PR-30, так пишет и
 * `takeSnapshot()`; лишние поля схема пропускает, недостающие необязательные — пустые.
 */
const snapshotNodeSchema = z.object({
  id: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  sort: z.number().int().catch(0),
  type: z.enum(ORG_NODE_TYPES),
  title: z.string().min(1),
  externalKey: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  positionId: z.string().uuid().nullable().optional(),
  orgUnitId: z.string().uuid().nullable().optional(),
  locationId: z.string().uuid().nullable().optional(),
  headcountPlanned: z.number().int(),
  isManagerPoint: z.boolean(),
  state: z.enum(ORG_NODE_STATES),
  archivedAt: z.string().nullable().optional(),
  createdBy: z.string().uuid().nullable().optional(),
})

const snapshotHolderSchema = z.object({
  nodeId: z.string().uuid(),
  userId: z.string().uuid(),
  isPrimary: z.boolean(),
  roleInNode: z.enum(ORG_ASSIGNMENT_ROLES),
})

export const orgSnapshotTreeSchema = z.object({
  nodes: z.array(snapshotNodeSchema),
  holders: z.array(snapshotHolderSchema),
})
export type OrgSnapshotTree = z.infer<typeof orgSnapshotTreeSchema>

export interface SnapshotRow {
  id: string
  label: string
  kind: OrgSnapshotKind
  nodeCount: number
  createdAt: string
  createdByName: string | null
}

/** Список снимков, новые сверху, ключевой курсор `created_at desc, id desc` (`docs/04` §4.1). */
export async function listSnapshotsPage(ctx: Ctx, query: { cursor?: string, limit: number }): Promise<{ rows: SnapshotRow[], cursor: string | null }> {
  const rows = await withTenant(ctx.tenantId, ctx.actorId, tx => tx.select({
    id: orgStructureSnapshots.id,
    label: orgStructureSnapshots.label,
    kind: orgStructureSnapshots.kind,
    nodeCount: orgStructureSnapshots.nodeCount,
    createdAt: orgStructureSnapshots.createdAt,
    createdByName: users.fullName,
    cursorAt: keysetAt(orgStructureSnapshots.createdAt),
  })
    .from(orgStructureSnapshots)
    .leftJoin(users, eq(users.id, orgStructureSnapshots.createdBy))
    .where(keysetAfter(KEYSETS.orgSnapshots, query.cursor, [orgStructureSnapshots.createdAt, orgStructureSnapshots.id], 'desc'))
    .orderBy(desc(orgStructureSnapshots.createdAt), desc(orgStructureSnapshots.id))
    .limit(query.limit + 1))
  const page = rows.slice(0, query.limit)
  const last = rows.length > query.limit ? page[page.length - 1] : undefined
  return {
    rows: page.map(r => ({ id: r.id, label: r.label, kind: r.kind as OrgSnapshotKind, nodeCount: r.nodeCount, createdAt: r.createdAt.toISOString(), createdByName: r.createdByName })),
    cursor: last ? encodeKeyset(KEYSETS.orgSnapshots, [last.cursorAt, last.id]) : null,
  }
}

// ── Откат ────────────────────────────────────────────────────────────────────────────────

export type RollbackError = 'not_found' | 'rollback_in_progress' | 'import_in_progress' | 'snapshot_invalid'

export interface RollbackResult {
  snapshotId: string
  /** Снимок «до отката» — чтобы откат можно было откатить. */
  preSnapshotId: string
  label: string
  snapshotAt: string
  /** Живых узлов после отката — столько же, сколько было на момент снимка. */
  nodes: number
  /** Узлы, появившиеся после снимка и ушедшие в архив. */
  archived: number
  assignmentsCreated: number
  assignmentsEnded: number
  assignmentsUpdated: number
  /** Держатели снимка, уволенные после него: не возвращены (`32` §7 п. 7). */
  dismissedSkipped: number
}

/** Существующие id справочника из набора: откат не ставит ссылку на удалённую запись. */
async function existingIds(tx: TenantTx, table: 'positions' | 'org_units' | 'locations' | 'users', ids: (string | null | undefined)[]): Promise<Set<string>> {
  const list = [...new Set(ids.filter((v): v is string => !!v))]
  if (!list.length) return new Set()
  const rows = await tx.execute(sql`select id::text as id from ${sql.identifier(table)} where id in (${sql.join(list.map(id => sql`${id}::uuid`), sql`, `)})`) as unknown as { id: string }[]
  return new Set(rows.map(r => r.id))
}

function sameState(a: NodeState, b: NodeState): boolean {
  return a.parentId === b.parentId && a.path === b.path && a.depth === b.depth && a.sort === b.sort
    && a.type === b.type && a.title === b.title && a.externalKey === b.externalKey && a.note === b.note
    && a.positionId === b.positionId && a.orgUnitId === b.orgUnitId && a.locationId === b.locationId
    && a.headcountPlanned === b.headcountPlanned && a.isManagerPoint === b.isManagerPoint && a.archived === b.archived
}

/**
 * Откат к снимку (`32` §7 п. 7, §10 `POST /snapshots/:id/rollback`, критерий приёмки 7).
 *
 * Идёт в запросе одной транзакцией: работа ограничена размером снимка и сделана пачками
 * (одно обновление узлов, пересчёт состояний одним запросом), а результат администратор
 * должен увидеть сразу. Второй одновременный откат — `409 rollback_in_progress`, откат во
 * время применения импорта — `409 import_in_progress`.
 *
 * Шаги: снимок «до отката» (вид `pre_bulk_move`: откат — массовое перемещение всего дерева,
 * нового вида снимка не заводится, правило 13) → узлы снимка возвращаются на свои места и в
 * свои поля, появившиеся позже — в архив там, где стоят → держатели приводятся к снимку →
 * состояния узлов, карта руководителей, уведомления, журнал.
 */
export async function rollbackToSnapshot(ctx: Ctx, snapshotId: string): Promise<{ ok: true, result: RollbackResult } | { ok: false, code: RollbackError }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [snap] = await tx.select().from(orgStructureSnapshots).where(eq(orgStructureSnapshots.id, snapshotId))
    if (!snap) return { ok: false as const, code: 'not_found' as const }
    if (await orgImportActive(tx)) return { ok: false as const, code: 'import_in_progress' as const }
    if (!await lockOrgStructure(tx, ctx.tenantId, false)) return { ok: false as const, code: 'rollback_in_progress' as const }
    const parsed = orgSnapshotTreeSchema.safeParse(snap.tree)
    if (!parsed.success) return { ok: false as const, code: 'snapshot_invalid' as const }
    const tree = parsed.data

    const current = await loadNodes(tx)
    const pre = await takeSnapshot(tx, ctx, { label: snap.label, kind: 'pre_bulk_move' })

    // ── 1. Каким будет дерево ───────────────────────────────────────────────────────────
    const snapIds = new Set(tree.nodes.map(n => n.id))
    const [positionOk, unitOk, locationOk, userOk] = await Promise.all([
      existingIds(tx, 'positions', tree.nodes.map(n => n.positionId)),
      existingIds(tx, 'org_units', tree.nodes.map(n => n.orgUnitId)),
      existingIds(tx, 'locations', tree.nodes.map(n => n.locationId)),
      existingIds(tx, 'users', tree.nodes.map(n => n.createdBy)),
    ])
    const keep = (id: string | null | undefined, ok: Set<string>) => (id && ok.has(id) ? id : null)
    const desired = new Map<string, NodeState>()
    for (const n of tree.nodes) {
      desired.set(n.id, {
        id: n.id,
        parentId: n.parentId && snapIds.has(n.parentId) ? n.parentId : null,
        path: '',
        depth: 0,
        sort: n.sort,
        type: n.type,
        title: n.title,
        externalKey: n.externalKey ?? null,
        note: n.note ?? null,
        positionId: keep(n.positionId, positionOk),
        orgUnitId: keep(n.orgUnitId, unitOk),
        locationId: keep(n.locationId, locationOk),
        headcountPlanned: n.headcountPlanned,
        isManagerPoint: n.isManagerPoint,
        archived: n.state === 'archived',
        archivedAt: n.state === 'archived' ? (n.archivedAt ?? null) : null,
        createdBy: keep(n.createdBy, userOk),
      })
    }
    // Появившиеся после снимка — в архив там, где стоят. Ключ импорта, совпавший с ключом
    // узла снимка, снимается: ключ принадлежит тому, кто вернулся (`unique (tenant_id, external_key)`).
    const snapKeys = new Set(tree.nodes.map(n => n.externalKey).filter((k): k is string => !!k))
    const now = new Date().toISOString()
    let archivedNow = 0
    for (const row of current.values()) {
      if (snapIds.has(row.id)) continue
      const s = stateOf(row)
      if (!s.archived) archivedNow++
      desired.set(row.id, { ...s, archived: true, archivedAt: s.archived ? s.archivedAt : now, externalKey: s.externalKey && snapKeys.has(s.externalKey) ? null : s.externalKey })
    }
    // Архивная ветка, которая под восстановленным родителем опустилась бы ниже 12-го уровня,
    // отцепляется в архивный корень целиком: в живое дерево она уже не входит.
    let lay = layoutTree([...desired.values()].map(s => ({ id: s.id, parentId: s.parentId })))
    if (!lay.ok) {
      for (const prob of lay.problems) {
        if (prob.kind !== 'depth_exceeded') return { ok: false as const, code: 'snapshot_invalid' as const }
        let top = prob.id
        while (!snapIds.has(top)) {
          const parent = desired.get(top)!.parentId
          if (parent === null || snapIds.has(parent)) break
          top = parent
        }
        if (snapIds.has(top)) return { ok: false as const, code: 'snapshot_invalid' as const }
        desired.get(top)!.parentId = null
      }
      lay = layoutTree([...desired.values()].map(s => ({ id: s.id, parentId: s.parentId })))
      if (!lay.ok) return { ok: false as const, code: 'snapshot_invalid' as const }
    }
    for (const [id, l] of lay.layout) Object.assign(desired.get(id)!, l)

    const states = [...desired.values()]
      .filter(s => !current.has(s.id) || !sameState(s, stateOf(current.get(s.id)!)))
      .sort((a, b) => a.depth - b.depth)
    await writeNodeStates(tx, ctx.tenantId, states, current)

    // ── 2. Держатели ────────────────────────────────────────────────────────────────────
    const moves = await restoreHolders(tx, ctx, tree, desired)

    // ── 3. Состояния, руководители, журнал, уведомления ────────────────────────────────
    await recomputeNodeStates(tx)
    for (const userId of moves.primaryChanged) await applyPositionRoles(tx, ctx, userId)
    await notifyManagerChangesFor(tx, ctx, moves.affected)

    const result: RollbackResult = {
      snapshotId: snap.id,
      preSnapshotId: pre.id,
      label: snap.label,
      snapshotAt: snap.createdAt.toISOString(),
      nodes: [...desired.values()].filter(s => !s.archived).length,
      archived: archivedNow,
      assignmentsCreated: moves.created,
      assignmentsEnded: moves.ended,
      assignmentsUpdated: moves.updated,
      dismissedSkipped: moves.dismissed,
    }
    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'org_structure.rollback',
      entity: 'org_structure',
      entityId: snap.id,
      before: { preSnapshotId: pre.id, nodes: [...current.values()].filter(r => r.state !== 'archived').length },
      after: { ...result, dismissedUserIds: moves.dismissedIds },
    })
    // «Оргструктуру відкочено до знімка «{{label}}» від {{date}}» — администраторам тенанта (`32` §8).
    for (const adminId of await scopeHolders(tx, 'org.structure.import')) {
      await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: adminId, code: 'org_structure_rollback', payload: { label: snap.label, date: snap.createdAt.toISOString() }, dedupKey: `org_rollback:${pre.id}:${adminId}` })
    }
    return { ok: true as const, result }
  })
}

/**
 * Держатели — к снимку. Совпадение — пара «узел × человек»: такая активная строка остаётся
 * (с ролью и признаком основного из снимка), лишние закрываются, недостающие создаются
 * **новой строкой от даты отката**: закрытое назначение не открывается обратно (`32` §4,
 * «обратного перехода нет»), история остаётся правдивой. Уволенные после снимка пропускаются.
 */
async function restoreHolders(tx: TenantTx, ctx: Ctx, tree: OrgSnapshotTree, desired: Map<string, NodeState>) {
  const active = await tx.select().from(orgNodeAssignments).where(isNull(orgNodeAssignments.endedAt))
  const ids = [...new Set([...tree.holders.map(h => h.userId), ...active.map(a => a.userId)])]
  const people = new Map((ids.length
    ? await tx.execute(sql`select id::text as id, status, kind from users where id in (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})`) as unknown as { id: string, status: string, kind: string }[]
    : []).map(p => [p.id, p]))
  const liveNode = (id: string) => desired.has(id) && !desired.get(id)!.archived

  const dismissedIds = new Set<string>()
  const target = new Map<string, OrgSnapshotTree['holders'][number]>()
  const key = (nodeId: string, userId: string) => `${nodeId}:${userId}`
  const primaryOf = new Map<string, string>()
  for (const h of tree.holders) {
    const p = people.get(h.userId)
    if (!p || p.kind !== 'employee' || !liveNode(h.nodeId)) continue
    if (p.status === 'archived') {
      dismissedIds.add(h.userId)
      continue
    }
    // Основное подчинение одно на человека — в снимке так и есть (частичный уникальный индекс);
    // проверка здесь только на случай ручной правки снимка.
    const primary = h.isPrimary && !primaryOf.has(h.userId)
    if (primary) primaryOf.set(h.userId, h.nodeId)
    target.set(key(h.nodeId, h.userId), { ...h, isPrimary: primary })
  }

  const beforePrimary = new Map(active.filter(a => a.isPrimary).map(a => [a.userId, a.nodeId]))
  let ended = 0
  let updated = 0
  const end = async (id: string, reason: OrgAssignmentEndReason) => {
    await tx.execute(sql`update org_node_assignments set ended_at = greatest(current_date, started_at), ended_reason = ${reason}, updated_at = now() where id = ${id}::uuid`)
    ended++
  }
  const inTarget = new Set([...target.values()].map(h => h.userId))
  for (const a of active) {
    if (target.has(key(a.nodeId, a.userId))) continue
    await end(a.id, !liveNode(a.nodeId) ? 'node_archived' : inTarget.has(a.userId) ? 'moved' : 'manual')
  }
  // Сначала снять лишние «основные», потом поставить нужные: индекс «одно основное на человека»
  // проверяется построчно сразу.
  const kept = active.filter(a => target.has(key(a.nodeId, a.userId)))
  const differs = kept.filter((a) => {
    const t = target.get(key(a.nodeId, a.userId))!
    return t.isPrimary !== a.isPrimary || t.roleInNode !== a.roleInNode
  })
  for (const pass of [false, true]) {
    for (const a of differs) {
      const t = target.get(key(a.nodeId, a.userId))!
      if (t.isPrimary !== pass) continue
      await tx.update(orgNodeAssignments).set({ isPrimary: t.isPrimary, roleInNode: t.roleInNode, updatedAt: new Date() }).where(eq(orgNodeAssignments.id, a.id))
      updated++
    }
  }

  const activeKeys = new Set(active.map(a => key(a.nodeId, a.userId)))
  const missing = [...target.values()].filter(h => !activeKeys.has(key(h.nodeId, h.userId)))
  const placements = new Map<string, string>()
  if (missing.length) {
    const rows = await tx.select({ userId: userPlacements.userId, id: userPlacements.id }).from(userPlacements)
      .where(and(eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt), sql`${userPlacements.userId} in (${sql.join([...new Set(missing.map(h => h.userId))].map(id => sql`${id}::uuid`), sql`, `)})`))
      .orderBy(sql`${userPlacements.startedAt} desc`)
    for (const r of rows) if (!placements.has(r.userId)) placements.set(r.userId, r.id)
  }
  // Основные — после второстепенных: к этому моменту прежнее основное человека уже снято.
  for (const h of missing.sort((a, b) => Number(a.isPrimary) - Number(b.isPrimary))) {
    await tx.insert(orgNodeAssignments).values({
      tenantId: ctx.tenantId,
      nodeId: h.nodeId,
      userId: h.userId,
      placementId: placements.get(h.userId) ?? null,
      isPrimary: h.isPrimary,
      roleInNode: h.roleInNode,
      createdBy: ctx.actorId,
    })
  }

  const afterPrimary = new Map([...target.values()].filter(h => h.isPrimary).map(h => [h.userId, h.nodeId]))
  const primaryChanged = [...new Set([...beforePrimary.keys(), ...afterPrimary.keys()])].filter(u => beforePrimary.get(u) !== afterPrimary.get(u))
  return {
    created: missing.length,
    ended,
    updated,
    dismissed: dismissedIds.size,
    dismissedIds: [...dismissedIds],
    primaryChanged,
    affected: [...new Set([...active.map(a => a.userId), ...[...target.values()].map(h => h.userId)])],
  }
}
