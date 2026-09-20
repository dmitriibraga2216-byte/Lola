import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Spec 17 по HTTP (docs/04 §4.10): траектория — создать → полотно → validate с понятными ошибками → publish;
 * правило с измерениями → preview/usages; employee — 403; чужой тенант — 404 (CLAUDE.md п. 15).
 * Гоняется против собранного приложения (.output), как scopes-http.spec.ts.
 */

const BUILT = existsSync('.output/server/index.mjs')
const PORT = 3792
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN_PHONE = '+380661864742'
const EMPLOYEE_PHONE = '+380670000003'

let server: ChildProcess | undefined
const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const stamp = Date.now()
const trajIds: string[] = []
const ruleIds: string[] = []
let foreignTrajectoryId: string | undefined
let otherTenantId: string | undefined

async function login(phone: string): Promise<string> {
  const reqRes = await fetch(`${BASE}/api/v1/auth/otp/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) })
  const reqBody = await reqRes.json() as { data: { devCode?: string } }
  if (!reqBody.data?.devCode) throw new Error(`Нет devCode для ${phone}: ${JSON.stringify(reqBody)}`)
  const verifyRes = await fetch(`${BASE}/api/v1/auth/otp/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, code: reqBody.data.devCode }) })
  if (!verifyRes.ok) throw new Error(`verify ${phone} → ${verifyRes.status}`)
  const jar = verifyRes.headers.getSetCookie().map(c => c.split(';')[0]!)
  if (!jar.some(c => c.startsWith('lola_sid='))) throw new Error('Нет cookie сессии')
  return jar.join('; ')
}
const csrfOf = (cookie: string) => cookie.split('; ').find(c => c.startsWith('lola_csrf='))?.split('=')[1] ?? ''
const json = (cookie: string, method: string, body?: unknown) => ({
  method,
  headers: { 'cookie': cookie, 'x-csrf-token': csrfOf(cookie), 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})
const data = async <T>(res: Response) => ((await res.json()) as { data: T }).data

describe.skipIf(!BUILT)('Spec 17 по HTTP', () => {
  beforeAll(async () => {
    await admin`delete from rate_limits where key like ${'otp:%'}`
    await admin`delete from otp_codes where phone in (${ADMIN_PHONE}, ${EMPLOYEE_PHONE})`
    const [other] = await admin`insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції') on conflict (slug) do update set name = excluded.name returning id`
    otherTenantId = other!.id as string
    const [t] = await admin`insert into trajectories (tenant_id, title, status) values (${otherTenantId}, ${`Чужа траєкторія ${stamp}`}, 'published') returning id`
    foreignTrajectoryId = t!.id as string

    server = spawn('node', ['.output/server/index.mjs'], {
      env: { ...process.env, PORT: String(PORT), NITRO_PORT: String(PORT), OTP_DEBUG: '1', NUXT_DATABASE_URL: process.env.DATABASE_URL },
      stdio: 'ignore',
    })
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${BASE}/health`)).ok) return
      }
      catch { /* ещё поднимается */ }
      await new Promise(r => setTimeout(r, 500))
    }
    throw new Error('Собранное приложение не поднялось за 30 секунд')
  }, 60_000)

  afterAll(async () => {
    server?.kill()
    if (trajIds.length) await admin`delete from trajectories where id in ${admin(trajIds)}`
    if (ruleIds.length) await admin`delete from automation_rules where id in ${admin(ruleIds)}`
    if (foreignTrajectoryId) await admin`delete from trajectories where id = ${foreignTrajectoryId}`
    await admin.end()
  })

  beforeEach(async () => {
    await admin`delete from rate_limits where key like ${'otp:%'}`
  })

  it('employee: траектории и правила — 403; свои траектории — 200', async () => {
    const cookie = await login(EMPLOYEE_PHONE)
    expect((await fetch(`${BASE}/api/v1/trajectories`, { headers: { cookie } })).status).toBe(403)
    expect((await fetch(`${BASE}/api/v1/trajectories`, json(cookie, 'POST', { title: 'Спроба' }))).status).toBe(403)
    expect((await fetch(`${BASE}/api/v1/automation-rules/preview`, json(cookie, 'POST', { dimensions: [] }))).status).toBe(403)
    expect((await fetch(`${BASE}/api/v1/me/trajectories`, { headers: { cookie } })).status).toBe(200)
    expect((await fetch(`${BASE}/api/v1/me/trajectories/catalog`, { headers: { cookie } })).status).toBe(200)
  })

  it('admin: создать → полотно → validate объясняет ошибки → publish; чужой тенант — 404', async () => {
    const cookie = await login(ADMIN_PHONE)
    const bad = await fetch(`${BASE}/api/v1/trajectories`, json(cookie, 'POST', { title: 'ab' }))
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { message: string } }).error.message).toBe('Назва від 3 символів')

    const create = await fetch(`${BASE}/api/v1/trajectories`, json(cookie, 'POST', { title: `HTTP s17-${stamp}`, tags: [] }))
    expect(create.status).toBe(200)
    const t = await data<{ id: string, status: string, assignMode: string }>(create)
    trajIds.push(t.id)
    expect(t).toMatchObject({ status: 'draft', assignMode: 'manual' })

    // Start и Finish созданы автоматически
    const g0 = await data<{ nodes: { id: string, kind: string }[] }>(await fetch(`${BASE}/api/v1/trajectories/${t.id}/graph`, { headers: { cookie } }))
    expect(g0.nodes.map(n => n.kind).sort()).toEqual(['finish', 'start'])
    const start = g0.nodes.find(n => n.kind === 'start')!.id, finish = g0.nodes.find(n => n.kind === 'finish')!.id

    // Полотно без завдань, «І» с одним входом: validate — понятные ошибки с nodeId
    const put = await fetch(`${BASE}/api/v1/trajectories/${t.id}/graph`, json(cookie, 'PUT', {
      nodes: [{ id: start, kind: 'start', x: 0, y: 0 }, { id: finish, kind: 'finish', x: 500, y: 0 }, { tmpId: 'tmp:and', kind: 'and', title: 'І', x: 200, y: 0 }],
      edges: [{ fromNodeId: start, toNodeId: 'tmp:and' }, { fromNodeId: 'tmp:and', toNodeId: finish }],
    }))
    expect(put.status).toBe(200)
    const g1 = await data<{ ids: Record<string, string>, problems: { code: string, nodeId?: string, message: string }[] }>(put)
    expect(g1.ids['tmp:and']).toMatch(/^[0-9a-f-]{36}$/)
    const v = await data<{ ok: boolean, problems: { code: string, nodeId?: string, message: string }[] }>(await fetch(`${BASE}/api/v1/trajectories/${t.id}/validate`, json(cookie, 'POST', {})))
    expect(v.ok).toBe(false)
    expect(v.problems.map(p => p.code)).toEqual(expect.arrayContaining(['no_tasks', 'and_single_input']))
    expect(v.problems.find(p => p.code === 'and_single_input')).toMatchObject({ nodeId: g1.ids['tmp:and'] })
    expect(v.problems.find(p => p.code === 'and_single_input')!.message).toContain('додайте')

    const pub = await fetch(`${BASE}/api/v1/trajectories/${t.id}/publish`, json(cookie, 'POST', {}))
    expect(pub.status).toBe(422)
    const err = ((await pub.json()) as { error: { code: string, details?: { problems: unknown[] } } }).error
    expect(err.code).toBe('trajectory.invalid')

    // Узел с недопустимым кодом — 400 от zod
    const badNode = await fetch(`${BASE}/api/v1/trajectories/${t.id}/graph`, json(cookie, 'PUT', { nodes: [{ kind: 'loop', x: 0, y: 0 }], edges: [] }))
    expect(badNode.status).toBe(400)

    // Режим automation без правила — 422
    const noRule = await fetch(`${BASE}/api/v1/trajectories/${t.id}`, json(cookie, 'PATCH', { assignMode: 'automation' }))
    expect(noRule.status).toBe(422)
    expect(((await noRule.json()) as { error: { code: string } }).error.code).toBe('trajectory.rule_required')

    // Чужой тенант — 404 везде
    for (const path of [`/trajectories/${foreignTrajectoryId}`, `/trajectories/${foreignTrajectoryId}/graph`, `/trajectories/${foreignTrajectoryId}/usages`, `/trajectories/${foreignTrajectoryId}/audience`]) {
      expect((await fetch(`${BASE}/api/v1${path}`, { headers: { cookie } })).status, path).toBe(404)
    }
    expect((await fetch(`${BASE}/api/v1/trajectories/${foreignTrajectoryId}`, json(cookie, 'PATCH', { title: 'Перехоплення' }))).status).toBe(404)
    expect((await fetch(`${BASE}/api/v1/trajectories/${foreignTrajectoryId}/validate`, json(cookie, 'POST', {}))).status).toBe(404)
    expect((await fetch(`${BASE}/api/v1/trajectories/${foreignTrajectoryId}/publish`, json(cookie, 'POST', {}))).status).toBe(404)
    expect((await fetch(`${BASE}/api/v1/me/trajectories/${foreignTrajectoryId}`, { headers: { cookie } })).status).toBe(404)
    expect((await fetch(`${BASE}/api/v1/me/trajectories/catalog/${foreignTrajectoryId}/enroll`, json(cookie, 'POST', {}))).status).toBe(404)
  })

  it('правило: измерения таблицей, preview по форме и по правилу, usages, удаление занятого — 409', async () => {
    const cookie = await login(ADMIN_PHONE)
    const positions = await data<{ id: string, name: string }[]>(await fetch(`${BASE}/api/v1/refs/positions`, { headers: { cookie } }))
    const pos = positions[0]!
    const badDim = await fetch(`${BASE}/api/v1/automation-rules/preview`, json(cookie, 'POST', { dimensions: [{ dimension: 'position', mode: 'include', valueIds: [] }] }))
    expect(badDim.status).toBe(400) // «Тільки ці» без значений
    const pv = await data<{ count: number, people: { id: string }[] }>(await fetch(`${BASE}/api/v1/automation-rules/preview`, json(cookie, 'POST', { dimensions: [{ dimension: 'position', mode: 'include', valueIds: [pos.id] }] })))
    expect(pv.count).toBe(pv.people.length)

    const create = await fetch(`${BASE}/api/v1/automation-rules`, json(cookie, 'POST', {
      name: `HTTP правило ${stamp}`, trigger: 'user.activated', assignDelayDays: 7,
      dimensions: [{ dimension: 'position', mode: 'include', valueIds: [pos.id] }, { dimension: 'city', mode: 'exclude', valueIds: [crypto.randomUUID()] }],
    }))
    expect(create.status).toBe(200)
    const rule = await data<{ id: string }>(create)
    ruleIds.push(rule.id)
    const got = await data<{ dimensions: { dimension: string, mode: string, values: { name: string }[] }[], usedBy: unknown[], assignDelayDays: number }>(await fetch(`${BASE}/api/v1/automation-rules/${rule.id}`, { headers: { cookie } }))
    expect(got.assignDelayDays).toBe(7)
    expect(got.dimensions.map(d => d.dimension)).toEqual(['city', 'position', 'org_unit', 'tag'])
    expect(got.dimensions.find(d => d.dimension === 'position')).toMatchObject({ mode: 'include', values: [{ name: pos.name }] })
    expect(got.dimensions.find(d => d.dimension === 'tag')!.mode).toBe('any')
    expect(got.usedBy).toEqual([])
    const pv2 = await data<{ count: number }>(await fetch(`${BASE}/api/v1/automation-rules/${rule.id}/preview`, { headers: { cookie } }))
    expect(pv2.count).toBe(pv.count)

    // Привязать к траектории → usages, удаление — 409 in_use
    const t = await data<{ id: string }>(await fetch(`${BASE}/api/v1/trajectories`, json(cookie, 'POST', { title: `HTTP s17 auto-${stamp}`, tags: [] })))
    trajIds.push(t.id)
    const link = await fetch(`${BASE}/api/v1/trajectories/${t.id}`, json(cookie, 'PATCH', { assignMode: 'automation', automationRuleId: rule.id }))
    expect(link.status).toBe(200)
    const usages = await data<{ kind: string, id: string }[]>(await fetch(`${BASE}/api/v1/automation-rules/${rule.id}/usages`, { headers: { cookie } }))
    expect(usages).toEqual([{ kind: 'trajectory', id: t.id, title: `HTTP s17 auto-${stamp}` }])
    expect((await fetch(`${BASE}/api/v1/automation-rules/${rule.id}`, json(cookie, 'DELETE'))).status).toBe(409)
    expect((await fetch(`${BASE}/api/v1/automation-rules/${crypto.randomUUID()}/preview`, { headers: { cookie } })).status).toBe(404)
  })
})
