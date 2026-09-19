import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { assignmentPeople } from '../../../../services/assignments'
import { apiData } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const q = z.object({ status: z.string().optional() }).parse(getQuery(event))
  return apiData(await assignmentPeople({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, q))
})
