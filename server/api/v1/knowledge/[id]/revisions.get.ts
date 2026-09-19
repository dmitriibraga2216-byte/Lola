import { requireScope } from '../../../../services/access'
import { revisions } from '../../../../services/knowledge'
import { apiData } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'knowledge.manage')
  return apiData(await revisions({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!))
})
