import { requireScope } from '../../../../services/access'
import { getPage } from '../../../../services/wiki'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const r = await getPage({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r) return apiError(event, 404, 'not_found', 'Сторінку не знайдено')
  if ('forbidden' in r) return apiError(event, 403, 'forbidden', 'Ця гілка wiki вам недоступна')
  return apiData(r)
})
