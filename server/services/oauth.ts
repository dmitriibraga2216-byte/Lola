import { createHash, randomBytes } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { oauthStates, tenantSecrets } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'
import { SECRET_KEYS, disconnect as revokeSecrets, getSecret, markSecretResult, setSecret } from './secrets'

/**
 * OAuth-подключение провайдера к тенанту (docs/09 §9.2): state в БД, тенант из state,
 * access_type=offline + prompt=consent, храним только зашифрованный refresh_token.
 */

export type OAuthProvider = 'google' | 'zoom'

export interface ProviderDef {
  authUrl: string
  tokenUrl: string
  scopes: string[]
  extraAuthParams: Record<string, string>
  clientId: () => string | undefined
  clientSecret: () => string | undefined
  /** Кто подключился — для account_label. */
  whoAmI: (accessToken: string) => Promise<string>
}

export const PROVIDERS: Record<OAuthProvider, ProviderDef> = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/admin.directory.user.readonly'],
    extraAuthParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
    whoAmI: async (token) => {
      const r = await http('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${token}` } })
      const j = await r.json() as { email?: string }
      return j.email ?? 'google'
    },
  },
  zoom: {
    authUrl: 'https://zoom.us/oauth/authorize',
    tokenUrl: 'https://zoom.us/oauth/token',
    scopes: ['meeting:write', 'meeting:read', 'report:read:admin', 'user:read'],
    extraAuthParams: {},
    clientId: () => process.env.ZOOM_CLIENT_ID,
    clientSecret: () => process.env.ZOOM_CLIENT_SECRET,
    whoAmI: async (token) => {
      const r = await http('https://api.zoom.us/v2/users/me', { headers: { authorization: `Bearer ${token}` } })
      const j = await r.json() as { email?: string }
      return j.email ?? 'zoom'
    },
  },
}

// HTTP-клиент подменяется в тестах (setOAuthHttp): реального провайдера в CI нет
type Http = (url: string, init?: RequestInit) => Promise<Response>
let http: Http = (url, init) => fetch(url, init)
export function setOAuthHttp(fn: Http | null) { http = fn ?? ((url, init) => fetch(url, init)) }

export function isConfigured(provider: OAuthProvider): boolean {
  const d = PROVIDERS[provider]
  return !!(d.clientId() && d.clientSecret())
}

const STATE_TTL_MS = 10 * 60_000
const hash = (s: string) => createHash('sha256').update(s).digest('hex')

function redirectUri(provider: OAuthProvider): string {
  const base = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')
  return `${base}/api/v1/integrations/${provider}/callback`
}

/** Ссылка собирается сервером; state одноразовый, 10 минут, в БД. */
export async function authUrl(ctx: { tenantId: string, actorId: string | null }, provider: OAuthProvider, purpose: 'connect' | 'signin' = 'connect'): Promise<{ url: string } | { error: 'not_configured' }> {
  if (!isConfigured(provider)) return { error: 'not_configured' }
  const d = PROVIDERS[provider]
  const state = randomBytes(24).toString('base64url')
  await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    await tx.insert(oauthStates).values({ tenantId: ctx.tenantId, provider, stateHash: hash(state), purpose, createdBy: ctx.actorId, expiresAt: new Date(Date.now() + STATE_TTL_MS) })
  })
  const params = new URLSearchParams({ client_id: d.clientId()!, redirect_uri: redirectUri(provider), response_type: 'code', scope: d.scopes.join(' '), state, ...d.extraAuthParams })
  return { url: `${d.authUrl}?${params}` }
}

export type CallbackResult
  = | { ok: true, tenantId: string, provider: OAuthProvider, accountLabel: string, purpose: string, createdBy: string | null }
    | { ok: false, code: 'bad_state' | 'state_expired' | 'state_used' | 'provider_error' | 'no_refresh_token', message: string, tenantId?: string }

/** Колбек: тенант — из state (окно без cookie), state потребляется; обмен кода; refresh_token → зашифрованный секрет. */
export async function handleCallback(provider: OAuthProvider, query: { code?: string, state?: string, error?: string }): Promise<CallbackResult> {
  if (!query.state) return { ok: false, code: 'bad_state', message: 'Вхід не завершено: немає state' }
  const rows = await db.execute(sql`select * from oauth_state_lookup(${hash(query.state)})`) as unknown as { id: string, tenant_id: string, provider: string, purpose: string, created_by: string | null, expires_at: string, consumed_at: string | null }[]
  const st = rows[0]
  if (!st || st.provider !== provider) return { ok: false, code: 'bad_state', message: 'Вхід не завершено: невідомий state' }
  if (st.consumed_at) return { ok: false, code: 'state_used', message: 'Це посилання вже використано. Спробуйте підключити ще раз', tenantId: st.tenant_id }
  if (new Date(st.expires_at) < new Date()) return { ok: false, code: 'state_expired', message: 'Посилання застаріло (10 хвилин). Спробуйте ще раз', tenantId: st.tenant_id }
  await withTenant(st.tenant_id, null, tx => tx.update(oauthStates).set({ consumedAt: new Date() }).where(eq(oauthStates.id, st.id)))
  const ctx = { tenantId: st.tenant_id, actorId: st.created_by }

  if (query.error || !query.code) {
    await withTenant(ctx.tenantId, ctx.actorId, tx => recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'integration.oauth_denied', entity: 'tenant_secret', after: { provider, error: query.error ?? 'no_code' } }))
    return { ok: false, code: 'provider_error', message: query.error === 'access_denied' ? 'Доступ не надано' : 'Вхід не завершено: немає коду', tenantId: ctx.tenantId }
  }
  const d = PROVIDERS[provider]
  let tokens: { access_token?: string, refresh_token?: string, error?: string, error_description?: string }
  try {
    const body = new URLSearchParams({ code: query.code, client_id: d.clientId()!, client_secret: d.clientSecret()!, redirect_uri: redirectUri(provider), grant_type: 'authorization_code' })
    const r = await http(d.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(provider === 'zoom' ? { authorization: `Basic ${Buffer.from(`${d.clientId()}:${d.clientSecret()}`).toString('base64')}` } : {}) }, body })
    tokens = await r.json() as typeof tokens
  }
  catch (e) {
    return { ok: false, code: 'provider_error', message: `Провайдер не відповідає: ${(e as Error).message}`, tenantId: ctx.tenantId }
  }
  if (tokens.error || !tokens.access_token) return { ok: false, code: 'provider_error', message: tokens.error_description ?? tokens.error ?? 'Провайдер відхилив код', tenantId: ctx.tenantId }
  if (st.purpose === 'signin') {
    const email = await d.whoAmI(tokens.access_token)
    return { ok: true, tenantId: ctx.tenantId, provider, accountLabel: email, purpose: 'signin', createdBy: st.created_by }
  }
  if (!tokens.refresh_token) return { ok: false, code: 'no_refresh_token', message: 'Провайдер не видав refresh_token: відкличте доступ у налаштуваннях акаунта і підключіть знову', tenantId: ctx.tenantId }
  const email = await d.whoAmI(tokens.access_token).catch(() => provider)
  const keys = SECRET_KEYS[provider]
  await setSecret({ tenantId: ctx.tenantId, actorId: ctx.actorId ?? '' }, provider, keys.REFRESH_TOKEN, tokens.refresh_token, email)
  await setSecret({ tenantId: ctx.tenantId, actorId: ctx.actorId ?? '' }, provider, keys.ACCOUNT_EMAIL, email, email)
  await withTenant(ctx.tenantId, ctx.actorId, tx => recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'integration.oauth_connected', entity: 'tenant_secret', after: { provider, account: email } }))
  return { ok: true, tenantId: ctx.tenantId, provider, accountLabel: email, purpose: 'connect', createdBy: st.created_by }
}

/** Короткий токен каждый раз заново из refresh_token (docs/09: access_token не хранится). */
export async function accessToken(tenantId: string, provider: OAuthProvider): Promise<string | null> {
  const refresh = await getSecret(tenantId, provider, SECRET_KEYS[provider].REFRESH_TOKEN)
  if (!refresh) return null
  const d = PROVIDERS[provider]
  try {
    const body = new URLSearchParams({ refresh_token: refresh, client_id: d.clientId()!, client_secret: d.clientSecret()!, grant_type: 'refresh_token' })
    const r = await http(d.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(provider === 'zoom' ? { authorization: `Basic ${Buffer.from(`${d.clientId()}:${d.clientSecret()}`).toString('base64')}` } : {}) }, body })
    const j = await r.json() as { access_token?: string, error?: string, error_description?: string }
    if (!j.access_token) { await markSecretResult(tenantId, provider, false, j.error_description ?? j.error ?? 'refresh failed'); return null }
    await markSecretResult(tenantId, provider, true)
    return j.access_token
  }
  catch (e) {
    await markSecretResult(tenantId, provider, false, (e as Error).message)
    return null
  }
}

/** Вызов API провайдера с учётом состояния «мовчить» (docs/09 §9.3): ошибки копятся в last_error. */
export async function providerFetch(tenantId: string, provider: OAuthProvider, url: string, init: RequestInit = {}): Promise<{ ok: true, json: unknown } | { ok: false, error: string }> {
  const token = await accessToken(tenantId, provider)
  if (!token) return { ok: false, error: 'not_connected' }
  try {
    const r = await http(url, { ...init, headers: { ...(init.headers as Record<string, string> ?? {}), 'authorization': `Bearer ${token}`, 'content-type': 'application/json' } })
    const text = await r.text()
    const json = text ? JSON.parse(text) : null
    if (!r.ok) { await markSecretResult(tenantId, provider, false, `${r.status} ${text.slice(0, 200)}`); return { ok: false, error: `${r.status}` } }
    await markSecretResult(tenantId, provider, true)
    return { ok: true, json }
  }
  catch (e) {
    await markSecretResult(tenantId, provider, false, (e as Error).message)
    return { ok: false, error: (e as Error).message }
  }
}

/** Состояние для панели (docs/09 §9.3): «не налаштовано» ≠ «не підключено»; «мовчить» перебивает «працює». */
export async function oauthStatus(ctx: { tenantId: string, actorId: string }, provider: OAuthProvider) {
  const configured = isConfigured(provider)
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select({ key: tenantSecrets.key, accountLabel: tenantSecrets.accountLabel, status: tenantSecrets.status, lastOkAt: tenantSecrets.lastOkAt, lastError: tenantSecrets.lastError, updatedAt: tenantSecrets.updatedAt })
      .from(tenantSecrets).where(and(eq(tenantSecrets.provider, provider), sql`${tenantSecrets.status} <> 'revoked'`))
    const token = rows.find(r => r.key === SECRET_KEYS[provider].REFRESH_TOKEN)
    const state = !configured ? 'not_configured' : !token ? 'not_connected' : token.status === 'failing' ? 'failing' : 'connected'
    return { provider, configured, connected: !!token, state, accountLabel: rows.find(r => r.accountLabel)?.accountLabel ?? null, lastOkAt: token?.lastOkAt ?? null, lastError: token?.status === 'failing' ? token.lastError : null, connectedAt: token?.updatedAt ?? null }
  })
}

export async function oauthDisconnect(ctx: { tenantId: string, actorId: string }, provider: OAuthProvider) {
  await revokeSecrets(ctx, provider)
}

export function cleanupStates(): Promise<unknown> {
  return db.execute(sql`delete from oauth_states where expires_at < now() - interval '1 day'`)
}
