import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { reviewQueue } from '../../../../services/workshops'
import { apiData } from '../../../../utils/apiResponse'
const q = z.object({ mine: z.coerce.boolean().optional(), overdue: z.coerce.boolean().optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'review.queue')
  return apiData(await reviewQueue({ tenantId: a.tenantId, actorId: a.userId }, q.parse(getQuery(event))))
})
