import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * `Idempotency-Key` (docs/04 §4.1, docs/v2/44 §18 Р-CC.3): повтор мутации с тем же ключом
 * отдаёт сохранённый ответ и не выполняет её второй раз; ключ — в пространстве «тенант ×
 * человек», живёт 24 часа; 5xx и исключение освобождают ключ.
 *
 * Авто-импорты Nitro (`getRequestHeader`, `readBody`, …) в vitest не подключены — обёртка
 * проверяется на минимальном событии с теми же функциями поверх простого объекта.
 */

interface FakeEvent { method: string, path: string, headers: Record<string, string>, body: unknown, status: number, out: Record<string, string>, parts?: { name: string, filename?: string, type?: string, data: Buffer }[] }
const g = globalThis as unknown as Record<string, unknown>
g.getRequestHeader = (e: FakeEvent, n: string) => e.headers[n.toLowerCase()]
g.readBody = async (e: FakeEvent) => e.body
g.readMultipartFormData = async (e: FakeEvent) => e.parts
g.setResponseStatus = (e: FakeEvent, s: number) => { e.status = s }
g.getResponseStatus = (e: FakeEvent) => e.status
g.setResponseHeader = (e: FakeEvent, k: string, v: string) => { e.out[k] = v }

const { idempotent } = await import('../../server/utils/idempotency')
const S = await import('../../server/services/idempotency')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
let tenantId: string, adminId: string, otherUserId: string, otherTenantId: string, otherTenantUserId: string
const PREFIX = 'idem-test-'

const ev = (key: string | undefined, body: unknown = { a: 1 }, path = '/api/v1/learning/quizzes/q/attempts'): FakeEvent =>
  ({ method: 'POST', path, headers: key === undefined ? {} : { 'idempotency-key': key }, body, status: 200, out: {} })

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  otherUserId = (await admin`select id from users where tenant_id = ${tenantId} and id <> ${adminId} and kind = 'employee' limit 1`)[0]!.id as string
  const [o] = await admin`insert into tenants (slug, name) values ('idem-other', 'Idem: інший') on conflict (slug) do update set name = excluded.name returning id`
  otherTenantId = o!.id as string
  const [u] = await admin`insert into users (tenant_id, phone, full_name, status, kind) values (${otherTenantId}, '+380679399001', 'Idem Інший', 'active', 'employee') on conflict do nothing returning id`
  otherTenantUserId = (u ?? (await admin`select id from users where phone = '+380679399001'`)[0])!.id as string
  await admin`delete from idempotency_keys where key like ${`${PREFIX}%`}`
})

afterAll(async () => {
  await admin`delete from idempotency_keys where key like ${`${PREFIX}%`}`
  await admin`delete from users where tenant_id = ${otherTenantId}`
  await admin`delete from tenants where id = ${otherTenantId}`
  await admin.end()
})

describe('Р-CC.3: Idempotency-Key', () => {
  const me = () => ({ tenantId, userId: adminId })

  it('без заголовка — обычное выполнение каждый раз, ключи не пишутся', async () => {
    let n = 0
    await idempotent(ev(undefined) as never, me(), async () => ({ data: ++n }))
    await idempotent(ev(undefined) as never, me(), async () => ({ data: ++n }))
    expect(n).toBe(2)
  })

  it('повтор с тем же ключом — сохранённый ответ и статус, действие один раз', async () => {
    let n = 0
    const fn = async () => ({ data: { attemptId: `a${++n}` } })
    const e1 = ev(`${PREFIX}same`)
    const r1 = await idempotent(e1 as never, me(), fn)
    const e2 = ev(`${PREFIX}same`, { a: 1 })
    const r2 = await idempotent(e2 as never, me(), fn)
    expect(n).toBe(1)
    expect(r2).toEqual(r1)
    expect(e2.out['Idempotent-Replayed']).toBe('true')
    expect(e2.status).toBe(200)
  })

  it('отказ 4xx тоже сохраняется и повторяется как есть', async () => {
    let n = 0
    const fn = async (e: FakeEvent) => { n++; e.status = 422; return { error: { code: 'quiz.attempts_exhausted', message: 'x' } } }
    const e1 = ev(`${PREFIX}422`)
    await idempotent(e1 as never, me(), () => fn(e1))
    const e2 = ev(`${PREFIX}422`)
    const r2 = await idempotent(e2 as never, me(), () => fn(e2))
    expect(n).toBe(1)
    expect(e2.status).toBe(422)
    expect(r2).toMatchObject({ error: { code: 'quiz.attempts_exhausted' } })
  })

  it('тот же ключ с другим телом или путём — 422 idempotency.key_reused; порядок полей тела не важен', async () => {
    await idempotent(ev(`${PREFIX}fp`, { a: 1, b: 2 }) as never, me(), async () => ({ data: 1 }))
    const same = ev(`${PREFIX}fp`, { b: 2, a: 1 })
    await idempotent(same as never, me(), async () => ({ data: 2 }))
    expect(same.out['Idempotent-Replayed']).toBe('true')
    const other = ev(`${PREFIX}fp`, { a: 2, b: 2 })
    expect(await idempotent(other as never, me(), async () => ({ data: 3 }))).toMatchObject({ error: { code: 'idempotency.key_reused' } })
    expect(other.status).toBe(422)
    const otherPath = ev(`${PREFIX}fp`, { a: 1, b: 2 }, '/api/v1/learning/resources/r/complete')
    expect(await idempotent(otherPath as never, me(), async () => ({ data: 4 }))).toMatchObject({ error: { code: 'idempotency.key_reused' } })
  })

  it('пока первый запрос выполняется — 409 idempotency.in_progress', async () => {
    let release!: () => void
    const slow = new Promise<void>((r) => { release = r })
    const first = idempotent(ev(`${PREFIX}slow`) as never, me(), async () => { await slow; return { data: 'ok' } })
    await new Promise(r => setTimeout(r, 100))
    const e2 = ev(`${PREFIX}slow`)
    expect(await idempotent(e2 as never, me(), async () => ({ data: 'twice' }))).toMatchObject({ error: { code: 'idempotency.in_progress' } })
    expect(e2.status).toBe(409)
    release()
    expect(await first).toEqual({ data: 'ok' })
  })

  it('исключение и 5xx освобождают ключ — повтор выполняется заново', async () => {
    await expect(idempotent(ev(`${PREFIX}throw`) as never, me(), async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await idempotent(ev(`${PREFIX}throw`) as never, me(), async () => ({ data: 'second' }))).toEqual({ data: 'second' })
    const e5 = ev(`${PREFIX}500`)
    await idempotent(e5 as never, me(), async () => { e5.status = 503; return { error: { code: 'internal', message: 'x' } } })
    let n = 0
    await idempotent(ev(`${PREFIX}500`) as never, me(), async () => ({ data: ++n }))
    expect(n).toBe(1)
  })

  it('ключ — свой у человека и тенанта: тот же текст у другого не повторяет чужой ответ', async () => {
    await idempotent(ev(`${PREFIX}shared`) as never, me(), async () => ({ data: 'admin' }))
    expect(await idempotent(ev(`${PREFIX}shared`) as never, { tenantId, userId: otherUserId }, async () => ({ data: 'colleague' }))).toEqual({ data: 'colleague' })
    expect(await idempotent(ev(`${PREFIX}shared`) as never, { tenantId: otherTenantId, userId: otherTenantUserId }, async () => ({ data: 'other' }))).toEqual({ data: 'other' })
    // RLS: из другого тенанта ключи «Каппі» не видны вовсе
    const { withTenant } = await import('../../server/utils/withTenant')
    const { idempotencyKeys } = await import('../../server/db/schema')
    const seen = await withTenant(otherTenantId, otherTenantUserId, tx => tx.select().from(idempotencyKeys))
    expect(seen.every(r => r.tenantId === otherTenantId)).toBe(true)
  })

  it('некорректный ключ — 400 idempotency.key_invalid, действие не выполняется', async () => {
    let n = 0
    for (const bad of ['', 'з пробілом', 'кирилиця', 'x'.repeat(256)]) {
      const e = ev(bad)
      expect(await idempotent(e as never, me(), async () => ({ data: ++n }))).toMatchObject({ error: { code: 'idempotency.key_invalid' } })
      expect(e.status).toBe(400)
    }
    expect(n).toBe(0)
  })

  it('через 24 часа ключ истекает: повтор выполняется заново, уборка удаляет истёкшие своего тенанта', async () => {
    await idempotent(ev(`${PREFIX}old`) as never, me(), async () => ({ data: 1 }))
    await admin`update idempotency_keys set expires_at = now() - interval '1 minute' where key = ${`${PREFIX}old`}`
    let n = 0
    await idempotent(ev(`${PREFIX}old`) as never, me(), async () => ({ data: ++n }))
    expect(n).toBe(1)
    await admin`update idempotency_keys set expires_at = now() - interval '1 minute' where key in (${`${PREFIX}old`}, ${`${PREFIX}same`})`
    expect(await S.purgeIdempotencyKeys(tenantId)).toBeGreaterThanOrEqual(2)
    expect((await admin`select count(*)::int as n from idempotency_keys where key in (${`${PREFIX}old`}, ${`${PREFIX}same`})`)[0]!.n).toBe(0)
    const [{ ttl }] = await admin`select extract(epoch from expires_at - created_at)::int as ttl from idempotency_keys where key = ${`${PREFIX}fp`}` as unknown as [{ ttl: number }]
    expect(Math.abs(ttl - 86_400)).toBeLessThan(5)
  })

  it('Р-CC.5: required — без заголовка 400 idempotency.key_required, действие не выполняется', async () => {
    let n = 0
    const e = ev(undefined)
    expect(await idempotent(e as never, me(), async () => ({ data: ++n }), { required: true })).toMatchObject({ error: { code: 'idempotency.key_required' } })
    expect(e.status).toBe(400)
    expect(n).toBe(0)
    expect(await idempotent(ev(`${PREFIX}req`) as never, me(), async () => ({ data: ++n }), { required: true })).toEqual({ data: 1 })
  })

  it('Р-CC.5: multipart — отпечаток по частям: тот же файл с новой границей — повтор, другой файл — key_reused', async () => {
    const mp = (data: string): FakeEvent => ({
      ...ev(`${PREFIX}csv`, `--b${Math.random()}\r\n…`, '/api/v1/org-structure/import'),
      headers: { 'idempotency-key': `${PREFIX}csv`, 'content-type': `multipart/form-data; boundary=b${Math.random()}` },
      parts: [{ name: 'file', filename: 'org.csv', type: 'text/csv', data: Buffer.from(data) }],
    })
    let n = 0
    await idempotent(mp('a;b\n1;2') as never, me(), async () => ({ data: ++n }))
    const again = mp('a;b\n1;2')
    expect(await idempotent(again as never, me(), async () => ({ data: ++n }))).toEqual({ data: 1 })
    expect(again.out['Idempotent-Replayed']).toBe('true')
    expect(await idempotent(mp('a;b\n3;4') as never, me(), async () => ({ data: ++n }))).toMatchObject({ error: { code: 'idempotency.key_reused' } })
    expect(n).toBe(1)
  })

  it('Р-CC.5: создание узла оргструктуры с тем же ключом — один узел, повтор получает тот же', async () => {
    const { createNode } = await import('../../server/services/orgStructure')
    const title = `${PREFIX}вузол-${Date.now()}`
    const ctx = { tenantId, actorId: adminId }
    const run = () => {
      const e = ev(`${PREFIX}node`, { title }, '/api/v1/org-structure/nodes')
      return idempotent(e as never, me(), async () => {
        const r = await createNode(ctx, { title, type: 'position' })
        return r.ok ? { data: r.node } : { error: { code: r.code } }
      })
    }
    const first = await run() as { data: { id: string } }
    const second = await run() as { data: { id: string } }
    expect(second.data.id).toBe(first.data.id)
    expect((await admin`select count(*)::int as n from org_nodes where title = ${title}`)[0]!.n).toBe(1)
    await admin`delete from audit_log where entity_id = ${first.data.id}`.catch(() => {})
    await admin`delete from org_nodes where id = ${first.data.id}`
  })
})
