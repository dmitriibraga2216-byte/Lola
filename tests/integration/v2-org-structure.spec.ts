import postgres from 'postgres'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * PR-30 пакета `docs/v2` (`45-plan.md`): дерево подчинения и **единственный**
 * `resolveManager()` (патч П-16.4, решение `44` В-7).
 *
 * Критерии приёмки `docs/v2/32-org-structure.md` §13, закреплённые за этим PR:
 * - **1** — корневой узел-посада виден `vacant`, в `audit_log` есть `org_node.create`;
 *   ответ «Ні» на «Зробити вузол іменним?» оставляет узел посадой со счётчиком «1 з 3»;
 * - **2** — архивация держателя переводит узел в `vacant`, но **оставляет его в дереве**:
 *   подчинённые получают руководителя уровнем выше, а не теряют его;
 * - **3** — тринадцатый уровень отвергается, подчинение предка потомку отвергается,
 *   и дерево при этом не меняется; тот же запрет стоит в БД триггером;
 * - **4** — руководитель человека в дереве — держатель ближайшей руководящей точки
 *   (`source='org_tree'`); человека нет в дереве — резерв `locations.manager_id`
 *   (`source='location'`) плюс конфликт `unit_missing` (он же `orphan_user` пакета, В-7);
 * - **5** — дерево и поле точки дают разных людей: выигрывает дерево, расхождение
 *   ложится строкой `manager_mismatch`;
 * - **8** — ветка руководителя: свой узел правит, чужой — нет.
 *
 * Плюс два условия выхода PR-30, которых в `32` §13 нет:
 * - **производные роли** пересобираются **существующим** механизмом (`position_role_map`
 *   + `user_roles.is_org_derived`), а не вторым, заведённым для дерева;
 * - **изоляция тенанта**: чужое дерево не видно и не пишется.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const {
  archiveNode, assignUser, canEditNode, createNode, createSnapshot, endAssignment,
  listTree, moveNode, syncDismissals,
} = await import('../../server/services/orgStructure')
const { resolveManager, rebuildManagerMap, managerIdOf, managerIdsOf } = await import('../../server/services/orgManager')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const PREFIX = 'v2-30 '
const PHONES = ['+380679930001', '+380679930002', '+380679930003', '+380679930004', '+380679930005']

let tenantId: string
let otherTenantId: string
let adminId: string
let locationId: string
let positionId: string
let mentorRoleId: string
let ctx: { tenantId: string, actorId: string }
/** Начальник, подчинённый, «второй начальник», человек вне дерева и человек без точки. */
let chief: string, worker: string, other: string, outsider: string, loner: string
/** Носитель роли со скоупом `report.team` на точке — шаг 3 `resolveManager()` (посев). */
let roleScopeManager: string

/**
 * Тестовый человек. Статус — `invited`, а не `active`, намеренно: активный штат считает
 * `usage.collect`, а его строка `tenant_usage` за сутки идемпотентна, поэтому пять лишних
 * активных сотрудников в общем тенанте «Каппі» ломают чужую проверку «сбор считает активных
 * без заблокированных» (`spec24-settings.spec.ts`) — и ломают её не там, где причина.
 * Дереву подчинения статус безразличен: `assignUser()` отказывает только архивированному,
 * а `rebuildManagerMap()` берёт и `active`, и `invited`.
 */
async function person(phone: string, name: string, placed = true): Promise<string> {
  const [u] = await admin`
    insert into users (tenant_id, full_name, last_name, first_name, phone, status, kind)
    values (${tenantId}, ${PREFIX + name}, ${name}, 'Тест', ${phone}, 'invited', 'employee')
    returning id`
  if (placed) {
    await admin`
      insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary)
      values (${tenantId}, ${u!.id}, ${locationId}, ${positionId}, true)`
  }
  return u!.id as string
}

async function cleanup() {
  const people = await admin`select id from users where phone in ${admin(PHONES)}`
  const ids = people.map(p => p.id as string)
  await admin`delete from org_node_assignments where tenant_id = ${tenantId}`
  await admin`delete from org_manager_map where tenant_id = ${tenantId}`
  await admin`delete from org_conflicts where tenant_id = ${tenantId}`
  await admin`delete from org_structure_snapshots where tenant_id = ${tenantId}`
  // Узлы удаляются снизу вверх: `parent_id` стоит на `restrict`.
  await admin`delete from org_nodes where tenant_id = ${tenantId} and id in (
    select id from org_nodes where tenant_id = ${tenantId} order by depth desc)`
  for (let i = 0; i < 13 && (await admin`select 1 from org_nodes where tenant_id = ${tenantId} limit 1`).length; i++) {
    await admin`delete from org_nodes where tenant_id = ${tenantId} and id not in (select parent_id from org_nodes where parent_id is not null and tenant_id = ${tenantId})`
  }
  await admin`delete from position_role_map where tenant_id = ${tenantId} and position_id = ${positionId ?? null}`.catch(() => {})
  if (ids.length) {
    await admin`delete from user_roles where user_id in ${admin(ids)}`
    await admin`delete from notifications where user_id in ${admin(ids)}`
    await admin`delete from user_placements where user_id in ${admin(ids)}`
    await admin`delete from audit_log where entity_id in ${admin(ids)}`
    await admin`delete from users where id in ${admin(ids)}`
  }
  await admin`update locations set manager_id = null where tenant_id = ${tenantId}`
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  locationId = (await admin`select id from locations where tenant_id = ${tenantId} order by name limit 1`)[0]!.id as string
  positionId = (await admin`select id from positions where tenant_id = ${tenantId} order by name limit 1`)[0]!.id as string
  mentorRoleId = (await admin`select id from roles where tenant_id = ${tenantId} and code = 'mentor'`)[0]!.id as string
  const [o] = await admin`
    insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції')
    on conflict (slug) do update set name = excluded.name returning id`
  otherTenantId = o!.id as string
  ctx = { tenantId, actorId: adminId }
  await cleanup()
  // Дерево объявлено источником истины (`32` §7.8): иначе шаг 1 пропускается и всё
  // работает ровно как до PR-30 — это отдельный тест ниже.
  await admin`update tenants set settings = coalesce(settings, '{}'::jsonb) || '{"org_structure_is_source_of_truth": true}'::jsonb where id = ${tenantId}`
  chief = await person(PHONES[0]!, 'Шеф')
  worker = await person(PHONES[1]!, 'Кухар')
  other = await person(PHONES[2]!, 'Керуючий')
  outsider = await person(PHONES[3]!, 'Позадерева')
  // Без размещения: у него пусты и шаг 2 (точка), и шаг 3 (роль в области).
  loner = await person(PHONES[4]!, 'Безточки', false)
  roleScopeManager = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380670000002'`)[0]!.id as string
})

afterAll(async () => {
  await cleanup()
  await admin`update tenants set settings = settings - 'org_structure_is_source_of_truth' where id = ${tenantId}`
  await admin.end()
})

async function node(title: string, over: Record<string, unknown> = {}) {
  const r = await createNode(ctx, { title: PREFIX + title, ...over } as never)
  if (!r.ok) throw new Error(`узел «${title}» не создан: ${r.code}`)
  return r.node
}

// ── Критерий 1 ─────────────────────────────────────────────────────────────────────────────

describe('§13 к. 1 — корневой узел и счётчик «N з M»', () => {
  it('создан vacant, в audit_log есть org_node.create', async () => {
    const root = await node('Керуюча компанія', { headcountPlanned: 3, isManagerPoint: true })
    expect(root.state).toBe('vacant')
    expect(root.type).toBe('position')
    expect(root.depth).toBe(1)
    const [log] = await admin`select action from audit_log where entity_id = ${root.id} and action = 'org_node.create'`
    expect(log?.action).toBe('org_node.create')
  })

  it('ответ «Ні» на «Зробити вузол іменним?» оставляет посаду со счётчиком «1 з 3»', async () => {
    const n = await node('Кухарі', { headcountPlanned: 3 })
    const r = await assignUser(ctx, n.id, { userId: worker, makeNamed: false })
    expect(r.ok).toBe(true)
    const tree = await listTree(ctx, { mode: 'admin' })
    const card = JSON.stringify(tree.nodes)
    expect(card).toContain(`${PREFIX}Кухарі`)
    const [row] = await admin`select type, state, headcount_planned from org_nodes where id = ${n.id}`
    expect(row!.type).toBe('position')
    expect(row!.state).toBe('occupied')
    expect(row!.headcount_planned).toBe(3)
    const [cnt] = await admin`select count(*)::int as n from org_node_assignments where node_id = ${n.id} and ended_at is null`
    expect(cnt!.n).toBe(1)
    await endAssignment(ctx, (await admin`select id from org_node_assignments where node_id = ${n.id} and ended_at is null`)[0]!.id as string)
  })

  it('ответ «Так» переводит узел в именной и кэширует держателя', async () => {
    const n = await node('Шеф-кухар точки', { headcountPlanned: 1 })
    const r = await assignUser(ctx, n.id, { userId: worker, makeNamed: true })
    expect(r.ok).toBe(true)
    const [row] = await admin`select type, holder_user_id from org_nodes where id = ${n.id}`
    expect(row!.type).toBe('employee')
    expect(row!.holder_user_id).toBe(worker)
    await endAssignment(ctx, (await admin`select id from org_node_assignments where node_id = ${n.id} and ended_at is null`)[0]!.id as string)
  })
})

// ── Критерий 3 ─────────────────────────────────────────────────────────────────────────────

describe('§13 к. 3 — глубина и циклы', () => {
  it('тринадцатый уровень не создаётся', async () => {
    let parentId: string | null = null
    const chain: string[] = []
    for (let i = 1; i <= 12; i++) {
      const n = await node(`Рівень ${i}`, { parentId })
      expect(n.depth).toBe(i)
      parentId = n.id
      chain.push(n.id)
    }
    const r = await createNode(ctx, { title: `${PREFIX}Рівень 13`, parentId })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.code).toBe('depth_exceeded')
  })

  it('перенос ветки глубиной 12 под второй уровень даёт depth_exceeded, дерево не меняется', async () => {
    const top = (await admin`select id from org_nodes where title = ${`${PREFIX}Рівень 1`}`)[0]!.id as string
    const second = (await admin`select id from org_nodes where title = ${`${PREFIX}Рівень 2`}`)[0]!.id as string
    const before = await admin`select id, path::text as path from org_nodes where tenant_id = ${tenantId} order by path`
    const r = await moveNode(ctx, top, { parentId: second })
    // Второй уровень — потомок первого: это и цикл, и превышение глубины; отвергается.
    expect(r.ok).toBe(false)
    const after = await admin`select id, path::text as path from org_nodes where tenant_id = ${tenantId} order by path`
    expect(after.map(r => r.path)).toEqual(before.map(r => r.path))
  })

  it('подчинение предка его потомку — 409 cycle_detected, дерево не меняется', async () => {
    const a = await node('Цикл A')
    const b = await node('Цикл B', { parentId: a.id })
    const before = await admin`select path::text as path from org_nodes where id in (${a.id}, ${b.id}) order by path`
    const r = await moveNode(ctx, a.id, { parentId: b.id })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.code).toBe('cycle_detected')
    const after = await admin`select path::text as path from org_nodes where id in (${a.id}, ${b.id}) order by path`
    expect(after.map(r => r.path)).toEqual(before.map(r => r.path))
  })

  /**
   * Условие выхода PR-30: запрет стоит **в БД или сервисе, а не только в UI**. Сервис выше
   * уже проверен; здесь — что прямой UPDATE мимо сервиса тоже не создаст петлю. Триггер
   * отложенный, поэтому ошибка приходит на коммите транзакции.
   */
  it('прямой UPDATE мимо сервиса цикл не создаёт — триггер org_nodes_guard', async () => {
    const a = (await admin`select id, path::text as path from org_nodes where title = ${`${PREFIX}Цикл A`}`)[0]!
    const b = (await admin`select id, path::text as path from org_nodes where title = ${`${PREFIX}Цикл B`}`)[0]!
    await expect(admin.begin(async (tx) => {
      await tx`update org_nodes set parent_id = ${b.id}, path = (${b.path} || '.loop')::ltree, depth = 3 where id = ${a.id}`
    })).rejects.toThrow(/org_node_cycle/)
  })

  it('самоподчинение не проходит даже прямым UPDATE — констрейнт org_nodes_not_self_parent_chk', async () => {
    const a = (await admin`select id from org_nodes where title = ${`${PREFIX}Цикл A`}`)[0]!
    await expect(
      admin`update org_nodes set parent_id = id where id = ${a.id}`,
    ).rejects.toThrow(/org_nodes_not_self_parent_chk/)
  })
})

// ── Критерии 4 и 5: единственный resolveManager() ──────────────────────────────────────────

describe('§13 к. 4 и 5 — resolveManager()', () => {
  let chiefNode: string
  let workerNode: string

  beforeAll(async () => {
    const top = await node('Директор', { isManagerPoint: true, headcountPlanned: 1 })
    chiefNode = top.id
    const under = await node('Кухня', { parentId: top.id, headcountPlanned: 5 })
    workerNode = under.id
    await assignUser(ctx, chiefNode, { userId: chief, makeNamed: true })
    await assignUser(ctx, workerNode, { userId: worker })
  })

  it('к. 4 — руководитель в дереве: держатель ближайшей руководящей точки, source=org_tree', async () => {
    const r = await withTenant(tenantId, adminId, tx => resolveManager(tx, worker, { tenantId }))
    expect(r.managerUserId).toBe(chief)
    expect(r.source).toBe('org_tree')
    expect(r.nodeId).toBe(chiefNode)
    expect(r.chain[0]).toBe(chief)
  })

  it('к. 4 — человека нет в дереве: резерв locations.manager_id, source=location, конфликт unit_missing', async () => {
    await admin`update locations set manager_id = ${other} where id = ${locationId}`
    await admin`delete from org_conflicts where user_id = ${outsider}`
    const r = await withTenant(tenantId, adminId, tx => resolveManager(tx, outsider, { tenantId, recordConflicts: true }))
    expect(r.managerUserId).toBe(other)
    expect(r.source).toBe('location')
    const [c] = await admin`select kind, severity from org_conflicts where user_id = ${outsider} and kind = 'unit_missing' and resolved_at is null`
    expect(c!.kind).toBe('unit_missing')
    expect(c!.severity).toBe('warning')
  })

  it('к. 5 — дерево и точка дают разных людей: выигрывает дерево, расхождение в org_conflicts', async () => {
    await admin`update locations set manager_id = ${other} where id = ${locationId}`
    // Открытый конфликт того же вида второй раз не пишется (`recordConflictOnce`), поэтому
    // строку, оставшуюся от пересборки карты при привязке к узлу, закрываем: проверяем ту,
    // что соответствует текущему состоянию поля точки.
    await admin`delete from org_conflicts where user_id = ${worker} and kind = 'manager_mismatch'`
    const r = await withTenant(tenantId, adminId, tx => resolveManager(tx, worker, { tenantId, recordConflicts: true }))
    expect(r.managerUserId).toBe(chief) // не `other` из поля точки
    expect(r.source).toBe('org_tree')
    const [c] = await admin`select details from org_conflicts where user_id = ${worker} and kind = 'manager_mismatch' and resolved_at is null`
    expect(c).toBeDefined()
    expect((c!.details as { tree: string, location: string }).location).toBe(other)
  })

  it('короткие формы managerIdOf/managerIdsOf видят флаг тенанта сами — уведомления идут тому же, кого называет ручка', async () => {
    // Поле точки указывает на другого человека: если бы короткие формы пропускали шаг 1
    // (их зовут без `tenantId`), ответ был бы `other`, а ручка `GET …/manager` назвала бы `chief`.
    await admin`update locations set manager_id = ${other} where id = ${locationId}`
    expect(await withTenant(tenantId, adminId, tx => managerIdOf(tx, worker))).toBe(chief)
    expect((await withTenant(tenantId, adminId, tx => managerIdsOf(tx, [worker]))).get(worker)).toBe(chief)
  })

  it('один и тот же конфликт не пишется дважды — журнал не заливается дублями', async () => {
    await withTenant(tenantId, adminId, tx => resolveManager(tx, worker, { tenantId, recordConflicts: true }))
    const [n] = await admin`select count(*)::int as n from org_conflicts where user_id = ${worker} and kind = 'manager_mismatch' and resolved_at is null`
    expect(n!.n).toBe(1)
  })

  it('флаг тенанта выключен — шаг 1 пропускается, всё работает как до PR-30', async () => {
    await admin`update tenants set settings = settings - 'org_structure_is_source_of_truth' where id = ${tenantId}`
    const r = await withTenant(tenantId, adminId, tx => resolveManager(tx, worker, { tenantId }))
    expect(r.source).toBe('location')
    expect(r.managerUserId).toBe(other)
    await admin`update tenants set settings = coalesce(settings, '{}'::jsonb) || '{"org_structure_is_source_of_truth": true}'::jsonb where id = ${tenantId}`
  })

  it('поле точки пусто — шаг 3: носитель роли со скоупом report.team на его точке', async () => {
    await admin`update locations set manager_id = null where id = ${locationId}`
    const r = await withTenant(tenantId, adminId, tx => resolveManager(tx, outsider, { tenantId }))
    expect(r.source).toBe('role_scope')
    expect(r.managerUserId).toBe(roleScopeManager)
  })

  it('у человека без руководителя вовсе — source=none и конфликт no_manager', async () => {
    await admin`delete from org_conflicts where user_id = ${loner}`
    // Ни дерева, ни точки, ни роли в области: у `loner` нет размещения вообще.
    const r = await withTenant(tenantId, adminId, tx => resolveManager(tx, loner, { tenantId, recordConflicts: true }))
    expect(r.managerUserId).toBeNull()
    expect(r.source).toBe('none')
    const [c] = await admin`select kind from org_conflicts where user_id = ${loner} and kind = 'no_manager' and resolved_at is null`
    expect(c!.kind).toBe('no_manager')
  })

  it('карта org_manager_map — проекция того же ответа, а не второй источник', async () => {
    await withTenant(tenantId, adminId, tx => rebuildManagerMap(tx, tenantId, [worker, chief]))
    const [row] = await admin`select manager_user_id, source from org_manager_map where tenant_id = ${tenantId} and user_id = ${worker}`
    expect(row!.manager_user_id).toBe(chief)
    expect(row!.source).toBe('org_tree')
  })

  // ── Критерий 2 ───────────────────────────────────────────────────────────────────────────

  it('к. 2 — архивация держателя: узел становится vacant и остаётся в дереве', async () => {
    const deep = await createNode(ctx, { title: `${PREFIX}Помічник`, parentId: workerNode })
    expect(deep.ok).toBe(true)
    await admin`update users set status = 'archived' where id = ${chief}`
    const closed = await withTenant(tenantId, adminId, tx => syncDismissals(tx, { tenantId, actorId: adminId }))
    expect(closed).toBeGreaterThan(0)

    const [n] = await admin`select state, holder_user_id from org_nodes where id = ${chiefNode}`
    expect(n!.state).toBe('vacant')
    expect(n!.holder_user_id).toBeNull()
    // Узел остался в дереве: подчинённая ветка не переподчинялась и не исчезла.
    const [kid] = await admin`select parent_id from org_nodes where id = ${workerNode}`
    expect(kid!.parent_id).toBe(chiefNode)

    // Руководитель подчинённого берётся уровнем выше; выше руководящих точек нет — значит
    // резерв, и это уже **не** архивированный держатель. Главное здесь: подчинённый не
    // остался подчинён уволенному и узел из дерева не исчез.
    const r = await withTenant(tenantId, adminId, tx => resolveManager(tx, worker, { tenantId }))
    expect(r.source).not.toBe('org_tree')
    expect(r.managerUserId).not.toBe(chief)

    const [msg] = await admin`select code from notifications where user_id = ${worker} and code = 'org_manager_changed' order by created_at desc limit 1`
    expect(msg?.code).toBe('org_manager_changed')
    await admin`update users set status = 'invited' where id = ${chief}`
  })
})

// ── Критерий 8: ветка руководителя ─────────────────────────────────────────────────────────

describe('§13 к. 8 — своя ветка', () => {
  it('держатель узла правит своё поддерево и не правит чужое', async () => {
    const mine = await node('Філія А', { isManagerPoint: true })
    const kid = await node('Бариста А', { parentId: mine.id })
    const foreign = await node('Філія Б')
    await assignUser(ctx, mine.id, { userId: other, makeNamed: true, transferPrimary: true })

    const asManager = { tenantId, actorId: other }
    expect(await canEditNode(asManager, kid.id, false)).toBe(true)
    expect(await canEditNode(asManager, foreign.id, false)).toBe(false)
    // Корневой узел создаёт только администратор: «своей ветки» у корня нет.
    expect(await canEditNode(asManager, null, false)).toBe(false)
    // Администратор со скоупом на весь тенант правит любую ветку.
    expect(await canEditNode(ctx, foreign.id, true)).toBe(true)
  })

  it('человек, не держащий ни одного узла, конструктора не получает вовсе', async () => {
    const someNode = (await admin`select id from org_nodes where tenant_id = ${tenantId} limit 1`)[0]!.id as string
    expect(await canEditNode({ tenantId, actorId: outsider }, someNode, false)).toBe(false)
  })
})

// ── Условия выхода PR-30 ───────────────────────────────────────────────────────────────────

describe('производные роли пересобираются существующим механизмом', () => {
  it('привязка к узлу выдаёт роль по position_role_map с is_org_derived, снятие правила — снимает', async () => {
    await admin`
      insert into position_role_map (tenant_id, position_id, role_id, scope_type)
      values (${tenantId}, ${positionId}, ${mentorRoleId}, 'tenant')
      on conflict do nothing`
    const n = await node('Вузол з посадою', { positionId })
    const r = await assignUser(ctx, n.id, { userId: outsider })
    expect(r.ok).toBe(true)

    const [granted] = await admin`
      select is_org_derived, reason from user_roles
      where user_id = ${outsider} and role_id = ${mentorRoleId}`
    expect(granted!.is_org_derived).toBe(true)
    // Тот же механизм, что у смены должности: `reason` ставит `applyPositionRoles`.
    expect(granted!.reason).toBe('position_role_map')

    await admin`delete from position_role_map where tenant_id = ${tenantId} and position_id = ${positionId}`
    const a = (await admin`select id from org_node_assignments where node_id = ${n.id} and user_id = ${outsider} and ended_at is null`)[0]!.id as string
    await endAssignment(ctx, a)
    const left = await admin`select 1 from user_roles where user_id = ${outsider} and role_id = ${mentorRoleId}`
    expect(left.length).toBe(0)
  })
})

describe('изоляция тенанта', () => {
  it('дерево чужого тенанта не видно', async () => {
    const mine = await listTree(ctx, { mode: 'admin' })
    expect(mine.total).toBeGreaterThan(0)
    const theirs = await listTree({ tenantId: otherTenantId, actorId: null }, { mode: 'admin' })
    expect(theirs.total).toBe(0)
  })

  it('узел с чужим tenant_id политикой не пишется', async () => {
    // `with check` политики `tenant_isolation`: приложение ходит ролью `app_user`,
    // и подставить чужой тенант в тело запроса нельзя (CLAUDE.md правило 1).
    await expect(withTenant(tenantId, adminId, tx => tx.execute(
      sql`insert into org_nodes (tenant_id, path, depth, title) values (${otherTenantId}::uuid, 'foreign', 1, 'Чужий')`,
    ))).rejects.toThrow()
  })

  it('снимок дерева пишется и виден только своему тенанту', async () => {
    const s = await createSnapshot(ctx, { label: `${PREFIX}знімок` })
    expect(s.nodeCount).toBeGreaterThan(0)
    const [row] = await admin`select tenant_id from org_structure_snapshots where id = ${s.id}`
    expect(row!.tenant_id).toBe(tenantId)
  })
})

describe('архивация узла', () => {
  it('узел с детьми не архивируется, без детей и держателей — архивируется', async () => {
    const parent = await node('Архів батько')
    const kid = await node('Архів дитина', { parentId: parent.id })
    const bad = await archiveNode(ctx, parent.id)
    expect(bad.ok).toBe(false)
    expect(bad.ok === false && bad.code).toBe('has_children')
    expect((await archiveNode(ctx, kid.id)).ok).toBe(true)
    expect((await archiveNode(ctx, parent.id)).ok).toBe(true)
    const [row] = await admin`select state from org_nodes where id = ${parent.id}`
    expect(row!.state).toBe('archived')
  })
})
