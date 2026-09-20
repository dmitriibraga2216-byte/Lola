import { requireScope } from '../../../services/access'
import { deleteAccessGroup } from '../../../services/resources'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'knowledge.manage')
  const ok = await deleteAccessGroup({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!ok) return apiError(event, 404, 'not_found', 'Групу доступу не знайдено')
  return apiData({ ok: true })
})
