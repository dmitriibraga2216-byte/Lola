import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { createEndpoint, WEBHOOK_EVENTS } from '../../../../services/webhooks'
import { apiData, apiError } from '../../../../utils/apiResponse'
const schema = z.object({ url: z.string().url().max(2000).refine(u => u.startsWith('https://') || process.env.NODE_ENV !== 'production', 'Тільки https'), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1), description: z.string().max(200).optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.integrations')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте поля', { issues: p.error.issues })
  const r = await createEndpoint({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r.ok) return apiError(event, 409, 'webhooks_limit', 'Ліміт вебхуків на тарифі вичерпано — зверніться до підтримки Lola')
  return apiData({ id: r.id, secret: r.secret })
})
