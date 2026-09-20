import { requireScope } from '../../../../services/access'
import { remind } from '../../../../services/notices'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** POST /notices/:id/remind — «Нагадати тим, хто не підтвердив» (мокап Notices): уведомление раз на день. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'knowledge.manage')
  const r = await remind({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r.ok) return apiError(event, 404, 'not_found', 'Оголошення не знайдено')
  return apiData(r)
})
