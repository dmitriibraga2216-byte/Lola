import { requireScope } from '../../../../services/access'
import { viewSimpleNotice } from '../../../../services/notices'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** POST /simple-notices/:id/view — открытие плашки: просмотр считается раз на человека в день. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const r = await viewSimpleNotice({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Оголошення не знайдено')
  return apiData(r)
})
