import { asc, eq, isNull, sql } from 'drizzle-orm'
import { orgNodeAssignments, orgNodes, orgStructureSnapshots } from '../db/schema'
import type { TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import type { OrgSnapshotKind } from '../../shared/enums'

/**
 * Запись дерева подчинения целиком — общая часть импорта CSV и отката к снимку (PR-31,
 * `docs/v2/32-org-structure.md` §7 п. 7, §11 `org.import_apply` / `org.rollback_apply`).
 *
 * Оба сценария сначала решают, каким будет дерево (у кого какой родитель, путь, поля), и
 * только потом пишут: вставка отсутствующих узлов родителями вперёд, одно обновление на всё
 * остальное, пересчёт состояний «зайнятий / вакантний» по держателям. Пути приходят уже
 * разложенными (`shared/domain/orgLayout.ts`), поэтому отложенный триггер `org_nodes_guard`
 * на коммите проверяет готовое корректное дерево, а не промежуточное.
 */

interface Ctx { tenantId: string, actorId: string | null }

/** Полное состояние узла, как его пишут импорт и откат. */
export interface NodeState {
  id: string
  parentId: string | null
  path: string
  depth: number
  sort: number
  type: string
  title: string
  externalKey: string | null
  note: string | null
  positionId: string | null
  orgUnitId: string | null
  locationId: string | null
  headcountPlanned: number
  isManagerPoint: boolean
  /** Живой узел пишется `vacant`: занятость выставит `recomputeNodeStates()` по держателям. */
  archived: boolean
  archivedAt: string | null
  createdBy: string | null
}

export type OrgNodeRow = typeof orgNodes.$inferSelect

/** Все узлы тенанта, включая архивные: пути архивных тоже обязаны сходиться с родителем. */
export async function loadNodes(tx: TenantTx): Promise<Map<string, OrgNodeRow>> {
  const rows = await tx.select().from(orgNodes).orderBy(asc(orgNodes.path))
  return new Map(rows.map(r => [r.id, r]))
}

/** Строка узла из БД → то же состояние, чтобы менять в нём только нужное. */
export function stateOf(row: OrgNodeRow): NodeState {
  return {
    id: row.id,
    parentId: row.parentId,
    path: row.path,
    depth: row.depth,
    sort: row.sort,
    type: row.type,
    title: row.title,
    externalKey: row.externalKey,
    note: row.note,
    positionId: row.positionId,
    orgUnitId: row.orgUnitId,
    locationId: row.locationId,
    headcountPlanned: row.headcountPlanned,
    isManagerPoint: row.isManagerPoint,
    archived: row.state === 'archived',
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdBy: row.createdBy,
  }
}

/**
 * Блокировка «одна реорганизация на тенант» — транзакционная advisory-блокировка: импорт и
 * откат не перемешиваются, второй одновременный откат получает `409 rollback_in_progress`
 * (`32` §10), а импорт в фоне ждёт окончания отката. Снимается сама на коммите или откате.
 */
export async function lockOrgStructure(tx: TenantTx, tenantId: string, wait: boolean): Promise<boolean> {
  if (wait) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('org_structure'), hashtext(${tenantId}))`)
    return true
  }
  const [r] = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext('org_structure'), hashtext(${tenantId})) as ok`) as unknown as { ok: boolean }[]
  return r?.ok === true
}

/**
 * Записать узлы: отсутствующие — вставкой (порядок входа — родители раньше детей, внешний
 * ключ `parent_id` проверяется сразу), существующие — одним `update … from jsonb_to_recordset`.
 *
 * `holder_user_id` у всех записанных обнуляется: констрейнт `org_nodes_named_chk` разрешает
 * кэш держателя только именному узлу, а узел мог сменить вид. Кэш и состояние выставляет
 * `recomputeNodeStates()` после того, как записаны держатели.
 */
export async function writeNodeStates(tx: TenantTx, tenantId: string, states: readonly NodeState[], current: ReadonlyMap<string, OrgNodeRow>): Promise<{ inserted: number, updated: number }> {
  const inserts = states.filter(s => !current.has(s.id))
  const updates = states.filter(s => current.has(s.id))

  for (let i = 0; i < inserts.length; i += 500) {
    await tx.insert(orgNodes).values(inserts.slice(i, i + 500).map(s => ({
      id: s.id,
      tenantId,
      parentId: s.parentId,
      path: s.path,
      depth: s.depth,
      sort: s.sort,
      type: s.type,
      title: s.title,
      externalKey: s.externalKey,
      note: s.note,
      positionId: s.positionId,
      orgUnitId: s.orgUnitId,
      locationId: s.locationId,
      headcountPlanned: s.headcountPlanned,
      isManagerPoint: s.isManagerPoint,
      state: s.archived ? 'archived' : 'vacant',
      archivedAt: s.archived ? (s.archivedAt ? new Date(s.archivedAt) : new Date()) : null,
      createdBy: s.createdBy,
    })))
  }

  if (updates.length) {
    // Ключ импорта уникален (`unique (tenant_id, external_key)`) и проверяется построчно сразу:
    // если ключи в пачке переезжают между узлами, сначала они снимаются, потом ставятся.
    const rekeyed = updates.filter(s => current.get(s.id)!.externalKey !== s.externalKey && current.get(s.id)!.externalKey !== null)
    if (rekeyed.length) {
      await tx.execute(sql`update org_nodes set external_key = null where id in (${sql.join(rekeyed.map(s => sql`${s.id}::uuid`), sql`, `)})`)
    }
    const payload = JSON.stringify(updates.map(s => ({
      id: s.id,
      parent_id: s.parentId,
      path: s.path,
      depth: s.depth,
      sort: s.sort,
      type: s.type,
      title: s.title,
      external_key: s.externalKey,
      note: s.note,
      position_id: s.positionId,
      org_unit_id: s.orgUnitId,
      location_id: s.locationId,
      headcount_planned: s.headcountPlanned,
      is_manager_point: s.isManagerPoint,
      state: s.archived ? 'archived' : (current.get(s.id)!.state === 'archived' ? 'vacant' : current.get(s.id)!.state),
      archived_at: s.archived ? (s.archivedAt ?? new Date().toISOString()) : null,
    })))
    await tx.execute(sql`
      update org_nodes n set
        parent_id = d.parent_id, path = d.path::ltree, depth = d.depth, sort = d.sort, type = d.type,
        title = d.title, external_key = d.external_key, note = d.note, position_id = d.position_id,
        org_unit_id = d.org_unit_id, location_id = d.location_id, headcount_planned = d.headcount_planned,
        is_manager_point = d.is_manager_point, state = d.state, archived_at = d.archived_at,
        holder_user_id = null, updated_at = now()
      from jsonb_to_recordset(${payload}::jsonb) as d(
        id uuid, parent_id uuid, path text, depth int, sort int, type text, title text, external_key text,
        note text, position_id uuid, org_unit_id uuid, location_id uuid, headcount_planned int,
        is_manager_point boolean, state text, archived_at timestamptz)
      where n.id = d.id`)
  }
  return { inserted: inserts.length, updated: updates.length }
}

/**
 * Состояние узла — производная от активных держателей (`32` §4): `occupied`, пока есть хоть
 * один, иначе `vacant`; кэш держателя — только у именного узла, первым по дате начала.
 * Архивные узлы не трогаются. Одним запросом на тенант, меняются только разошедшиеся строки.
 */
export async function recomputeNodeStates(tx: TenantTx): Promise<number> {
  const res = await tx.execute(sql`
    with s as (
      select n.id,
             case when exists (select 1 from org_node_assignments a where a.node_id = n.id and a.ended_at is null)
                  then 'occupied' else 'vacant' end as state,
             case when n.type = 'employee' then (
               select a.user_id from org_node_assignments a
                where a.node_id = n.id and a.ended_at is null
                order by a.started_at, a.created_at limit 1)
             end as holder
        from org_nodes n
       where n.state <> 'archived'
    )
    update org_nodes n set state = s.state, holder_user_id = s.holder, updated_at = now()
      from s
     where s.id = n.id and (n.state <> s.state or n.holder_user_id is distinct from s.holder)`) as unknown as { count?: number }
  return Number(res.count ?? 0)
}

/**
 * Снимок дерева (`32` §3.3, §7 п. 7): все узлы, включая архивные, и активные держатели.
 * Формат — строки таблиц как есть (так писал снимок PR-30), поэтому откат читает и снимки,
 * сделанные до PR-31. Пишется в той же транзакции, что и изменение, перед ним.
 */
export async function takeSnapshot(tx: TenantTx, ctx: Ctx, input: { label: string, kind: OrgSnapshotKind }) {
  const nodes = await tx.select().from(orgNodes).orderBy(asc(orgNodes.path))
  const holders = await tx.select().from(orgNodeAssignments).where(isNull(orgNodeAssignments.endedAt)).orderBy(asc(orgNodeAssignments.createdAt))
  const [snap] = await tx.insert(orgStructureSnapshots).values({
    tenantId: ctx.tenantId,
    label: input.label,
    kind: input.kind,
    tree: { nodes, holders },
    nodeCount: nodes.filter(n => n.state !== 'archived').length,
    createdBy: ctx.actorId,
  }).returning({ id: orgStructureSnapshots.id, label: orgStructureSnapshots.label, kind: orgStructureSnapshots.kind, nodeCount: orgStructureSnapshots.nodeCount, createdAt: orgStructureSnapshots.createdAt })
  await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'org_structure.snapshot', entity: 'org_structure', entityId: snap!.id, after: { label: input.label, kind: input.kind, nodeCount: snap!.nodeCount } })
  return snap!
}

/** Узел по id в транзакции — для проверок перед записью. */
export async function nodeRow(tx: TenantTx, id: string): Promise<OrgNodeRow | null> {
  const [n] = await tx.select().from(orgNodes).where(eq(orgNodes.id, id))
  return n ?? null
}
