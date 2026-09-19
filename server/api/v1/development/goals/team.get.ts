import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { teamGoals } from '../../../../services/development'
import { apiData } from '../../../../utils/apiResponse'
const q = z.object({ status: z.string().optional(), overdue: z.coerce.boolean().optional(), locationId: z.string().uuid().optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.team')
  return apiData(await teamGoals({ tenantId: a.tenantId, actorId: a.userId }, q.parse(getQuery(event))))
})
