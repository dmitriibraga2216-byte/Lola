import { requirePlatform } from '../../../../../utils/platformGuard'
import { getTenantCard } from '../../../../../services/platform'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** GET /platform/tenants/:id — карточка одного тенанта (docs/33 D-064: в `04` был только список). */
export default defineEventHandler(async (event) => {
  requirePlatform(event, 'tenant.read')
  const r = await getTenantCard(getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Тенант не знайдено')
  return apiData(r)
})
