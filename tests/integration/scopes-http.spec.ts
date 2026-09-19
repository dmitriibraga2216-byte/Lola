import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Приёмка этапа 1 (docs/07-stages.md): «employee не открывает админку
 * ни по прямой ссылке, ни по API». Гоняется против собранного приложения
 * (.output), поэтому в CI build идёт до тестов; локально пропускается,
 * если сборки нет.
 */

const BUILT = existsSync('.output/server/index.mjs')
const PORT = 3789
const BASE = `http://127.0.0.1:${PORT}`

const ADMIN_PHONE = '+380661864742'
const EMPLOYEE_PHONE = '+380670000003' // Кухар Тестовий, роль employee

let server: ChildProcess | undefined

async function login(phone: string): Promise<string> {
  const reqRes = await fetch(`${BASE}/api/v1/auth/otp/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  })
  const reqBody = await reqRes.json() as { data: { devCode?: string } }
  if (!reqBody.data?.devCode) throw new Error(`Нет devCode для ${phone}: ${JSON.stringify(reqBody)}`)

  const verifyRes = await fetch(`${BASE}/api/v1/auth/otp/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code: reqBody.data.devCode }),
  })
  if (!verifyRes.ok) throw new Error(`verify ${phone} → ${verifyRes.status}`)
  const cookies = verifyRes.headers.getSetCookie()
  const sid = cookies.find(c => c.startsWith('lola_sid='))
  if (!sid) throw new Error('Нет cookie сессии')
  return sid.split(';')[0]!
}

describe.skipIf(!BUILT)('скоупы по HTTP: employee не проходит в админку', () => {
  beforeAll(async () => {
    // Сбросить rate-лимиты и старые коды между прогонами
    const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
    await admin`delete from rate_limits where key like ${'otp:%'}`
    await admin`delete from otp_codes where phone in (${ADMIN_PHONE}, ${EMPLOYEE_PHONE})`
    await admin.end()

    server = spawn('node', ['.output/server/index.mjs'], {
      env: {
        ...process.env,
        PORT: String(PORT),
        NITRO_PORT: String(PORT),
        OTP_DEBUG: '1',
        NUXT_DATABASE_URL: process.env.DATABASE_URL,
      },
      stdio: 'ignore',
    })

    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`${BASE}/health`)
        if (res.ok) return
      }
      catch { /* ещё поднимается */ }
      await new Promise(r => setTimeout(r, 500))
    }
    throw new Error('Собранное приложение не поднялось за 30 секунд')
  }, 60_000)

  afterAll(() => {
    server?.kill()
  })

  // Каждый тест логинится заново — сбрасываем лимит OTP, иначе шестой вход упирается в rate_limited
  beforeEach(async () => {
    const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
    await admin`delete from rate_limits where key like ${'otp:%'}`
    await admin.end()
  })

  it('без сессии — 401', async () => {
    const res = await fetch(`${BASE}/api/v1/people`)
    expect(res.status).toBe(401)
  })

  it('employee: люди, аудит, журнал безопасности, импорт — всё 403', async () => {
    const cookie = await login(EMPLOYEE_PHONE)
    for (const path of ['/api/v1/people', '/api/v1/audit', '/api/v1/security-log', '/api/v1/refs/cities']) {
      const res = await fetch(`${BASE}${path}`, { headers: { cookie } })
      expect(res.status, path).toBe(403)
    }
  })

  it('admin: список людей — 200 с данными', async () => {
    const cookie = await login(ADMIN_PHONE)
    const res = await fetch(`${BASE}/api/v1/people`, { headers: { cookie } })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: unknown[] }
    expect(body.data.length).toBeGreaterThan(0)
  })

  it('CLAUDE.md п. 14: сессия и журнал безопасности пишут единый request_context (ip, браузер)', async () => {
    const cookie = await login(ADMIN_PHONE)
    const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
    try {
      const [s] = await admin`select request_context from sessions where token_hash is not null order by created_at desc limit 1`
      const rc = s!.request_context as { ip?: string, userAgent?: string, browser?: string | null, device?: string | null } | null
      expect(rc, 'sessions.request_context').not.toBeNull()
      expect(rc!.ip).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/)
      expect(rc!.userAgent).toBeTruthy()
      expect(rc).toHaveProperty('device')
      const [sec] = await admin`select request_context from security_log where event like 'login%' order by created_at desc limit 1`
      expect((sec!.request_context as { ip?: string } | null)?.ip).toBeTruthy()
    }
    finally {
      await admin.end()
    }
    expect(cookie).toBeTruthy()
  })

  it('CLAUDE.md п. 15: файл чужого тенанта — 404, не 403', async () => {
    const cookie = await login(ADMIN_PHONE)
    const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
    try {
      const [other] = await admin`insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції') on conflict (slug) do update set name = excluded.name returning id`
      const [m] = await admin`insert into media_assets (tenant_id, key, original_name, kind, mime, bytes, status) values (${other!.id}, ${`${other!.id}/2026/09/foreign.jpg`}, 'foreign.jpg', 'image', 'image/jpeg', 10, 'ready') returning id`
      const res = await fetch(`${BASE}/api/v1/media/${m!.id}`, { headers: { cookie } })
      expect(res.status).toBe(404)
      const res2 = await fetch(`${BASE}/api/v1/media/${m!.id}?redirect=1`, { headers: { cookie }, redirect: 'manual' })
      expect(res2.status).toBe(404)
      await admin`delete from media_assets where id = ${m!.id}`
    }
    finally {
      await admin.end()
    }
  })

  it('мутация без CSRF-заголовка отклоняется', async () => {
    const cookie = await login(ADMIN_PHONE)
    const res = await fetch(`${BASE}/api/v1/people`, {
      method: 'POST',
      headers: { 'cookie': cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName: 'CSRF Тест' }),
    })
    expect(res.status).toBe(403)
  })
})
