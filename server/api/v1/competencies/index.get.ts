import { requireScope } from '../../../services/access'
import { listCompetencies } from '../../../services/development'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.own')
  return apiData(await listCompetencies({ tenantId: a.tenantId, actorId: a.userId }))
})
