import { requireScope } from '../../../../services/access'
import { catalogPrograms, myPrograms } from '../../../../services/programs'
import { apiData } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  return apiData({ mine: await myPrograms(ctx), catalog: await catalogPrograms(ctx) })
})
