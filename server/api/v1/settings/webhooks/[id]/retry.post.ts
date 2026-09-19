import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { retryDelivery } from '../../../../../services/webhooks'
import { apiData, apiError } from '../../../../../utils/apiResponse'
const schema = z.object({ deliveryId: z.string().uuid() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.integrations')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть доставку')
  const r = await retryDelivery({ tenantId: a.tenantId, actorId: a.userId }, p.data.deliveryId)
  if (!r) return apiError(event, 404, 'not_found', 'Доставку не знайдено')
  return apiData(r)
})
