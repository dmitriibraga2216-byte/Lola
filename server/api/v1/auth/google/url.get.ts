import { z } from 'zod'
import { authUrl, isConfigured } from '../../../../services/oauth'
import { db } from '../../../../db/client'
import { tenants } from '../../../../db/schema'
import { eq } from 'drizzle-orm'
import { hostTenantIdOf } from '../../../../utils/authCookies'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * Вход через Google (docs/09 §9.1, докс/33 D-059): ссылка от сервера, state привязан к тенанту.
 * Тенант — из `Host` (`01.host`, свій домен або `<slug>.<base>`), если резолв по хосту включён;
 * `?tenant=` — только фолбек (dev без `TENANT_HOST_BASE`, стенд с общим хостом на несколько
 * тенантів). Так вибір простору для входу не залежить від параметра, який шле клієнт.
 */
export default defineEventHandler(async (event) => {
  if (!isConfigured('google')) return apiError(event, 409, 'not_configured', 'Вхід через Google не налаштовано')
  const hostTenantId = hostTenantIdOf(event)
  let tenantId = hostTenantId
  if (!tenantId) {
    const q = z.object({ tenant: z.string().min(1).max(60) }).safeParse(getQuery(event))
    if (!q.success) return apiError(event, 400, 'validation_failed', 'Вкажіть простір')
    const [t] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, q.data.tenant))
    if (!t) return apiError(event, 404, 'not_found', 'Простір не знайдено')
    tenantId = t.id
  }
  const r = await authUrl({ tenantId, actorId: null }, 'google', 'signin')
  if ('error' in r) return apiError(event, 409, 'not_configured', 'Вхід через Google не налаштовано')
  return apiData(r)
})
