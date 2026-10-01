import { limitsReasonSchema, tenantLimitsSchema } from '../../../../../../shared/schemas/platform'
import { requirePlatform } from '../../../../../utils/platformGuard'
import { setTenantLimits } from '../../../../../services/platformTenants'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/**
 * PUT /platform/tenants/:id/limits — переопределение лимитов тенанта; null — вернуть тариф.
 * Без причины — `422` (`docs/v2/35` §7.10, §10): причина уходит в `platform_audit`.
 */
export default defineEventHandler(async (event) => {
  const actor = requirePlatform(event, 'billing.limits')
  const body = await readBody(event)
  const reason = limitsReasonSchema.safeParse(body ?? {})
  if (!reason.success) return apiError(event, 422, 'reason_required', 'Вкажіть причину зміни лімітів (10–500 знаків)', { issues: reason.error.issues })
  const p = tenantLimitsSchema.safeParse(body)
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Ліміти — цілі числа від 0', { issues: p.error.issues })
  const r = await setTenantLimits(getRouterParam(event, 'id')!, p.data, actor, reason.data.reason)
  return r ? apiData(r) : apiError(event, 404, 'not_found', 'Тенант не знайдено')
})
