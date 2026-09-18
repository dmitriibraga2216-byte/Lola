import { requireScope } from '../../../services/access'
import { reviewQueue } from '../../../services/attempts'
import { apiData } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'review.queue')
  return apiData(await reviewQueue({ tenantId: a.tenantId, actorId: a.userId }))
})
