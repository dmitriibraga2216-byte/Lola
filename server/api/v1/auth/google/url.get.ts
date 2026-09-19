import { z } from 'zod'
import { authUrl, isConfigured } from '../../../../services/oauth'
import { db } from '../../../../db/client'
import { tenants } from '../../../../db/schema'
import { eq } from 'drizzle-orm'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** Вход через Google (docs/09 §9.1): ссылка от сервера, state привязан к тенанту по slug. */
export default defineEventHandler(async (event) => {
  if (!isConfigured('google')) return apiError(event, 409, 'not_configured', 'Вхід через Google не налаштовано')
  const q = z.object({ tenant: z.string().min(1).max(60) }).safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Вкажіть простір')
  const [t] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, q.data.tenant))
  if (!t) return apiError(event, 404, 'not_found', 'Простір не знайдено')
  const r = await authUrl({ tenantId: t.id, actorId: null }, 'google', 'signin')
  if ('error' in r) return apiError(event, 409, 'not_configured', 'Вхід через Google не налаштовано')
  return apiData(r)
})
