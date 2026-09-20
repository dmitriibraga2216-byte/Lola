import { requireScope } from '../../../services/access'
import { deleteScale } from '../../../services/scales'
import { apiData, apiError } from '../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const ok = await deleteScale({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!ok) return apiError(event, 404, 'not_found', 'Шкалу не знайдено')
  return apiData({ ok: true })
})
