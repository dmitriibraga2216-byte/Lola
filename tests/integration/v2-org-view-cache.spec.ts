import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Кэш витрины оргструктуры на 5 минут (docs/v2/32 §7 п. 7, docs/v2/44 Р-CC.6): повтор из кэша,
 * правка дерева видна сразу, скрытие человека — сразу, справочники — в пределах 5 минут,
 * тенанты не смешиваются. Свой тенант: общий «Каппі» чистят соседние спеки оргструктуры.
 */

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const { createNode, updateNode, assignUser } = await import('../../server/services/orgStructure')
const { listViewTreeCached, clearOrgViewCache, ORG_VIEW_CACHE_TTL_MS } = await import('../../server/services/orgTreeCache')

const SLUGS = ['orgcache-a', 'orgcache-b']
let tA: string, tB: string, adminA: string, adminB: string, holder: string
let ctxA: { tenantId: string, actorId: string }

interface N { title: string, positionName: string | null, holders: { userId: string }[], headcountActual: number, children: N[] }
const flat = (ns: unknown[]): N[] => (ns as N[]).flatMap(n => [n, ...flat(n.children)])

async function cleanup() {
  for (const slug of SLUGS) {
    const [t] = await admin`select id from tenants where slug = ${slug}`
    if (!t) continue
    await admin`delete from org_node_assignments where tenant_id = ${t.id}`
    await admin`delete from org_manager_map where tenant_id = ${t.id}`
    await admin`delete from org_conflicts where tenant_id = ${t.id}`
    for (let i = 0; i < 13 && (await admin`select 1 from org_nodes where tenant_id = ${t.id} limit 1`).length; i++) {
      await admin`delete from org_nodes where tenant_id = ${t.id} and id not in (select parent_id from org_nodes where parent_id is not null and tenant_id = ${t.id})`
    }
    await admin`delete from positions where tenant_id = ${t.id}`
    await admin`delete from users where tenant_id = ${t.id}`
    await admin`delete from tenants where id = ${t.id}`.catch(() => {})
  }
}

beforeAll(async () => {
  await cleanup()
  const mk = async (slug: string, phone: string) => {
    const [t] = await admin`insert into tenants (slug, name) values (${slug}, ${`Кеш ${slug}`}) returning id`
    const [u] = await admin`insert into users (tenant_id, phone, full_name, status, kind) values (${t!.id}, ${phone}, ${`Адмін ${slug}`}, 'invited', 'employee') returning id`
    return [t!.id as string, u!.id as string] as const
  }
  ;[tA, adminA] = await mk(SLUGS[0]!, '+380679388001')
  ;[tB, adminB] = await mk(SLUGS[1]!, '+380679388002')
  holder = (await admin`insert into users (tenant_id, phone, full_name, status, kind) values (${tA}, '+380679388003', 'Держатель Кешу', 'invited', 'employee') returning id`)[0]!.id as string
  ctxA = { tenantId: tA, actorId: adminA }
  clearOrgViewCache()
})

afterAll(async () => {
  clearOrgViewCache()
  await cleanup()
  await admin.end()
})

describe('Р-CC.6: кэш витрины оргструктуры', () => {
  let nodeId: string, positionId: string

  it('второй запрос — из кэша; правка узла видна сразу', async () => {
    const [p] = await admin`insert into positions (tenant_id, name) values (${tA}, 'Бариста') returning id`
    positionId = p!.id as string
    const r = await createNode(ctxA, { title: 'Кавʼярня', type: 'position', positionId })
    expect(r.ok).toBe(true)
    nodeId = (r as { node: { id: string } }).node.id
    const t0 = Date.now()
    const first = await listViewTreeCached(ctxA, {}, t0)
    expect(first.cached).toBe(false)
    const second = await listViewTreeCached(ctxA, {}, t0 + 1000)
    expect(second.cached).toBe(true)
    expect(second.nodes).toEqual(first.nodes)

    expect((await updateNode(ctxA, nodeId, { title: 'Кавʼярня центр', type: 'position', positionId })).ok).toBe(true)
    const after = await listViewTreeCached(ctxA, {}, t0 + 2000)
    expect(after.cached).toBe(false)
    expect(flat(after.nodes).map(n => n.title)).toContain('Кавʼярня центр')
  })

  it('привязка человека меняет отметку — витрина строится заново', async () => {
    const t0 = Date.now()
    await listViewTreeCached(ctxA, {}, t0)
    expect((await assignUser(ctxA, nodeId, { userId: holder, isPrimary: true })).ok).toBe(true)
    const v = await listViewTreeCached(ctxA, {}, t0 + 1000)
    expect(v.cached).toBe(false)
    expect(flat(v.nodes).find(n => n.title === 'Кавʼярня центр')!.holders.map(h => h.userId)).toEqual([holder])
  })

  it('скрытый человек пропадает из кэшированной витрины сразу', async () => {
    const t0 = Date.now()
    await listViewTreeCached(ctxA, {}, t0)
    await admin`update users set is_hidden = true where id = ${holder}`
    const v = await listViewTreeCached(ctxA, {}, t0 + 1000)
    expect(v.cached).toBe(true)
    const node = flat(v.nodes).find(n => n.title === 'Кавʼярня центр')!
    expect(node.holders).toEqual([])
    expect(node.headcountActual).toBe(0)
    await admin`update users set is_hidden = false where id = ${holder}`
    // кэш не испорчен вычёркиванием: вернувшийся человек снова в витрине
    const back = await listViewTreeCached(ctxA, {}, t0 + 2000)
    expect(flat(back.nodes).find(n => n.title === 'Кавʼярня центр')!.holders.map(h => h.userId)).toEqual([holder])
  })

  it('переименование должности — в пределах 5 минут, после — свежая витрина', async () => {
    const t0 = Date.now()
    clearOrgViewCache() // запись предыдущих проверок собрана по их «часам»
    await listViewTreeCached(ctxA, {}, t0)
    await admin`update positions set name = 'Старший бариста' where id = ${positionId}`
    const within = await listViewTreeCached(ctxA, {}, t0 + ORG_VIEW_CACHE_TTL_MS - 1000)
    expect(within.cached).toBe(true)
    expect(flat(within.nodes)[0]!.positionName).toBe('Бариста')
    const later = await listViewTreeCached(ctxA, {}, t0 + ORG_VIEW_CACHE_TTL_MS + 1)
    expect(later.cached).toBe(false)
    expect(flat(later.nodes)[0]!.positionName).toBe('Старший бариста')
  })

  it('флаги и тенанты — разные записи: чужой тенант не получает дерево «А»', async () => {
    const t0 = Date.now()
    await listViewTreeCached(ctxA, {}, t0)
    const archived = await listViewTreeCached(ctxA, { includeArchived: true }, t0 + 1)
    expect(archived.cached).toBe(false)
    const b = await listViewTreeCached({ tenantId: tB, actorId: adminB }, {}, t0 + 2)
    expect(b.cached).toBe(false)
    expect(b.nodes).toEqual([])
    expect(b.total).toBe(0)
  })
})
