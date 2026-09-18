import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { myLearning } from '../../../services/learning'
import { apiData } from '../../../utils/apiResponse'

const q = z.object({ tab: z.enum(['active', 'overdue', 'done']).default('active') })

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'learn.view')
  const { tab } = q.parse(getQuery(event))
  return apiData(await myLearning({ tenantId: access.tenantId, actorId: access.userId }, tab))
})
