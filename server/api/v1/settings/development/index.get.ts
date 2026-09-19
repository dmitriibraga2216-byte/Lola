import { requireScope } from '../../../../services/access'
import { getDevelopmentSettings } from '../../../../services/developmentExtra'
import { apiData } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.manage')
  return apiData(await getDevelopmentSettings({ tenantId: a.tenantId, actorId: a.userId }))
})
