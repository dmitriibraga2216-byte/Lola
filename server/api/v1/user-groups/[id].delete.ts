import { requireScope } from '../../../services/access'
import { deleteGroup } from '../../../services/groups'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.edit')
  const ok = await deleteGroup({ tenantId: access.tenantId, actorId: access.userId }, getRouterParam(event, 'id')!)
  if (!ok) return apiError(event, 404, 'not_found', 'Групу не знайдено')
  return apiData({ ok: true })
})
