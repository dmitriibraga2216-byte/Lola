import { requireScope } from '../../../services/access'
import { myTasks } from '../../../services/assessment'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assessment.own')
  return apiData(await myTasks({ tenantId: a.tenantId, actorId: a.userId }))
})
