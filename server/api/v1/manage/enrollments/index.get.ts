import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { manageEnrollments } from '../../../../services/assignments'
import { apiData } from '../../../../utils/apiResponse'

const q = z.object({ status: z.string().optional(), courseId: z.string().uuid().optional(), onlyMandatory: z.coerce.boolean().optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'report.team')
  return apiData(await manageEnrollments({ tenantId: a.tenantId, actorId: a.userId }, q.parse(getQuery(event))))
})
