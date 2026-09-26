import { requirePlatform } from '../../../../../utils/platformGuard'
import { listTenantPaymentsForOperator } from '../../../../../services/platformTenants'
import { apiData } from '../../../../../utils/apiResponse'

/** GET /platform/tenants/:id/payments — история платежей в панели оператора (docs/v2/35 §5.6). */
export default defineEventHandler(async (event) => {
  requirePlatform(event, 'billing.read')
  const rows = await listTenantPaymentsForOperator(getRouterParam(event, 'id')!)
  return apiData(rows)
})
