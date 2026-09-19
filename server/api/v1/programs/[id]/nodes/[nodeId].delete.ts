import { requireScope } from '../../../../../services/access'
import { deleteNode } from '../../../../../services/programs'
import { apiData, apiError } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'program.manage')
  if (!await deleteNode({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, getRouterParam(event, 'nodeId')!)) return apiError(event, 404, 'not_found', 'Елемент не знайдено')
  return apiData({ ok: true })
})
