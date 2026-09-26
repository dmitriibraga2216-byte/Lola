import type postgres from 'postgres'
import { totpAt } from '../../server/services/totp'

/**
 * Вход оператора по HTTP с обязательным вторым фактором (docs/25 §7 п. 8): пароль → промежуточная
 * сессия → подключение фактора → полная сессия. Фактор оператора перед входом сбрасывается прямо в
 * базе, чтобы каждый файл начинал с экрана подключения и не зависел от соседей. Файл с подчёркивания
 * не попадает под `**\/*.spec.ts`.
 */
export async function opsHttpLogin(o: {
  fetch: (url: string, init: { method?: string, headers?: Record<string, string>, body?: string }) => Promise<Response>
  base: string
  email: string
  password: string
  sql: postgres.Sql
  headers?: Record<string, string>
}): Promise<string> {
  await o.sql`update platform_admins set totp_secret_encrypted = null, totp_secret_nonce = null, totp_confirmed_at = null, totp_last_used_step = null, totp_pending_encrypted = null, totp_pending_nonce = null, totp_pending_created_at = null where email = ${o.email}`
  await o.sql`delete from rate_limits where key like ${'ops%'}`
  const h = { 'Content-Type': 'application/json', ...o.headers }
  const cookieOf = (r: Response) => r.headers.getSetCookie().map(c => c.split(';')[0]!).join('; ')
  const login = await o.fetch(`${o.base}/api/v1/platform/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: o.email, password: o.password }) })
  if (!login.ok) throw new Error(`ops login → ${login.status} ${await login.text()}`)
  const pending = cookieOf(login)
  const setup = await o.fetch(`${o.base}/api/v1/platform/two-factor/setup`, { method: 'POST', headers: { ...h, cookie: pending }, body: '{}' })
  if (!setup.ok) throw new Error(`ops 2fa setup → ${setup.status} ${await setup.text()}`)
  const { data } = await setup.json() as { data: { secret: string } }
  const confirm = await o.fetch(`${o.base}/api/v1/platform/two-factor/confirm`, { method: 'POST', headers: { ...h, cookie: pending }, body: JSON.stringify({ code: totpAt(data.secret, Date.now()) }) })
  if (!confirm.ok) throw new Error(`ops 2fa confirm → ${confirm.status} ${await confirm.text()}`)
  return cookieOf(confirm)
}
