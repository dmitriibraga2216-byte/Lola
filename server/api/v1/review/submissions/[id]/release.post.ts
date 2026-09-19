import { requireScope } from '../../../../../services/access'
import { release } from '../../../../../services/workshops'
import { apiData } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'review.grade')
  return apiData({ ok: await release({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!) })
})
