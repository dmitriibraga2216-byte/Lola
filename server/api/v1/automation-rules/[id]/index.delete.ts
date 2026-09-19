import { requireScope } from '../../../../services/access'
import { deleteRule } from '../../../../services/automation'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const r = await deleteRule({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r.ok) return apiError(event, r.code === 'not_found' ? 404 : 409, r.code, r.code === 'in_use' ? `Правило використовується: ${r.usedBy.join(', ')}` : 'Правило не знайдено')
  return apiData({ ok: true })
})
