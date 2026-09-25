import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Профили поставщика модели и журнал вызовов по HTTP (PR-27, образец — `v2-library-http.spec.ts`).
 * Сервисный слой проверяют `v2-ai-providers.spec.ts` и `v2-ai-gateway.spec.ts`; здесь — то, что
 * видно только снаружи: коды и тела ошибок `docs/v2/30` §10, скоуп `ai.audit` на живых ролях и
 * условие выхода PR-27 дословно — сохранить профиль расшифровки с неизвестным сроком хранения
 * у поставщика нельзя: `422 provider.retention_unknown` (сквозная проверка 18, `42` §5).
 */
const BUILT = existsSync('.output/server/index.mjs')
const PORT = 3829
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN_PHONE = '+380661864742'
const EMPLOYEE_PHONE = '+380670000003'
const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

let server: ChildProcess | undefined
let tenantId: string
let otherTenantId: string
let foreignId: string
let transcribeId: string
let originalRetention: string

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
const error = async (res: Response) => ((await res.json()) as { error: { code: string, message: string } }).error

describe.skipIf(!BUILT)('ИИ: профили и журнал по HTTP', () => {
  beforeAll(async () => {
    await admin`delete from rate_limits`
    await admin`delete from otp_codes`
    tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
    const [other] = await admin`insert into tenants (slug, name) values ('test-ai-http', 'Тест ШІ HTTP')
      on conflict (slug) do update set name = excluded.name returning id`
    otherTenantId = other!.id as string
    const [foreign] = await admin`insert into ai_providers (tenant_id, code, name, purpose, driver, model_name, provider_retention)
      values (${otherTenantId}, 'platform-generate', 'Чужий профіль', 'generate', 'stub', 'stub-v1', 'none')
      on conflict (tenant_id, code) do update set name = excluded.name returning id`
    foreignId = foreign!.id as string
    await admin`delete from ai_providers where tenant_id = ${tenantId} and code like 'pr27h-%'`

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
    if (transcribeId) await admin`update ai_providers set provider_retention = ${originalRetention} where id = ${transcribeId}`
    await admin`delete from ai_providers where tenant_id = ${tenantId} and code like 'pr27h-%'`
    await admin`delete from tenants where id = ${otherTenantId}`
    await admin.end()
  })

  beforeEach(async () => { await admin`delete from rate_limits` })

  it('сотруднику профили и журнал не отдаются — нет ai.audit (403 forbidden)', async () => {
    const emp = await login(EMPLOYEE_PHONE)
    for (const path of ['/ai/providers', '/ai/calls']) {
      const res = await send(emp, 'GET', path)
      expect(res.status, path).toBe(403)
      expect((await error(res)).code).toBe('forbidden')
    }
  })

  it('профиль расшифровки с неизвестным сроком хранения не сохраняется ни правкой, ни созданием (422)', async () => {
    const adm = await login(ADMIN_PHONE)
    const list = await send(adm, 'GET', '/ai/providers')
    expect(list.status).toBe(200)
    const items = ((await list.json()) as { data: { items: { id: string, purpose: string, providerRetention: string }[] } }).data.items
    const t = items.find(p => p.purpose === 'transcribe')!
    transcribeId = t.id
    originalRetention = t.providerRetention

    const put = await send(adm, 'PUT', `/ai/providers/${t.id}`, { providerRetention: 'unknown' })
    expect(put.status).toBe(422)
    const e = await error(put)
    expect(e.code).toBe('provider.retention_unknown')
    expect(e.message).toMatch(/розшифровки/)
    expect((await admin`select provider_retention from ai_providers where id = ${t.id}`)[0]!.provider_retention).toBe(originalRetention)

    const post = await send(adm, 'POST', '/ai/providers', { code: 'pr27h-voice', name: 'Голос', purpose: 'transcribe', driver: 'stub', modelName: 'stub-v1' })
    expect(post.status).toBe(422)
    expect((await error(post)).code).toBe('provider.retention_unknown')

    const ok = await send(adm, 'POST', '/ai/providers', { code: 'pr27h-voice', name: 'Голос', purpose: 'transcribe', driver: 'stub', modelName: 'stub-v1', providerRetention: 'none' })
    expect(ok.status).toBe(201)
  })

  it('чужой профиль — 404, не 403; журнал отдаётся страницей с курсором', async () => {
    const adm = await login(ADMIN_PHONE)
    expect((await send(adm, 'GET', `/ai/providers/${foreignId}`)).status).toBe(404)
    expect((await send(adm, 'PUT', `/ai/providers/${foreignId}`, { name: 'Захоплено' })).status).toBe(404)
    const calls = await send(adm, 'GET', '/ai/calls?limit=5')
    expect(calls.status).toBe(200)
    const body = (await calls.json()) as { data: { items: unknown[], nextCursor: string | null } }
    expect(Array.isArray(body.data.items)).toBe(true)
    expect((await send(adm, 'GET', '/ai/calls?cursor=not-a-cursor')).status).toBe(400)
  })
})
