import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Библиотека модулей по HTTP (PR-25 пакета `docs/v2`, образец — `v2-lifecycle-http.spec.ts`).
 *
 * Сервисный слой проверяет `v2-library.spec.ts`; здесь — то, что видно только снаружи: коды
 * ответа и форма тела ошибки (`docs/v2/31` §10), права скоупами на живых ролях после
 * миграции, и условие выхода PR-25 дословно — «удаление модуля, использованного в трёх
 * треках, даёт `409`». Критерии `31` §13: 3 (409 со списком трёх мест и предложением
 * архива), 4 (архивного модуля нет в палитре, места живы), 5 (наставник — предложение, а не
 * модуль), 9 (чужой тенант — 404, не 403).
 */
const BUILT = existsSync('.output/server/index.mjs')
const PORT = 3827
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN_PHONE = '+380661864742'
const AUTHOR_PHONE = '+380670000001'
const MENTOR_PHONE = '+380670000002'
const EMPLOYEE_PHONE = '+380670000003'
const P = 'v2-25-http '
const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

let server: ChildProcess | undefined
let tenantId: string
let otherTenantId: string
let adminId: string
let foreignModuleId: string
let resourceForNodes: string

async function login(phone: string): Promise<string> {
  const req = await fetch(`${BASE}/api/v1/auth/otp/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) })
  const body = await req.json() as { data: { devCode?: string } }
  if (!body.data?.devCode) throw new Error(`Нет devCode для ${phone}: ${JSON.stringify(body)}`)
  const ver = await fetch(`${BASE}/api/v1/auth/otp/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, code: body.data.devCode }) })
  if (!ver.ok) throw new Error(`verify ${phone} → ${ver.status}`)
  return ver.headers.getSetCookie().map(c => c.split(';')[0]!).join('; ')
}
const csrfOf = (cookie: string) => cookie.split('; ').find(c => c.startsWith('lola_csrf='))?.split('=')[1] ?? ''
const send = (cookie: string, method: string, path: string, body?: unknown) => fetch(`${BASE}/api/v1${path}`, {
  method,
  headers: { 'cookie': cookie, 'x-csrf-token': csrfOf(cookie), 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})
const data = async <T>(res: Response) => ((await res.json()) as { data: T }).data
const error = async (res: Response) => ((await res.json()) as { error: { code: string, message: string, details?: Record<string, unknown> } }).error

async function cleanup() {
  const tenants = [tenantId, otherTenantId]
  await admin`delete from library_module_usages where tenant_id in ${admin(tenants)}`
  await admin`delete from library_module_proposals where tenant_id in ${admin(tenants)}`
  await admin`update library_modules set current_version_id = null, draft_lesson_id = null where tenant_id in ${admin(tenants)}`
  await admin`update lessons set library_version_id = null where tenant_id in ${admin(tenants)} and library_version_id is not null`
  await admin`delete from library_module_versions where tenant_id in ${admin(tenants)}`
  await admin`delete from lessons where tenant_id in ${admin(tenants)} and library_module_id is not null`
  await admin`delete from library_modules where tenant_id in ${admin(tenants)}`
  await admin`delete from trajectories where tenant_id = ${tenantId} and title like ${`${P}%`}`
  await admin`delete from resources where tenant_id = ${tenantId} and (title like ${`${P}%`} or slug like 'library-v2-25-http%')`
  await admin`delete from notifications where tenant_id = ${tenantId} and code like 'library_%'`
}

/** Черновой трек с узлом-заданием — держатель места; автор трека — администратор. */
async function track(n: number) {
  const [t] = await admin`insert into trajectories (tenant_id, title, status, created_by) values (${tenantId}, ${`${P}Трек ${n}`}, 'draft', ${adminId}) returning id`
  const [node] = await admin`insert into trajectory_nodes (tenant_id, trajectory_id, kind, title, content_type, content_id)
    values (${tenantId}, ${t!.id}, 'task', 'Інструкція', 'resource', ${resourceForNodes}) returning id`
  return { trajectoryId: t!.id as string, nodeId: node!.id as string }
}

describe.skipIf(!BUILT)('Библиотека модулей по HTTP', () => {
  beforeAll(async () => {
    await admin`delete from rate_limits`
    await admin`delete from otp_codes`
    tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
    adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = ${ADMIN_PHONE}`)[0]!.id as string
    resourceForNodes = (await admin`select id from resources where tenant_id = ${tenantId} and status = 'published' order by created_at limit 1`)[0]!.id as string
    const [other] = await admin`insert into tenants (slug, name) values ('test-library-http', 'Тест бібліотеки HTTP')
      on conflict (slug) do update set name = excluded.name returning id`
    otherTenantId = other!.id as string
    await cleanup()
    // Тот же код модуля в чужом тенанте — критерий 9: «одинаковый slug», запрос по id
    const [foreign] = await admin`insert into library_modules (tenant_id, title, slug, owner_id, author_ids, created_by)
      values (${otherTenantId}, 'Чужий модуль', 'v2-25-http-shared', ${adminId}, ${[adminId]}, ${adminId}) returning id`
    foreignModuleId = foreign!.id as string

    server = spawn('node', ['.output/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), NITRO_PORT: String(PORT), OTP_DEBUG: '1', WORKER_ENABLED: '0', NUXT_DATABASE_URL: process.env.DATABASE_URL }, stdio: 'ignore' })
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${BASE}/health`)).ok) return }
      catch { /* ещё поднимается */ }
      await new Promise(r => setTimeout(r, 500))
    }
    throw new Error('Собранное приложение не поднялось за 30 секунд')
  }, 90_000)

  afterAll(async () => {
    server?.kill()
    await cleanup()
    await admin`delete from tenants where id = ${otherTenantId}`
    await admin.end()
  })

  beforeEach(async () => { await admin`delete from rate_limits` })
  afterEach(async () => { await admin`delete from rate_limits` })

  it('сотруднику библиотека не отдаётся — нет library.view (403 forbidden)', async () => {
    const emp = await login(EMPLOYEE_PHONE)
    const res = await send(emp, 'GET', '/library/modules')
    expect(res.status).toBe(403)
    expect((await error(res)).code).toBe('forbidden')
  })

  describe('модуль в трёх треках', () => {
    let author: string
    let moduleId: string

    beforeAll(async () => {
      author = await login(AUTHOR_PHONE)
      const created = await send(author, 'POST', '/library/modules', { title: `${P}Техніка безпеки`, body: [{ id: 'b1', type: 'text', html: '<p>Рукавички обовʼязкові</p>' }] })
      expect(created.status).toBe(200)
      moduleId = (await data<{ id: string }>(created)).id
    })

    it('версия без «Що змінилось» — 422 changelog_required; с ним — v1', async () => {
      const bad = await send(author, 'POST', `/library/modules/${moduleId}/versions`, { changelog: '' })
      expect(bad.status).toBe(422)
      expect((await error(bad)).code).toBe('changelog_required')
      const ok = await send(author, 'POST', `/library/modules/${moduleId}/versions`, { changelog: 'Перша версія' })
      expect(ok.status).toBe(200)
      expect((await data<{ version: { version: number } }>(ok)).version.version).toBe(1)
    })

    it('наставник с library.use не вставляет модуль в трек — 403 container.forbidden', async () => {
      const mentor = await login(MENTOR_PHONE)
      const t = await track(0)
      const res = await send(mentor, 'POST', '/library/usages', { libraryModuleId: moduleId, holderType: 'trajectory_node', holderId: t.nodeId, containerType: 'trajectory', containerId: t.trajectoryId })
      expect(res.status).toBe(403)
      expect((await error(res)).code).toBe('container.forbidden')
    })

    it('методист вставляет модуль в три трека; повтор в тот же узел — 409 already_attached', async () => {
      let last: { trajectoryId: string, nodeId: string } | null = null
      for (const n of [1, 2, 3]) {
        last = await track(n)
        const res = await send(author, 'POST', '/library/usages', { libraryModuleId: moduleId, holderType: 'trajectory_node', holderId: last.nodeId, containerType: 'trajectory', containerId: last.trajectoryId })
        expect(res.status).toBe(200)
        expect(await data<{ version: number, isStale: boolean }>(res)).toMatchObject({ version: 1, isStale: false })
      }
      const again = await send(author, 'POST', '/library/usages', { libraryModuleId: moduleId, holderType: 'trajectory_node', holderId: last!.nodeId, containerType: 'trajectory', containerId: last!.trajectoryId })
      expect(again.status).toBe(409)
      expect((await error(again)).code).toBe('already_attached')
    })

    it('условие выхода PR-25 и критерий 3: DELETE → 409 library_module.in_use со списком трёх мест, модуль цел', async () => {
      const adm = await login(ADMIN_PHONE)
      const res = await send(adm, 'DELETE', `/library/modules/${moduleId}`)
      expect(res.status).toBe(409)
      const err = await error(res)
      expect(err.code).toBe('library_module.in_use')
      expect(err.message).toContain('3')
      expect(err.details).toMatchObject({ reason: 'active_usages', total: 3, suggest: 'archive' })
      const titles = (err.details!.usages as { containerTitle: string }[]).map(u => u.containerTitle).sort()
      expect(titles).toEqual([1, 2, 3].map(n => `${P}Трек ${n}`))
      expect((await send(adm, 'GET', `/library/modules/${moduleId}`)).status).toBe(200)
    })

    it('методисту удалять нельзя вовсе — нет library.manage (403)', async () => {
      expect((await send(author, 'DELETE', `/library/modules/${moduleId}`)).status).toBe(403)
    })

    it('архив без причины — 422 reason_required; с причиной — archived', async () => {
      const bad = await send(author, 'POST', `/library/modules/${moduleId}/archive`, {})
      expect(bad.status).toBe(422)
      expect((await error(bad)).code).toBe('reason_required')
      const ok = await send(author, 'POST', `/library/modules/${moduleId}/archive`, { reason: 'Замінено новою інструкцією' })
      expect(ok.status).toBe(200)
      expect(await data<{ status: string }>(ok)).toMatchObject({ status: 'archived' })
    })

    it('критерий 4: в палитре архивного модуля нет, три места живы на своей версии', async () => {
      const palette = await data<{ items: { id: string }[] }>(await send(author, 'GET', '/library/modules?status=published&limit=100'))
      expect(palette.items.map(i => i.id)).not.toContain(moduleId)
      const usages = await data<{ active: { version: number }[] }>(await send(author, 'GET', `/library/modules/${moduleId}/usages`))
      expect(usages.active.map(u => u.version)).toEqual([1, 1, 1])
      const v1 = await send(author, 'GET', `/library/modules/${moduleId}/versions/1`)
      expect(v1.status).toBe(200)
      expect((await data<{ body: unknown[] }>(v1)).body).toHaveLength(1)
    })
  })

  it('критерий 5: наставник — 403 на модуль, но предложение pending; модулей не прибавилось', async () => {
    const mentor = await login(MENTOR_PHONE)
    const countModules = async () => Number((await admin`select count(*)::int as n from library_modules where tenant_id = ${tenantId}`)[0]!.n)
    const before = await countModules()
    const denied = await send(mentor, 'POST', '/library/modules', { title: `${P}Від наставника` })
    expect(denied.status).toBe(403)
    const [lesson] = await admin`select l.id from lessons l join modules m on m.id = l.module_id where l.tenant_id = ${tenantId} and l.item_type = 'resource' and l.library_version_id is null limit 1`
    const res = await send(mentor, 'POST', '/library/proposals', { sourceLessonId: lesson!.id, comment: 'Корисно для всіх точок' })
    expect(res.status).toBe(200)
    expect(await data<{ status: string }>(res)).toMatchObject({ status: 'pending' })
    const again = await send(mentor, 'POST', '/library/proposals', { sourceLessonId: lesson!.id, comment: 'Ще раз' })
    expect(again.status).toBe(409)
    expect((await error(again)).code).toBe('proposal_pending')
    expect(await countModules()).toBe(before)
  })

  it('критерий 9: модуль чужого тенанта — 404, не 403, ни одной операцией', async () => {
    const adm = await login(ADMIN_PHONE)
    for (const [method, path, body] of [
      ['GET', `/library/modules/${foreignModuleId}`, undefined],
      ['PATCH', `/library/modules/${foreignModuleId}`, { summary: 'Спроба' }],
      ['DELETE', `/library/modules/${foreignModuleId}`, undefined],
      ['POST', `/library/modules/${foreignModuleId}/archive`, { reason: 'Спроба чужого' }],
      ['GET', `/library/modules/${foreignModuleId}/usages`, undefined],
    ] as const) {
      const res = await send(adm, method, path, body)
      expect(res.status, `${method} ${path}`).toBe(404)
      expect((await error(res)).code).toBe('not_found')
    }
    const [row] = await admin`select title from library_modules where id = ${foreignModuleId}`
    expect(row!.title).toBe('Чужий модуль')
  })
})
