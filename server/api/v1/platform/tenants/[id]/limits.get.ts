import { requirePlatform } from '../../../../../utils/platformGuard'
import { getTenantLimits } from '../../../../../services/platformTenants'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** GET /platform/tenants/:id/limits — тариф и переопределения (docs/24 §4.4). */
export default defineEventHandler(async (event) => {
  requirePlatform(event)
  const r = await getTenantLimits(getRouterParam(event, 'id')!)
  return r ? apiData(r) : apiError(event, 404, 'not_found', 'Тенант не знайдено')
})
