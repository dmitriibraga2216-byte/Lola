import { z } from 'zod'
import { platformCan } from '../../../../../../shared/domain/platformRoles'
import { tenantOverview } from '../../../../../services/platformConsole'
import { apiData, apiError } from '../../../../../utils/apiResponse'
import { requirePlatform } from '../../../../../utils/platformGuard'

/** GET /platform/tenants/:id/overview — обзор карточки компании: статус, тариф, потребление по осям, последние действия. */
export default defineEventHandler(async (event) => {
  const op = requirePlatform(event, 'tenant.read')
  const id = getRouterParam(event, 'id')!
  if (!z.string().uuid().safeParse(id).success) return apiError(event, 404, 'not_found', 'Компанію не знайдено')
  const r = await tenantOverview(id, { withBilling: platformCan(op.role, 'billing.read') })
  return r ? apiData(r) : apiError(event, 404, 'not_found', 'Компанію не знайдено')
})
