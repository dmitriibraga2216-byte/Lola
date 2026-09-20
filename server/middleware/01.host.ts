import { hostConfig, resolveTenantByHost, type ResolvedTenant } from '../services/tenantResolve'

/**
 * Резолв тенанта по `Host` — до сессии и до всего остального (docs/25 §16.1, docs/27 §27.3).
 * `<slug>.<TENANT_HOST_BASE>` → тенант в `event.context.hostTenant`; неизвестный поддомен — 404 без страницы входа
 * (список клиентов перебором не узнать). Хосты вне базы и `TENANT_HOST_DEFAULT` → тенант `NUXT_PUBLIC_DEFAULT_TENANT`.
 * Без `TENANT_HOST_BASE` резолв выключен (dev, тесты): тенант только из сессии.
 *
 * Не касается платформы (`/ops`, `/api/v1/platform`), служебных путей, статики и входящих вебхуков
 * (Telegram приходит на хост платформы, а не тенанта).
 */
const EXEMPT = ['/api/v1/platform/', '/ops', '/health', '/ready', '/metrics', '/_nuxt/', '/__nuxt', '/favicon', '/tg/', '/api/v1/telegram/', '/c/', '/api/_']

export default defineEventHandler(async (event) => {
  const cfg = hostConfig()
  if (!cfg.base) return
  const path = event.path.split('?')[0]!
  if (EXEMPT.some(p => path === p || path.startsWith(p) || path === p.replace(/\/$/, ''))) return
  const r = await resolveTenantByHost(getHeader(event, 'host'), cfg)
  if (!r) return
  if (!r.tenant) {
    throw createError({ statusCode: 404, data: { code: 'not_found', message: 'Простір не знайдено' } })
  }
  event.context.hostTenant = r.tenant satisfies ResolvedTenant
})
