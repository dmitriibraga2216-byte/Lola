import { requireScope } from '../../../services/access'
import { hasSubscription } from '../../../services/push'
import { apiData } from '../../../utils/apiResponse'

/** GET /push/status — чи є в людини хоч одна активна підписка (докс/33 D-051). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  return apiData({ subscribed: await hasSubscription({ tenantId: a.tenantId, actorId: a.userId }) })
})
