import { requireScope } from '../../../../services/access'
import { deletePage } from '../../../../services/wiki'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'wiki.edit')
  const r = await deletePage({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if ('forbidden' in r) return apiError(event, 403, 'forbidden', 'Немає права видаляти цю гілку')
  return apiData(r)
})
