import { requireScope } from '../../../../services/access'
import { acknowledge } from '../../../../services/notices'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** POST /notices/:id/acknowledge — «Ознайомлений» (docs/04 §4.13, docs/21 §14.5): один тап, отметка с датой. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const r = await acknowledge({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r.ok) return apiError(event, 404, 'not_found', 'Оголошення не знайдено')
  return apiData(r)
})
