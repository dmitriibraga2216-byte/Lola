import { requireScope } from '../../../../services/access'
import { listWaves } from '../../../../services/mystery'
import { apiData } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'report.tenant')
  return apiData(await listWaves({ tenantId: a.tenantId, actorId: a.userId }))
})
