import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ORG_IMPORT_COLUMNS, toCsv } from '../../shared/domain/orgImport'
import type { OrgImportColumn, OrgImportOptions } from '../../shared/domain/orgImport'

/**
 * PR-31 пакета `docs/v2` (`45-plan.md`): импорт CSV, снимки, откат реорганизации и эскалация
 * SLA по дереву.
 *
 * Критерии приёмки `docs/v2/32-org-structure.md` §13, закреплённые за этим PR:
 * - **6** — CSV на 120 строк: перед применением создан снимок `pre_import`, по завершении
 *   инициатору пришло `org_structure_import_finished` со счётчиками;
 * - **7** — неудачная реорганизация откатывается: дерево **и активные назначения** совпадают
 *   со снимком, уволенные после снимка не возвращены, в `audit_log` есть
 *   `org_structure.rollback`.
 *
 * Условия выхода PR-31:
 * - откат восстанавливает не только узлы, но и держателей;
 * - петли и висячие узлы из кривого CSV попадают в `org_conflicts`, а не в дерево, и
 *   инвариант дерева (путь ребёнка = путь родителя + метка) держится после любого импорта;
 * - эскалация SLA идёт вверх по дереву до ближайшего держателя, а не сразу администратору
 *   (фолбэк PR-19 снят; администратор — только когда выше в дереве никого).
 *
 * Весь файл работает в общем тенанте «Каппі», но **всё дерево тенанта** принадлежит ему на
 * время прогона: откат и импорт по определению меняют дерево целиком. Файлы тестов идут
 * последовательно (`fileParallelism: false`), а до и после файла дерево тенанта пустое.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const { applyOrgImport, exportOrgStructureCsv, getOrgImport, parseOrgImportFile, remapOrgImport, requestOrgImportApply, startOrgImport } = await import('../../server/services/orgImport')
const { listSnapshotsPage, rollbackToSnapshot } = await import('../../server/services/orgSnapshots')
const { assignUser, createNode, createSnapshot, endAssignment, moveNode, syncDismissals, updateNode } = await import('../../server/services/orgStructure')
const { escalationTarget } = await import('../../server/services/reviewPeople')
const { reviewSlaScan } = await import('../../server/services/reviewSla')
const { enqueueReview } = await import('../../server/services/reviewQueue')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 3, onnotice: () => {} })

const H = 3_600_000
const PREFIX = 'v2-31 '
const PEOPLE = {
  boss: ['+380679931011', 'EXT31-BOSS', 'Директор'],
  chief: ['+380679931012', 'EXT31-CHIEF', 'Керуючий'],
  w1: ['+380679931013', 'EXT31-W1', 'Кухар один'],
  w2: ['+380679931014', 'EXT31-W2', 'Кухар два'],
  w3: ['+380679931015', 'EXT31-W3', 'Бариста'],
  mgr: ['+380679931016', 'EXT31-MGR', 'Керівник точки'],
  upper: ['+380679931017', 'EXT31-UP', 'Регіональний'],
  top: ['+380679931018', 'EXT31-TOP', 'Операційний'],
  learner: ['+380679931019', 'EXT31-L', 'Учень'],
} as const
type Who = keyof typeof PEOPLE

let tenantId: string
let otherTenantId: string
let adminId: string
let locationId: string
let positionId: string
let prevLocationManager: string | null
let ctx: { tenantId: string, actorId: string }
const people = {} as Record<Who, string>

async function cleanupTree() {
  await admin`delete from org_node_assignments where tenant_id = ${tenantId}`
  await admin`delete from org_manager_map where tenant_id = ${tenantId}`
  await admin`delete from org_conflicts where tenant_id = ${tenantId} and (node_id is not null or import_job_id in (select id from import_jobs where tenant_id = ${tenantId} and kind = 'org_structure'))`
  await admin`delete from org_structure_snapshots where tenant_id = ${tenantId}`
  await admin`delete from import_jobs where tenant_id = ${tenantId} and kind = 'org_structure'`
  // Узлы — снизу вверх: `parent_id` стоит на `restrict`.
  for (let i = 0; i < 20 && (await admin`select 1 from org_nodes where tenant_id = ${tenantId} limit 1`).length; i++) {
    await admin`delete from org_nodes where tenant_id = ${tenantId} and id not in (select parent_id from org_nodes where parent_id is not null and tenant_id = ${tenantId})`
  }
  await admin`delete from positions where tenant_id = ${tenantId} and name like ${`${PREFIX}%`}`
}

async function cleanupPeople() {
  const ids = (await admin`select id from users where tenant_id = ${tenantId} and phone like '+38067993101%'`).map(r => r.id as string)
  if (!ids.length) return
  await admin`delete from review_queue_items where tenant_id = ${tenantId} and user_id in ${admin(ids)}`
  await admin`delete from notifications where user_id in ${admin(ids)}`
  await admin`delete from user_roles where user_id in ${admin(ids)}`
  await admin`delete from user_placements where user_id in ${admin(ids)}`
  await admin`delete from audit_log where entity_id in ${admin(ids)}`
  await admin`update locations set manager_id = null where manager_id in ${admin(ids)}`
  await admin`delete from users where id in ${admin(ids)}`
}

const setFlag = (on: boolean) => on
  ? admin`update tenants set settings = coalesce(settings, '{}'::jsonb) || '{"org_structure_is_source_of_truth": true}'::jsonb where id = ${tenantId}`
  : admin`update tenants set settings = settings - 'org_structure_is_source_of_truth' where id = ${tenantId}`

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  const [loc] = await admin`select id, manager_id from locations where tenant_id = ${tenantId} order by name limit 1`
  locationId = loc!.id as string
  positionId = (await admin`select id from positions where tenant_id = ${tenantId} and is_active order by name limit 1`)[0]!.id as string
  const [o] = await admin`insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції') on conflict (slug) do update set name = excluded.name returning id`
  otherTenantId = o!.id as string
  ctx = { tenantId, actorId: adminId }
  await cleanupTree()
  await cleanupPeople()
  const [cur] = await admin`select manager_id from locations where id = ${locationId}`
  prevLocationManager = (cur?.manager_id as string | null) ?? null
  for (const [key, [phone, ext, name]] of Object.entries(PEOPLE) as [Who, readonly [string, string, string]][]) {
    const [u] = await admin`
      insert into users (tenant_id, kind, full_name, last_name, first_name, phone, external_id, status)
      values (${tenantId}, 'employee', ${PREFIX + name}, ${name}, 'Тест', ${phone}, ${ext}, 'active')
      returning id`
    people[key] = u!.id as string
    await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary) values (${tenantId}, ${u!.id}, ${locationId}, ${positionId}, true)`
  }
  await setFlag(true)
})

afterAll(async () => {
  await cleanupTree()
  await cleanupPeople()
  await admin`update locations set manager_id = ${prevLocationManager} where id = ${locationId}`
  await setFlag(false)
  await admin.end()
})

// ── Помощники ────────────────────────────────────────────────────────────────────────────

type Row = Partial<Record<OrgImportColumn, string | number | boolean>>

function csvOf(rows: Row[]): string {
  return toCsv([[...ORG_IMPORT_COLUMNS], ...rows.map(r => ORG_IMPORT_COLUMNS.map(c => r[c] ?? ''))])
}

/** Полный путь импорта: разбор → предпросмотр → опции → запуск → применение фоновой задачей. */
async function importCsv(text: string, options: Partial<OrgImportOptions> = {}, fileName = 'structure.csv') {
  const parsed = parseOrgImportFile(Buffer.from(text, 'utf8'))
  if (!parsed.ok) throw new Error(`файл не разобран: ${parsed.code}`)
  let view = await startOrgImport(ctx, fileName, parsed)
  if (Object.keys(options).length) {
    const r = await remapOrgImport(ctx, view.jobId, { options })
    if (!r.ok) throw new Error(`опции не приняты: ${r.code}`)
    view = r.view
  }
  const queued = await requestOrgImportApply(ctx, view.jobId)
  if (!queued.ok) return { view, queued, outcome: null }
  const outcome = await applyOrgImport(tenantId, view.jobId)
  return { view, queued, outcome, after: await getOrgImport(ctx, view.jobId) }
}

async function nodeByKey(key: string) {
  return (await admin`select * from org_nodes where tenant_id = ${tenantId} and external_key = ${key}`)[0] ?? null
}

/** Инвариант дерева: путь ребёнка = путь родителя + метка, ровно на уровень глубже; корень — одна метка. */
async function treeViolations(): Promise<number> {
  const [r] = await admin`
    select count(*)::int as n from org_nodes c
      left join org_nodes p on p.id = c.parent_id
     where c.tenant_id = ${tenantId}
       and (nlevel(c.path) <> c.depth
         or (c.parent_id is null and nlevel(c.path) <> 1)
         or (c.parent_id is not null and (p.id is null or not (p.path @> c.path) or nlevel(c.path) <> nlevel(p.path) + 1)))`
  return r!.n as number
}

async function activeHolders() {
  return (await admin`
    select node_id::text as node_id, user_id::text as user_id, is_primary, role_in_node
      from org_node_assignments where tenant_id = ${tenantId} and ended_at is null
     order by node_id, user_id`).map(r => `${r.node_id}|${r.user_id}|${r.is_primary}|${r.role_in_node}`)
}

async function node(title: string, over: Record<string, unknown> = {}) {
  const r = await createNode(ctx, { title: PREFIX + title, ...over } as never)
  if (!r.ok) throw new Error(`узел «${title}» не создан: ${r.code}`)
  return r.node
}

// ── Критерий 6 ─────────────────────────────────────────────────────────────────────────────

describe('§13 к. 6 — CSV на 120 строк: снимок pre_import и письмо со счётчиками', () => {
  it('120 строк применяются одной транзакцией; перед записью — pre_import, после — org_structure_import_finished', async () => {
    await cleanupTree()
    const rows: Row[] = [{ external_key: 'ROOT', title: `${PREFIX}Керуюча компанія`, is_manager_point: true, employee_external_id: 'EXT31-BOSS', type: 'employee' }]
    for (let b = 1; b <= 10; b++) {
      rows.push({ external_key: `BR${b}`, parent_external_key: 'ROOT', title: `${PREFIX}Філія ${b}`, is_manager_point: true, sort: b })
      for (let k = 1; k <= (b === 10 ? 10 : 11); k++) {
        rows.push({ external_key: `BR${b}-${k}`, parent_external_key: `BR${b}`, title: `${PREFIX}Посада ${b}.${k}`, headcount_planned: 3 })
      }
    }
    // Держатель филиала — по телефону: у человека может не быть зовнішнього №.
    rows[1] = { ...rows[1], employee_external_id: PEOPLE.chief[0], type: 'employee' }
    rows[2] = { ...rows[2], employee_external_id: 'EXT31-W1' }
    expect(rows.length).toBe(120)

    const r = await importCsv(csvOf(rows))
    expect(r.queued.ok).toBe(true)
    expect(r.view.snapshotForced, 'при >50 строках снимок обязателен').toBe(true)
    expect(r.outcome).toMatchObject({ created: 120, updated: 0, errors: 0, assignmentsCreated: 3 })
    expect(r.after!.status).toBe('applied')

    // Снимок pre_import — до записи: в нём нет ни одного узла из файла.
    const [snap] = await admin`select kind, label, node_count, tree from org_structure_snapshots where id = ${r.outcome!.snapshotId}`
    expect(snap!.kind).toBe('pre_import')
    expect(snap!.label).toBe('structure.csv')
    expect((snap!.tree as { nodes: unknown[] }).nodes).toHaveLength(0)

    // Письмо инициатору со счётчиками (`32` §8).
    const [msg] = await admin`select payload from notifications where user_id = ${adminId} and code = 'org_structure_import_finished' and dedup_key = ${`org_import_finished:${r.view.jobId}`}`
    expect(msg!.payload).toMatchObject({ created: 120, updated: 0, errors: 0 })

    // Журнал: итог импорта и строка на каждый созданный узел (`32` §7 п. 3).
    const [log] = await admin`select after from audit_log where tenant_id = ${tenantId} and action = 'org_structure.import' and entity_id = ${r.view.jobId}`
    expect(log!.after).toMatchObject({ created: 120, snapshotId: r.outcome!.snapshotId })
    const [creates] = await admin`select count(*)::int as n from audit_log where tenant_id = ${tenantId} and action = 'org_node.create' and after->>'importJobId' = ${r.view.jobId}`
    expect(creates!.n).toBe(120)

    // Дерево собрано и корректно, держатели на местах, руководитель — по дереву.
    expect(await treeViolations()).toBe(0)
    const root = await nodeByKey('ROOT')
    expect(root!.state).toBe('occupied')
    expect(root!.holder_user_id).toBe(people.boss)
    const [mm] = await admin`select manager_user_id, source from org_manager_map where tenant_id = ${tenantId} and user_id = ${people.w1}`
    expect(mm).toMatchObject({ manager_user_id: people.chief, source: 'org_tree' })
  })

  it('снять «Зробити знімок перед імпортом» при >50 строках нельзя — сервер держит его включённым', async () => {
    const rows: Row[] = Array.from({ length: 60 }, (_, i) => ({ external_key: `SNAP${i}`, parent_external_key: 'ROOT', title: `${PREFIX}Вузол ${i}` }))
    const parsed = parseOrgImportFile(Buffer.from(csvOf(rows)))
    if (!parsed.ok) throw new Error(parsed.code)
    const view = await startOrgImport(ctx, 'big.csv', parsed)
    const r = await remapOrgImport(ctx, view.jobId, { options: { snapshot: false } })
    expect(r.ok && r.view.options.snapshot).toBe(true)
  })

  it('повторный импорт выгрузки — «без змін»: запускать нечего', async () => {
    const csv = await exportOrgStructureCsv(ctx)
    expect(csv.startsWith('\uFEFFexternal_key;parent_external_key;')).toBe(true)
    const r = await importCsv(csv)
    expect(r.view.stats).toMatchObject({ create: 0, update: 0, errors: 0 })
    expect(r.queued).toEqual({ ok: false, code: 'nothing_to_apply' })
  })
})

// ── Условие выхода: кривой CSV не ломает дерево ────────────────────────────────────────────

describe('условие выхода — петли и висячие узлы идут в org_conflicts, а не в дерево', () => {
  it('петля A→B→A, узел-сам-себе-родитель, неизвестный родитель и его потомок отклонены; остальное применено', async () => {
    const r = await importCsv(csvOf([
      { external_key: 'LOOP-A', parent_external_key: 'LOOP-B', title: `${PREFIX}Петля А` },
      { external_key: 'LOOP-B', parent_external_key: 'LOOP-A', title: `${PREFIX}Петля Б` },
      { external_key: 'SELF', parent_external_key: 'SELF', title: `${PREFIX}Сам собі` },
      { external_key: 'ORPHAN', parent_external_key: 'NO-SUCH-KEY', title: `${PREFIX}Сирота` },
      { external_key: 'ORPHAN-KID', parent_external_key: 'ORPHAN', title: `${PREFIX}Дитина сироти` },
      { external_key: 'OK-1', parent_external_key: 'BR2', title: `${PREFIX}Нормальний` },
    ]))
    expect(r.outcome).toMatchObject({ created: 1, errors: 5, conflicts: 5 })
    for (const key of ['LOOP-A', 'LOOP-B', 'SELF', 'ORPHAN', 'ORPHAN-KID']) expect(await nodeByKey(key), `${key} попал в дерево`).toBeNull()
    expect(await nodeByKey('OK-1')).not.toBeNull()

    const conflicts = await admin`select kind, severity, source, details from org_conflicts where import_job_id = ${r.view.jobId} order by kind, details->>'externalKey'`
    expect(conflicts.map(c => [c.kind, (c.details as { externalKey: string }).externalKey])).toEqual([
      ['manager_cycle', 'LOOP-A'], ['manager_cycle', 'LOOP-B'], ['manager_self', 'SELF'], ['unit_missing', 'ORPHAN'], ['unit_missing', 'ORPHAN-KID'],
    ])
    expect(conflicts.every(c => c.source === 'import')).toBe(true)
    expect(conflicts.find(c => c.kind === 'manager_cycle')!.severity).toBe('critical')
    expect(await treeViolations()).toBe(0)

    // Ошибки видны и в отчёте импорта, построчно.
    const rows = r.after!.rows
    expect(rows.find(x => x.key === 'ORPHAN')!.errors[0]).toEqual({ code: 'parent_not_found', params: { key: 'NO-SUCH-KEY' } })
    expect(rows.find(x => x.key === 'OK-1')!.action).toBe('create')
  })

  it('файл подчиняет существующий узел его же потомку — строка отклонена, ветка на месте', async () => {
    const before = await nodeByKey('BR3')
    const r = await importCsv(csvOf([{ external_key: 'BR3', parent_external_key: 'BR3-1', title: `${PREFIX}Філія 3`, is_manager_point: true, sort: 3 }]))
    expect(r.queued).toEqual({ ok: false, code: 'nothing_to_apply' })
    expect(r.view.rows[0]!.errors.map(e => e.code)).toEqual(['cycle'])
    expect((await nodeByKey('BR3'))!.path).toBe(before!.path)
  })

  it('13-й уровень отклоняется, 14-й висит; 12 уровней созданы', async () => {
    const rows: Row[] = Array.from({ length: 14 }, (_, i) => ({ external_key: `DEEP${i + 1}`, parent_external_key: i ? `DEEP${i}` : '', title: `${PREFIX}Рівень ${i + 1}` }))
    const r = await importCsv(csvOf(rows))
    expect(r.outcome).toMatchObject({ created: 12, errors: 2 })
    expect((await nodeByKey('DEEP12'))!.depth).toBe(12)
    const conflicts = await admin`select kind from org_conflicts where import_job_id = ${r.view.jobId} order by kind`
    expect(conflicts.map(c => c.kind)).toEqual(['depth_exceeded', 'unit_missing'])
    expect(await treeViolations()).toBe(0)
  })
})

// ── Импорт существующего: перенос, переименование, архивация отсутствующих ─────────────────

describe('импорт по ключу: обновление, перенос ветки, привязки', () => {
  it('перенос и переименование по ключу; потомки вне файла переезжают вместе; основное подчинение переносится', async () => {
    const kid = await node('Під BR4-1', { parentId: (await nodeByKey('BR4-1'))!.id })
    const r = await importCsv(csvOf([
      { external_key: 'BR4-1', parent_external_key: 'BR5', title: `${PREFIX}Перенесена посада`, headcount_planned: 3 },
      { external_key: 'BR5', parent_external_key: 'ROOT', title: `${PREFIX}Філія 5`, is_manager_point: true, sort: 5, type: 'employee', employee_external_id: 'EXT31-W1' },
    ]))
    expect(r.outcome).toMatchObject({ created: 0, updated: 2, errors: 0 })
    const moved = await nodeByKey('BR4-1')
    expect(moved!.parent_id).toBe((await nodeByKey('BR5'))!.id)
    expect(moved!.title).toBe(`${PREFIX}Перенесена посада`)
    const [k] = await admin`select path::text as path from org_nodes where id = ${kid.id}`
    expect(k!.path.startsWith(`${moved!.path}.`)).toBe(true)
    // w1 был основным в BR1-1 — основное подчинение перенесено, прежнее закрыто как `moved`.
    const [old] = await admin`select ended_reason from org_node_assignments a join org_nodes n on n.id = a.node_id where n.external_key = 'BR1-1' and a.user_id = ${people.w1} order by a.created_at desc limit 1`
    expect(old!.ended_reason).toBe('moved')
    expect(await treeViolations()).toBe(0)
    // Журнал переноса: одна строка на перенесённый узел и число задетых потомков (`32` §7 п. 3).
    const moves = await admin`select after from audit_log where tenant_id = ${tenantId} and action = 'org_node.move' and after->>'importJobId' = ${r.view.jobId}`
    expect(moves.length).toBe(1)
    expect(moves[0]!.after).toMatchObject({ affected: 1, changed: ['parent', 'title'] })
  })

  it('«Архівувати вузли, яких немає у файлі»: отсутствующие листья — в архив, держатели сняты node_archived', async () => {
    await assignUser(ctx, (await nodeByKey('DEEP12'))!.id, { userId: people.w3 })
    const r = await importCsv(csvOf(Array.from({ length: 11 }, (_, i) => ({ external_key: `DEEP${i + 1}`, parent_external_key: i ? `DEEP${i}` : '', title: `${PREFIX}Рівень ${i + 1}` }))), { archiveMissing: true })
    expect(r.outcome!.archived).toBeGreaterThan(100)
    expect((await nodeByKey('DEEP12'))!.state).toBe('archived')
    expect((await nodeByKey('DEEP11'))!.state).toBe('vacant')
    const [a] = await admin`select ended_reason from org_node_assignments a join org_nodes n on n.id = a.node_id where n.external_key = 'DEEP12' and a.user_id = ${people.w3}`
    expect(a!.ended_reason).toBe('node_archived')
    expect(await treeViolations()).toBe(0)
  })
})

// ── Критерий 7 ─────────────────────────────────────────────────────────────────────────────

describe('§13 к. 7 — откат неудачной реорганизации', () => {
  let snapshotId: string
  let before: { nodes: Record<string, unknown>[], holders: string[] }
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    await cleanupTree()
    const r = await node('Корінь', { isManagerPoint: true, headcountPlanned: 1 })
    const x = await node('Філія Х', { parentId: r.id, isManagerPoint: true, headcountPlanned: 1 })
    const y = await node('Кухарі', { parentId: x.id, headcountPlanned: 3 })
    const z = await node('Бар', { parentId: x.id, headcountPlanned: 2 })
    Object.assign(ids, { r: r.id, x: x.id, y: y.id, z: z.id })
    await assignUser(ctx, r.id, { userId: people.boss, makeNamed: true })
    await assignUser(ctx, x.id, { userId: people.chief, makeNamed: true })
    await assignUser(ctx, y.id, { userId: people.w1 })
    await assignUser(ctx, y.id, { userId: people.w2, roleInNode: 'deputy' })
    await assignUser(ctx, z.id, { userId: people.w3 })
    await assignUser(ctx, z.id, { userId: people.w1, isPrimary: false, roleInNode: 'acting' })
    before = {
      nodes: await admin`select id, parent_id, path::text as path, depth, title, type, is_manager_point, headcount_planned, state from org_nodes where tenant_id = ${tenantId} order by id`,
      holders: await activeHolders(),
    }
    snapshotId = (await createSnapshot(ctx, { label: `${PREFIX}до реорганізації` })).id
  })

  it('дерево и активные назначения совпадают со снимком; уволенный после снимка не возвращён; журнал и письмо', async () => {
    // «Неудачная реорганизация»: новая ветка, перенос, переименование, перестановки людей, увольнение.
    const n = await node('Нова філія', { parentId: ids.r, isManagerPoint: true })
    expect((await moveNode(ctx, ids.y, { parentId: n.id })).ok).toBe(true)
    expect((await updateNode(ctx, ids.x, { title: `${PREFIX}Перейменована`, isManagerPoint: false })).ok).toBe(true)
    await assignUser(ctx, n.id, { userId: people.w1, transferPrimary: true })
    const [w2a] = await admin`select id from org_node_assignments where user_id = ${people.w2} and ended_at is null`
    await endAssignment(ctx, w2a!.id as string)
    await assignUser(ctx, ids.z, { userId: people.upper })
    await admin`update users set status = 'archived' where id = ${people.chief}`
    await withTenant(tenantId, adminId, tx => syncDismissals(tx, { tenantId, actorId: adminId }))
    expect(await activeHolders()).not.toEqual(before.holders)

    const r = await rollbackToSnapshot(ctx, snapshotId)
    expect(r.ok).toBe(true)
    if (!r.ok) return

    // Узлы снимка — на своих местах и со своими полями; появившиеся после — в архиве.
    const after = await admin`select id, parent_id, path::text as path, depth, title, type, is_manager_point, headcount_planned, state from org_nodes where tenant_id = ${tenantId} and state <> 'archived' order by id`
    expect(after).toEqual(before.nodes.map(n => n.id === ids.x ? { ...n, state: 'vacant' } : n))
    expect((await admin`select state from org_nodes where id = ${n.id}`)[0]!.state).toBe('archived')
    expect(r.result.archived).toBe(1)

    // Держатели — как в снимке, кроме уволенного после снимка: его узел вакантен.
    const chiefRow = `${ids.x}|${people.chief}|true|holder`
    expect(await activeHolders()).toEqual(before.holders.filter(h => h !== chiefRow))
    expect((await admin`select state from org_nodes where id = ${ids.x}`)[0]!.state).toBe('vacant')
    expect(r.result.dismissedSkipped).toBe(1)
    expect(await treeViolations()).toBe(0)

    // Возвращённое назначение — новая строка от даты отката: закрытое не открывается обратно.
    const w2rows = await admin`select ended_at from org_node_assignments where user_id = ${people.w2} and node_id = ${ids.y} order by created_at`
    expect(w2rows.length).toBe(2)
    expect(w2rows[0]!.ended_at).not.toBeNull()
    expect(w2rows[1]!.ended_at).toBeNull()

    // Журнал, снимок «до отката», письмо администраторам (`32` §7 п. 7, §8).
    const [log] = await admin`select after from audit_log where tenant_id = ${tenantId} and action = 'org_structure.rollback' and entity_id = ${snapshotId} order by created_at desc limit 1`
    expect(log!.after).toMatchObject({ snapshotId, preSnapshotId: r.result.preSnapshotId, dismissedSkipped: 1, dismissedUserIds: [people.chief] })
    const [pre] = await admin`select kind, tree from org_structure_snapshots where id = ${r.result.preSnapshotId}`
    expect(pre!.kind).toBe('pre_bulk_move')
    expect((pre!.tree as { nodes: { id: string }[] }).nodes.some(x => x.id === n.id)).toBe(true)
    const [mail] = await admin`select payload from notifications where user_id = ${adminId} and code = 'org_structure_rollback' and dedup_key = ${`org_rollback:${r.result.preSnapshotId}:${adminId}`}`
    expect(mail!.payload).toMatchObject({ label: `${PREFIX}до реорганізації` })
    await admin`update users set status = 'active' where id = ${people.chief}`
  })

  it('откат можно откатить: снимок «до отката» возвращает реорганизацию', async () => {
    const { rows } = await listSnapshotsPage(ctx, { limit: 5 })
    const pre = rows.find(s => s.kind === 'pre_bulk_move')!
    const r = await rollbackToSnapshot(ctx, pre.id)
    expect(r.ok).toBe(true)
    const [y] = await admin`select parent_id from org_nodes where id = ${ids.y}`
    const [renamed] = await admin`select title from org_nodes where id = ${ids.x}`
    expect(renamed!.title).toBe(`${PREFIX}Перейменована`)
    expect((await admin`select state from org_nodes where id = ${y!.parent_id}`)[0]!.state).not.toBe('archived')
    expect(await treeViolations()).toBe(0)
  })

  it('второй откат, пока идёт первый, — 409 rollback_in_progress; во время импорта — import_in_progress', async () => {
    const lock = await admin.reserve()
    try {
      await lock`select pg_advisory_lock(hashtext('org_structure'), hashtext(${tenantId}))`
      expect(await rollbackToSnapshot(ctx, snapshotId)).toEqual({ ok: false, code: 'rollback_in_progress' })
      await lock`select pg_advisory_unlock(hashtext('org_structure'), hashtext(${tenantId}))`
    }
    finally {
      lock.release()
    }
    const [job] = await admin`
      insert into import_jobs (tenant_id, kind, source, file_name, status, created_by)
      values (${tenantId}, 'org_structure', 'csv', 'running.csv', 'applying', ${adminId}) returning id`
    expect(await rollbackToSnapshot(ctx, snapshotId)).toEqual({ ok: false, code: 'import_in_progress' })
    const parsed = parseOrgImportFile(Buffer.from(csvOf([{ external_key: 'Q1', title: `${PREFIX}Черговий` }])))
    if (!parsed.ok) throw new Error(parsed.code)
    const view = await startOrgImport(ctx, 'second.csv', parsed)
    expect(await requestOrgImportApply(ctx, view.jobId)).toEqual({ ok: false, code: 'import_in_progress' })
    await admin`update import_jobs set status = 'failed' where id = ${job!.id}`
  })

  it('чужой тенант: снимок и импорт не видны — 404, а не 403 (правило 15)', async () => {
    const foreign = { tenantId: otherTenantId, actorId: null }
    expect(await rollbackToSnapshot(foreign, snapshotId)).toEqual({ ok: false, code: 'not_found' })
    const [job] = await admin`select id from import_jobs where tenant_id = ${tenantId} and kind = 'org_structure' limit 1`
    expect(await getOrgImport(foreign, job!.id as string)).toBeNull()
  })

  it('перенос ветки больше 20 узлов делает снимок pre_bulk_move', async () => {
    const big = await node('Велика гілка')
    for (let i = 0; i < 21; i++) await node(`Лист ${i}`, { parentId: big.id })
    const [{ n: before }] = await admin`select count(*)::int as n from org_structure_snapshots where tenant_id = ${tenantId} and kind = 'pre_bulk_move'` as unknown as { n: number }[]
    expect((await moveNode(ctx, big.id, { parentId: ids.r })).ok).toBe(true)
    const [{ n: after }] = await admin`select count(*)::int as n from org_structure_snapshots where tenant_id = ${tenantId} and kind = 'pre_bulk_move'` as unknown as { n: number }[]
    expect(after).toBe(before + 1)
  })
})

// ── Эскалация SLA по дереву (снимает фолбэк PR-19) ────────────────────────────────────────

describe('эскалация SLA вверх по дереву до ближайшего держателя, а не сразу администратору', () => {
  let upperNode: string
  let item: { tenantId: string, userId: string, assignedReviewerId: string | null }

  beforeAll(async () => {
    await cleanupTree()
    // Руководитель точки ученика — он же проверяющий: эскалация на себя не уходит (`37` §12).
    await admin`update locations set manager_id = ${people.mgr} where id = ${locationId}`
    const top = await node('Операційний директор', { isManagerPoint: true, headcountPlanned: 1 })
    const up = await node('Регіональний керуючий', { parentId: top.id, isManagerPoint: true, headcountPlanned: 1 })
    const own = await node('Керівник точки', { parentId: up.id, isManagerPoint: true, headcountPlanned: 1 })
    upperNode = up.id
    await assignUser(ctx, top.id, { userId: people.top, makeNamed: true })
    await assignUser(ctx, up.id, { userId: people.upper, makeNamed: true })
    await assignUser(ctx, own.id, { userId: people.mgr, makeNamed: true })
    item = { tenantId, userId: people.learner, assignedReviewerId: people.mgr }
  })

  it('флаг дерева выключен: руководитель точки — сам проверяющий → держатель узла над ним, source=tree', async () => {
    await setFlag(false)
    const t = await withTenant(tenantId, null, tx => escalationTarget(tx, item))
    expect(t).toEqual({ id: people.upper, source: 'tree' })
  })

  it('узел над ним вакантен — выше до ближайшего держателя', async () => {
    const [a] = await admin`select id from org_node_assignments where node_id = ${upperNode} and ended_at is null`
    await endAssignment(ctx, a!.id as string)
    const t = await withTenant(tenantId, null, tx => escalationTarget(tx, item))
    expect(t).toEqual({ id: people.top, source: 'tree' })
    await assignUser(ctx, upperNode, { userId: people.upper })
  })

  it('флаг включён, ученик в дереве под руководителем: цепочка та же — прямой руководитель, затем уровень выше', async () => {
    await setFlag(true)
    const [own] = await admin`select n.id from org_nodes n join org_node_assignments a on a.node_id = n.id where a.user_id = ${people.mgr} and a.ended_at is null`
    const cooks = await node('Кухарі точки', { parentId: own!.id as string, headcountPlanned: 5 })
    await assignUser(ctx, cooks.id, { userId: people.learner })
    expect(await withTenant(tenantId, null, tx => escalationTarget(tx, item))).toEqual({ id: people.upper, source: 'tree' })
    expect(await withTenant(tenantId, null, tx => escalationTarget(tx, { ...item, assignedReviewerId: people.w3 }))).toEqual({ id: people.mgr, source: 'manager' })
    await setFlag(false)
  })

  it('SLA-скан: эскалация на 150 % уходит держателю над руководителем, в журнале target=tree', async () => {
    const t0 = new Date(Date.now() - 73 * H)
    const sourceId = (await admin`select gen_random_uuid() as id`)[0]!.id as string
    const itemId = await withTenant(tenantId, adminId, tx => enqueueReview(tx, { tenantId, taskType: 'offline_confirm', sourceId, userId: people.learner, taskTitle: `${PREFIX}ескалація по дереву`, submittedAt: t0, slaHours: 48 }))
    await admin`update review_queue_items set assigned_reviewer_id = ${people.mgr} where id = ${itemId}`
    await reviewSlaScan(tenantId, new Date(t0.getTime() + 72 * H))
    const [q] = await admin`select status, escalated_to_id from review_queue_items where id = ${itemId}`
    expect(q).toMatchObject({ status: 'escalated', escalated_to_id: people.upper })
    const [ev] = await admin`select target_id, details from review_sla_events where queue_item_id = ${itemId} and event = 'escalated'`
    expect(ev!.target_id).toBe(people.upper)
    expect((ev!.details as { target: string }).target).toBe('tree')
  })

  it('выше в дереве никого — только тогда администратор тенанта', async () => {
    await cleanupTree()
    const t = await withTenant(tenantId, null, tx => escalationTarget(tx, item))
    expect(t).toEqual({ id: adminId, source: 'admin' })
  })
})
