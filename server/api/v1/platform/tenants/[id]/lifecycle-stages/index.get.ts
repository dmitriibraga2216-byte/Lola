import { requirePlatform } from '../../../../../../utils/platformGuard'
import { listStagesForPlatform } from '../../../../../../services/lifecycle'
import { apiData } from '../../../../../../utils/apiResponse'

/**
 * GET /platform/tenants/:id/lifecycle-stages — этапи тенанта з можливостями для вкладки
 * «Етапи» консолі оператора (ops-console-2, docs/v2/33 §2, §5.2, §10). Правити можливості
 * може лише оператор (`PATCH .../lifecycle-stages/:stageId`), решту полів — сам тенант.
 */
export default defineEventHandler(async (event) => {
  requirePlatform(event, 'tenant.read')
  return apiData(await listStagesForPlatform(getRouterParam(event, 'id')!))
})
