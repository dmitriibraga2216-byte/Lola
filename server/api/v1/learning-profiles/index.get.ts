import { requireScope } from '../../../services/access'
import { listProfiles } from '../../../services/automation'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  return apiData(await listProfiles({ tenantId: a.tenantId, actorId: a.userId }))
})
