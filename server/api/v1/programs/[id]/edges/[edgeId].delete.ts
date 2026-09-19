import { requireScope } from '../../../../../services/access'
import { deleteEdge } from '../../../../../services/programs'
import { apiData, apiError } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'program.manage')
  if (!await deleteEdge({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, getRouterParam(event, 'edgeId')!)) return apiError(event, 404, 'not_found', 'Звʼязок не знайдено')
  return apiData({ ok: true })
})
