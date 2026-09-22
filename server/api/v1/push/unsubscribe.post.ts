import { pushUnsubscribeSchema } from '../../../../shared/schemas/push'
import { requireScope } from '../../../services/access'
import { unsubscribe } from '../../../services/push'
import { apiData, apiError } from '../../../utils/apiResponse'

/** POST /push/unsubscribe — зняти підписку цього браузера (докс/33 D-051). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = pushUnsubscribeSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте запит')
  await unsubscribe({ tenantId: a.tenantId, actorId: a.userId }, p.data.endpoint)
  return apiData({ ok: true })
})
