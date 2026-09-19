import { requireScope } from '../../../services/access'
import { listWorkshops } from '../../../services/workshops'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.view')
  return apiData(await listWorkshops({ tenantId: a.tenantId, actorId: a.userId }))
})
