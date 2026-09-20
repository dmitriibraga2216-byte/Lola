import { and, eq, isNull } from 'drizzle-orm'
import { locations, positions, tenants, userPlacements, users } from '../../../db/schema'
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
      birthdayConsent: users.birthdayConsent, // 29 Б.16: тумблер в профиле
    }).from(users).where(eq(users.id, auth.userId))
    if (!u) return null
    // Основное размещение — для карточки человека в меню и профиля (мокапы Main, Profile)
    const [placement] = await tx.select({ position: positions.name, location: locations.name })
      .from(userPlacements)
      .leftJoin(positions, eq(positions.id, userPlacements.positionId))
      .leftJoin(locations, eq(locations.id, userPlacements.locationId))
      .where(and(eq(userPlacements.userId, auth.userId), eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt)))
    return { ...u, position: placement?.position ?? null, location: placement?.location ?? null }
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

  // Скоупы — по активной роли (docs/01 §1.9.2); roles — все действующие, для переключателя
  const scopes = [...new Set(access.grants.flatMap(g => g.scopes))].sort()

  return apiData({
    user: { ...profile, roles: access.roles },
    tenant,
    scopes,
    activeRole: access.activeRole,
    roles: access.roles,
    impersonated: auth.impersonatedBy !== null,
  })
})
