import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Отчёты оргструктуры `docs/v2/32-org-structure.md` §9 (решения `docs/v2/44` §14 Р-OS.6, Р-OS.7):
 * «Підпорядкування людей» и «Журнал змін структури». Свой тенант: отчёты читают весь штат и весь
 * журнал, а общий «Каппі» наполняют другие файлы.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const { subordinationReport, changesJournal, changesExportRows, subordinationExportRows } = await import('../../server/services/orgReports')
const { assignUser, createNode, moveNode, editableBranches } = await import('../../server/services/orgStructure')
const { rebuildManagerMap } = await import('../../server/services/orgManager')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

let tenantId: string
let otherTenantId: string
let adminId: string, chief: string, worker: string, outsider: string, candidate: string
let locationId: string, otherLocationId: string, positionId: string
let ctx: { tenantId: string, actorId: string }
const ids: Record<string, string> = {}

async function wipe(tid: string) {
  await admin`delete from notifications where tenant_id = ${tid}`
  await admin`delete from org_node_assignments where tenant_id = ${tid}`
  await admin`delete from org_manager_map where tenant_id = ${tid}`
  await admin`delete from org_conflicts where tenant_id = ${tid}`
  await admin`delete from org_structure_snapshots where tenant_id = ${tid}`
  for (let i = 0; i < 13 && (await admin`select 1 from org_nodes where tenant_id = ${tid} limit 1`).length; i++) {
    await admin`delete from org_nodes where tenant_id = ${tid} and id not in (select parent_id from org_nodes where parent_id is not null and tenant_id = ${tid})`
  }
  await admin`delete from audit_log where tenant_id = ${tid}`
  await admin`update tenants set settings = coalesce(settings, '{}'::jsonb) - 'org_structure_is_source_of_truth' where id = ${tid}`
}

async function upsertOne(select: () => Promise<postgres.RowList<postgres.Row[]>>, insert: () => Promise<postgres.RowList<postgres.Row[]>>): Promise<string> {
  return ((await select())[0]?.id ?? (await insert())[0]!.id) as string
}

async function person(name: string, phone: string, loc: string, kind: 'employee' | 'candidate' = 'employee'): Promise<string> {
  const id = await upsertOne(
    () => admin`select id from users where tenant_id = ${tenantId} and phone = ${phone}`,
    () => admin`insert into users (tenant_id, full_name, last_name, first_name, phone, status, kind, candidate_state) values (${tenantId}, ${name}, ${name}, 'Тест', ${phone}, 'invited', ${kind}, ${kind === 'candidate' ? 'active' : null}) returning id`,
  )
  await admin`delete from user_placements where user_id = ${id}`
  await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary) values (${tenantId}, ${id}, ${loc}, ${positionId}, true)`
  return id
}

beforeAll(async () => {
  tenantId = (await admin`insert into tenants (slug, name) values ('test-org-reports', 'Тест звітів оргструктури') on conflict (slug) do update set name = excluded.name returning id`)[0]!.id as string
  otherTenantId = (await admin`insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції') on conflict (slug) do update set name = excluded.name returning id`)[0]!.id as string
  await wipe(tenantId)
  const unit = (await admin`insert into org_units (tenant_id, name, path) values (${tenantId}, 'Мережа звітів', 'reports') on conflict (tenant_id, path) do update set name = excluded.name returning id`)[0]!.id
  locationId = await upsertOne(() => admin`select id from locations where tenant_id = ${tenantId} and name = 'Точка А'`, () => admin`insert into locations (tenant_id, name, org_unit_id) values (${tenantId}, 'Точка А', ${unit}) returning id`)
  otherLocationId = await upsertOne(() => admin`select id from locations where tenant_id = ${tenantId} and name = 'Точка Б'`, () => admin`insert into locations (tenant_id, name, org_unit_id) values (${tenantId}, 'Точка Б', ${unit}) returning id`)
  positionId = await upsertOne(() => admin`select id from positions where tenant_id = ${tenantId} and name = 'Кухар звітів'`, () => admin`insert into positions (tenant_id, name) values (${tenantId}, 'Кухар звітів') returning id`)
  adminId = await person('Адмін Звітів', '+380684320001', locationId)
  chief = await person('Шеф Звітів', '+380684320002', locationId)
  worker = await person('Кухар Звітів', '+380684320003', locationId)
  outsider = await person('Поза Деревом', '+380684320004', otherLocationId)
  candidate = await person('Кандидат Звітів', '+380684320005', locationId, 'candidate')
  await admin`update locations set manager_id = ${adminId} where id = ${otherLocationId}`
  await admin`update tenants set settings = coalesce(settings, '{}'::jsonb) || '{"org_structure_is_source_of_truth": true}'::jsonb where id = ${tenantId}`
  ctx = { tenantId, actorId: adminId }

  const node = async (key: string, over: Record<string, unknown>) => {
    const r = await createNode(ctx, over as never)
    if (!r.ok) throw new Error(`узел ${key}: ${r.code}`)
    ids[key] = r.node.id
  }
  await node('root', { title: 'Шеф-кухар', isManagerPoint: true, headcountPlanned: 1 })
  await node('cook', { title: 'Кухар', parentId: ids.root, headcountPlanned: 3 })
  await node('bar', { title: 'Бар', parentId: ids.root })
  await node('other', { title: 'Інша гілка' })
  await assignUser(ctx, ids.root!, { userId: chief })
  await assignUser(ctx, ids.cook!, { userId: worker, startedAt: '2026-09-01' })
  await assignUser(ctx, ids.bar!, { userId: worker, isPrimary: false })
  await withTenant(tenantId, null, tx => rebuildManagerMap(tx, tenantId))
})

afterAll(async () => {
  await wipe(tenantId)
  // Люди тестового тенанта — тоже прочь: вход идёт по телефону, и чужой файл с тем же номером
  // иначе попал бы в этого человека (префикс `+38068432` больше нигде не занят).
  await admin`update locations set manager_id = null where tenant_id = ${tenantId}`
  await admin`delete from user_placements where tenant_id = ${tenantId}`
  await admin`delete from users where tenant_id = ${tenantId}`
  await admin.end()
})

describe('«Підпорядкування людей» (`32` §9)', () => {
  it('колонки: вузол, керівник з дерева, джерело, сумісництва, дата початку', async () => {
    const rows = await subordinationReport(ctx, { scope: null })
    const w = rows.find(r => r.userId === worker)!
    expect(w).toMatchObject({ fullName: 'Кухар Звітів', position: 'Кухар звітів', location: 'Точка А', node: 'Кухар', managerUserId: chief, manager: 'Шеф Звітів', source: 'org_tree', secondary: ['Бар'], since: '2026-09-01' })
    const o = rows.find(r => r.userId === outsider)!
    expect(o).toMatchObject({ node: null, manager: 'Адмін Звітів', source: 'location', secondary: [] })
  })

  it('кандидата в отчёте нет (правило 17)', async () => {
    const rows = await subordinationReport(ctx, { scope: null })
    expect(rows.map(r => r.userId)).not.toContain(candidate)
  })

  it('«лише резервні правила» — только source ≠ org_tree', async () => {
    const rows = await subordinationReport(ctx, { scope: null, onlyFallback: true })
    expect(rows.map(r => r.userId)).toContain(outsider)
    expect(rows.map(r => r.userId)).not.toContain(worker)
    expect(rows.every(r => r.source !== 'org_tree')).toBe(true)
  })

  it('область видимости и фильтры: точка, поиск', async () => {
    expect((await subordinationReport(ctx, { scope: [otherLocationId] })).map(r => r.userId)).toEqual([outsider])
    expect(await subordinationReport(ctx, { scope: [] })).toEqual([])
    expect((await subordinationReport(ctx, { scope: null, locationId: otherLocationId })).map(r => r.userId)).toEqual([outsider])
    expect((await subordinationReport(ctx, { scope: null, q: 'Шеф Зв' })).map(r => r.userId)).toEqual(expect.arrayContaining([chief, worker]))
  })

  it('файл: плоские строки', async () => {
    const flat = subordinationExportRows((await subordinationReport(ctx, { scope: null })).filter(r => r.userId === worker))
    expect(flat[0]).toMatchObject({ full_name: 'Кухар Звітів', manager: 'Шеф Звітів', source: 'org_tree', secondary: 'Бар', since: '2026-09-01' })
  })

  it('чужой тенант людей не видит', async () => {
    expect(await subordinationReport({ tenantId: otherTenantId, actorId: null }, { scope: null, q: 'Звітів' })).toEqual([])
  })
})

describe('«Журнал змін структури» (`32` §9)', () => {
  it('строки из audit_log с автором, узлом и действием, новые сверху', async () => {
    const { rows } = await changesJournal(ctx, { branches: null, limit: 100 })
    expect(rows.length).toBeGreaterThanOrEqual(7)
    expect(rows[0]!.action).toBe('org_node.assign_user')
    expect(rows.every(r => r.actor === 'Адмін Звітів')).toBe(true)
    const create = rows.find(r => r.action === 'org_node.create' && r.nodeId === ids.cook)!
    expect(create).toMatchObject({ node: 'Кухар', before: null })
    expect(create.after).toMatchObject({ title: 'Кухар' })
  })

  it('перенос ветки: «Зачеплено нащадків»', async () => {
    const r = await moveNode(ctx, ids.bar!, { parentId: ids.other! })
    expect(r.ok).toBe(true)
    const { rows } = await changesJournal(ctx, { branches: null, limit: 1 })
    expect(rows[0]).toMatchObject({ action: 'org_node.move', node: 'Бар', affected: 1 })
    expect(rows[0]!.before).toMatchObject({ parentId: ids.root })
  })

  it('фильтры: действие, автор, период, ветка', async () => {
    const creates = await changesJournal(ctx, { branches: null, action: 'org_node.create', limit: 100 })
    expect(creates.rows).toHaveLength(4)
    expect((await changesJournal(ctx, { branches: null, actorId: chief, limit: 100 })).rows).toEqual([])
    expect((await changesJournal(ctx, { branches: null, from: '2001-01-01', to: '2001-01-02', limit: 100 })).rows).toEqual([])
    const today = new Date().toISOString().slice(0, 10)
    expect((await changesJournal(ctx, { branches: null, from: today, limit: 100 })).rows.length).toBeGreaterThan(0)
    const branch = await changesJournal(ctx, { branches: null, nodeId: ids.other, limit: 100 })
    expect(new Set(branch.rows.map(r => r.node))).toEqual(new Set(['Інша гілка', 'Бар']))
  })

  it('руководитель видит только свою ветку; без ветки — ничего', async () => {
    const branches = await withTenant(tenantId, chief, tx => editableBranches(tx, chief))
    const mine = await changesJournal({ tenantId, actorId: chief }, { branches, limit: 100 })
    expect(mine.rows.length).toBeGreaterThan(0)
    expect(mine.rows.map(r => r.node)).not.toContain('Інша гілка')
    expect(mine.rows.map(r => r.node)).not.toContain('Бар')
    expect(await changesJournal(ctx, { branches: [], limit: 100 })).toEqual({ rows: [], cursor: null })
  })

  it('курсор: вторая страница продолжает первую без повторов', async () => {
    const all = (await changesJournal(ctx, { branches: null, limit: 100 })).rows
    const p1 = await changesJournal(ctx, { branches: null, limit: 3 })
    expect(p1.cursor).not.toBeNull()
    const p2 = await changesJournal(ctx, { branches: null, limit: 3, cursor: p1.cursor! })
    expect([...p1.rows, ...p2.rows].map(r => r.id)).toEqual(all.slice(0, 6).map(r => r.id))
  })

  it('снимки, перевод флага и чистка входят в журнал; файл — «Було»/«Стало» JSON', async () => {
    await admin`insert into audit_log (tenant_id, actor_id, action, entity, after) values (${tenantId}, null, 'org_structure.snapshot_cleanup', 'org_structure', '{"expired":1,"dailyOverflow":0}'::jsonb)`
    const { rows } = await changesJournal(ctx, { branches: null, action: 'org_structure.snapshot_cleanup', limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor: null, node: null })
    const flat = changesExportRows(rows)
    expect(flat[0]).toMatchObject({ action: 'org_structure.snapshot_cleanup', before: '', after: '{"expired":1,"dailyOverflow":0}' })
  })

  it('чужие действия (не структуры) и чужой тенант в журнал не попадают', async () => {
    await admin`insert into audit_log (tenant_id, actor_id, action, entity) values (${tenantId}, ${adminId}, 'people.update', 'user')`
    expect((await changesJournal(ctx, { branches: null, limit: 500 })).rows.map(r => r.action)).not.toContain('people.update')
    expect((await changesJournal({ tenantId: otherTenantId, actorId: null }, { branches: null, action: 'org_node.create', limit: 100 })).rows).toEqual([])
  })
})
