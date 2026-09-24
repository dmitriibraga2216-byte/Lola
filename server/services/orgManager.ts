import { eq, sql } from 'drizzle-orm'
import { orgManagerMap, tenants } from '../db/schema'
import { withTenant, type TenantTx } from '../utils/withTenant'
import { logOrgConflict } from './journals'
import type { OrgManagerSource } from '../../shared/enums'

/**
 * **Единственный источник истины о руководителе человека** — патч П-16.4
 * (`docs/v2/39-patches.md`), алгоритм `docs/v2/32-org-structure.md` §7.8.
 *
 * До этого модуля руководитель вычислялся в шестнадцати местах, и все шестнадцать делали это
 * по-своему: `select l.manager_id from user_placements up join locations l …`, повторённый
 * с мелкими расхождениями (где-то `is_primary`, где-то нет; где-то `ended_at is null`,
 * где-то нет; где-то проверка «не сам себе», где-то нет). Одно поле `locations.manager_id`
 * не описывает подчинение **внутри** точки (шеф-кухар → кухарі) и ломается на совместителях,
 * поэтому источником истины становится дерево `org_nodes`, а поле точки понижается
 * до резервного шага.
 *
 * Строгий приоритет (`32` §7.8):
 *   1. **дерево** — активное основное назначение человека на узел, подъём вверх до ближайшего
 *      узла с `is_manager_point` и `state='occupied'`; его держатель (`holder`, при отсутствии
 *      `acting`) и есть линейный руководитель, `source='org_tree'`;
 *   2. **точка** — человека нет в дереве или вся ветка вверх вакантна: `locations.manager_id`
 *      его основного `user_placements`, `source='location'`;
 *   3. **роль в области** — и там пусто: носитель роли со скоупом `report.team`, назначенной
 *      на его точку; при нескольких — с самым ранним `user_roles.created_at`,
 *      `source='role_scope'`;
 *   4. иначе `null`, `source='none'` и конфликт `no_manager`.
 *
 * `functional_chiefs` в цепочке **не участвуют** (`32` §7.8): функциональный руководитель —
 * отдельная ось, он получает только те коды уведомлений, где адресат назван явно. Иначе обе
 * сущности теряют смысл.
 *
 * Переход управляется флагом тенанта `settings.org_structure_is_source_of_truth`: пока он
 * `false`, шаг 1 пропускается и всё работает ровно как до PR-30 — дерево можно строить,
 * ничего не ломая. При расхождении шага 1 и `locations.manager_id` выигрывает дерево,
 * но пишется конфликт `manager_mismatch` (`warning`) — видна цена переключения.
 *
 * Конфликты пишутся только при `recordConflicts: true` (валидатор, пересборка карты и
 * `GET /org-structure/manager/:userId`): резолв руководителя случается на каждом уведомлении,
 * и писать журнал на каждое чтение значило бы залить `org_conflicts` дублями.
 */

export interface ManagerResolution {
  userId: string
  managerUserId: string | null
  source: OrgManagerSource
  nodeId: string | null
  /** Цепочка руководителей снизу вверх, ≤ 12 (`32` §3.3). Пусто, если источник не дерево. */
  chain: string[]
}

export interface ResolveOptions {
  /** Писать ли найденные расхождения в `org_conflicts`. По умолчанию — нет. */
  recordConflicts?: boolean
  /**
   * Тенант для записи конфликтов. Флаг дерева от него не зависит: без `tenantId` тенант
   * берётся из транзакции (`flagTenantOf`).
   */
  tenantId?: string
  actorId?: string | null
}

const NONE = (userId: string): ManagerResolution => ({ userId, managerUserId: null, source: 'none', nodeId: null, chain: [] })

/** Флаг тенанта `org_structure_is_source_of_truth` (`32` §7.8). По умолчанию — `false`. */
export async function orgTreeIsSourceOfTruth(tx: TenantTx, tenantId: string): Promise<boolean> {
  const [t] = await tx.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId))
  return (t?.settings as Record<string, unknown> | undefined)?.org_structure_is_source_of_truth === true
}

/**
 * Тенант, чей флаг решает, участвует ли дерево (шаг 1). Короткие формы (`managerIdOf`,
 * `managerIdsOf`) зовутся из двух десятков сервисов без `tenantId` — тогда он берётся из самой
 * транзакции: `withTenant()` ставит `app.tenant_id`. Без этого дерево учитывала бы только ручка
 * `GET /org-structure/manager/:userId`, а уведомления, эскалации и отчёты при включённом флаге
 * по-прежнему шли бы руководителю точки — два ответа на один вопрос (`32` §7.8).
 */
async function flagTenantOf(tx: TenantTx, tenantId: string | undefined): Promise<string | null> {
  if (tenantId) return tenantId
  const [r] = await tx.execute(sql`select nullif(current_setting('app.tenant_id', true), '') as id`) as unknown as { id: string | null }[]
  return r?.id ?? null
}

/**
 * Шаг 1 — дерево. Для каждого человека берём его активное основное назначение, поднимаемся
 * по `path` вверх и выбираем ближайшего держателя узла-руководящей точки. Один запрос на
 * всю пачку людей: подъём делается `ltree`-предикатом `node.path @> me.path`, а не циклом.
 */
async function fromTree(tx: TenantTx, userIds: string[]): Promise<Map<string, ManagerResolution>> {
  const out = new Map<string, ManagerResolution>()
  if (!userIds.length) return out
  const rows = await tx.execute(sql`
    with me as (
      select a.user_id, n.id as node_id, n.path
      from org_node_assignments a
      join org_nodes n on n.id = a.node_id
      where a.user_id in (${sql.join(userIds.map(id => sql`${id}::uuid`), sql`, `)})
        and a.ended_at is null and a.is_primary and n.state <> 'archived'
    ),
    up as (
      select me.user_id, me.node_id as own_node_id, mgr.id as mgr_node_id, mgr.path as mgr_path,
             nlevel(mgr.path) as lvl,
             (select ha.user_id from org_node_assignments ha
               where ha.node_id = mgr.id and ha.ended_at is null
               order by case ha.role_in_node when 'holder' then 0 when 'acting' then 1 else 2 end,
                        ha.started_at desc
               limit 1) as holder_id
      from me
      join org_nodes mgr on mgr.path @> me.path and mgr.id <> me.node_id
      where mgr.is_manager_point and mgr.state = 'occupied'
    )
    select user_id, own_node_id, mgr_node_id, holder_id, lvl from up
    where holder_id is not null and holder_id <> user_id
    order by user_id, lvl desc`) as unknown as { user_id: string, own_node_id: string, mgr_node_id: string, holder_id: string, lvl: number }[]
  for (const r of rows) {
    const cur = out.get(r.user_id)
    // `order by lvl desc` ставит ближайшего руководителя первым; остальные строки той же
    // выборки — его собственные руководители, они и образуют цепочку снизу вверх.
    if (!cur) out.set(r.user_id, { userId: r.user_id, managerUserId: r.holder_id, source: 'org_tree', nodeId: r.mgr_node_id, chain: [r.holder_id] })
    else if (cur.chain.length < 12 && !cur.chain.includes(r.holder_id)) cur.chain.push(r.holder_id)
  }
  return out
}

/** Шаг 2 — `locations.manager_id` основного размещения. Единственное место, где поле читается. */
async function fromLocation(tx: TenantTx, userIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!userIds.length) return out
  const rows = await tx.execute(sql`
    select distinct on (up.user_id) up.user_id, l.manager_id
    from user_placements up join locations l on l.id = up.location_id
    where up.user_id in (${sql.join(userIds.map(id => sql`${id}::uuid`), sql`, `)})
      and up.is_primary and up.ended_at is null and l.manager_id is not null
    order by up.user_id, up.started_at desc`) as unknown as { user_id: string, manager_id: string }[]
  for (const r of rows) if (r.manager_id !== r.user_id) out.set(r.user_id, r.manager_id)
  return out
}

/** Шаг 3 — носитель роли со скоупом `report.team`, назначенной на точку человека. */
async function fromRoleScope(tx: TenantTx, userIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!userIds.length) return out
  const rows = await tx.execute(sql`
    select distinct on (up.user_id) up.user_id, ur.user_id as manager_id
    from user_placements up
    join user_roles ur on ur.scope_type = 'location' and ur.scope_id = up.location_id
    join roles r on r.id = ur.role_id
    join users mu on mu.id = ur.user_id
    where up.user_id in (${sql.join(userIds.map(id => sql`${id}::uuid`), sql`, `)})
      and up.is_primary and up.ended_at is null
      and 'report.team' = any(r.scopes)
      and ur.user_id <> up.user_id
      and (ur.valid_until is null or ur.valid_until > now())
      and mu.status = 'active' and not mu.is_blocked
    order by up.user_id, ur.created_at asc`) as unknown as { user_id: string, manager_id: string }[]
  for (const r of rows) out.set(r.user_id, r.manager_id)
  return out
}

/** Уже открытый такой же конфликт второй раз не пишется — иначе журнал заливается дублями. */
async function recordConflictOnce(tx: TenantTx, input: { tenantId: string, userId: string, kind: Parameters<typeof logOrgConflict>[1]['kind'], severity: 'info' | 'warning' | 'critical', nodeId?: string | null, details?: Record<string, unknown>, actorId?: string | null }): Promise<void> {
  const [open] = await tx.execute(sql`
    select 1 from org_conflicts
    where user_id = ${input.userId}::uuid and kind = ${input.kind} and resolved_at is null
    limit 1`) as unknown as unknown[]
  if (open) return
  await logOrgConflict(tx, {
    tenantId: input.tenantId,
    userId: input.userId,
    kind: input.kind,
    severity: input.severity,
    nodeId: input.nodeId ?? null,
    details: input.details,
    actorId: input.actorId ?? null,
  })
}

/**
 * Руководители пачки людей одним проходом. Пакетная форма нужна не для красоты: рассылки,
 * дайджесты и эскалации собирают адресатов сотнями, и вариант «вызвать одиночный резолв в
 * цикле» вернул бы ровно те запросы в цикле, которые этот модуль убирает.
 */
export async function resolveManagers(tx: TenantTx, userIds: string[], opts: ResolveOptions = {}): Promise<Map<string, ManagerResolution>> {
  const ids = [...new Set(userIds.filter(Boolean))]
  const out = new Map<string, ManagerResolution>(ids.map(id => [id, NONE(id)]))
  if (!ids.length) return out

  const tenantId = opts.tenantId
  const flagTenant = await flagTenantOf(tx, tenantId)
  const useTree = flagTenant ? await orgTreeIsSourceOfTruth(tx, flagTenant) : false
  const tree = useTree ? await fromTree(tx, ids) : new Map<string, ManagerResolution>()
  const byLocation = await fromLocation(tx, ids)

  const rest: string[] = []
  for (const id of ids) {
    const t = tree.get(id)
    if (t) {
      out.set(id, t)
      continue
    }
    const loc = byLocation.get(id)
    if (loc) out.set(id, { userId: id, managerUserId: loc, source: 'location', nodeId: null, chain: [loc] })
    else rest.push(id)
  }

  const byRole = await fromRoleScope(tx, rest)
  for (const id of rest) {
    const m = byRole.get(id)
    if (m) out.set(id, { userId: id, managerUserId: m, source: 'role_scope', nodeId: null, chain: [m] })
  }

  if (opts.recordConflicts && tenantId) {
    for (const id of ids) {
      const r = out.get(id)!
      if (r.source === 'none') {
        await recordConflictOnce(tx, { tenantId, userId: id, kind: 'no_manager', severity: 'warning', actorId: opts.actorId })
        continue
      }
      // Человек работает, дерево объявлено источником истины, а его в дереве нет:
      // `unit_missing` — то же, что `orphan_user` пакета (решение В-7).
      if (useTree && r.source !== 'org_tree') {
        await recordConflictOnce(tx, { tenantId, userId: id, kind: 'unit_missing', severity: 'warning', details: { source: r.source }, actorId: opts.actorId })
      }
      // Дерево и поле точки дают разных людей: выигрывает дерево, расхождение — в журнал.
      const loc = byLocation.get(id)
      if (r.source === 'org_tree' && loc && loc !== r.managerUserId) {
        await recordConflictOnce(tx, { tenantId, userId: id, kind: 'manager_mismatch', severity: 'warning', nodeId: r.nodeId, details: { tree: r.managerUserId, location: loc }, actorId: opts.actorId })
      }
    }
  }
  return out
}

/** Руководитель одного человека. Полный ответ: кто, откуда, каким узлом и какой цепочкой. */
export async function resolveManager(tx: TenantTx, userId: string, opts: ResolveOptions = {}): Promise<ManagerResolution> {
  return (await resolveManagers(tx, [userId], opts)).get(userId) ?? NONE(userId)
}

/**
 * Короткая форма для вызывающих, которым нужен только адресат уведомления.
 * Именно она заменила пятнадцать копий `select l.manager_id from user_placements …`.
 */
export async function managerIdOf(tx: TenantTx, userId: string): Promise<string | null> {
  return (await resolveManager(tx, userId)).managerUserId
}

/** Та же короткая форма для пачки: `Map<userId, managerUserId>` без пустых значений. */
export async function managerIdsOf(tx: TenantTx, userIds: string[]): Promise<Map<string, string>> {
  const res = await resolveManagers(tx, userIds)
  const out = new Map<string, string>()
  for (const [id, r] of res) if (r.managerUserId) out.set(id, r.managerUserId)
  return out
}

/**
 * Обратный вопрос — «кто мои подчинённые» (`32` §10, `GET /org-structure/subordinates/:userId`).
 * Читается из материализованной карты: перебирать всех людей тенанта резолвом на каждого
 * ради одного экрана дорого, а карта для того и существует.
 */
export async function subordinatesOf(tx: TenantTx, managerUserId: string, deep = false): Promise<string[]> {
  const rows = deep
    ? await tx.execute(sql`select user_id from org_manager_map where ${managerUserId}::uuid = any(chain)`) as unknown as { user_id: string }[]
    : await tx.execute(sql`select user_id from org_manager_map where manager_user_id = ${managerUserId}::uuid`) as unknown as { user_id: string }[]
  return rows.map(r => r.user_id)
}

/**
 * Пересборка проекции `org_manager_map` (`32` §11, задача `org.rebuild_manager_map`).
 * Без списка — по всем действующим сотрудникам тенанта; со списком — точечно, в той же
 * транзакции, что изменение дерева (`32` §7.8: «результат материализуется в той же
 * транзакции для затронутого поддерева»).
 *
 * Выборка людей идёт через репозиторий (`employeeOnly`, правило 17 корневого CLAUDE.md):
 * у кандидата руководителя нет, и попасть в карту подчинения он не должен.
 */
export async function rebuildManagerMap(tx: TenantTx, tenantId: string, userIds?: string[]): Promise<number> {
  let ids = userIds
  if (!ids) {
    const rows = await tx.execute(sql`
      select distinct u.id from users u
      join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null
      where u.kind = 'employee' and u.status in ('active', 'invited')`) as unknown as { id: string }[]
    ids = rows.map(r => r.id)
  }
  if (!ids.length) return 0
  const res = await resolveManagers(tx, ids, { tenantId, recordConflicts: true })
  for (const id of ids) {
    const r = res.get(id) ?? NONE(id)
    await tx.insert(orgManagerMap).values({
      tenantId,
      userId: id,
      managerUserId: r.managerUserId,
      source: r.source,
      nodeId: r.nodeId,
      chain: r.chain,
      computedAt: new Date(),
    }).onConflictDoUpdate({
      target: [orgManagerMap.tenantId, orgManagerMap.userId],
      set: { managerUserId: r.managerUserId, source: r.source, nodeId: r.nodeId, chain: r.chain, computedAt: new Date() },
    })
  }
  return ids.length
}

/** Фоновая задача `org.rebuild_manager_map` (`32` §11): полная пересборка по тенанту. */
export async function rebuildManagerMapJob(tenantId: string): Promise<number> {
  return withTenant(tenantId, null, tx => rebuildManagerMap(tx, tenantId))
}
