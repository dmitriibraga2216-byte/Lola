import { eq } from 'drizzle-orm'
import { tenants, users } from '../../../db/schema'
import { db } from '../../../db/client'
import { withTenant } from '../../../utils/withTenant'
import type { AuthContext } from '../../../services/session'
import { getAccess } from '../../../services/access'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const auth = event.context.auth as AuthContext | undefined
  if (!auth) return apiError(event, 401, 'auth_required', 'Потрібен вхід')

  const access = await getAccess(event)
  if (!access) return apiError(event, 401, 'auth_required', 'Обліковий запис неактивний')

  const profile = await withTenant(auth.tenantId, auth.userId, async (tx) => {
    const [u] = await tx.select({
      id: users.id,
      fullName: users.fullName,
      phone: users.phone,
      email: users.email,
      locale: users.locale,
      status: users.status,
    }).from(users).where(eq(users.id, auth.userId))
    return u ?? null
  })
  if (!profile) return apiError(event, 401, 'auth_required', 'Користувача не знайдено')

  // tenants — платформенная таблица без RLS
  const [tenant] = await db.select({
    id: tenants.id,
    slug: tenants.slug,
    name: tenants.name,
    locale: tenants.locale,
    timezone: tenants.timezone,
  }).from(tenants).where(eq(tenants.id, auth.tenantId))

  const scopes = [...new Set(access.grants.flatMap(g => g.scopes))].sort()

  return apiData({
    user: profile,
    tenant,
    scopes,
    impersonated: auth.impersonatedBy !== null,
  })
})
