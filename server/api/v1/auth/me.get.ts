import { and, eq, isNull, sql } from 'drizzle-orm'
import { locations, positions, tenants, userPlacements, users } from '../../../db/schema'
import { db } from '../../../db/client'
import { withTenant } from '../../../utils/withTenant'
import type { AuthContext } from '../../../services/session'
import { getAccess } from '../../../services/access'
import { accentOf } from '../../../services/settings'
import { tenantModules } from '../../../services/modules'
import { impersonationInfo } from '../../../services/impersonation'
import { previewInfo } from '../../../services/previewAs'
import { tenantSettingsSchema } from '../../../../shared/schemas/settings'
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
      mustChangePassword: users.mustChangePassword, // docs/24 §3.4.1 «Змінити пароль після першого входу»
      hasPassword: sql<boolean>`${users.passwordHash} is not null`, // сам хеш наружу не уходит
    }).from(users).where(eq(users.id, auth.userId))
    if (!u) return null
    // Основное размещение — для карточки человека в меню и профиля (мокапы Main, Profile)
    const [placement] = await tx.select({ position: positions.name, location: locations.name })
      .from(userPlacements)
      .leftJoin(positions, eq(positions.id, userPlacements.positionId))
      .leftJoin(locations, eq(locations.id, userPlacements.locationId))
      .where(and(eq(userPlacements.userId, auth.userId), eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt)))
    // docs/33 D-021: чи можна задати новий пароль без поточного (вхід за кодом + політики «Паролі»)
    const { readSettings } = await import('../../../services/settings')
    const { passwordRecoveryAllowed } = await import('../../../services/password')
    const canRecoverPassword = u.hasPassword ? (await passwordRecoveryAllowed(tx, (await readSettings(tx, auth.tenantId)).policies.passwords, auth.sessionId)).ok : false
    return { ...u, canRecoverPassword, position: placement?.position ?? null, location: placement?.location ?? null }
  })
  if (!profile) return apiError(event, 401, 'auth_required', 'Користувача не знайдено')

  // tenants — платформенная таблица без RLS
  const [tenant] = await db.select({
    id: tenants.id,
    slug: tenants.slug,
    name: tenants.name,
    locale: tenants.locale,
    timezone: tenants.timezone,
    branding: tenants.branding,
    settings: tenants.settings,
    // Рекрутинг — колонка-флаг, а не модуль настроек (docs/v2/28, миграция 0056): меню и
    // клиентский guard смотрят на него так же, как на `modules`.
    candidatesEnabled: tenants.candidatesEnabled,
  }).from(tenants).where(eq(tenants.id, auth.tenantId))
  // Модули и акцент нужны клиенту для меню и CSS-переменной (docs/24 §3.1, §3.2); политики наружу не отдаём
  const modules = await tenantModules(auth.tenantId)
  const parsedSettings = tenantSettingsSchema.parse(tenant?.settings ?? {})
  const space = parsedSettings.space
  // Единственное поле политики паролей, отдаваемое клиенту (docs/33 D-005): подпись-требование в форме
  // «Задати пароль» до ввода. Остальные политики наружу не отдаются (см. `/settings/policies`, скоуп `settings.tenant`).
  const passwordMinLength = parsedSettings.policies.passwords.minLength

  // Скоупы — по активной роли (docs/01 §1.9.2); roles — все действующие, для переключателя
  const scopes = [...new Set(access.grants.flatMap(g => g.scopes))].sort()

  return apiData({
    user: { ...profile, roles: access.roles },
    tenant: tenant ? { id: tenant.id, slug: tenant.slug, name: tenant.name, locale: tenant.locale, timezone: tenant.timezone, accent: accentOf(tenant.branding), modules, candidatesEnabled: tenant.candidatesEnabled, localesEnabled: space.localesEnabled, passwordMinLength } : null,
    scopes,
    activeRole: access.activeRole,
    roles: access.roles,
    impersonated: auth.impersonatedBy !== null || !!auth.impersonatorAdminId,
    // Плашка «Ви увійшли як …» (docs/24 §4.5): оператор, причина, до когда
    impersonation: await impersonationInfo(auth),
    // Плашка «Переглянути систему як роль» (docs/24 §3.5, докс/33 D-052)
    preview: await previewInfo(auth),
  })
})
