import { requireScope } from '../../../services/access'
import { listPositionProfiles } from '../../../services/development'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.team')
  return apiData(await listPositionProfiles({ tenantId: a.tenantId, actorId: a.userId }))
})
