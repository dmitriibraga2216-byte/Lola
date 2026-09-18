import { requireScope } from '../../../services/access'
import { listRules } from '../../../services/automation'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  return apiData(await listRules({ tenantId: a.tenantId, actorId: a.userId }))
})
