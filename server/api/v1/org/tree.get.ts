import { requireScope } from '../../../services/access'
import { orgTree } from '../../../services/orgTree'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  return apiData(await orgTree({ tenantId: a.tenantId, actorId: a.userId }))
})
