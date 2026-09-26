import { eq } from 'drizzle-orm'
import { impersonateSchema } from '../../../../../../shared/schemas/settings'
import { requirePlatform } from '../../../../../utils/platformGuard'
import { impersonate, platformDb } from '../../../../../services/platform'
import { sealHandoff, tenantHostFor } from '../../../../../services/impersonationHandoff'
import { opsHostOf } from '../../../../../services/opsHost'
import { tenants } from '../../../../../db/schema'
import { apiData, apiError } from '../../../../../utils/apiResponse'
import { setSessionCookies } from '../../../../../utils/authCookies'

/**
 * Вход «от имени» (docs/24 §4.5): причина 10–500 знаков обязательна, сессия 60 минут, всё в журналах.
 * Без отдельного хоста консоли — cookie тенантской сессии ставится здесь же (как раньше). С `OPS_HOST`
 * cookie на хосте консоли бесполезна (host-only): ответ несёт одноразовую ссылку `handoffUrl` на хост
 * тенанта, который сам ставит свою cookie (`/impersonate/go`, docs/25 §7 п. 6).
 */
export default defineEventHandler(async (event) => {
  const actor = requirePlatform(event)
  const p = impersonateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Опишіть причину — це побачить клієнт у своєму журналі (10–500 символів)')
  const tenantId = getRouterParam(event, 'id')!
  if (opsHostOf()) {
    const [t] = await platformDb().select({ slug: tenants.slug, customDomain: tenants.customDomain }).from(tenants).where(eq(tenants.id, tenantId)).catch(() => [])
    const host = t ? tenantHostFor(t) : null
    if (!t) return apiError(event, 404, 'not_found', 'Тенант не знайдено')
    if (!host) return apiError(event, 409, 'impersonation.no_tenant_host', 'Не задано адресу простору (TENANT_HOST_BASE або власний домен) — вхід «від імені» з окремого хоста неможливий')
    const r = await impersonate(tenantId, p.data.userId, p.data.reason, actor)
    if (!r) return apiError(event, 404, 'not_found', 'Користувача не знайдено або неактивний')
    return apiData({ ok: true, expiresAt: r.expiresAt.toISOString(), handoffUrl: `https://${host}/impersonate/go?h=${encodeURIComponent(sealHandoff(r.token))}` })
  }
  const r = await impersonate(tenantId, p.data.userId, p.data.reason, actor)
  if (!r) return apiError(event, 404, 'not_found', 'Користувача не знайдено або неактивний')
  setSessionCookies(event, r.token)
  return apiData({ ok: true, expiresAt: r.expiresAt.toISOString(), handoffUrl: null })
})
