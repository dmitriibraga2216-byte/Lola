import { requireScope } from '../../../services/access'
import { listCategories } from '../../../services/developmentExtra'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.own')
  return apiData(await listCategories({ tenantId: a.tenantId, actorId: a.userId }))
})
