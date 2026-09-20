import { touchSession, validateSession } from '../services/session'
import { TenantClosedError, tenantById, type ResolvedTenant } from '../services/tenantResolve'

export const SESSION_COOKIE = 'lola_sid'
export const CSRF_COOKIE = 'lola_csrf'
export const PLATFORM_COOKIE = 'lola_ops'

/**
 * Кладёт AuthContext в event.context.auth: из cookie сессии, либо из Bearer
 * (API-токен тенанта, docs/04 §4.1 — скоупы те же, actor = создатель токена).
 * Панель оператора — отдельная cookie и отдельный контекст.
 * Сессия обязана совпадать с тенантом из Host (docs/25 §16.1): чужая сессия на этом хосте — как её нет.
 * Приостановленный тенант — 403 `tenant_suspended` для сессий и API-токенов (docs/25 §8).
 */
async function assertTenantOpen(tenantId: string): Promise<void> {
  const t = await tenantById(tenantId)
  if (t && t.status !== 'active') throw new TenantClosedError()
}
export default defineEventHandler(async (event) => {
  if (!event.path.startsWith('/api/') && event.path !== '/ready') return

  if (event.path.startsWith('/api/v1/platform/')) {
    const ops = getCookie(event, PLATFORM_COOKIE)
    if (ops) {
      const { validatePlatformSession } = await import('../services/platform')
      event.context.platform = await validatePlatformSession(ops)
      // docs/25 §7 п. 5: каждый запрос панели — в platform_audit (кто, что, по какому тенанту); login/me/logout — не про тенантов
      if (event.context.platform && !/^\/api\/v1\/platform\/(me|login|logout)$/.test(event.path.split('?')[0]!)) {
        const { recordPlatformAudit } = await import('../services/platformTenants')
        const tenantId = event.path.match(/\/tenants\/([0-9a-f-]{36})/)?.[1] ?? null
        event.waitUntil(recordPlatformAudit(event.context.platform, { action: 'platform.request', tenantId, entity: 'request', entityId: `${event.method} ${event.path.split('?')[0]}` }).catch(err => console.error('platform_audit', err)))
      }
    }
    return
  }

  const bearer = getHeader(event, 'authorization')
  if (bearer?.startsWith('Bearer ')) {
    const { validateBearer } = await import('../services/apiTokens')
    const r = await validateBearer(bearer.slice(7).trim())
    if (!r.ok) {
      throw createError({ statusCode: r.code === 'rate_limited' ? 429 : 401, data: { code: r.code === 'rate_limited' ? 'rate_limited' : 'auth_required', message: r.code === 'rate_limited' ? 'Ліміт 60 запитів на хвилину' : 'Невірний токен' } })
    }
    const hostTenant = event.context.hostTenant as ResolvedTenant | undefined
    if (hostTenant && hostTenant.id !== r.auth.tenantId) throw createError({ statusCode: 401, data: { code: 'auth_required', message: 'Токен не належить цьому простору' } })
    await assertTenantOpen(r.auth.tenantId)
    event.context.auth = { sessionId: `token:${r.auth.tokenId}`, tenantId: r.auth.tenantId, userId: r.auth.actorId ?? '', impersonatedBy: null, activeRoleId: null }
    event.context.tokenScopes = r.auth.scopes
    return
  }

  const token = getCookie(event, SESSION_COOKIE)
  if (!token) return

  const auth = await validateSession(token)
  if (!auth) return

  const hostTenant = event.context.hostTenant as ResolvedTenant | undefined
  if (hostTenant && hostTenant.id !== auth.tenantId) return // сессия другого пространства на этом хосте не действует
  if (!event.path.startsWith('/api/v1/auth/logout')) await assertTenantOpen(auth.tenantId) // выйти из закрытого пространства можно

  event.context.auth = auth
  // Продление скользящее, не чаще раза в час — не блокируем ответ
  event.waitUntil(touchSession(auth).catch(() => {}))
})
