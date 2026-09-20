import { tenantLimitsSchema } from '../../../../../../shared/schemas/platform'
import { requirePlatform } from '../../../../../utils/platformGuard'
import { setTenantLimits } from '../../../../../services/platformTenants'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** PUT /platform/tenants/:id/limits — переопределение лимитов тенанта; null — вернуть тариф. */
export default defineEventHandler(async (event) => {
  const actor = requirePlatform(event)
  const p = tenantLimitsSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Ліміти — цілі числа від 0', { issues: p.error.issues })
  const r = await setTenantLimits(getRouterParam(event, 'id')!, p.data, actor)
  return r ? apiData(r) : apiError(event, 404, 'not_found', 'Тенант не знайдено')
})
