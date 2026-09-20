import { requireScope } from '../../../services/access'
import { deleteGroup } from '../../../services/groups'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.edit')
  const r = await deleteGroup({ tenantId: access.tenantId, actorId: access.userId }, getRouterParam(event, 'id')!)
  if (!r.ok) {
    if (r.code === 'org_derived') return apiError(event, 409, 'org_derived', 'Групу з оргструктури не можна видалити: вона перебудовується автоматично')
    return apiError(event, 404, 'not_found', 'Групу не знайдено')
  }
  return apiData({ ok: true })
})
