import { requireScope } from '../../../services/access'
import { listScales } from '../../../services/assessment'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assessment.own')
  return apiData(await listScales({ tenantId: a.tenantId, actorId: a.userId }))
})
