import { requireScope } from '../../../services/access'
import { removeChief } from '../../../services/people'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.edit')
  const ok = await removeChief({ tenantId: access.tenantId, actorId: access.userId }, getRouterParam(event, 'id')!)
  if (!ok) return apiError(event, 404, 'not_found', 'Звʼязок не знайдено')
  return apiData({ ok: true })
})
