import { tenantPatchSchema } from '../../../../../../shared/schemas/platform'
import { requirePlatform } from '../../../../../utils/platformGuard'
import { updateTenant } from '../../../../../services/platform'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** PATCH /platform/tenants/:id — тариф, триал, название, settings. Статус — только suspend/resume/purge (docs/25 §8). */
export default defineEventHandler(async (event) => {
  const actor = requirePlatform(event, 'tenant.update')
  const p = tenantPatchSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте поля')
  // Тариф и срок триала — деньги: к праву правки компании нужно право смены тарифа (docs/25 §7 п. 7)
  if (p.data.plan !== undefined || p.data.trialEndsAt !== undefined) requirePlatform(event, 'billing.plan_change')
  const r = await updateTenant(getRouterParam(event, 'id')!, p.data, actor)
  if (!r.ok && r.code === 'not_found') return apiError(event, 404, 'not_found', 'Тенант не знайдено')
  if (!r.ok) return apiError(event, 409, 'domain_taken', 'Цей домен вже прив’язано до іншого тенанта')
  return apiData(r.tenant)
})
