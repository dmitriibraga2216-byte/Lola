import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { createEndpoint, WEBHOOK_EVENTS } from '../../../../services/webhooks'
import { apiData, apiError } from '../../../../utils/apiResponse'
const schema = z.object({ url: z.string().url().max(2000).refine(u => u.startsWith('https://') || process.env.NODE_ENV !== 'production', 'Тільки https'), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1), description: z.string().max(200).optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.integrations')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте поля', { issues: p.error.issues })
  return apiData(await createEndpoint({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
