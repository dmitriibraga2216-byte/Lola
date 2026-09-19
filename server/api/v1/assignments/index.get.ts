import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { listAssignments } from '../../../services/assignments'
import { apiData } from '../../../utils/apiResponse'

const q = z.object({ status: z.string().optional(), kind: z.string().optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  return apiData(await listAssignments({ tenantId: a.tenantId, actorId: a.userId }, q.parse(getQuery(event))))
})
