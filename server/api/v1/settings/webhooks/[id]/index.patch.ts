import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { updateEndpoint, WEBHOOK_EVENTS } from '../../../../../services/webhooks'
import { apiData, apiError } from '../../../../../utils/apiResponse'
const schema = z.object({ isActive: z.boolean().optional(), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional(), url: z.string().url().max(2000).optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.integrations')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте поля')
  const r = await updateEndpoint({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (r === 'url_not_allowed') return apiError(event, 422, 'url_not_allowed', 'Адреса вебхука — лише https:// на публічний хост. Внутрішні адреси й мережі недоступні')
  if (!r) return apiError(event, 404, 'not_found', 'Вебхук не знайдено')
  return apiData(r)
})
