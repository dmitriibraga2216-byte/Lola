import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { setPref } from '../../../services/notifications'
import { apiData, apiError } from '../../../utils/apiResponse'
/** «Мої сповіщення» (docs/23 §5.1): включить/выключить код, канал; обязательные не отключаются. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = z.object({ code: z.string().max(60), enabled: z.boolean().optional(), channel: z.enum(['telegram', 'sms', 'email']).nullable().optional() }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте поля')
  const r = await setPref({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r.ok) return apiError(event, r.code === 'mandatory' ? 422 : 404, `notification.${r.code}`, r.code === 'mandatory' ? 'Це сповіщення не можна вимкнути' : 'Невідомий код')
  return apiData(r)
})
