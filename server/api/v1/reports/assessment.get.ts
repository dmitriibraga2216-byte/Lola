import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { assessmentReport } from '../../../services/checklists'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assessment.team')
  const q = z.object({ cycleId: z.string().uuid().optional(), locationId: z.string().uuid().optional() }).parse(getQuery(event))
  return apiData(await assessmentReport({ tenantId: a.tenantId, actorId: a.userId }, q))
})
