import { requireScope } from '../../../../services/access'
import { describeEntities, listSaved } from '../../../../services/reportBuilder'
import { apiData } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'report.builder')
  return apiData({ entities: describeEntities(), saved: await listSaved({ tenantId: a.tenantId, actorId: a.userId }) })
})
