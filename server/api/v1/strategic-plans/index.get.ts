import { requireScope } from '../../../services/access'
import { listStrategicPlans } from '../../../services/developmentExtra'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.team')
  return apiData(await listStrategicPlans({ tenantId: a.tenantId, actorId: a.userId }))
})
