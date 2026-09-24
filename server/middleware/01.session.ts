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
/**
 * Что открыто промежуточной сессии двухфакторного входа (docs/24 §3.4, PR-39): экран второго
 * фактора и выход. Всё прочее — `401 two_factor_required`, и так для любой ручки: закрытие
 * здесь, а не в эндпоинтах, иначе каждая новая ручка должна была бы помнить про 2FA.
 */
const TWO_FACTOR_OPEN = ['/api/v1/auth/two-factor', '/api/v1/auth/logout']
export function openForPendingTwoFactor(path: string): boolean {
  const clean = path.split('?')[0]!
  return TWO_FACTOR_OPEN.some(p => clean === p || clean.startsWith(`${p}/`))
}

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
      // docs/25 §7 п. 5, долг «28» Spec 25 отк. (5): не каждый GET панели — только действия (не-GET)
      // и просмотр карточки конкретного тенанта (GET .../tenants/:id и .../tenants/:id/...); список
      // тенантов, планы, метрики, общий журнал — не пишутся, иначе журнал платформы захлёбывается
      // при росте числа операторов.
      const platformPath = event.path.split('?')[0]!
      const isTenantCardView = event.method === 'GET' && /^\/api\/v1\/platform\/tenants\/[0-9a-f-]{36}(\/|$)/.test(platformPath)
      if (event.context.platform && !/^\/api\/v1\/platform\/(me|login|logout)$/.test(platformPath) && (event.method !== 'GET' || isTenantCardView)) {
        const { recordPlatformAudit } = await import('../services/platformTenants')
        const tenantId = platformPath.match(/\/tenants\/([0-9a-f-]{36})/)?.[1] ?? null
        event.waitUntil(recordPlatformAudit(event.context.platform, { action: 'platform.request', tenantId, entity: 'request', entityId: `${event.method} ${platformPath}` }).catch(err => console.error('platform_audit', err)))
      }
    }
    return
  }

  const bearer = getHeader(event, 'authorization')
  if (bearer?.startsWith('Bearer ')) {
    const { validateBearer } = await import('../services/apiTokens')
    const r = await validateBearer(bearer.slice(7).trim())
    if (!r.ok) {
      // Ліміт — `tenant_limits.apiPerMinute` (докс/33 D-055), текст не називає число, бо воно може бути перевизначене тенанту
      throw createError({ statusCode: r.code === 'rate_limited' ? 429 : 401, data: { code: r.code === 'rate_limited' ? 'rate_limited' : 'auth_required', message: r.code === 'rate_limited' ? 'Перевищено ліміт запитів на хвилину' : 'Невірний токен' } })
    }
    const hostTenant = event.context.hostTenant as ResolvedTenant | undefined
    if (hostTenant && hostTenant.id !== r.auth.tenantId) throw createError({ statusCode: 401, data: { code: 'auth_required', message: 'Токен не належить цьому простору' } })
    await assertTenantOpen(r.auth.tenantId)
    event.context.auth = { sessionId: `token:${r.auth.tokenId}`, tenantId: r.auth.tenantId, userId: r.auth.actorId ?? '', impersonatedBy: null, activeRoleId: null, previewRoleId: null }
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

  // Второй фактор не пройден: сессия есть, но права — только на экран кода и выход
  if (auth.twoFactorPending && !openForPendingTwoFactor(event.path)) {
    if (!event.path.startsWith('/api/')) return
    throw createError({ statusCode: 401, data: { code: 'two_factor_required', message: 'Підтвердіть вхід кодом із застосунку-автентифікатора' } })
  }

  event.context.auth = auth
  // Продление скользящее, не чаще раза в час — не блокируем ответ
  event.waitUntil(touchSession(auth).catch(() => {}))
})
