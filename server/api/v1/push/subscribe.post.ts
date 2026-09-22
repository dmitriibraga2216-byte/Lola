import { pushSubscribeSchema } from '../../../../shared/schemas/push'
import { requireScope } from '../../../services/access'
import { subscribe } from '../../../services/push'
import { apiData, apiError } from '../../../utils/apiResponse'

/** POST /push/subscribe — підписка браузера на push (докс/33 D-051, docs/23 §4). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = pushSubscribeSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте підписку')
  await subscribe({ tenantId: a.tenantId, actorId: a.userId }, p.data, getHeader(event, 'user-agent'))
  return apiData({ ok: true })
})
