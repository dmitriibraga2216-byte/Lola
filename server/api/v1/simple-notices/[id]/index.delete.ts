import { requireScope } from '../../../../services/access'
import { deleteSimpleNotice } from '../../../../services/notices'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'knowledge.manage')
  const ok = await deleteSimpleNotice({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!ok) return apiError(event, 404, 'not_found', 'Оголошення не знайдено')
  return apiData({ ok: true })
})
